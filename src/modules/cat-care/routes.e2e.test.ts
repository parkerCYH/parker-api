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
});
