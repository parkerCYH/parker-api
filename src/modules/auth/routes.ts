import { randomBytes } from "node:crypto";
import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { buildGoogleAuthUrl, exchangeGoogleCode } from "./google-oauth.js";
import { loginWithGoogleProfile, refreshSession } from "./service.js";

const STATE_COOKIE = "auth_oauth_state";

const errorResponseSchema = z.object({
  error: z.string(),
});

const playerSchema = z.object({
  id: z.string().uuid(),
  email: z.string().email(),
  name: z.string(),
  avatarUrl: z.string().nullable().optional(),
});

const sessionResponseSchema = z.object({
  accessToken: z.string(),
  refreshToken: z.string(),
  player: playerSchema,
});

const refreshBodySchema = z.object({
  refreshToken: z.string(),
});

const refreshResponseSchema = z.object({
  accessToken: z.string(),
});

export const authRoutes = new OpenAPIHono();

const googleLoginRoute = createRoute({
  method: "get",
  path: "/google",
  tags: ["auth"],
  summary: "Redirect to Google's OAuth consent screen",
  responses: {
    302: { description: "Redirect to Google's OAuth consent screen" },
  },
});

authRoutes.openapi(googleLoginRoute, (c) => {
  const state = randomBytes(16).toString("hex");

  setCookie(c, STATE_COOKIE, state, {
    httpOnly: true,
    sameSite: "Lax",
    maxAge: 300,
    path: "/",
  });

  return c.redirect(buildGoogleAuthUrl(state, process.env.GOOGLE_REDIRECT_URI ?? ""));
});

const googleCallbackRoute = createRoute({
  method: "get",
  path: "/google/callback",
  tags: ["auth"],
  summary: "Google OAuth callback: exchanges the code, finds or creates the Player, issues a session",
  request: {
    query: z.object({
      code: z.string().optional(),
      state: z.string().optional(),
    }),
  },
  responses: {
    200: {
      description: "Login successful",
      content: { "application/json": { schema: sessionResponseSchema } },
    },
    400: {
      description: "Missing or mismatched OAuth state",
      content: { "application/json": { schema: errorResponseSchema } },
    },
  },
});

authRoutes.openapi(googleCallbackRoute, async (c) => {
  const { code, state } = c.req.valid("query");
  const expectedState = getCookie(c, STATE_COOKIE);

  deleteCookie(c, STATE_COOKIE, { path: "/" });

  if (!code || !state || !expectedState || state !== expectedState) {
    return c.json({ error: "invalid_oauth_state" }, 400);
  }

  const profile = await exchangeGoogleCode(code, process.env.GOOGLE_REDIRECT_URI ?? "");
  const session = await loginWithGoogleProfile(profile);

  return c.json(session, 200);
});

const refreshRoute = createRoute({
  method: "post",
  path: "/refresh",
  tags: ["auth"],
  summary: "Exchange a refresh token for a new access token",
  request: {
    body: {
      content: { "application/json": { schema: refreshBodySchema } },
    },
  },
  responses: {
    200: {
      description: "New access token issued",
      content: { "application/json": { schema: refreshResponseSchema } },
    },
    401: {
      description: "Invalid, expired, or revoked refresh token",
      content: { "application/json": { schema: errorResponseSchema } },
    },
  },
});

authRoutes.openapi(refreshRoute, async (c) => {
  const { refreshToken } = c.req.valid("json");

  try {
    const session = await refreshSession(refreshToken);
    return c.json(session, 200);
  } catch {
    return c.json({ error: "invalid_refresh_token" }, 401);
  }
});
