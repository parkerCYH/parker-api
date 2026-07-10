import { randomUUID } from "node:crypto";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import app from "../../app.js";
import { grantAccess } from "../auth/index.js";
import { listAllCats } from "./index.js";

const CAT_CARE_REFERER = "http://test.cat-care.local/login";
// 另一個跟 catCare 無關的 app,用來證明「登入成功、拿到有效 token」不等於「對 catCare 有權限」
const OTHER_APP_REFERER = "http://test.other-app.local/login";

const AUTHORIZED_PROFILE = {
  sub: `google-player-${randomUUID()}`,
  email: `player-${randomUUID()}@example.com`,
  name: "Cat Owner",
  picture: "https://example.com/avatar.png",
};

const UNAUTHORIZED_PROFILE = {
  sub: `google-noaccess-${randomUUID()}`,
  email: `noaccess-${randomUUID()}@example.com`,
  name: "No Access Player",
  picture: "https://example.com/avatar.png",
};

let currentProfile = AUTHORIZED_PROFILE;

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

interface ForbiddenLoginResponse {
  error: string;
  playerId: string;
}

async function attemptLogin(referer: string) {
  stubGoogleFetch();

  const startRes = await app.request("/api/v1/auth/google", { headers: { referer } });
  const cookie = startRes.headers.get("set-cookie") ?? "";
  const state = extractState(startRes.headers.get("location") ?? "");

  return app.request(`/api/v1/auth/google/callback?code=fake-code&state=${state}`, {
    headers: { cookie },
  });
}

// 先登入一次(必然被擋,因為還沒有任何 app 的權限)拿到 playerId,granting 之後的規則,
// 再登入一次拿到真正的 token——跟 auth/admin module 的 e2e 測試同一套模式(ADR-0006)。
async function loginPlayer(profile: typeof AUTHORIZED_PROFILE, referer: string, rule: string) {
  currentProfile = profile;

  const first = await attemptLogin(referer);
  const { playerId } = (await first.json()) as ForbiddenLoginResponse;
  await grantAccess(playerId, rule);

  const res = await attemptLogin(referer);
  const location = res.headers.get("location") ?? "";
  const params = new URL(location).searchParams;

  return { accessToken: params.get("accessToken") ?? "", playerId };
}

interface CatResponse {
  id: string;
  name: string;
  birthdate?: string | null;
  notes?: string | null;
  createdAt: string;
  chipPlayerId?: string | null;
}

// 建一個全新、有 catCare.access 的 Player,給邀請/退出/晶片轉移這類需要「另一個真人」的測試用。
async function newCatCarePlayer(label: string) {
  const profile = {
    sub: `google-${label}-${randomUUID()}`,
    email: `${label}-${randomUUID()}@example.com`,
    name: label,
    picture: "https://example.com/avatar.png",
  };
  const login = await loginPlayer(profile, CAT_CARE_REFERER, "catCare.access");
  return { ...login, profile };
}

describe("cat-care routes", () => {
  let authorizedToken: string;
  let unauthorizedToken: string;

  beforeAll(async () => {
    const owner = await loginPlayer(AUTHORIZED_PROFILE, CAT_CARE_REFERER, "catCare.access");
    authorizedToken = owner.accessToken;

    // 登入的是完全不同的 app(otherApp),拿到的是有效 token,但沒有 catCare.access——
    // 用來測 cat-care 自己的 canPlayer 檢查,不是測登入本身的 app 權限檢查(那是 auth 的責任)
    const noAccess = await loginPlayer(UNAUTHORIZED_PROFILE, OTHER_APP_REFERER, "otherApp.access");
    unauthorizedToken = noAccess.accessToken;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("rejects requests without an access token", async () => {
    const res = await app.request("/api/v1/cat-care/cats", { method: "GET" });
    expect(res.status).toBe(401);
  });

  it("rejects a Player without catCare.access", async () => {
    const res = await app.request("/api/v1/cat-care/cats", {
      method: "GET",
      headers: { authorization: `Bearer ${unauthorizedToken}` },
    });
    expect(res.status).toBe(403);
  });

  it("lets an authorized Player create a cat and become its member", async () => {
    const res = await app.request("/api/v1/cat-care/cats", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${authorizedToken}`,
      },
      body: JSON.stringify({ name: "Mochi", birthdate: "2019-05-01", notes: "kidney diet" }),
    });

    expect(res.status).toBe(201);
    const cat = (await res.json()) as CatResponse;
    expect(cat.name).toBe("Mochi");

    const listRes = await app.request("/api/v1/cat-care/cats", {
      headers: { authorization: `Bearer ${authorizedToken}` },
    });
    const cats = (await listRes.json()) as CatResponse[];
    expect(cats.some((c) => c.id === cat.id)).toBe(true);

    const getRes = await app.request(`/api/v1/cat-care/cats/${cat.id}`, {
      headers: { authorization: `Bearer ${authorizedToken}` },
    });
    expect(getRes.status).toBe(200);
  });

  it("404s a cat the caller is not a member of", async () => {
    const createRes = await app.request("/api/v1/cat-care/cats", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${authorizedToken}`,
      },
      body: JSON.stringify({ name: "Someone Else's Cat" }),
    });
    const cat = (await createRes.json()) as CatResponse;

    // 讓另一個有 catCare.access 但不是這隻貓成員的 Player 來查
    const otherProfile = {
      sub: `google-other-${randomUUID()}`,
      email: `other-${randomUUID()}@example.com`,
      name: "Other Player",
      picture: "https://example.com/avatar.png",
    };
    const other = await loginPlayer(otherProfile, CAT_CARE_REFERER, "catCare.access");

    const res = await app.request(`/api/v1/cat-care/cats/${cat.id}`, {
      headers: { authorization: `Bearer ${other.accessToken}` },
    });
    expect(res.status).toBe(404);
  });

  it("records and lists bowel movements for a cat", async () => {
    const createRes = await app.request("/api/v1/cat-care/cats", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${authorizedToken}`,
      },
      body: JSON.stringify({ name: "Bowel Test Cat" }),
    });
    const cat = (await createRes.json()) as CatResponse;

    const recordRes = await app.request(`/api/v1/cat-care/cats/${cat.id}/bowel-movements`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${authorizedToken}`,
      },
      body: JSON.stringify({ stoolType: "normal", isAbnormal: false }),
    });
    expect(recordRes.status).toBe(201);

    const listRes = await app.request(`/api/v1/cat-care/cats/${cat.id}/bowel-movements`, {
      headers: { authorization: `Bearer ${authorizedToken}` },
    });
    expect(listRes.status).toBe(200);
    const records = (await listRes.json()) as unknown[];
    expect(records.length).toBeGreaterThanOrEqual(1);
  });

  it("records and lists weight measurements for a cat, with history", async () => {
    const createRes = await app.request("/api/v1/cat-care/cats", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${authorizedToken}`,
      },
      body: JSON.stringify({ name: "Weight Test Cat" }),
    });
    const cat = (await createRes.json()) as CatResponse;

    for (const weightGrams of [4200, 4150]) {
      const res = await app.request(`/api/v1/cat-care/cats/${cat.id}/weight-records`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${authorizedToken}`,
        },
        body: JSON.stringify({ weightGrams }),
      });
      expect(res.status).toBe(201);
    }

    const listRes = await app.request(`/api/v1/cat-care/cats/${cat.id}/weight-records`, {
      headers: { authorization: `Bearer ${authorizedToken}` },
    });
    expect(listRes.status).toBe(200);
    const records = (await listRes.json()) as Array<{ weightGrams: number }>;
    expect(records.length).toBeGreaterThanOrEqual(2);
  });

  it("exposes listAllCats() for the admin module to call in-process (ADR-0005)", async () => {
    const createRes = await app.request("/api/v1/cat-care/cats", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${authorizedToken}`,
      },
      body: JSON.stringify({ name: "Gateway Visible Cat" }),
    });
    const cat = (await createRes.json()) as CatResponse;

    const allCats = await listAllCats();
    expect(allCats.some((c) => c.id === cat.id)).toBe(true);
  });

  it("archives a cat instead of hard-deleting it (ticket #23)", async () => {
    const createRes = await app.request("/api/v1/cat-care/cats", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${authorizedToken}`,
      },
      body: JSON.stringify({ name: "Archive Test Cat" }),
    });
    const cat = (await createRes.json()) as CatResponse;

    const archiveRes = await app.request(`/api/v1/cat-care/cats/${cat.id}`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${authorizedToken}` },
    });
    expect(archiveRes.status).toBe(200);
    const archived = (await archiveRes.json()) as CatResponse & { archivedAt: string };
    expect(archived.archivedAt).toBeTruthy();

    // Player app 的 list/get 預設排除已封存的貓咪,視同不存在
    const listRes = await app.request("/api/v1/cat-care/cats", {
      headers: { authorization: `Bearer ${authorizedToken}` },
    });
    const cats = (await listRes.json()) as CatResponse[];
    expect(cats.some((c) => c.id === cat.id)).toBe(false);

    const getRes = await app.request(`/api/v1/cat-care/cats/${cat.id}`, {
      headers: { authorization: `Bearer ${authorizedToken}` },
    });
    expect(getRes.status).toBe(404);

    // admin gateway 的 listAllCats() 仍看得到,且帶 archivedAt
    const allCats = await listAllCats();
    const gatewayCat = allCats.find((c) => c.id === cat.id);
    expect(gatewayCat?.archivedAt).toBeTruthy();
  });

  it("404s archiving a cat the caller is not a member of", async () => {
    const createRes = await app.request("/api/v1/cat-care/cats", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${authorizedToken}`,
      },
      body: JSON.stringify({ name: "Not Yours To Archive" }),
    });
    const cat = (await createRes.json()) as CatResponse;

    const otherProfile = {
      sub: `google-other-${randomUUID()}`,
      email: `other-${randomUUID()}@example.com`,
      name: "Other Player",
      picture: "https://example.com/avatar.png",
    };
    const other = await loginPlayer(otherProfile, CAT_CARE_REFERER, "catCare.access");

    const res = await app.request(`/api/v1/cat-care/cats/${cat.id}`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${other.accessToken}` },
    });
    expect(res.status).toBe(404);
  });

  it("lets only the recording Player edit a bowel movement (ticket #23)", async () => {
    const createRes = await app.request("/api/v1/cat-care/cats", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${authorizedToken}`,
      },
      body: JSON.stringify({ name: "Bowel Edit Test Cat" }),
    });
    const cat = (await createRes.json()) as CatResponse;

    const recordRes = await app.request(`/api/v1/cat-care/cats/${cat.id}/bowel-movements`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${authorizedToken}`,
      },
      body: JSON.stringify({ stoolType: "normal", isAbnormal: false }),
    });
    const record = (await recordRes.json()) as { id: string };

    const editRes = await app.request(
      `/api/v1/cat-care/cats/${cat.id}/bowel-movements/${record.id}`,
      {
        method: "PATCH",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${authorizedToken}`,
        },
        body: JSON.stringify({ isAbnormal: true, notes: "corrected" }),
      },
    );
    expect(editRes.status).toBe(200);
    const updated = (await editRes.json()) as { isAbnormal: boolean; notes?: string | null };
    expect(updated.isAbnormal).toBe(true);
    expect(updated.notes).toBe("corrected");

    // 另一個有 catCare.access 但不是 recorded_by 本人的 Player 不能編輯
    const otherProfile = {
      sub: `google-other-${randomUUID()}`,
      email: `other-${randomUUID()}@example.com`,
      name: "Other Player",
      picture: "https://example.com/avatar.png",
    };
    const other = await loginPlayer(otherProfile, CAT_CARE_REFERER, "catCare.access");

    const forbiddenRes = await app.request(
      `/api/v1/cat-care/cats/${cat.id}/bowel-movements/${record.id}`,
      {
        method: "PATCH",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${other.accessToken}`,
        },
        body: JSON.stringify({ notes: "not mine to edit" }),
      },
    );
    expect(forbiddenRes.status).toBe(403);
  });

  it("lets only the measuring Player edit a weight record (ticket #23)", async () => {
    const createRes = await app.request("/api/v1/cat-care/cats", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${authorizedToken}`,
      },
      body: JSON.stringify({ name: "Weight Edit Test Cat" }),
    });
    const cat = (await createRes.json()) as CatResponse;

    const recordRes = await app.request(`/api/v1/cat-care/cats/${cat.id}/weight-records`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${authorizedToken}`,
      },
      body: JSON.stringify({ weightGrams: 4300 }),
    });
    const record = (await recordRes.json()) as { id: string };

    const editRes = await app.request(
      `/api/v1/cat-care/cats/${cat.id}/weight-records/${record.id}`,
      {
        method: "PATCH",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${authorizedToken}`,
        },
        body: JSON.stringify({ weightGrams: 4280 }),
      },
    );
    expect(editRes.status).toBe(200);
    const updated = (await editRes.json()) as { weightGrams: number };
    expect(updated.weightGrams).toBe(4280);

    const otherProfile = {
      sub: `google-other-${randomUUID()}`,
      email: `other-${randomUUID()}@example.com`,
      name: "Other Player",
      picture: "https://example.com/avatar.png",
    };
    const other = await loginPlayer(otherProfile, CAT_CARE_REFERER, "catCare.access");

    const forbiddenRes = await app.request(
      `/api/v1/cat-care/cats/${cat.id}/weight-records/${record.id}`,
      {
        method: "PATCH",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${other.accessToken}`,
        },
        body: JSON.stringify({ weightGrams: 1 }),
      },
    );
    expect(forbiddenRes.status).toBe(403);
  });

  it("lets a member invite an existing Player by email, who then gains access (ticket #24)", async () => {
    const createRes = await app.request("/api/v1/cat-care/cats", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${authorizedToken}`,
      },
      body: JSON.stringify({ name: "Invite Test Cat" }),
    });
    const cat = (await createRes.json()) as CatResponse;

    const invitee = await newCatCarePlayer("invitee");

    // 邀請前,對方看不到這隻貓
    const beforeRes = await app.request(`/api/v1/cat-care/cats/${cat.id}`, {
      headers: { authorization: `Bearer ${invitee.accessToken}` },
    });
    expect(beforeRes.status).toBe(404);

    const inviteRes = await app.request(`/api/v1/cat-care/cats/${cat.id}/players`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${authorizedToken}`,
      },
      body: JSON.stringify({ email: invitee.profile.email }),
    });
    expect(inviteRes.status).toBe(201);
    const invited = (await inviteRes.json()) as { id: string; email: string };
    expect(invited.email).toBe(invitee.profile.email);

    const afterRes = await app.request(`/api/v1/cat-care/cats/${cat.id}`, {
      headers: { authorization: `Bearer ${invitee.accessToken}` },
    });
    expect(afterRes.status).toBe(200);
  });

  it("404s inviting an email with no parker-api account", async () => {
    const createRes = await app.request("/api/v1/cat-care/cats", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${authorizedToken}`,
      },
      body: JSON.stringify({ name: "Invite Unknown Email Cat" }),
    });
    const cat = (await createRes.json()) as CatResponse;

    const res = await app.request(`/api/v1/cat-care/cats/${cat.id}/players`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${authorizedToken}`,
      },
      body: JSON.stringify({ email: `nobody-${randomUUID()}@example.com` }),
    });
    expect(res.status).toBe(404);
  });

  it("404s a non-member trying to invite someone into a cat", async () => {
    const createRes = await app.request("/api/v1/cat-care/cats", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${authorizedToken}`,
      },
      body: JSON.stringify({ name: "Not Yours To Invite Into" }),
    });
    const cat = (await createRes.json()) as CatResponse;

    const outsider = await newCatCarePlayer("outsider");
    const someoneElse = await newCatCarePlayer("someone-else");

    const res = await app.request(`/api/v1/cat-care/cats/${cat.id}/players`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${outsider.accessToken}`,
      },
      body: JSON.stringify({ email: someoneElse.profile.email }),
    });
    expect(res.status).toBe(404);
  });

  it("lets a member leave a cat, but 404s leaving one they don't belong to (ticket #24)", async () => {
    const createRes = await app.request("/api/v1/cat-care/cats", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${authorizedToken}`,
      },
      body: JSON.stringify({ name: "Leave Test Cat" }),
    });
    const cat = (await createRes.json()) as CatResponse;

    const member = await newCatCarePlayer("leaving-member");
    await app.request(`/api/v1/cat-care/cats/${cat.id}/players`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${authorizedToken}`,
      },
      body: JSON.stringify({ email: member.profile.email }),
    });

    const leaveRes = await app.request(`/api/v1/cat-care/cats/${cat.id}/players/me`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${member.accessToken}` },
    });
    expect(leaveRes.status).toBe(204);

    // 已經退出了,不再是 member
    const afterRes = await app.request(`/api/v1/cat-care/cats/${cat.id}`, {
      headers: { authorization: `Bearer ${member.accessToken}` },
    });
    expect(afterRes.status).toBe(404);

    // 再退一次(已經不是 member)回 404
    const secondLeaveRes = await app.request(`/api/v1/cat-care/cats/${cat.id}/players/me`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${member.accessToken}` },
    });
    expect(secondLeaveRes.status).toBe(404);
  });

  it("refuses to let the last member of a chip-less cat leave (would orphan it)", async () => {
    const createRes = await app.request("/api/v1/cat-care/cats", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${authorizedToken}`,
      },
      body: JSON.stringify({ name: "Sole Member Cat" }),
    });
    const cat = (await createRes.json()) as CatResponse;

    const res = await app.request(`/api/v1/cat-care/cats/${cat.id}/players/me`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${authorizedToken}` },
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("would_orphan");
  });

  it("sets and transfers the chip-registration custodian; custodian can't leave until transferred (ticket #24)", async () => {
    const createRes = await app.request("/api/v1/cat-care/cats", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${authorizedToken}`,
      },
      body: JSON.stringify({ name: "Chip Player Cat" }),
    });
    const cat = (await createRes.json()) as CatResponse;

    const successor = await newCatCarePlayer("chip-successor");
    await app.request(`/api/v1/cat-care/cats/${cat.id}/players`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${authorizedToken}`,
      },
      body: JSON.stringify({ email: successor.profile.email }),
    });

    // 還不是成員的人不能被設成晶片責任人
    const nonMember = await newCatCarePlayer("chip-non-member");
    const rejectedRes = await app.request(`/api/v1/cat-care/cats/${cat.id}/chip-player`, {
      method: "PUT",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${authorizedToken}`,
      },
      body: JSON.stringify({ email: nonMember.profile.email }),
    });
    expect(rejectedRes.status).toBe(409);

    // 設定 authorizedToken 的 player 為晶片責任人
    const setRes = await app.request(`/api/v1/cat-care/cats/${cat.id}/chip-player`, {
      method: "PUT",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${authorizedToken}`,
      },
      body: JSON.stringify({ email: AUTHORIZED_PROFILE.email }),
    });
    expect(setRes.status).toBe(200);
    const cat1 = (await setRes.json()) as CatResponse;
    expect(cat1.chipPlayerId).toBeTruthy();

    // 責任人本人不能直接退出
    const blockedLeaveRes = await app.request(`/api/v1/cat-care/cats/${cat.id}/players/me`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${authorizedToken}` },
    });
    expect(blockedLeaveRes.status).toBe(409);
    const blockedBody = (await blockedLeaveRes.json()) as { error: string };
    expect(blockedBody.error).toBe("chip_holder");

    // 轉移給另一位既有成員
    const transferRes = await app.request(`/api/v1/cat-care/cats/${cat.id}/chip-player`, {
      method: "PUT",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${authorizedToken}`,
      },
      body: JSON.stringify({ email: successor.profile.email }),
    });
    expect(transferRes.status).toBe(200);

    // 轉移之後,原本的責任人可以退出了(即使退到只剩責任人一人也允許)
    const leaveAfterTransferRes = await app.request(`/api/v1/cat-care/cats/${cat.id}/players/me`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${authorizedToken}` },
    });
    expect(leaveAfterTransferRes.status).toBe(204);
  });

  it("filters bowel-movement and weight-record history by ?from=&to= (ticket #24)", async () => {
    const createRes = await app.request("/api/v1/cat-care/cats", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${authorizedToken}`,
      },
      body: JSON.stringify({ name: "Date Filter Cat" }),
    });
    const cat = (await createRes.json()) as CatResponse;

    const oldDate = "2020-01-01T00:00:00.000Z";
    const recentDate = "2026-06-01T00:00:00.000Z";

    await app.request(`/api/v1/cat-care/cats/${cat.id}/bowel-movements`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${authorizedToken}`,
      },
      body: JSON.stringify({ recordedAt: oldDate, stoolType: "old" }),
    });
    await app.request(`/api/v1/cat-care/cats/${cat.id}/bowel-movements`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${authorizedToken}`,
      },
      body: JSON.stringify({ recordedAt: recentDate, stoolType: "recent" }),
    });

    await app.request(`/api/v1/cat-care/cats/${cat.id}/weight-records`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${authorizedToken}`,
      },
      body: JSON.stringify({ measuredAt: oldDate, weightGrams: 4000 }),
    });
    await app.request(`/api/v1/cat-care/cats/${cat.id}/weight-records`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${authorizedToken}`,
      },
      body: JSON.stringify({ measuredAt: recentDate, weightGrams: 4100 }),
    });

    const bowelRes = await app.request(
      `/api/v1/cat-care/cats/${cat.id}/bowel-movements?from=2025-01-01&to=2026-12-31`,
      { headers: { authorization: `Bearer ${authorizedToken}` } },
    );
    expect(bowelRes.status).toBe(200);
    const bowelRecords = (await bowelRes.json()) as Array<{ stoolType: string }>;
    expect(bowelRecords.some((r) => r.stoolType === "recent")).toBe(true);
    expect(bowelRecords.some((r) => r.stoolType === "old")).toBe(false);

    const weightRes = await app.request(
      `/api/v1/cat-care/cats/${cat.id}/weight-records?from=2025-01-01&to=2026-12-31`,
      { headers: { authorization: `Bearer ${authorizedToken}` } },
    );
    expect(weightRes.status).toBe(200);
    const weightRecords = (await weightRes.json()) as Array<{ weightGrams: number }>;
    expect(weightRecords.some((r) => r.weightGrams === 4100)).toBe(true);
    expect(weightRecords.some((r) => r.weightGrams === 4000)).toBe(false);
  });

  it("lists cat_players members, and 404s for a non-member (ticket #25)", async () => {
    const createRes = await app.request("/api/v1/cat-care/cats", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${authorizedToken}`,
      },
      body: JSON.stringify({ name: "Members List Cat" }),
    });
    const cat = (await createRes.json()) as CatResponse;

    const coCaretaker = await newCatCarePlayer("co-caretaker");
    await app.request(`/api/v1/cat-care/cats/${cat.id}/players`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${authorizedToken}`,
      },
      body: JSON.stringify({ email: coCaretaker.profile.email }),
    });

    const listRes = await app.request(`/api/v1/cat-care/cats/${cat.id}/players`, {
      headers: { authorization: `Bearer ${authorizedToken}` },
    });
    expect(listRes.status).toBe(200);
    const members = (await listRes.json()) as Array<{ id: string; email: string }>;
    expect(members.some((m) => m.email === AUTHORIZED_PROFILE.email)).toBe(true);
    expect(members.some((m) => m.email === coCaretaker.profile.email)).toBe(true);

    const outsider = await newCatCarePlayer("members-outsider");
    const forbiddenRes = await app.request(`/api/v1/cat-care/cats/${cat.id}/players`, {
      headers: { authorization: `Bearer ${outsider.accessToken}` },
    });
    expect(forbiddenRes.status).toBe(404);
  });

  it("returns chipPlayerId in GET /cats and GET /cats/{catId} before and after it's set (ticket #25)", async () => {
    const createRes = await app.request("/api/v1/cat-care/cats", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${authorizedToken}`,
      },
      body: JSON.stringify({ name: "Chip Field Visibility Cat" }),
    });
    const cat = (await createRes.json()) as CatResponse;
    expect(cat.chipPlayerId ?? null).toBeNull();

    const getBeforeRes = await app.request(`/api/v1/cat-care/cats/${cat.id}`, {
      headers: { authorization: `Bearer ${authorizedToken}` },
    });
    const beforeCat = (await getBeforeRes.json()) as CatResponse;
    expect(beforeCat.chipPlayerId ?? null).toBeNull();

    const listBeforeRes = await app.request("/api/v1/cat-care/cats", {
      headers: { authorization: `Bearer ${authorizedToken}` },
    });
    const listBefore = (await listBeforeRes.json()) as CatResponse[];
    expect(listBefore.find((c) => c.id === cat.id)?.chipPlayerId ?? null).toBeNull();

    await app.request(`/api/v1/cat-care/cats/${cat.id}/chip-player`, {
      method: "PUT",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${authorizedToken}`,
      },
      body: JSON.stringify({ email: AUTHORIZED_PROFILE.email }),
    });

    const getAfterRes = await app.request(`/api/v1/cat-care/cats/${cat.id}`, {
      headers: { authorization: `Bearer ${authorizedToken}` },
    });
    const afterCat = (await getAfterRes.json()) as CatResponse;
    expect(afterCat.chipPlayerId).toBeTruthy();

    const listAfterRes = await app.request("/api/v1/cat-care/cats", {
      headers: { authorization: `Bearer ${authorizedToken}` },
    });
    const listAfter = (await listAfterRes.json()) as CatResponse[];
    expect(listAfter.find((c) => c.id === cat.id)?.chipPlayerId).toBeTruthy();
  });

  it("lets only the recording Player hard-delete a bowel movement (ticket #25)", async () => {
    const createRes = await app.request("/api/v1/cat-care/cats", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${authorizedToken}`,
      },
      body: JSON.stringify({ name: "Bowel Delete Test Cat" }),
    });
    const cat = (await createRes.json()) as CatResponse;

    const recordRes = await app.request(`/api/v1/cat-care/cats/${cat.id}/bowel-movements`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${authorizedToken}`,
      },
      body: JSON.stringify({ stoolType: "to be deleted" }),
    });
    const record = (await recordRes.json()) as { id: string };

    const otherMember = await newCatCarePlayer("bowel-delete-other");
    await app.request(`/api/v1/cat-care/cats/${cat.id}/players`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${authorizedToken}`,
      },
      body: JSON.stringify({ email: otherMember.profile.email }),
    });

    const forbiddenRes = await app.request(
      `/api/v1/cat-care/cats/${cat.id}/bowel-movements/${record.id}`,
      { method: "DELETE", headers: { authorization: `Bearer ${otherMember.accessToken}` } },
    );
    expect(forbiddenRes.status).toBe(403);

    const deleteRes = await app.request(
      `/api/v1/cat-care/cats/${cat.id}/bowel-movements/${record.id}`,
      { method: "DELETE", headers: { authorization: `Bearer ${authorizedToken}` } },
    );
    expect(deleteRes.status).toBe(204);

    const listRes = await app.request(`/api/v1/cat-care/cats/${cat.id}/bowel-movements`, {
      headers: { authorization: `Bearer ${authorizedToken}` },
    });
    const records = (await listRes.json()) as Array<{ id: string }>;
    expect(records.some((r) => r.id === record.id)).toBe(false);

    // 已刪除,再刪一次回 404
    const secondDeleteRes = await app.request(
      `/api/v1/cat-care/cats/${cat.id}/bowel-movements/${record.id}`,
      { method: "DELETE", headers: { authorization: `Bearer ${authorizedToken}` } },
    );
    expect(secondDeleteRes.status).toBe(404);
  });

  it("lets only the measuring Player hard-delete a weight record (ticket #25)", async () => {
    const createRes = await app.request("/api/v1/cat-care/cats", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${authorizedToken}`,
      },
      body: JSON.stringify({ name: "Weight Delete Test Cat" }),
    });
    const cat = (await createRes.json()) as CatResponse;

    const recordRes = await app.request(`/api/v1/cat-care/cats/${cat.id}/weight-records`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${authorizedToken}`,
      },
      body: JSON.stringify({ weightGrams: 4321 }),
    });
    const record = (await recordRes.json()) as { id: string };

    const otherMember = await newCatCarePlayer("weight-delete-other");
    await app.request(`/api/v1/cat-care/cats/${cat.id}/players`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${authorizedToken}`,
      },
      body: JSON.stringify({ email: otherMember.profile.email }),
    });

    const forbiddenRes = await app.request(
      `/api/v1/cat-care/cats/${cat.id}/weight-records/${record.id}`,
      { method: "DELETE", headers: { authorization: `Bearer ${otherMember.accessToken}` } },
    );
    expect(forbiddenRes.status).toBe(403);

    const deleteRes = await app.request(
      `/api/v1/cat-care/cats/${cat.id}/weight-records/${record.id}`,
      { method: "DELETE", headers: { authorization: `Bearer ${authorizedToken}` } },
    );
    expect(deleteRes.status).toBe(204);

    const listRes = await app.request(`/api/v1/cat-care/cats/${cat.id}/weight-records`, {
      headers: { authorization: `Bearer ${authorizedToken}` },
    });
    const records = (await listRes.json()) as Array<{ id: string }>;
    expect(records.some((r) => r.id === record.id)).toBe(false);
  });
});
