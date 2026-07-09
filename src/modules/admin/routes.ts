import { randomBytes } from "node:crypto";
import { buildGoogleAuthUrl, exchangeGoogleCode } from "../auth/index.js";
import { listAllCats } from "../cat-care/index.js";
import { addRuleToRole, createRole, deleteRole, listRoles, removeRuleFromRole } from "../rbac/index.js";
import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import type { Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { verifyAdminAccessToken } from "./jwt.js";
import {
  addToWhitelist,
  approveUser,
  applyOrLoginWithGoogleProfile,
  canApproveUsers,
  canManageWhitelist,
  canUser,
  canViewUsers,
  listUsers,
  listWhitelist,
  refreshSession,
  rejectUser,
  removeFromWhitelist,
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

const userStatusSchema = z.enum(["pending", "approved", "rejected"]);

const userSchema = z.object({
  id: z.string().uuid(),
  email: z.string().email(),
  name: z.string(),
  avatarUrl: z.string().nullable().optional(),
  status: userStatusSchema,
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

const roleNameSchema = z.enum(["Owner", "SuperAdmin", "Viewer"]);

const approveBodySchema = z.object({
  roleName: roleNameSchema,
});

const roleSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  createdAt: z.string(),
});

const whitelistEntrySchema = z.object({
  id: z.string().uuid(),
  email: z.string().email(),
  roleId: z.string().uuid(),
  createdBy: z.string().uuid(),
  createdAt: z.string(),
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

// User 列表 / 調整 Role / 拒絕申請(ticket #19):列表用新的 admin.users.view(唯讀,Owner/
// SuperAdmin/Viewer 都有),調整 Role 跟拒絕沿用 admin.users.approve(跟核准是同一種能力)。
const listUsersRoute = createRoute({
  method: "get",
  path: "/users",
  tags: ["admin"],
  summary: "List Users, optionally filtered by status (requires admin.users.view)",
  request: {
    query: z.object({ status: userStatusSchema.optional() }),
  },
  responses: {
    200: {
      description: "Users",
      content: { "application/json": { schema: z.array(userSchema) } },
    },
    401: {
      description: "Missing or invalid caller access token",
      content: { "application/json": { schema: errorResponseSchema } },
    },
    403: {
      description: "Caller lacks admin.users.view",
      content: { "application/json": { schema: errorResponseSchema } },
    },
  },
});

adminRoutes.openapi(listUsersRoute, async (c) => {
  const auth = await authenticateAdminCaller(c);
  if (!auth.ok) return c.json({ error: auth.error }, auth.status);

  if (!(await canViewUsers(auth.userId))) {
    return c.json({ error: "forbidden" }, 403);
  }

  const { status } = c.req.valid("query");
  const users = await listUsers(status);
  return c.json(users, 200);
});

const updateUserRoleRoute = createRoute({
  method: "patch",
  path: "/users/{id}/role",
  tags: ["admin"],
  summary: "Adjust an existing User's Role (requires admin.users.approve)",
  request: {
    params: z.object({ id: z.string().uuid() }),
    body: {
      content: { "application/json": { schema: approveBodySchema } },
    },
  },
  responses: {
    200: {
      description: "Role updated",
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

adminRoutes.openapi(updateUserRoleRoute, async (c) => {
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

const rejectUserRoute = createRoute({
  method: "post",
  path: "/users/{id}/reject",
  tags: ["admin"],
  summary: "Reject a pending User application (requires admin.users.approve)",
  request: {
    params: z.object({ id: z.string().uuid() }),
  },
  responses: {
    200: {
      description: "Rejected",
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

adminRoutes.openapi(rejectUserRoute, async (c) => {
  const auth = await authenticateAdminCaller(c);
  if (!auth.ok) return c.json({ error: auth.error }, auth.status);

  if (!(await canApproveUsers(auth.userId))) {
    return c.json({ error: "forbidden" }, 403);
  }

  const { id } = c.req.valid("param");

  try {
    const user = await rejectUser(id);
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

// Role/Rule 管理(ADR-0007):所有這些 route 都要求 rbac.roles.manage,通過後直接呼叫
// rbac 匯出的管理函式——admin 只做權限檢查這一層,Role/Rule 本身的存取邏輯完全在 rbac。
// 回傳結果而非 Response(同 authenticateAdminCaller 的理由),讓每個 handler 自己用當下
// 正確型別的 c.json() 產生回應,避免 zod-openapi 的 typed response 型別檢查衝突。
type RoleManagerGuard = { ok: true } | { ok: false; status: 401 | 403; error: string };

async function requireRoleManager(c: Context): Promise<RoleManagerGuard> {
  const auth = await authenticateAdminCaller(c);
  if (!auth.ok) {
    return { ok: false, status: auth.status, error: auth.error };
  }

  if (!(await canUser(auth.userId, "rbac.roles.manage"))) {
    return { ok: false, status: 403, error: "forbidden" };
  }

  return { ok: true };
}

const listRolesRoute = createRoute({
  method: "get",
  path: "/roles",
  tags: ["admin"],
  summary: "List all Roles (requires rbac.roles.manage)",
  responses: {
    200: { description: "Roles", content: { "application/json": { schema: z.array(roleSchema) } } },
    401: {
      description: "Missing or invalid caller access token",
      content: { "application/json": { schema: errorResponseSchema } },
    },
    403: {
      description: "Caller lacks rbac.roles.manage",
      content: { "application/json": { schema: errorResponseSchema } },
    },
  },
});

adminRoutes.openapi(listRolesRoute, async (c) => {
  const guard = await requireRoleManager(c);
  if (!guard.ok) return c.json({ error: guard.error }, guard.status);

  const roles = await listRoles();
  return c.json(roles, 200);
});

const createRoleRoute = createRoute({
  method: "post",
  path: "/roles",
  tags: ["admin"],
  summary: "Create a Role (requires rbac.roles.manage)",
  request: {
    body: {
      content: { "application/json": { schema: z.object({ name: z.string().min(1) }) } },
    },
  },
  responses: {
    201: { description: "Role created", content: { "application/json": { schema: roleSchema } } },
    401: {
      description: "Missing or invalid caller access token",
      content: { "application/json": { schema: errorResponseSchema } },
    },
    403: {
      description: "Caller lacks rbac.roles.manage",
      content: { "application/json": { schema: errorResponseSchema } },
    },
  },
});

adminRoutes.openapi(createRoleRoute, async (c) => {
  const guard = await requireRoleManager(c);
  if (!guard.ok) return c.json({ error: guard.error }, guard.status);

  const { name } = c.req.valid("json");
  const role = await createRole(name);
  return c.json(role, 201);
});

const deleteRoleRoute = createRoute({
  method: "delete",
  path: "/roles/{roleId}",
  tags: ["admin"],
  summary: "Delete a Role (requires rbac.roles.manage)",
  request: { params: z.object({ roleId: z.string().uuid() }) },
  responses: {
    204: { description: "Role deleted" },
    401: {
      description: "Missing or invalid caller access token",
      content: { "application/json": { schema: errorResponseSchema } },
    },
    403: {
      description: "Caller lacks rbac.roles.manage",
      content: { "application/json": { schema: errorResponseSchema } },
    },
  },
});

adminRoutes.openapi(deleteRoleRoute, async (c) => {
  const guard = await requireRoleManager(c);
  if (!guard.ok) return c.json({ error: guard.error }, guard.status);

  const { roleId } = c.req.valid("param");
  await deleteRole(roleId);
  return c.body(null, 204);
});

const addRuleRoute = createRoute({
  method: "post",
  path: "/roles/{roleId}/rules",
  tags: ["admin"],
  summary: "Add a rule to a Role (requires rbac.roles.manage)",
  request: {
    params: z.object({ roleId: z.string().uuid() }),
    body: {
      content: { "application/json": { schema: z.object({ rule: z.string().min(1) }) } },
    },
  },
  responses: {
    204: { description: "Rule added" },
    401: {
      description: "Missing or invalid caller access token",
      content: { "application/json": { schema: errorResponseSchema } },
    },
    403: {
      description: "Caller lacks rbac.roles.manage",
      content: { "application/json": { schema: errorResponseSchema } },
    },
  },
});

adminRoutes.openapi(addRuleRoute, async (c) => {
  const guard = await requireRoleManager(c);
  if (!guard.ok) return c.json({ error: guard.error }, guard.status);

  const { roleId } = c.req.valid("param");
  const { rule } = c.req.valid("json");
  await addRuleToRole(roleId, rule);
  return c.body(null, 204);
});

const removeRuleRoute = createRoute({
  method: "delete",
  path: "/roles/{roleId}/rules/{rule}",
  tags: ["admin"],
  summary: "Remove a rule from a Role (requires rbac.roles.manage)",
  request: {
    params: z.object({ roleId: z.string().uuid(), rule: z.string() }),
  },
  responses: {
    204: { description: "Rule removed" },
    401: {
      description: "Missing or invalid caller access token",
      content: { "application/json": { schema: errorResponseSchema } },
    },
    403: {
      description: "Caller lacks rbac.roles.manage",
      content: { "application/json": { schema: errorResponseSchema } },
    },
  },
});

adminRoutes.openapi(removeRuleRoute, async (c) => {
  const guard = await requireRoleManager(c);
  if (!guard.ok) return c.json({ error: guard.error }, guard.status);

  const { roleId, rule } = c.req.valid("param");
  await removeRuleFromRole(roleId, rule);
  return c.body(null, 204);
});

// 邀請白名單(ADR-0001 的 Whitelist 段落):只有握有 admin.whitelist.manage 的人(即 Owner)
// 能管理,命中白名單的 email 登入時直接核准,見 service.ts 的 applyOrLoginWithGoogleProfile。
type WhitelistGuard =
  | { ok: true; userId: string }
  | { ok: false; status: 401 | 403; error: string };

async function requireWhitelistManager(c: Context): Promise<WhitelistGuard> {
  const auth = await authenticateAdminCaller(c);
  if (!auth.ok) {
    return { ok: false, status: auth.status, error: auth.error };
  }

  if (!(await canManageWhitelist(auth.userId))) {
    return { ok: false, status: 403, error: "forbidden" };
  }

  return { ok: true, userId: auth.userId };
}

const listWhitelistRoute = createRoute({
  method: "get",
  path: "/whitelist",
  tags: ["admin"],
  summary: "List invite whitelist entries (requires admin.whitelist.manage)",
  responses: {
    200: {
      description: "Whitelist entries",
      content: { "application/json": { schema: z.array(whitelistEntrySchema) } },
    },
    401: {
      description: "Missing or invalid caller access token",
      content: { "application/json": { schema: errorResponseSchema } },
    },
    403: {
      description: "Caller lacks admin.whitelist.manage",
      content: { "application/json": { schema: errorResponseSchema } },
    },
  },
});

adminRoutes.openapi(listWhitelistRoute, async (c) => {
  const guard = await requireWhitelistManager(c);
  if (!guard.ok) return c.json({ error: guard.error }, guard.status);

  const entries = await listWhitelist();
  return c.json(entries, 200);
});

const addToWhitelistRoute = createRoute({
  method: "post",
  path: "/whitelist",
  tags: ["admin"],
  summary: "Add (or update) an invite whitelist entry (requires admin.whitelist.manage)",
  request: {
    body: {
      content: {
        "application/json": {
          schema: z.object({ email: z.string().email(), roleName: roleNameSchema }),
        },
      },
    },
  },
  responses: {
    201: {
      description: "Whitelist entry created or updated",
      content: { "application/json": { schema: whitelistEntrySchema } },
    },
    401: {
      description: "Missing or invalid caller access token",
      content: { "application/json": { schema: errorResponseSchema } },
    },
    403: {
      description: "Caller lacks admin.whitelist.manage",
      content: { "application/json": { schema: errorResponseSchema } },
    },
  },
});

adminRoutes.openapi(addToWhitelistRoute, async (c) => {
  const guard = await requireWhitelistManager(c);
  if (!guard.ok) return c.json({ error: guard.error }, guard.status);

  const { email, roleName } = c.req.valid("json");
  const entry = await addToWhitelist(guard.userId, email, roleName);
  return c.json(entry, 201);
});

const removeFromWhitelistRoute = createRoute({
  method: "delete",
  path: "/whitelist/{email}",
  tags: ["admin"],
  summary: "Remove an invite whitelist entry (requires admin.whitelist.manage)",
  request: { params: z.object({ email: z.string().email() }) },
  responses: {
    204: { description: "Whitelist entry removed" },
    401: {
      description: "Missing or invalid caller access token",
      content: { "application/json": { schema: errorResponseSchema } },
    },
    403: {
      description: "Caller lacks admin.whitelist.manage",
      content: { "application/json": { schema: errorResponseSchema } },
    },
  },
});

adminRoutes.openapi(removeFromWhitelistRoute, async (c) => {
  const guard = await requireWhitelistManager(c);
  if (!guard.ok) return c.json({ error: guard.error }, guard.status);

  const { email } = c.req.valid("param");
  await removeFromWhitelist(email);
  return c.body(null, 204);
});
