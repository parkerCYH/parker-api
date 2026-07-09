import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import app from "../../app.js";
import { canPlayer, grantAccess } from "./index.js";

const GOOGLE_PROFILE = {
  sub: `google-${randomUUID()}`,
  email: `player-${randomUUID()}@example.com`,
  name: "Test Player",
  picture: "https://example.com/avatar.png",
};

function stubGoogleFetch() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input.toString();

      if (url.startsWith("https://oauth2.googleapis.com/token")) {
        return new Response(JSON.stringify({ access_token: "fake-google-access-token" }), { status: 200 });
      }

      if (url.startsWith("https://www.googleapis.com/oauth2/v3/userinfo")) {
        return new Response(JSON.stringify(GOOGLE_PROFILE), { status: 200 });
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
  refreshToken: string;
  player: { id: string; email: string; name: string; avatarUrl?: string };
}

interface RefreshResponse {
  accessToken: string;
}

async function loginTestPlayer() {
  stubGoogleFetch();

  const startRes = await app.request("/api/v1/auth/google");
  const cookie = startRes.headers.get("set-cookie") ?? "";
  const state = extractState(startRes.headers.get("location") ?? "");

  return app.request(`/api/v1/auth/google/callback?code=fake-code&state=${state}`, {
    headers: { cookie },
  });
}

describe("auth routes", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("redirects to Google with a state cookie", async () => {
    const res = await app.request("/api/v1/auth/google");

    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toContain("accounts.google.com");
    expect(res.headers.get("set-cookie")).toContain("auth_oauth_state=");
  });

  it("logs in via the Google OAuth callback and issues tokens", async () => {
    const res = await loginTestPlayer();

    expect(res.status).toBe(200);
    const body = (await res.json()) as LoginResponse;
    expect(body.accessToken).toEqual(expect.any(String));
    expect(body.refreshToken).toEqual(expect.any(String));
    expect(body.player.email).toBe(GOOGLE_PROFILE.email);
  });

  it("rejects a callback with a mismatched state", async () => {
    stubGoogleFetch();

    const res = await app.request("/api/v1/auth/google/callback?code=fake-code&state=mismatched");

    expect(res.status).toBe(400);
  });

  it("issues a new access token via refresh", async () => {
    const loginRes = await loginTestPlayer();
    const { refreshToken } = (await loginRes.json()) as LoginResponse;

    const res = await app.request("/api/v1/auth/refresh", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ refreshToken }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as RefreshResponse;
    expect(body.accessToken).toEqual(expect.any(String));
  });

  it("rejects refresh with an unknown token", async () => {
    const res = await app.request("/api/v1/auth/refresh", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ refreshToken: "not-a-real-token" }),
    });

    expect(res.status).toBe(401);
  });

  it("canPlayer reflects granted access rules", async () => {
    const loginRes = await loginTestPlayer();
    const { player } = (await loginRes.json()) as LoginResponse;

    expect(await canPlayer(player.id, "catCare.access")).toBe(false);

    await grantAccess(player.id, "catCare.access");

    expect(await canPlayer(player.id, "catCare.access")).toBe(true);
  });
});
