import { randomUUID } from "node:crypto";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import app from "../../app.js";
import * as repo from "./repository.js";
import { db } from "../../shared/db.js";
import { roles } from "./schema.js";

const SUPER_ADMIN_PROFILE = {
  sub: `google-superadmin-${randomUUID()}`,
  email: `superadmin-${randomUUID()}@example.com`,
  name: "Bootstrap SuperAdmin",
  picture: "https://example.com/avatar.png",
};

const APPLICANT_PROFILE = {
  sub: `google-applicant-${randomUUID()}`,
  email: `applicant-${randomUUID()}@example.com`,
  name: "Pending Applicant",
  picture: "https://example.com/avatar.png",
};

let currentProfile = SUPER_ADMIN_PROFILE;

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

async function loginAs(profile: typeof SUPER_ADMIN_PROFILE) {
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

describe("admin routes", () => {
  beforeAll(() => {
    process.env.SUPER_ADMIN_EMAILS = SUPER_ADMIN_PROFILE.email;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("bootstraps the first User via SUPER_ADMIN_EMAILS with SuperAdmin role", async () => {
    const res = await loginAs(SUPER_ADMIN_PROFILE);

    expect(res.status).toBe(200);
    const body = (await res.json()) as ApprovedResponse;
    expect(body.status).toBe("approved");
    expect(body.accessToken).toEqual(expect.any(String));
    expect(body.user.email).toBe(SUPER_ADMIN_PROFILE.email);
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

  it("lets a SuperAdmin approve a pending applicant and assign a Role", async () => {
    const superAdminLogin = (await (await loginAs(SUPER_ADMIN_PROFILE)).json()) as ApprovedResponse;
    const applicantLogin = (await (await loginAs(APPLICANT_PROFILE)).json()) as PendingResponse;

    const res = await app.request(`/api/v1/admin/users/${applicantLogin.userId}/approve`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${superAdminLogin.accessToken}`,
      },
      body: JSON.stringify({ roleName: "Viewer" }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { id: string; email: string };
    expect(body.email).toBe(APPLICANT_PROFILE.email);

    const secondLogin = (await loginAs(APPLICANT_PROFILE)).status === 200;
    expect(secondLogin).toBe(true);
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
    const login = (await (await loginAs(SUPER_ADMIN_PROFILE)).json()) as ApprovedResponse;

    const res = await app.request("/api/v1/admin/refresh", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ refreshToken: login.refreshToken }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { accessToken: string };
    expect(body.accessToken).toEqual(expect.any(String));
  });

  it("lets a SuperAdmin call the cat-care gateway route", async () => {
    const login = (await (await loginAs(SUPER_ADMIN_PROFILE)).json()) as ApprovedResponse;

    const res = await app.request("/api/v1/admin/cat-care/cats", {
      headers: { authorization: `Bearer ${login.accessToken}` },
    });

    expect(res.status).toBe(200);
    expect(Array.isArray(await res.json())).toBe(true);
  });

  it("lets a Viewer call the cat-care gateway route (admin.catCare.viewAll seeded on Viewer)", async () => {
    const viewerApplicant = {
      sub: `google-viewer-${randomUUID()}`,
      email: `viewer-${randomUUID()}@example.com`,
      name: "Viewer User",
      picture: "https://example.com/avatar.png",
    };
    const applicantLogin = (await (await loginAs(viewerApplicant)).json()) as PendingResponse;
    const superAdminLogin = (await (await loginAs(SUPER_ADMIN_PROFILE)).json()) as ApprovedResponse;

    await app.request(`/api/v1/admin/users/${applicantLogin.userId}/approve`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${superAdminLogin.accessToken}`,
      },
      body: JSON.stringify({ roleName: "Viewer" }),
    });

    const viewerLogin = (await (await loginAs(viewerApplicant)).json()) as ApprovedResponse;

    const res = await app.request("/api/v1/admin/cat-care/cats", {
      headers: { authorization: `Bearer ${viewerLogin.accessToken}` },
    });

    expect(res.status).toBe(200);
  });

  it("forbids an approved User whose Role lacks admin.catCare.viewAll", async () => {
    // Viewer 現在的規則裡有 admin.catCare.viewAll,production 的兩個角色都能看,所以這裡建一個
    // 只在測試裡存在、沒有任何規則的臨時角色,證明 canUser 真的逐條查 role_rules、不是永遠放行。
    const [noRulesRole] = await db
      .insert(roles)
      .values({ name: `NoRules-${randomUUID()}` })
      .returning();

    const noRulesApplicant = {
      sub: `google-norules-${randomUUID()}`,
      email: `norules-${randomUUID()}@example.com`,
      name: "No Rules User",
      picture: "https://example.com/avatar.png",
    };
    const applicantLogin = (await (await loginAs(noRulesApplicant)).json()) as PendingResponse;
    const superAdminLogin = (await (await loginAs(SUPER_ADMIN_PROFILE)).json()) as ApprovedResponse;

    await repo.updateUserRole(applicantLogin.userId, {
      roleId: noRulesRole.id,
      approvedBy: superAdminLogin.user.id,
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
});
