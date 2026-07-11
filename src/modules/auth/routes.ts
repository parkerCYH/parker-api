import { randomBytes } from "node:crypto";
import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { resolveAppByReferer } from "./app-domains.js";
import { buildGoogleAuthUrl, exchangeGoogleCode } from "./google-oauth.js";
import { canPlayer, findOrCreatePlayer, grantAccess, issueSession, refreshSession } from "./service.js";

const STATE_COOKIE = "auth_oauth_state";

const errorResponseSchema = z.object({
  error: z.string(),
});

const forbiddenAppResponseSchema = z.object({
  error: z.string(),
  playerId: z.string().uuid(),
});

const refreshBodySchema = z.object({
  refreshToken: z.string(),
});

const refreshResponseSchema = z.object({
  accessToken: z.string(),
});

export const authRoutes = new OpenAPIHono();

interface OAuthStatePayload {
  nonce: string;
  app: string;
  redirectUrl: string;
}

// state 同時扛兩個責任:CSRF nonce(對照 cookie)+ 記住 /google 那一步從 Referer 解析出的
// app/redirectUrl——callback 收到的 Referer 是 accounts.google.com,不是原始前端網域,無法
// 重新查表,所以把 /google 當下查到的結果直接編碼進 state,靠 cookie 比對確保沒被竄改。
function encodeState(payload: OAuthStatePayload): string {
  return Buffer.from(JSON.stringify(payload)).toString("base64url");
}

function decodeState(state: string): OAuthStatePayload | undefined {
  try {
    return JSON.parse(Buffer.from(state, "base64url").toString("utf8")) as OAuthStatePayload;
  } catch {
    return undefined;
  }
}

function redirectWithError(redirectUrl: string, code: string): string {
  const url = new URL(redirectUrl);
  url.searchParams.set("error", code);
  return url.toString();
}

const googleLoginRoute = createRoute({
  method: "get",
  path: "/google",
  tags: ["auth"],
  summary: "Redirect to Google's OAuth consent screen (app resolved from the Referer domain, ADR-0006)",
  responses: {
    302: { description: "Redirect to Google's OAuth consent screen" },
    400: {
      description: "Missing or unrecognized Referer domain",
      content: { "application/json": { schema: errorResponseSchema } },
    },
  },
});

authRoutes.openapi(googleLoginRoute, (c) => {
  const resolved = resolveAppByReferer(c.req.header("referer"));
  if (!resolved) {
    return c.json({ error: "unknown_app_domain" }, 400);
  }

  const state = encodeState({ nonce: randomBytes(16).toString("hex"), ...resolved });

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
  summary:
    "Google OAuth callback: finds/creates the Player, checks <app>.access, redirects back to the app's URL with tokens",
  request: {
    query: z.object({
      code: z.string().optional(),
      state: z.string().optional(),
      error: z.string().optional(),
    }),
  },
  responses: {
    302: {
      description:
        "Redirect back to the app's registered URL — with accessToken/refreshToken on success, or ?error=<code> on cancellation/failure",
    },
    400: {
      description: "Missing or mismatched OAuth state (can't safely redirect anywhere)",
      content: { "application/json": { schema: errorResponseSchema } },
    },
    403: {
      description: "Player lacks <app>.access — no session issued",
      content: { "application/json": { schema: forbiddenAppResponseSchema } },
    },
  },
});

authRoutes.openapi(googleCallbackRoute, async (c) => {
  const { code, state, error } = c.req.valid("query");
  const expectedState = getCookie(c, STATE_COOKIE);

  deleteCookie(c, STATE_COOKIE, { path: "/" });

  // 真正的 CSRF/state 過期情境:不知道該導去哪個 app,只能維持 400 JSON。
  if (!state || !expectedState || state !== expectedState) {
    return c.json({ error: "invalid_oauth_state" }, 400);
  }

  const payload = decodeState(state);
  if (!payload) {
    return c.json({ error: "invalid_oauth_state" }, 400);
  }

  // Google 帶 error 回來(使用者取消)或根本沒給 code,一律當成 access_denied 導回 app——
  // state 已經驗證過,知道該導去哪,不需要停在 parker-api 自己的網域。
  if (error || !code) {
    return c.redirect(redirectWithError(payload.redirectUrl, "access_denied"));
  }

  let profile;
  try {
    profile = await exchangeGoogleCode(code, process.env.GOOGLE_REDIRECT_URI ?? "");
  } catch {
    return c.redirect(redirectWithError(payload.redirectUrl, "google_auth_failed"));
  }

  const player = await findOrCreatePlayer(profile);

  // cat-care 沒有任何管道能發 catCare.access(見 docs/services/auth.md「cat-care 登入即自動
  // 授權」),登入即自動授權——grantAccess 本身 onConflictDoNothing,天生 idempotent,不用先查。
  // 只影響這個 app;其他 app 的 <app>.access 仍要人工授予。
  if (payload.app === "catCare") {
    await grantAccess(player.id, "catCare.access");
  }

  if (!(await canPlayer(player.id, `${payload.app}.access`))) {
    return c.json({ error: "forbidden_app", playerId: player.id }, 403);
  }

  const session = await issueSession(player.id);

  const redirectUrl = new URL(payload.redirectUrl);
  redirectUrl.searchParams.set("accessToken", session.accessToken);
  redirectUrl.searchParams.set("refreshToken", session.refreshToken);

  return c.redirect(redirectUrl.toString());
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
