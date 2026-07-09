import { randomBytes } from "node:crypto";
import { Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { buildGoogleAuthUrl, exchangeGoogleCode } from "./google-oauth.js";
import { loginWithGoogleProfile, refreshSession } from "./service.js";

const STATE_COOKIE = "auth_oauth_state";

export const authRoutes = new Hono();

authRoutes.get("/google", (c) => {
  const state = randomBytes(16).toString("hex");

  setCookie(c, STATE_COOKIE, state, {
    httpOnly: true,
    sameSite: "Lax",
    maxAge: 300,
    path: "/",
  });

  return c.redirect(buildGoogleAuthUrl(state));
});

authRoutes.get("/google/callback", async (c) => {
  const code = c.req.query("code");
  const state = c.req.query("state");
  const expectedState = getCookie(c, STATE_COOKIE);

  deleteCookie(c, STATE_COOKIE, { path: "/" });

  if (!code || !state || !expectedState || state !== expectedState) {
    return c.json({ error: "invalid_oauth_state" }, 400);
  }

  const profile = await exchangeGoogleCode(code);
  const session = await loginWithGoogleProfile(profile);

  return c.json(session);
});

authRoutes.post("/refresh", async (c) => {
  const body = await c.req.json<{ refreshToken?: string }>().catch(() => ({}) as { refreshToken?: string });

  if (!body.refreshToken) {
    return c.json({ error: "missing_refresh_token" }, 400);
  }

  try {
    const session = await refreshSession(body.refreshToken);
    return c.json(session);
  } catch {
    return c.json({ error: "invalid_refresh_token" }, 401);
  }
});
