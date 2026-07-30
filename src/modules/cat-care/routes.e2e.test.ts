import { randomUUID } from "node:crypto";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import app from "../../app.js";
import { env } from "../../shared/env.js";
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

// 先登入一次拿到 playerId,granting 之後的規則,再登入一次拿到真正的 token——跟
// auth/admin module 的 e2e 測試同一套模式(ADR-0006)。cat-care 登入即自動授權
// catCare.access(ticket #28)之後,第一次就會直接成功,不會被擋,所以這裡要能處理
// 兩種結果:403(該 app 仍要人工授予,例如 otherApp)或直接 302 成功。
async function loginPlayer(profile: typeof AUTHORIZED_PROFILE, referer: string, rule: string) {
  currentProfile = profile;

  const first = await attemptLogin(referer);

  if (first.status !== 403) {
    const location = first.headers.get("location") ?? "";
    const params = new URL(location).searchParams;
    return { accessToken: params.get("accessToken") ?? "", playerId: "" };
  }

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

  it("lets a member partially update a cat's basic profile (ticket 07)", async () => {
    const createRes = await app.request("/api/v1/cat-care/cats", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${authorizedToken}`,
      },
      body: JSON.stringify({ name: "Old Name", birthdate: "2019-05-01", notes: "old notes" }),
    });
    const cat = (await createRes.json()) as CatResponse;

    // 只送 name,birthdate/notes 應維持不變(partial update)
    const updateRes = await app.request(`/api/v1/cat-care/cats/${cat.id}`, {
      method: "PATCH",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${authorizedToken}`,
      },
      body: JSON.stringify({ name: "New Name" }),
    });
    expect(updateRes.status).toBe(200);
    const updated = (await updateRes.json()) as CatResponse;
    expect(updated.name).toBe("New Name");
    expect(updated.birthdate).toBe("2019-05-01");
    expect(updated.notes).toBe("old notes");
  });

  it("404s updating a cat the caller is not a member of", async () => {
    const createRes = await app.request("/api/v1/cat-care/cats", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${authorizedToken}`,
      },
      body: JSON.stringify({ name: "Not Yours To Edit" }),
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
      method: "PATCH",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${other.accessToken}`,
      },
      body: JSON.stringify({ name: "Hijacked Name" }),
    });
    expect(res.status).toBe(404);
  });

  it("rejects an empty name and a future birthdate when updating a cat (ticket 07)", async () => {
    const createRes = await app.request("/api/v1/cat-care/cats", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${authorizedToken}`,
      },
      body: JSON.stringify({ name: "Validation Cat" }),
    });
    const cat = (await createRes.json()) as CatResponse;

    const emptyNameRes = await app.request(`/api/v1/cat-care/cats/${cat.id}`, {
      method: "PATCH",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${authorizedToken}`,
      },
      body: JSON.stringify({ name: "" }),
    });
    expect(emptyNameRes.status).toBe(400);

    const futureYear = new Date().getUTCFullYear() + 1;
    const futureBirthdateRes = await app.request(`/api/v1/cat-care/cats/${cat.id}`, {
      method: "PATCH",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${authorizedToken}`,
      },
      body: JSON.stringify({ birthdate: `${futureYear}-01-01` }),
    });
    expect(futureBirthdateRes.status).toBe(400);
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
    // 刻意用非 00:00 的時間,且跟下面查詢的 `to=2026-06-01` 同一天——用來驗證 `to` 篩選涵蓋
    // 「當天結束」而非被誤判成「當天 00:00」(否則這筆會被 lte 濾掉,見 service.ts 的
    // `endOfDayUtc` 註解)。
    const recentDate = "2026-06-01T15:30:00.000Z";

    await app.request(`/api/v1/cat-care/cats/${cat.id}/bowel-movements`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${authorizedToken}`,
      },
      body: JSON.stringify({ recordedAt: oldDate, stoolType: "hard" }),
    });
    await app.request(`/api/v1/cat-care/cats/${cat.id}/bowel-movements`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${authorizedToken}`,
      },
      body: JSON.stringify({ recordedAt: recentDate, stoolType: "watery" }),
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
      `/api/v1/cat-care/cats/${cat.id}/bowel-movements?from=2025-01-01&to=2026-06-01`,
      { headers: { authorization: `Bearer ${authorizedToken}` } },
    );
    expect(bowelRes.status).toBe(200);
    const bowelRecords = (await bowelRes.json()) as Array<{ stoolType: string }>;
    expect(bowelRecords.some((r) => r.stoolType === "watery")).toBe(true);
    expect(bowelRecords.some((r) => r.stoolType === "hard")).toBe(false);

    const weightRes = await app.request(
      `/api/v1/cat-care/cats/${cat.id}/weight-records?from=2025-01-01&to=2026-06-01`,
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
      body: JSON.stringify({ stoolType: "normal" }),
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

  it("rejects out-of-enum stoolType and method values (ticket #27)", async () => {
    const createRes = await app.request("/api/v1/cat-care/cats", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${authorizedToken}`,
      },
      body: JSON.stringify({ name: "Enum Validation Cat" }),
    });
    const cat = (await createRes.json()) as CatResponse;

    const badStoolTypeRes = await app.request(`/api/v1/cat-care/cats/${cat.id}/bowel-movements`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${authorizedToken}`,
      },
      body: JSON.stringify({ stoolType: "not-a-real-type" }),
    });
    expect(badStoolTypeRes.status).toBe(400);

    const badMethodRes = await app.request(`/api/v1/cat-care/cats/${cat.id}/weight-records`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${authorizedToken}`,
      },
      body: JSON.stringify({ weightGrams: 4000, method: "not-a-real-method" }),
    });
    expect(badMethodRes.status).toBe(400);
  });

  it("records and lists fluid injections for a cat, with date-range filtering (ticket #02)", async () => {
    const createRes = await app.request("/api/v1/cat-care/cats", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${authorizedToken}`,
      },
      body: JSON.stringify({ name: "Fluid Injection Test Cat" }),
    });
    const cat = (await createRes.json()) as CatResponse;

    const oldDate = "2020-01-01T00:00:00.000Z";
    // 同上一組 bowel/weight 測試的理由:非 00:00 且跟 `to=2026-06-01` 同一天,驗證 `to` 篩選
    // 涵蓋當天結束而非當天 00:00。
    const recentDate = "2026-06-01T15:30:00.000Z";

    await app.request(`/api/v1/cat-care/cats/${cat.id}/fluid-injections`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${authorizedToken}`,
      },
      body: JSON.stringify({
        injectedAt: oldDate,
        site: "left",
        volumeMl: 80,
        fluidType: "normalSaline",
      }),
    });
    const recentRes = await app.request(`/api/v1/cat-care/cats/${cat.id}/fluid-injections`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${authorizedToken}`,
      },
      body: JSON.stringify({
        injectedAt: recentDate,
        site: "nape",
        volumeMl: 100,
        fluidType: "lactatedRingers",
      }),
    });
    expect(recentRes.status).toBe(201);
    const recentRecord = (await recentRes.json()) as { volumeMl: number; site: string };
    expect(recentRecord.volumeMl).toBe(100);
    expect(recentRecord.site).toBe("nape");

    const listRes = await app.request(
      `/api/v1/cat-care/cats/${cat.id}/fluid-injections?from=2025-01-01&to=2026-06-01`,
      { headers: { authorization: `Bearer ${authorizedToken}` } },
    );
    expect(listRes.status).toBe(200);
    const records = (await listRes.json()) as Array<{ volumeMl: number }>;
    expect(records.some((r) => r.volumeMl === 100)).toBe(true);
    expect(records.some((r) => r.volumeMl === 80)).toBe(false);
  });

  it("requires siteOther/fluidTypeOther when 'other' is picked, and rejects them otherwise (ticket #02)", async () => {
    const createRes = await app.request("/api/v1/cat-care/cats", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${authorizedToken}`,
      },
      body: JSON.stringify({ name: "Fluid Injection Validation Cat" }),
    });
    const cat = (await createRes.json()) as CatResponse;

    const missingSiteOtherRes = await app.request(`/api/v1/cat-care/cats/${cat.id}/fluid-injections`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${authorizedToken}`,
      },
      body: JSON.stringify({ site: "other", volumeMl: 50, fluidType: "normalSaline" }),
    });
    expect(missingSiteOtherRes.status).toBe(400);

    const strayFluidTypeOtherRes = await app.request(
      `/api/v1/cat-care/cats/${cat.id}/fluid-injections`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${authorizedToken}`,
        },
        body: JSON.stringify({
          site: "left",
          volumeMl: 50,
          fluidType: "normalSaline",
          fluidTypeOther: "shouldn't be here",
        }),
      },
    );
    expect(strayFluidTypeOtherRes.status).toBe(400);

    const okRes = await app.request(`/api/v1/cat-care/cats/${cat.id}/fluid-injections`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${authorizedToken}`,
      },
      body: JSON.stringify({
        site: "other",
        siteOther: "belly",
        volumeMl: 50,
        fluidType: "other",
        fluidTypeOther: "custom mix",
      }),
    });
    expect(okRes.status).toBe(201);
    const record = (await okRes.json()) as { siteOther: string; fluidTypeOther: string };
    expect(record.siteOther).toBe("belly");
    expect(record.fluidTypeOther).toBe("custom mix");

    const badSiteRes = await app.request(`/api/v1/cat-care/cats/${cat.id}/fluid-injections`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${authorizedToken}`,
      },
      body: JSON.stringify({ site: "not-a-real-site", volumeMl: 50, fluidType: "normalSaline" }),
    });
    expect(badSiteRes.status).toBe(400);
  });

  it("lets only the injecting Player edit or hard-delete a fluid injection (ticket #02)", async () => {
    const createRes = await app.request("/api/v1/cat-care/cats", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${authorizedToken}`,
      },
      body: JSON.stringify({ name: "Fluid Injection Edit/Delete Cat" }),
    });
    const cat = (await createRes.json()) as CatResponse;

    const recordRes = await app.request(`/api/v1/cat-care/cats/${cat.id}/fluid-injections`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${authorizedToken}`,
      },
      body: JSON.stringify({ site: "left", volumeMl: 80, fluidType: "normalSaline" }),
    });
    const record = (await recordRes.json()) as { id: string };

    const otherMember = await newCatCarePlayer("fluid-edit-delete-other");
    await app.request(`/api/v1/cat-care/cats/${cat.id}/players`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${authorizedToken}`,
      },
      body: JSON.stringify({ email: otherMember.profile.email }),
    });

    const forbiddenEditRes = await app.request(
      `/api/v1/cat-care/cats/${cat.id}/fluid-injections/${record.id}`,
      {
        method: "PATCH",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${otherMember.accessToken}`,
        },
        body: JSON.stringify({ volumeMl: 999 }),
      },
    );
    expect(forbiddenEditRes.status).toBe(403);

    // 從 left 切到 other 卻沒補 siteOther:合併既有紀錄後仍不合法,回 400
    const invalidSwitchRes = await app.request(
      `/api/v1/cat-care/cats/${cat.id}/fluid-injections/${record.id}`,
      {
        method: "PATCH",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${authorizedToken}`,
        },
        body: JSON.stringify({ site: "other" }),
      },
    );
    expect(invalidSwitchRes.status).toBe(400);

    const editRes = await app.request(
      `/api/v1/cat-care/cats/${cat.id}/fluid-injections/${record.id}`,
      {
        method: "PATCH",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${authorizedToken}`,
        },
        body: JSON.stringify({ site: "other", siteOther: "tail base", volumeMl: 90 }),
      },
    );
    expect(editRes.status).toBe(200);
    const updated = (await editRes.json()) as { site: string; siteOther: string; volumeMl: number };
    expect(updated.site).toBe("other");
    expect(updated.siteOther).toBe("tail base");
    expect(updated.volumeMl).toBe(90);

    // 切回非 other 的部位:後端自動清掉殘留的 siteOther,不需要呼叫端額外傳 null
    const switchBackRes = await app.request(
      `/api/v1/cat-care/cats/${cat.id}/fluid-injections/${record.id}`,
      {
        method: "PATCH",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${authorizedToken}`,
        },
        body: JSON.stringify({ site: "right" }),
      },
    );
    expect(switchBackRes.status).toBe(200);
    const switchedBack = (await switchBackRes.json()) as { site: string; siteOther: string | null };
    expect(switchedBack.site).toBe("right");
    expect(switchedBack.siteOther ?? null).toBeNull();

    const forbiddenDeleteRes = await app.request(
      `/api/v1/cat-care/cats/${cat.id}/fluid-injections/${record.id}`,
      { method: "DELETE", headers: { authorization: `Bearer ${otherMember.accessToken}` } },
    );
    expect(forbiddenDeleteRes.status).toBe(403);

    const deleteRes = await app.request(
      `/api/v1/cat-care/cats/${cat.id}/fluid-injections/${record.id}`,
      { method: "DELETE", headers: { authorization: `Bearer ${authorizedToken}` } },
    );
    expect(deleteRes.status).toBe(204);

    const secondDeleteRes = await app.request(
      `/api/v1/cat-care/cats/${cat.id}/fluid-injections/${record.id}`,
      { method: "DELETE", headers: { authorization: `Bearer ${authorizedToken}` } },
    );
    expect(secondDeleteRes.status).toBe(404);
  });

  it("records and lists bloodwork reports for a cat, always confirmed, with date-range filtering (ticket #18)", async () => {
    const createRes = await app.request("/api/v1/cat-care/cats", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${authorizedToken}`,
      },
      body: JSON.stringify({ name: "Bloodwork Test Cat" }),
    });
    const cat = (await createRes.json()) as CatResponse;

    const oldDate = "2020-01-01T00:00:00.000Z";
    const recentDate = "2026-06-01T15:30:00.000Z";

    await app.request(`/api/v1/cat-care/cats/${cat.id}/bloodwork-records`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${authorizedToken}`,
      },
      body: JSON.stringify({ recordedAt: oldDate, glu: 90 }),
    });

    // 兩張真實報告驗的項目數量不同(票 04):只填一部分欄位也要能成功建立。
    const recentRes = await app.request(`/api/v1/cat-care/cats/${cat.id}/bloodwork-records`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${authorizedToken}`,
      },
      body: JSON.stringify({ recordedAt: recentDate, glu: 105.5, bunCrea: 12.3, wbc: 8.1 }),
    });
    expect(recentRes.status).toBe(201);
    const recentRecord = (await recentRes.json()) as {
      status: string;
      glu: number;
      bunCrea: number;
      wbc: number;
      crea: number | null;
    };
    expect(recentRecord.status).toBe("confirmed");
    expect(recentRecord.glu).toBe(105.5);
    expect(recentRecord.bunCrea).toBe(12.3);
    expect(recentRecord.wbc).toBe(8.1);
    expect(recentRecord.crea ?? null).toBeNull();

    const listRes = await app.request(
      `/api/v1/cat-care/cats/${cat.id}/bloodwork-records?from=2025-01-01&to=2026-06-01`,
      { headers: { authorization: `Bearer ${authorizedToken}` } },
    );
    expect(listRes.status).toBe(200);
    const records = (await listRes.json()) as Array<{ glu: number }>;
    expect(records.some((r) => r.glu === 105.5)).toBe(true);
    expect(records.some((r) => r.glu === 90)).toBe(false);
  });

  it("rejects non-numeric bloodwork values (ticket #18)", async () => {
    const createRes = await app.request("/api/v1/cat-care/cats", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${authorizedToken}`,
      },
      body: JSON.stringify({ name: "Bloodwork Validation Cat" }),
    });
    const cat = (await createRes.json()) as CatResponse;

    const badRes = await app.request(`/api/v1/cat-care/cats/${cat.id}/bloodwork-records`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${authorizedToken}`,
      },
      body: JSON.stringify({ glu: "not-a-number" }),
    });
    expect(badRes.status).toBe(400);
  });

  it("lets only the recording Player edit (incl. clearing a value with null) or hard-delete a bloodwork record (ticket #18)", async () => {
    const createRes = await app.request("/api/v1/cat-care/cats", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${authorizedToken}`,
      },
      body: JSON.stringify({ name: "Bloodwork Edit/Delete Cat" }),
    });
    const cat = (await createRes.json()) as CatResponse;

    const recordRes = await app.request(`/api/v1/cat-care/cats/${cat.id}/bloodwork-records`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${authorizedToken}`,
      },
      body: JSON.stringify({ glu: 90, crea: 1.2 }),
    });
    const record = (await recordRes.json()) as { id: string };

    const otherMember = await newCatCarePlayer("bloodwork-edit-delete-other");
    await app.request(`/api/v1/cat-care/cats/${cat.id}/players`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${authorizedToken}`,
      },
      body: JSON.stringify({ email: otherMember.profile.email }),
    });

    const forbiddenEditRes = await app.request(
      `/api/v1/cat-care/cats/${cat.id}/bloodwork-records/${record.id}`,
      {
        method: "PATCH",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${otherMember.accessToken}`,
        },
        body: JSON.stringify({ glu: 999 }),
      },
    );
    expect(forbiddenEditRes.status).toBe(403);

    const editRes = await app.request(`/api/v1/cat-care/cats/${cat.id}/bloodwork-records/${record.id}`, {
      method: "PATCH",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${authorizedToken}`,
      },
      body: JSON.stringify({ glu: 100, crea: null }),
    });
    expect(editRes.status).toBe(200);
    const updated = (await editRes.json()) as { glu: number; crea: number | null };
    expect(updated.glu).toBe(100);
    expect(updated.crea ?? null).toBeNull();

    const forbiddenDeleteRes = await app.request(
      `/api/v1/cat-care/cats/${cat.id}/bloodwork-records/${record.id}`,
      { method: "DELETE", headers: { authorization: `Bearer ${otherMember.accessToken}` } },
    );
    expect(forbiddenDeleteRes.status).toBe(403);

    const deleteRes = await app.request(
      `/api/v1/cat-care/cats/${cat.id}/bloodwork-records/${record.id}`,
      { method: "DELETE", headers: { authorization: `Bearer ${authorizedToken}` } },
    );
    expect(deleteRes.status).toBe(204);

    const secondDeleteRes = await app.request(
      `/api/v1/cat-care/cats/${cat.id}/bloodwork-records/${record.id}`,
      { method: "DELETE", headers: { authorization: `Bearer ${authorizedToken}` } },
    );
    expect(secondDeleteRes.status).toBe(404);
  });

  describe("bloodwork photo recognition (票 20)", () => {
    interface RecognizeCall {
      jobId: string;
      callbackUrl: string;
      sharedKey: string | null;
      photoBytes: Uint8Array;
    }

    // 用假的 eve 端點取代真正的 apps/eve,讓「parker-api 怎麼發起辨識作業」這件事可以在 CI
    // 重現,不依賴真的 eve/Gemini 跑起來(比照 eve module 的 client.e2e.test.ts)。
    function stubEveFetch(behavior: "accept" | "reject"): RecognizeCall[] {
      const calls: RecognizeCall[] = [];
      vi.stubGlobal(
        "fetch",
        vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
          const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
          if (!url.endsWith("/bloodwork/recognize")) {
            throw new Error(`unexpected fetch to ${url}`);
          }

          const form = init?.body as FormData;
          const photo = form.get("photo") as Blob;
          const headers = init?.headers as Record<string, string> | undefined;
          calls.push({
            jobId: String(form.get("jobId")),
            callbackUrl: String(form.get("callbackUrl")),
            sharedKey: headers?.["x-parker-to-eve-key"] ?? null,
            photoBytes: new Uint8Array(await photo.arrayBuffer()),
          });

          return behavior === "accept"
            ? new Response(JSON.stringify({ ok: true }), { status: 202 })
            : new Response("bad gateway", { status: 502 });
        }),
      );
      return calls;
    }

    async function createCat(name: string): Promise<CatResponse> {
      const res = await app.request("/api/v1/cat-care/cats", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${authorizedToken}` },
        body: JSON.stringify({ name }),
      });
      return res.json() as Promise<CatResponse>;
    }

    function recognizeRequest(catId: string, token: string) {
      const formData = new FormData();
      formData.set("photo", new Blob([new Uint8Array([1, 2, 3])], { type: "image/jpeg" }), "report.jpg");
      return app.request(`/api/v1/cat-care/cats/${catId}/bloodwork-records/recognize`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}` },
        body: formData,
      });
    }

    it("forwards the uploaded photo to eve with the shared key and returns 202 with a job id", async () => {
      const cat = await createCat("Recognize Accept Cat");
      const calls = stubEveFetch("accept");

      const res = await recognizeRequest(cat.id, authorizedToken);
      expect(res.status).toBe(202);
      const body = (await res.json()) as { jobId: string };
      expect(body.jobId).toBeTruthy();

      expect(calls).toHaveLength(1);
      expect(calls[0].jobId).toBe(body.jobId);
      expect(calls[0].sharedKey).toBe(env.PARKER_TO_EVE_KEY);
      expect(calls[0].photoBytes).toEqual(new Uint8Array([1, 2, 3]));
      expect(new URL(calls[0].callbackUrl).pathname).toBe(
        `/api/v1/cat-care/eve-callback/bloodwork-recognition/${body.jobId}`,
      );
    });

    it("returns 502 when eve does not accept the recognition request", async () => {
      const cat = await createCat("Recognize Reject Cat");
      stubEveFetch("reject");

      const res = await recognizeRequest(cat.id, authorizedToken);
      expect(res.status).toBe(502);
    });

    it("404s a recognize request for a cat the caller is not a member of", async () => {
      const cat = await createCat("Recognize Not Member Cat");
      const otherMember = await newCatCarePlayer("recognize-not-member");
      stubEveFetch("accept");

      const res = await recognizeRequest(cat.id, otherMember.accessToken);
      expect(res.status).toBe(404);
    });

    it("rejects an eve callback with a missing or wrong shared key", async () => {
      const missingKeyRes = await app.request(
        "/api/v1/cat-care/eve-callback/bloodwork-recognition/some-job-id",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ status: "failed" }),
        },
      );
      expect(missingKeyRes.status).toBe(401);

      const wrongKeyRes = await app.request(
        "/api/v1/cat-care/eve-callback/bloodwork-recognition/some-job-id",
        {
          method: "POST",
          headers: { "content-type": "application/json", "x-eve-to-parker-key": "wrong-key" },
          body: JSON.stringify({ status: "failed" }),
        },
      );
      expect(wrongKeyRes.status).toBe(401);
    });

    it("404s an eve callback for an unknown job id", async () => {
      const res = await app.request(
        "/api/v1/cat-care/eve-callback/bloodwork-recognition/unknown-job-id",
        {
          method: "POST",
          headers: { "content-type": "application/json", "x-eve-to-parker-key": env.EVE_TO_PARKER_KEY },
          body: JSON.stringify({ status: "failed" }),
        },
      );
      expect(res.status).toBe(404);
    });

    it("writes a draft record on a success callback, and writes nothing on a failed callback", async () => {
      const cat = await createCat("Recognize Callback Cat");

      const successCalls = stubEveFetch("accept");
      const successJobRes = await recognizeRequest(cat.id, authorizedToken);
      const { jobId: successJobId } = (await successJobRes.json()) as { jobId: string };
      const successCallbackPath = new URL(successCalls[0].callbackUrl).pathname;

      const callbackRes = await app.request(successCallbackPath, {
        method: "POST",
        headers: { "content-type": "application/json", "x-eve-to-parker-key": env.EVE_TO_PARKER_KEY },
        body: JSON.stringify({ status: "success", data: { glu: 105.5, wbc: 8.1 } }),
      });
      expect(callbackRes.status).toBe(200);

      // 同一個 job id 只能消費一次(票 20 定案:一次性),第二次 callback 視為未知作業。
      const secondCallbackRes = await app.request(successCallbackPath, {
        method: "POST",
        headers: { "content-type": "application/json", "x-eve-to-parker-key": env.EVE_TO_PARKER_KEY },
        body: JSON.stringify({ status: "success", data: { glu: 999 } }),
      });
      expect(secondCallbackRes.status).toBe(404);

      const listRes = await app.request(`/api/v1/cat-care/cats/${cat.id}/bloodwork-records`, {
        headers: { authorization: `Bearer ${authorizedToken}` },
      });
      const records = (await listRes.json()) as Array<{
        status: string;
        glu: number | null;
        wbc: number | null;
      }>;
      expect(records).toHaveLength(1);
      expect(records[0].status).toBe("draft");
      expect(records[0].glu).toBe(105.5);
      expect(records[0].wbc).toBe(8.1);

      const failedCalls = stubEveFetch("accept");
      await recognizeRequest(cat.id, authorizedToken);
      const failedCallbackPath = new URL(failedCalls[0].callbackUrl).pathname;

      const failedCallbackRes = await app.request(failedCallbackPath, {
        method: "POST",
        headers: { "content-type": "application/json", "x-eve-to-parker-key": env.EVE_TO_PARKER_KEY },
        body: JSON.stringify({ status: "failed" }),
      });
      expect(failedCallbackRes.status).toBe(200);

      const listAfterFailureRes = await app.request(`/api/v1/cat-care/cats/${cat.id}/bloodwork-records`, {
        headers: { authorization: `Bearer ${authorizedToken}` },
      });
      const recordsAfterFailure = (await listAfterFailureRes.json()) as unknown[];
      expect(recordsAfterFailure).toHaveLength(1);
      expect(successJobId).not.toBe(failedCalls[0].jobId);
    });

    it("confirms a draft record via PATCH status, optionally alongside edited field values (票 21)", async () => {
      const cat = await createCat("Confirm Draft Cat");

      const calls = stubEveFetch("accept");
      const recognizeRes = await recognizeRequest(cat.id, authorizedToken);
      const { jobId } = (await recognizeRes.json()) as { jobId: string };
      const callbackPath = new URL(calls[0].callbackUrl).pathname;

      await app.request(callbackPath, {
        method: "POST",
        headers: { "content-type": "application/json", "x-eve-to-parker-key": env.EVE_TO_PARKER_KEY },
        body: JSON.stringify({ status: "success", data: { glu: 90 } }),
      });

      const listRes = await app.request(`/api/v1/cat-care/cats/${cat.id}/bloodwork-records`, {
        headers: { authorization: `Bearer ${authorizedToken}` },
      });
      const [draft] = (await listRes.json()) as Array<{ id: string; status: string; glu: number | null }>;
      expect(draft.status).toBe("draft");
      expect(jobId).toBeTruthy();

      // 使用者在 read-only/edit 兩態表單改了 glu、順便按下確認送出(票 09 定案:同一次 PATCH
      // 可以同時帶欄位修改與 status 轉換,不需要拆成兩次呼叫)。
      const confirmRes = await app.request(`/api/v1/cat-care/cats/${cat.id}/bloodwork-records/${draft.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json", authorization: `Bearer ${authorizedToken}` },
        body: JSON.stringify({ glu: 95, status: "confirmed" }),
      });
      expect(confirmRes.status).toBe(200);
      const confirmed = (await confirmRes.json()) as { status: string; glu: number | null };
      expect(confirmed.status).toBe("confirmed");
      expect(confirmed.glu).toBe(95);
    });
  });
});
