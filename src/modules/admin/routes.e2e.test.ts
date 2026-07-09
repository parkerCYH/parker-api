import { randomUUID } from "node:crypto";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import app from "../../app.js";
import { grantAccess } from "../auth/index.js";
import { createRole } from "../rbac/index.js";
import { updateUserRole } from "./repository.js";
import { canUser } from "./service.js";

const OWNER_PROFILE = {
  sub: `google-owner-${randomUUID()}`,
  email: `owner-${randomUUID()}@example.com`,
  name: "Bootstrap Owner",
  picture: "https://example.com/avatar.png",
};

const APPLICANT_PROFILE = {
  sub: `google-applicant-${randomUUID()}`,
  email: `applicant-${randomUUID()}@example.com`,
  name: "Pending Applicant",
  picture: "https://example.com/avatar.png",
};

let currentProfile = OWNER_PROFILE;

function stubGoogleFetch() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input.toString();

      if (url.startsWith("https://oauth2.googleapis.com/token")) {
        return new Response(JSON.stringify({ access_token: "fake-google-access-token" }), { status: 200 });
      }

      if (url.startsWith("https://www.googleapis.com/oauth2/v3/userinfo")) {
        return new Response(JSON.stringify(currentProfile), { status: 200 });
      }

      throw new Error(`unexpected fetch to ${url}`);
    }),
  );
}

function extractState(location: string): string {
  return new URL(location).searchParams.get("state") ?? "";
}

interface PendingResponse {
  status: "pending";
  userId: string;
}

interface ApprovedResponse {
  status: "approved";
  accessToken: string;
  refreshToken: string;
  user: { id: string; email: string; name: string; avatarUrl?: string };
}

async function loginAs(profile: typeof OWNER_PROFILE) {
  currentProfile = profile;
  stubGoogleFetch();

  const startRes = await app.request("/api/v1/admin/login/google");
  const cookie = startRes.headers.get("set-cookie") ?? "";
  const state = extractState(startRes.headers.get("location") ?? "");

  const res = await app.request(`/api/v1/admin/login/google/callback?code=fake-code&state=${state}`, {
    headers: { cookie },
  });

  return res;
}

// 申請 → 用 Owner 核准指定的 roleName → 用同一個 profile 再登入一次拿 token
async function loginWithRole(profile: typeof OWNER_PROFILE, roleName: "Owner" | "SuperAdmin" | "Viewer") {
  const applicantLogin = (await (await loginAs(profile)).json()) as PendingResponse;
  const ownerLogin = (await (await loginAs(OWNER_PROFILE)).json()) as ApprovedResponse;

  await app.request(`/api/v1/admin/users/${applicantLogin.userId}/approve`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${ownerLogin.accessToken}`,
    },
    body: JSON.stringify({ roleName }),
  });

  return (await (await loginAs(profile)).json()) as ApprovedResponse;
}

// ticket #20 的 gateway route 測試需要真的 cat-care 資料——透過 auth 的 Player 登入
// (跟 admin 的 User 登入是完全不同的端點)+ catCare.access 授權 + cat-care 自己的 API 建資料,
// 不直接碰 cat-care 的 repository,走真實流程。
const CAT_CARE_REFERER = "http://test.cat-care.local/login";

async function loginPlayerWithCatCareAccess() {
  const playerProfile = {
    sub: `google-player-${randomUUID()}`,
    email: `player-${randomUUID()}@example.com`,
    name: "Cat Care Player",
    picture: "https://example.com/avatar.png",
  };

  currentProfile = playerProfile;
  stubGoogleFetch();

  async function attemptPlayerLogin() {
    const startRes = await app.request("/api/v1/auth/google", { headers: { referer: CAT_CARE_REFERER } });
    const cookie = startRes.headers.get("set-cookie") ?? "";
    const state = extractState(startRes.headers.get("location") ?? "");

    return app.request(`/api/v1/auth/google/callback?code=fake-code&state=${state}`, {
      headers: { cookie },
    });
  }

  const firstAttempt = await attemptPlayerLogin();
  const { playerId } = (await firstAttempt.json()) as { playerId: string };

  await grantAccess(playerId, "catCare.access");

  const secondAttempt = await attemptPlayerLogin();
  const location = secondAttempt.headers.get("location") ?? "";
  const accessToken = new URL(location).searchParams.get("accessToken") ?? "";

  return { playerId, accessToken, profile: playerProfile };
}

describe("admin routes", () => {
  beforeAll(() => {
    process.env.SUPER_ADMIN_EMAILS = OWNER_PROFILE.email;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("bootstraps the first User via SUPER_ADMIN_EMAILS with Owner role (ADR-0007)", async () => {
    const res = await loginAs(OWNER_PROFILE);

    expect(res.status).toBe(200);
    const body = (await res.json()) as ApprovedResponse;
    expect(body.status).toBe("approved");
    expect(body.accessToken).toEqual(expect.any(String));
    expect(body.user.email).toBe(OWNER_PROFILE.email);
  });

  it("creates a pending application for a non-allowlisted email", async () => {
    const res = await loginAs(APPLICANT_PROFILE);

    expect(res.status).toBe(202);
    const body = (await res.json()) as PendingResponse;
    expect(body.status).toBe("pending");
    expect(body.userId).toEqual(expect.any(String));
  });

  it("rejects approval attempts without a caller access token", async () => {
    const applicantRes = await loginAs(APPLICANT_PROFILE);
    const { userId } = (await applicantRes.json()) as PendingResponse;

    const res = await app.request(`/api/v1/admin/users/${userId}/approve`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ roleName: "Viewer" }),
    });

    expect(res.status).toBe(401);
  });

  it("lets an Owner approve a pending applicant and assign a Role", async () => {
    const ownerLogin = (await (await loginAs(OWNER_PROFILE)).json()) as ApprovedResponse;
    const applicantLogin = (await (await loginAs(APPLICANT_PROFILE)).json()) as PendingResponse;

    const res = await app.request(`/api/v1/admin/users/${applicantLogin.userId}/approve`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${ownerLogin.accessToken}`,
      },
      body: JSON.stringify({ roleName: "Viewer" }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { id: string; email: string };
    expect(body.email).toBe(APPLICANT_PROFILE.email);

    const secondLogin = (await loginAs(APPLICANT_PROFILE)).status === 200;
    expect(secondLogin).toBe(true);
  });

  it("lets a SuperAdmin approve applications too (admin.users.approve is a real seeded rule)", async () => {
    const superAdminProfile = {
      sub: `google-superadmin-${randomUUID()}`,
      email: `superadmin-${randomUUID()}@example.com`,
      name: "SuperAdmin User",
      picture: "https://example.com/avatar.png",
    };
    const superAdmin = await loginWithRole(superAdminProfile, "SuperAdmin");

    const freshApplicant = {
      sub: `google-fresh-applicant-${randomUUID()}`,
      email: `fresh-applicant-${randomUUID()}@example.com`,
      name: "Fresh Applicant",
      picture: "https://example.com/avatar.png",
    };
    const applicantLogin = (await (await loginAs(freshApplicant)).json()) as PendingResponse;

    const res = await app.request(`/api/v1/admin/users/${applicantLogin.userId}/approve`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${superAdmin.accessToken}`,
      },
      body: JSON.stringify({ roleName: "Viewer" }),
    });

    expect(res.status).toBe(200);
  });

  it("forbids a Viewer from approving other applications", async () => {
    const viewerLogin = (await (await loginAs(APPLICANT_PROFILE)).json()) as ApprovedResponse;

    const anotherApplicant = {
      sub: `google-another-${randomUUID()}`,
      email: `another-${randomUUID()}@example.com`,
      name: "Another Applicant",
      picture: "https://example.com/avatar.png",
    };
    const anotherLogin = (await (await loginAs(anotherApplicant)).json()) as PendingResponse;

    const res = await app.request(`/api/v1/admin/users/${anotherLogin.userId}/approve`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${viewerLogin.accessToken}`,
      },
      body: JSON.stringify({ roleName: "Viewer" }),
    });

    expect(res.status).toBe(403);
  });

  it("issues a new access token via refresh", async () => {
    const login = (await (await loginAs(OWNER_PROFILE)).json()) as ApprovedResponse;

    const res = await app.request("/api/v1/admin/refresh", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ refreshToken: login.refreshToken }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { accessToken: string };
    expect(body.accessToken).toEqual(expect.any(String));
  });

  it("lets an Owner call the cat-care gateway route", async () => {
    const login = (await (await loginAs(OWNER_PROFILE)).json()) as ApprovedResponse;

    const res = await app.request("/api/v1/admin/cat-care/cats", {
      headers: { authorization: `Bearer ${login.accessToken}` },
    });

    expect(res.status).toBe(200);
    expect(Array.isArray(await res.json())).toBe(true);
  });

  it("lets a Viewer call the cat-care gateway route (admin.catCare.viewAll seeded on Viewer)", async () => {
    const viewerProfile = {
      sub: `google-viewer-${randomUUID()}`,
      email: `viewer-${randomUUID()}@example.com`,
      name: "Viewer User",
      picture: "https://example.com/avatar.png",
    };
    const viewer = await loginWithRole(viewerProfile, "Viewer");

    const res = await app.request("/api/v1/admin/cat-care/cats", {
      headers: { authorization: `Bearer ${viewer.accessToken}` },
    });

    expect(res.status).toBe(200);
  });

  it("forbids an approved User whose Role lacks admin.catCare.viewAll", async () => {
    // Viewer 現在的規則裡有 admin.catCare.viewAll,production 的三個角色(Owner/SuperAdmin/Viewer)
    // 都能看,所以這裡透過 rbac 建一個只在測試裡存在、沒有任何規則的臨時角色,證明 canUser
    // 真的逐條查 rbac.role_rules、不是永遠放行。approve API 的 roleName enum 只接受
    // Owner/SuperAdmin/Viewer,這裡直接呼叫 rbac 的 createRole 繞過,再用 repository 指派。
    const noRulesRole = await createRole(`NoRules-${randomUUID()}`);

    const noRulesApplicant = {
      sub: `google-norules-${randomUUID()}`,
      email: `norules-${randomUUID()}@example.com`,
      name: "No Rules User",
      picture: "https://example.com/avatar.png",
    };
    const applicantLogin = (await (await loginAs(noRulesApplicant)).json()) as PendingResponse;
    const ownerLogin = (await (await loginAs(OWNER_PROFILE)).json()) as ApprovedResponse;

    await updateUserRole(applicantLogin.userId, {
      roleId: noRulesRole.id,
      approvedBy: ownerLogin.user.id,
      approvedAt: new Date(),
    });

    const noRulesLogin = (await (await loginAs(noRulesApplicant)).json()) as ApprovedResponse;

    const res = await app.request("/api/v1/admin/cat-care/cats", {
      headers: { authorization: `Bearer ${noRulesLogin.accessToken}` },
    });

    expect(res.status).toBe(403);
  });

  it("rejects the gateway route without a caller access token", async () => {
    const res = await app.request("/api/v1/admin/cat-care/cats");
    expect(res.status).toBe(401);
  });

  it("SuperAdmin no longer bypasses rules it wasn't explicitly given (ADR-0007)", async () => {
    const superAdminProfile = {
      sub: `google-superadmin2-${randomUUID()}`,
      email: `superadmin2-${randomUUID()}@example.com`,
      name: "SuperAdmin User 2",
      picture: "https://example.com/avatar.png",
    };
    const superAdmin = await loginWithRole(superAdminProfile, "SuperAdmin");

    // SuperAdmin 沒有 rbac.roles.manage(那是 Owner 專屬),舊的角色名稱特判會讓這裡誤放行
    const res = await app.request("/api/v1/admin/roles", {
      headers: { authorization: `Bearer ${superAdmin.accessToken}` },
    });

    expect(res.status).toBe(403);
  });

  it("lets an Owner manage Roles and their rules end to end", async () => {
    const owner = (await (await loginAs(OWNER_PROFILE)).json()) as ApprovedResponse;
    const authHeader = { authorization: `Bearer ${owner.accessToken}` };

    const createRes = await app.request("/api/v1/admin/roles", {
      method: "POST",
      headers: { "content-type": "application/json", ...authHeader },
      body: JSON.stringify({ name: `Owner-Managed-${randomUUID()}` }),
    });
    expect(createRes.status).toBe(201);
    const role = (await createRes.json()) as { id: string; name: string };

    const listRes = await app.request("/api/v1/admin/roles", { headers: authHeader });
    expect(listRes.status).toBe(200);
    const rolesList = (await listRes.json()) as Array<{ id: string }>;
    expect(rolesList.some((r) => r.id === role.id)).toBe(true);

    const addRuleRes = await app.request(`/api/v1/admin/roles/${role.id}/rules`, {
      method: "POST",
      headers: { "content-type": "application/json", ...authHeader },
      body: JSON.stringify({ rule: "some.test.rule" }),
    });
    expect(addRuleRes.status).toBe(204);

    const removeRuleRes = await app.request(`/api/v1/admin/roles/${role.id}/rules/some.test.rule`, {
      method: "DELETE",
      headers: authHeader,
    });
    expect(removeRuleRes.status).toBe(204);

    const deleteRes = await app.request(`/api/v1/admin/roles/${role.id}`, {
      method: "DELETE",
      headers: authHeader,
    });
    expect(deleteRes.status).toBe(204);

    const listAfterDelete = (await (
      await app.request("/api/v1/admin/roles", { headers: authHeader })
    ).json()) as Array<{ id: string }>;
    expect(listAfterDelete.some((r) => r.id === role.id)).toBe(false);
  });

  it("rejects whitelist API calls from a User without admin.whitelist.manage", async () => {
    const viewerProfile = {
      sub: `google-viewer-wl-${randomUUID()}`,
      email: `viewer-wl-${randomUUID()}@example.com`,
      name: "Viewer for whitelist test",
      picture: "https://example.com/avatar.png",
    };
    const viewer = await loginWithRole(viewerProfile, "Viewer");

    const res = await app.request("/api/v1/admin/whitelist", {
      headers: { authorization: `Bearer ${viewer.accessToken}` },
    });

    expect(res.status).toBe(403);
  });

  it("auto-approves a whitelisted email with the pre-assigned Role on first login (ADR-0001)", async () => {
    const owner = (await (await loginAs(OWNER_PROFILE)).json()) as ApprovedResponse;
    const authHeader = { authorization: `Bearer ${owner.accessToken}` };

    const invitedProfile = {
      sub: `google-invited-${randomUUID()}`,
      email: `invited-${randomUUID()}@example.com`,
      name: "Invited User",
      picture: "https://example.com/avatar.png",
    };

    const addRes = await app.request("/api/v1/admin/whitelist", {
      method: "POST",
      headers: { "content-type": "application/json", ...authHeader },
      body: JSON.stringify({ email: invitedProfile.email, roleName: "Viewer" }),
    });
    expect(addRes.status).toBe(201);

    const listRes = await app.request("/api/v1/admin/whitelist", { headers: authHeader });
    const entries = (await listRes.json()) as Array<{ email: string }>;
    expect(entries.some((e) => e.email === invitedProfile.email)).toBe(true);

    // 第一次登入就該直接核准,不是 pending
    const loginRes = await loginAs(invitedProfile);
    expect(loginRes.status).toBe(200);
    const body = (await loginRes.json()) as ApprovedResponse;
    expect(body.status).toBe("approved");

    // 套用的是白名單指定的 Viewer,能看 cat-care gateway route 但不能管 Role
    const catCareRes = await app.request("/api/v1/admin/cat-care/cats", {
      headers: { authorization: `Bearer ${body.accessToken}` },
    });
    expect(catCareRes.status).toBe(200);

    const rolesRes = await app.request("/api/v1/admin/roles", {
      headers: { authorization: `Bearer ${body.accessToken}` },
    });
    expect(rolesRes.status).toBe(403);
  });

  it("removes a whitelist entry so the email falls back to the pending flow", async () => {
    const owner = (await (await loginAs(OWNER_PROFILE)).json()) as ApprovedResponse;
    const authHeader = { authorization: `Bearer ${owner.accessToken}` };

    const removedProfile = {
      sub: `google-removed-${randomUUID()}`,
      email: `removed-${randomUUID()}@example.com`,
      name: "Removed From Whitelist",
      picture: "https://example.com/avatar.png",
    };

    await app.request("/api/v1/admin/whitelist", {
      method: "POST",
      headers: { "content-type": "application/json", ...authHeader },
      body: JSON.stringify({ email: removedProfile.email, roleName: "Viewer" }),
    });

    const deleteRes = await app.request(
      `/api/v1/admin/whitelist/${encodeURIComponent(removedProfile.email)}`,
      { method: "DELETE", headers: authHeader },
    );
    expect(deleteRes.status).toBe(204);

    const loginRes = await loginAs(removedProfile);
    expect(loginRes.status).toBe(202);
    const body = (await loginRes.json()) as PendingResponse;
    expect(body.status).toBe("pending");
  });

  it("lists Users filtered by status (requires admin.users.view)", async () => {
    const owner = (await (await loginAs(OWNER_PROFILE)).json()) as ApprovedResponse;
    const authHeader = { authorization: `Bearer ${owner.accessToken}` };

    const pendingProfile = {
      sub: `google-list-pending-${randomUUID()}`,
      email: `list-pending-${randomUUID()}@example.com`,
      name: "List Pending",
      picture: "https://example.com/avatar.png",
    };
    const pendingLogin = (await (await loginAs(pendingProfile)).json()) as PendingResponse;

    const pendingRes = await app.request("/api/v1/admin/users?status=pending", { headers: authHeader });
    expect(pendingRes.status).toBe(200);
    const pendingList = (await pendingRes.json()) as Array<{ id: string; status: string }>;
    expect(pendingList.some((u) => u.id === pendingLogin.userId && u.status === "pending")).toBe(true);

    const approvedRes = await app.request("/api/v1/admin/users?status=approved", { headers: authHeader });
    const approvedList = (await approvedRes.json()) as Array<{ id: string; status: string }>;
    expect(approvedList.some((u) => u.id === pendingLogin.userId)).toBe(false);
    expect(approvedList.every((u) => u.status === "approved")).toBe(true);

    const allRes = await app.request("/api/v1/admin/users", { headers: authHeader });
    const allList = (await allRes.json()) as Array<{ id: string }>;
    expect(allList.some((u) => u.id === pendingLogin.userId)).toBe(true);
    expect(allList.length).toBeGreaterThanOrEqual(approvedList.length + pendingList.length);
  });

  it("lets a Viewer see the User list but not approve, reject, or adjust Role", async () => {
    const viewerProfile = {
      sub: `google-viewer-users-${randomUUID()}`,
      email: `viewer-users-${randomUUID()}@example.com`,
      name: "Viewer for user mgmt test",
      picture: "https://example.com/avatar.png",
    };
    const viewer = await loginWithRole(viewerProfile, "Viewer");
    const authHeader = { authorization: `Bearer ${viewer.accessToken}` };

    const listRes = await app.request("/api/v1/admin/users", { headers: authHeader });
    expect(listRes.status).toBe(200);

    const someApplicant = {
      sub: `google-viewer-target-${randomUUID()}`,
      email: `viewer-target-${randomUUID()}@example.com`,
      name: "Viewer Target",
      picture: "https://example.com/avatar.png",
    };
    const targetLogin = (await (await loginAs(someApplicant)).json()) as PendingResponse;

    const approveRes = await app.request(`/api/v1/admin/users/${targetLogin.userId}/approve`, {
      method: "POST",
      headers: { "content-type": "application/json", ...authHeader },
      body: JSON.stringify({ roleName: "Viewer" }),
    });
    expect(approveRes.status).toBe(403);

    const rejectRes = await app.request(`/api/v1/admin/users/${targetLogin.userId}/reject`, {
      method: "POST",
      headers: authHeader,
    });
    expect(rejectRes.status).toBe(403);

    const patchRes = await app.request(`/api/v1/admin/users/${targetLogin.userId}/role`, {
      method: "PATCH",
      headers: { "content-type": "application/json", ...authHeader },
      body: JSON.stringify({ roleName: "Viewer" }),
    });
    expect(patchRes.status).toBe(403);
  });

  it("lets a SuperAdmin reject an application and it disappears from the pending list", async () => {
    const superAdminProfile = {
      sub: `google-superadmin-reject-${randomUUID()}`,
      email: `superadmin-reject-${randomUUID()}@example.com`,
      name: "SuperAdmin for reject test",
      picture: "https://example.com/avatar.png",
    };
    const superAdmin = await loginWithRole(superAdminProfile, "SuperAdmin");
    const authHeader = { authorization: `Bearer ${superAdmin.accessToken}` };

    const rejectedApplicant = {
      sub: `google-to-reject-${randomUUID()}`,
      email: `to-reject-${randomUUID()}@example.com`,
      name: "To Be Rejected",
      picture: "https://example.com/avatar.png",
    };
    const applicantLogin = (await (await loginAs(rejectedApplicant)).json()) as PendingResponse;

    const rejectRes = await app.request(`/api/v1/admin/users/${applicantLogin.userId}/reject`, {
      method: "POST",
      headers: authHeader,
    });
    expect(rejectRes.status).toBe(200);
    const rejectedBody = (await rejectRes.json()) as { status: string };
    expect(rejectedBody.status).toBe("rejected");

    const pendingRes = await app.request("/api/v1/admin/users?status=pending", { headers: authHeader });
    const pendingList = (await pendingRes.json()) as Array<{ id: string }>;
    expect(pendingList.some((u) => u.id === applicantLogin.userId)).toBe(false);

    const rejectedRes = await app.request("/api/v1/admin/users?status=rejected", { headers: authHeader });
    const rejectedList = (await rejectedRes.json()) as Array<{ id: string }>;
    expect(rejectedList.some((u) => u.id === applicantLogin.userId)).toBe(true);
  });

  it("lets a SuperAdmin adjust an already-approved User's Role via PATCH", async () => {
    const superAdminProfile = {
      sub: `google-superadmin-patch-${randomUUID()}`,
      email: `superadmin-patch-${randomUUID()}@example.com`,
      name: "SuperAdmin for patch test",
      picture: "https://example.com/avatar.png",
    };
    const superAdmin = await loginWithRole(superAdminProfile, "SuperAdmin");
    const authHeader = { authorization: `Bearer ${superAdmin.accessToken}` };

    const viewerProfile = {
      sub: `google-promote-${randomUUID()}`,
      email: `promote-${randomUUID()}@example.com`,
      name: "Promote Me",
      picture: "https://example.com/avatar.png",
    };
    const viewer = await loginWithRole(viewerProfile, "Viewer");

    const patchRes = await app.request(`/api/v1/admin/users/${viewer.user.id}/role`, {
      method: "PATCH",
      headers: { "content-type": "application/json", ...authHeader },
      body: JSON.stringify({ roleName: "SuperAdmin" }),
    });
    expect(patchRes.status).toBe(200);
    const patchedBody = (await patchRes.json()) as { status: string };
    expect(patchedBody.status).toBe("approved");

    // Viewer 沒有 admin.users.approve,升級成 SuperAdmin 之後應該有了
    expect(await canUser(viewer.user.id, "admin.users.approve")).toBe(true);
  });

  it("gives an Owner a single cat's detail, bowel movements, and weight records via the gateway", async () => {
    const owner = (await (await loginAs(OWNER_PROFILE)).json()) as ApprovedResponse;
    const adminAuthHeader = { authorization: `Bearer ${owner.accessToken}` };

    const player = await loginPlayerWithCatCareAccess();
    const playerAuthHeader = { authorization: `Bearer ${player.accessToken}` };

    const createCatRes = await app.request("/api/v1/cat-care/cats", {
      method: "POST",
      headers: { "content-type": "application/json", ...playerAuthHeader },
      body: JSON.stringify({ name: "Gateway Detail Cat" }),
    });
    const cat = (await createCatRes.json()) as { id: string; name: string };

    await app.request(`/api/v1/cat-care/cats/${cat.id}/bowel-movements`, {
      method: "POST",
      headers: { "content-type": "application/json", ...playerAuthHeader },
      body: JSON.stringify({ stoolType: "normal", isAbnormal: false }),
    });
    await app.request(`/api/v1/cat-care/cats/${cat.id}/weight-records`, {
      method: "POST",
      headers: { "content-type": "application/json", ...playerAuthHeader },
      body: JSON.stringify({ weightGrams: 4300 }),
    });

    const detailRes = await app.request(`/api/v1/admin/cat-care/cats/${cat.id}`, {
      headers: adminAuthHeader,
    });
    expect(detailRes.status).toBe(200);
    const detail = (await detailRes.json()) as { id: string; name: string };
    expect(detail.name).toBe("Gateway Detail Cat");

    const bowelRes = await app.request(`/api/v1/admin/cat-care/cats/${cat.id}/bowel-movements`, {
      headers: adminAuthHeader,
    });
    expect(bowelRes.status).toBe(200);
    const bowelRecords = (await bowelRes.json()) as unknown[];
    expect(bowelRecords.length).toBeGreaterThanOrEqual(1);

    const weightRes = await app.request(`/api/v1/admin/cat-care/cats/${cat.id}/weight-records`, {
      headers: adminAuthHeader,
    });
    expect(weightRes.status).toBe(200);
    const weightRecords = (await weightRes.json()) as Array<{ weightGrams: number }>;
    expect(weightRecords.some((r) => r.weightGrams === 4300)).toBe(true);
  });

  it("404s the cat detail/records gateway routes for a nonexistent cat", async () => {
    const owner = (await (await loginAs(OWNER_PROFILE)).json()) as ApprovedResponse;
    const authHeader = { authorization: `Bearer ${owner.accessToken}` };
    const fakeCatId = randomUUID();

    const detailRes = await app.request(`/api/v1/admin/cat-care/cats/${fakeCatId}`, { headers: authHeader });
    expect(detailRes.status).toBe(404);

    const bowelRes = await app.request(`/api/v1/admin/cat-care/cats/${fakeCatId}/bowel-movements`, {
      headers: authHeader,
    });
    expect(bowelRes.status).toBe(404);
  });

  it("lists cat-care-related Players with profile info via the gateway", async () => {
    const owner = (await (await loginAs(OWNER_PROFILE)).json()) as ApprovedResponse;
    const adminAuthHeader = { authorization: `Bearer ${owner.accessToken}` };

    const player = await loginPlayerWithCatCareAccess();

    const listRes = await app.request("/api/v1/admin/cat-care/players", { headers: adminAuthHeader });
    expect(listRes.status).toBe(200);
    const players = (await listRes.json()) as Array<{ player: { id: string; email: string } }>;
    const found = players.find((p) => p.player.id === player.playerId);
    expect(found).toBeDefined();
    expect(found?.player.email).toBe(player.profile.email);

    const detailRes = await app.request(`/api/v1/admin/cat-care/players/${player.playerId}`, {
      headers: adminAuthHeader,
    });
    expect(detailRes.status).toBe(200);
    const detail = (await detailRes.json()) as { player: { email: string } };
    expect(detail.player.email).toBe(player.profile.email);
  });

  it("404s the Player detail gateway route for a Player unrelated to cat-care", async () => {
    const owner = (await (await loginAs(OWNER_PROFILE)).json()) as ApprovedResponse;
    const authHeader = { authorization: `Bearer ${owner.accessToken}` };

    const res = await app.request(`/api/v1/admin/cat-care/players/${randomUUID()}`, { headers: authHeader });
    expect(res.status).toBe(404);
  });

  it("forbids a caller without admin.catCare.viewAll from the new cat-care gateway routes", async () => {
    const noRulesRole = await createRole(`NoCatCareRules-${randomUUID()}`);

    const noRulesApplicant = {
      sub: `google-nocatcare-${randomUUID()}`,
      email: `nocatcare-${randomUUID()}@example.com`,
      name: "No CatCare Rules User",
      picture: "https://example.com/avatar.png",
    };
    const applicantLogin = (await (await loginAs(noRulesApplicant)).json()) as PendingResponse;
    const ownerLogin = (await (await loginAs(OWNER_PROFILE)).json()) as ApprovedResponse;

    await updateUserRole(applicantLogin.userId, {
      roleId: noRulesRole.id,
      approvedBy: ownerLogin.user.id,
      approvedAt: new Date(),
    });

    const noRulesLogin = (await (await loginAs(noRulesApplicant)).json()) as ApprovedResponse;
    const authHeader = { authorization: `Bearer ${noRulesLogin.accessToken}` };
    const someId = randomUUID();

    const results = await Promise.all([
      app.request(`/api/v1/admin/cat-care/cats/${someId}`, { headers: authHeader }),
      app.request(`/api/v1/admin/cat-care/cats/${someId}/bowel-movements`, { headers: authHeader }),
      app.request(`/api/v1/admin/cat-care/cats/${someId}/weight-records`, { headers: authHeader }),
      app.request("/api/v1/admin/cat-care/players", { headers: authHeader }),
      app.request(`/api/v1/admin/cat-care/players/${someId}`, { headers: authHeader }),
    ]);

    for (const res of results) {
      expect(res.status).toBe(403);
    }
  });
});
