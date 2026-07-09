import { randomUUID } from "node:crypto";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import app from "../../app.js";
import { grantAccess } from "../auth/index.js";
import { listAllCats } from "./index.js";

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

interface LoginResponse {
  accessToken: string;
  player: { id: string };
}

async function loginPlayer(profile: typeof AUTHORIZED_PROFILE) {
  currentProfile = profile;
  stubGoogleFetch();

  const startRes = await app.request("/api/v1/auth/google");
  const cookie = startRes.headers.get("set-cookie") ?? "";
  const state = extractState(startRes.headers.get("location") ?? "");

  const res = await app.request(`/api/v1/auth/google/callback?code=fake-code&state=${state}`, {
    headers: { cookie },
  });

  return (await res.json()) as LoginResponse;
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
    const owner = await loginPlayer(AUTHORIZED_PROFILE);
    await grantAccess(owner.player.id, "catCare.access");
    authorizedToken = owner.accessToken;

    const noAccess = await loginPlayer(UNAUTHORIZED_PROFILE);
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
    const other = await loginPlayer(otherProfile);
    await grantAccess(other.player.id, "catCare.access");

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
});
