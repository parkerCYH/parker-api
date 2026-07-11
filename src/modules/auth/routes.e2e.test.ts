import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import app from "../../app.js";
import { canPlayer, grantAccess } from "./index.js";

const APP_REFERER = "http://test.cat-care.local/login";
const APP_REDIRECT_URL = "http://test.cat-care.local/login/callback";
// otherApp 不是 cat-care,<app>.access 仍要人工授予(ticket #28 只改 catCare 這一條分支)——
// 用來測試「manual grant 仍然運作」的迴歸保護,cat-care 自己已經不會走到 forbidden_app 了。
const OTHER_APP_REFERER = "http://test.other-app.local/login";
const OTHER_APP_REDIRECT_URL = "http://test.other-app.local/login/callback";

let currentProfile = makeGoogleProfile();

function makeGoogleProfile() {
  return {
    sub: `google-${randomUUID()}`,
    email: `player-${randomUUID()}@example.com`,
    name: "Test Player",
    picture: "https://example.com/avatar.png",
  };
}

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

interface ForbiddenResponse {
  error: string;
  playerId: string;
}

async function startLogin(referer: string = APP_REFERER) {
  const startRes = await app.request("/api/v1/auth/google", { headers: { referer } });
  const cookie = startRes.headers.get("set-cookie") ?? "";
  const state = extractState(startRes.headers.get("location") ?? "");
  return { cookie, state };
}

async function attemptLogin(referer: string | undefined = APP_REFERER) {
  stubGoogleFetch();

  const startRes = await app.request("/api/v1/auth/google", {
    headers: referer !== undefined ? { referer } : {},
  });

  if (startRes.status !== 302) {
    return startRes;
  }

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

  it("redirects to Google with a state cookie when the Referer resolves to a known app", async () => {
    const res = await app.request("/api/v1/auth/google", { headers: { referer: APP_REFERER } });

    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toContain("accounts.google.com");
    expect(res.headers.get("set-cookie")).toContain("auth_oauth_state=");
  });

  it("rejects login with no Referer", async () => {
    const res = await app.request("/api/v1/auth/google");
    expect(res.status).toBe(400);
  });

  it("rejects login with a Referer host that isn't in the domain table", async () => {
    const res = await app.request("/api/v1/auth/google", {
      headers: { referer: "http://unknown-app.example.com/login" },
    });
    expect(res.status).toBe(400);
  });

  it("denies the callback and returns playerId when the Player lacks <app>.access (otherApp, unaffected by ticket #28)", async () => {
    currentProfile = makeGoogleProfile();
    const res = await attemptLogin(OTHER_APP_REFERER);

    expect(res.status).toBe(403);
    const body = (await res.json()) as ForbiddenResponse;
    expect(body.error).toBe("forbidden_app");
    expect(body.playerId).toEqual(expect.any(String));
  });

  it("redirects back to the app's redirectUrl with tokens once <app>.access is granted (otherApp)", async () => {
    currentProfile = makeGoogleProfile();

    const firstAttempt = await attemptLogin(OTHER_APP_REFERER);
    const { playerId } = (await firstAttempt.json()) as ForbiddenResponse;
    await grantAccess(playerId, "otherApp.access");

    const res = await attemptLogin(OTHER_APP_REFERER);

    expect(res.status).toBe(302);
    const location = res.headers.get("location") ?? "";
    expect(location.startsWith(OTHER_APP_REDIRECT_URL)).toBe(true);
    const redirectParams = new URL(location).searchParams;
    expect(redirectParams.get("accessToken")).toEqual(expect.any(String));
    expect(redirectParams.get("refreshToken")).toEqual(expect.any(String));
  });

  it("auto-grants catCare.access on first cat-care login, no forbidden_app (ticket #28)", async () => {
    currentProfile = makeGoogleProfile();

    const res = await attemptLogin();

    expect(res.status).toBe(302);
    const location = res.headers.get("location") ?? "";
    expect(location.startsWith(APP_REDIRECT_URL)).toBe(true);
    const redirectParams = new URL(location).searchParams;
    expect(redirectParams.get("accessToken")).toEqual(expect.any(String));
    expect(redirectParams.get("refreshToken")).toEqual(expect.any(String));
  });

  it("rejects a callback with a mismatched state", async () => {
    stubGoogleFetch();

    const startRes = await app.request("/api/v1/auth/google", { headers: { referer: APP_REFERER } });
    const cookie = startRes.headers.get("set-cookie") ?? "";

    const res = await app.request("/api/v1/auth/google/callback?code=fake-code&state=mismatched", {
      headers: { cookie },
    });

    expect(res.status).toBe(400);
  });

  it("redirects back to the app with ?error=access_denied when the user cancels consent (ticket #26)", async () => {
    stubGoogleFetch();
    const { cookie, state } = await startLogin();

    const res = await app.request(`/api/v1/auth/google/callback?error=access_denied&state=${state}`, {
      headers: { cookie },
    });

    expect(res.status).toBe(302);
    const location = res.headers.get("location") ?? "";
    expect(location.startsWith(APP_REDIRECT_URL)).toBe(true);
    const params = new URL(location).searchParams;
    expect(params.get("error")).toBe("access_denied");
    expect(params.get("accessToken")).toBeNull();
  });

  it("redirects back with ?error=access_denied when Google omits both code and error (ticket #26)", async () => {
    stubGoogleFetch();
    const { cookie, state } = await startLogin();

    const res = await app.request(`/api/v1/auth/google/callback?state=${state}`, { headers: { cookie } });

    expect(res.status).toBe(302);
    const params = new URL(res.headers.get("location") ?? "").searchParams;
    expect(params.get("error")).toBe("access_denied");
  });

  it("redirects back with ?error=google_auth_failed when token exchange fails (ticket #26)", async () => {
    const { cookie, state } = await startLogin();

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("boom", { status: 500 })),
    );

    const res = await app.request(`/api/v1/auth/google/callback?code=fake-code&state=${state}`, {
      headers: { cookie },
    });

    expect(res.status).toBe(302);
    const location = res.headers.get("location") ?? "";
    expect(location.startsWith(APP_REDIRECT_URL)).toBe(true);
    const params = new URL(location).searchParams;
    expect(params.get("error")).toBe("google_auth_failed");
  });

  it("issues a new access token via refresh", async () => {
    currentProfile = makeGoogleProfile();

    // cat-care 登入即自動授權(ticket #28),不用先手動 grant 就能拿到 token。
    const loginRes = await attemptLogin();
    const location = loginRes.headers.get("location") ?? "";
    const refreshToken = new URL(location).searchParams.get("refreshToken") ?? "";

    const res = await app.request("/api/v1/auth/refresh", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ refreshToken }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { accessToken: string };
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

  it("canPlayer reflects granted access rules (otherApp, unaffected by ticket #28's auto-grant)", async () => {
    currentProfile = makeGoogleProfile();

    const firstAttempt = await attemptLogin(OTHER_APP_REFERER);
    const { playerId } = (await firstAttempt.json()) as ForbiddenResponse;

    expect(await canPlayer(playerId, "otherApp.access")).toBe(false);

    await grantAccess(playerId, "otherApp.access");

    expect(await canPlayer(playerId, "otherApp.access")).toBe(true);
  });
});
