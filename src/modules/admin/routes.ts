import { randomBytes } from "node:crypto";
import { buildGoogleAuthUrl, exchangeGoogleCode } from "../auth/index.js";
import { listAllCats } from "../cat-care/index.js";
import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import type { Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { verifyAdminAccessToken } from "./jwt.js";
import {
  approveUser,
  applyOrLoginWithGoogleProfile,
  canApproveUsers,
  canUser,
  refreshSession,
} from "./service.js";

const STATE_COOKIE = "admin_oauth_state";

const errorResponseSchema = z.object({
  error: z.string(),
});

type AuthResult = { ok: true; userId: string } | { ok: false; status: 401; error: string };

// 每個要求「既有 User」身分的 route 都過這一關:驗證 Bearer access token。回傳結果而非
// Response,讓每個 handler 自己用當下正確型別的 c.json() 產生回應(同 cat-care 的做法,避免
// zod-openapi 的 typed response 型別檢查衝突)。
async function authenticateAdminCaller(c: Context): Promise<AuthResult> {
  const authHeader = c.req.header("authorization");
  const bearerToken = authHeader?.startsWith("Bearer ") ? authHeader.slice("Bearer ".length) : undefined;

  if (!bearerToken) {
    return { ok: false, status: 401, error: "unauthorized" };
  }

  try {
    const userId = (await verifyAdminAccessToken(bearerToken)).userId;
    return { ok: true, userId };
  } catch {
    return { ok: false, status: 401, error: "unauthorized" };
  }
}

const userSchema = z.object({
  id: z.string().uuid(),
  email: z.string().email(),
  name: z.string(),
  avatarUrl: z.string().nullable().optional(),
});

const pendingResponseSchema = z.object({
  status: z.literal("pending"),
  userId: z.string().uuid(),
});

const approvedResponseSchema = z.object({
  status: z.literal("approved"),
  accessToken: z.string(),
  refreshToken: z.string(),
  user: userSchema,
});

const refreshBodySchema = z.object({
  refreshToken: z.string(),
});

const refreshResponseSchema = z.object({
  accessToken: z.string(),
});

const approveBodySchema = z.object({
  roleName: z.enum(["SuperAdmin", "Viewer"]),
});

export const adminRoutes = new OpenAPIHono();

const loginRoute = createRoute({
  method: "get",
  path: "/login/google",
  tags: ["admin"],
  summary: "Redirect to Google's OAuth consent screen for a User application/login",
  responses: {
    302: { description: "Redirect to Google's OAuth consent screen" },
  },
});

adminRoutes.openapi(loginRoute, (c) => {
  const state = randomBytes(16).toString("hex");

  setCookie(c, STATE_COOKIE, state, {
    httpOnly: true,
    sameSite: "Lax",
    maxAge: 300,
    path: "/",
  });

  return c.redirect(buildGoogleAuthUrl(state, process.env.ADMIN_GOOGLE_REDIRECT_URI ?? ""));
});

const loginCallbackRoute = createRoute({
  method: "get",
  path: "/login/google/callback",
  tags: ["admin"],
  summary: "Google OAuth callback: creates a pending application, or logs in an approved User",
  request: {
    query: z.object({
      code: z.string().optional(),
      state: z.string().optional(),
    }),
  },
  responses: {
    200: {
      description: "Login successful (User already approved)",
      content: { "application/json": { schema: approvedResponseSchema } },
    },
    202: {
      description: "Application received, awaiting approval",
      content: { "application/json": { schema: pendingResponseSchema } },
    },
    400: {
      description: "Missing or mismatched OAuth state",
      content: { "application/json": { schema: errorResponseSchema } },
    },
  },
});

adminRoutes.openapi(loginCallbackRoute, async (c) => {
  const { code, state } = c.req.valid("query");
  const expectedState = getCookie(c, STATE_COOKIE);

  deleteCookie(c, STATE_COOKIE, { path: "/" });

  if (!code || !state || !expectedState || state !== expectedState) {
    return c.json({ error: "invalid_oauth_state" }, 400);
  }

  const profile = await exchangeGoogleCode(code, process.env.ADMIN_GOOGLE_REDIRECT_URI ?? "");
  const result = await applyOrLoginWithGoogleProfile(profile);

  if (result.status === "pending") {
    return c.json(result, 202);
  }

  return c.json(result, 200);
});

const refreshRoute = createRoute({
  method: "post",
  path: "/refresh",
  tags: ["admin"],
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

adminRoutes.openapi(refreshRoute, async (c) => {
  const { refreshToken } = c.req.valid("json");

  try {
    const session = await refreshSession(refreshToken);
    return c.json(session, 200);
  } catch {
    return c.json({ error: "invalid_refresh_token" }, 401);
  }
});

const approveRoute = createRoute({
  method: "post",
  path: "/users/{id}/approve",
  tags: ["admin"],
  summary: "Approve a pending User application and assign a Role (requires admin.users.approve)",
  request: {
    params: z.object({ id: z.string().uuid() }),
    body: {
      content: { "application/json": { schema: approveBodySchema } },
    },
  },
  responses: {
    200: {
      description: "User approved",
      content: { "application/json": { schema: userSchema } },
    },
    401: {
      description: "Missing or invalid caller access token",
      content: { "application/json": { schema: errorResponseSchema } },
    },
    403: {
      description: "Caller lacks admin.users.approve",
      content: { "application/json": { schema: errorResponseSchema } },
    },
    404: {
      description: "Target user not found",
      content: { "application/json": { schema: errorResponseSchema } },
    },
  },
});

adminRoutes.openapi(approveRoute, async (c) => {
  const auth = await authenticateAdminCaller(c);
  if (!auth.ok) return c.json({ error: auth.error }, auth.status);

  if (!(await canApproveUsers(auth.userId))) {
    return c.json({ error: "forbidden" }, 403);
  }

  const { id } = c.req.valid("param");
  const { roleName } = c.req.valid("json");

  try {
    const user = await approveUser(auth.userId, id, roleName);
    return c.json(user, 200);
  } catch (err) {
    if (err instanceof Error && err.message === "user_not_found") {
      return c.json({ error: "user_not_found" }, 404);
    }
    throw err;
  }
});

// Gateway route(ADR-0005):Admin Dashboard 只打 admin 的 API,這裡先做權限檢查,
// 通過後 in-process 呼叫 cat-care 從 index.ts 額外匯出的 listAllCats()——cat-care
// 自己不開任何對外端點給這個用途,也不需要知道 User/RBAC 的存在。
const catCareCatSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  birthdate: z.string().nullable().optional(),
  notes: z.string().nullable().optional(),
  createdAt: z.string(),
});

const catCareCatsRoute = createRoute({
  method: "get",
  path: "/cat-care/cats",
  tags: ["admin"],
  summary: "Gateway: list all cats across every Player (requires admin.catCare.viewAll)",
  responses: {
    200: {
      description: "Cats",
      content: { "application/json": { schema: z.array(catCareCatSchema) } },
    },
    401: {
      description: "Missing or invalid caller access token",
      content: { "application/json": { schema: errorResponseSchema } },
    },
    403: {
      description: "Caller lacks admin.catCare.viewAll",
      content: { "application/json": { schema: errorResponseSchema } },
    },
  },
});

adminRoutes.openapi(catCareCatsRoute, async (c) => {
  const auth = await authenticateAdminCaller(c);
  if (!auth.ok) return c.json({ error: auth.error }, auth.status);

  if (!(await canUser(auth.userId, "admin.catCare.viewAll"))) {
    return c.json({ error: "forbidden" }, 403);
  }

  const cats = await listAllCats();
  return c.json(cats, 200);
});
