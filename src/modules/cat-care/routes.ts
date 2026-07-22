import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import type { Context } from "hono";
import { canPlayer, verifyPlayerAccessToken } from "../auth/index.js";
import * as service from "./service.js";

type AuthResult =
  | { ok: true; playerId: string }
  | { ok: false; status: 401 | 403; error: string };

const errorResponseSchema = z.object({
  error: z.string(),
});

const catSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  birthdate: z.string().nullable().optional(),
  notes: z.string().nullable().optional(),
  archivedAt: z.string().nullable().optional(),
  chipPlayerId: z.string().uuid().nullable().optional(),
  createdAt: z.string(),
});

// DB 欄位維持 text,只在 API 層驗證(ticket #27,比照 admin module 的
// userStatusSchema/roleNameSchema 做法),不建 Postgres enum type、不加 CHECK constraint。
const stoolTypeSchema = z.enum(["normal", "hard", "soft", "watery", "bloody", "mucous"]);
const methodSchema = z.enum(["catScale", "holdAndSubtract", "other"]);

const bowelMovementSchema = z.object({
  id: z.string().uuid(),
  catId: z.string().uuid(),
  recordedBy: z.string().uuid(),
  recordedAt: z.string(),
  stoolType: stoolTypeSchema.nullable().optional(),
  isAbnormal: z.boolean(),
  notes: z.string().nullable().optional(),
  createdAt: z.string(),
});

const weightRecordSchema = z.object({
  id: z.string().uuid(),
  catId: z.string().uuid(),
  measuredBy: z.string().uuid(),
  measuredAt: z.string(),
  weightGrams: z.number(),
  method: methodSchema.nullable().optional(),
  notes: z.string().nullable().optional(),
  createdAt: z.string(),
});

// 比照 stoolType/method,英文 key 用完整單字而非縮寫(票 01 定案)。
const fluidSiteSchema = z.enum(["left", "right", "nape", "other"]);
const fluidTypeSchema = z.enum(["normalSaline", "lactatedRingers", "other"]);

const fluidInjectionSchema = z.object({
  id: z.string().uuid(),
  catId: z.string().uuid(),
  injectedBy: z.string().uuid(),
  injectedAt: z.string(),
  site: fluidSiteSchema,
  siteOther: z.string().nullable().optional(),
  volumeMl: z.number(),
  fluidType: fluidTypeSchema,
  fluidTypeOther: z.string().nullable().optional(),
  notes: z.string().nullable().optional(),
  createdAt: z.string(),
});

// site='other'/fluidType='other' 時對應的自由文字欄位必填,非 other 時帶值直接拒絕(票 01 定案)。
const createFluidInjectionBodySchema = z
  .object({
    injectedAt: z.string().datetime().optional(),
    site: fluidSiteSchema,
    siteOther: z.string().min(1).optional(),
    volumeMl: z.number().int().positive(),
    fluidType: fluidTypeSchema,
    fluidTypeOther: z.string().min(1).optional(),
    notes: z.string().optional(),
  })
  .refine((body) => body.site === "other" || body.siteOther === undefined, {
    message: "siteOther must not be set unless site is 'other'",
    path: ["siteOther"],
  })
  .refine((body) => body.site !== "other" || Boolean(body.siteOther), {
    message: "siteOther is required when site is 'other'",
    path: ["siteOther"],
  })
  .refine((body) => body.fluidType === "other" || body.fluidTypeOther === undefined, {
    message: "fluidTypeOther must not be set unless fluidType is 'other'",
    path: ["fluidTypeOther"],
  })
  .refine((body) => body.fluidType !== "other" || Boolean(body.fluidTypeOther), {
    message: "fluidTypeOther is required when fluidType is 'other'",
    path: ["fluidTypeOther"],
  });

// PATCH 是部分更新,site/fluidType 的 other 一致性要合併既有紀錄才能判斷,交給 service 層驗證
// (見 service.ts 的 resolveOtherField),這裡只驗證各欄位本身的型別/格式。
const updateFluidInjectionBodySchema = z.object({
  injectedAt: z.string().datetime().optional(),
  site: fluidSiteSchema.optional(),
  siteOther: z.string().min(1).optional(),
  volumeMl: z.number().int().positive().optional(),
  fluidType: fluidTypeSchema.optional(),
  fluidTypeOther: z.string().min(1).optional(),
  notes: z.string().optional(),
});

const invitedPlayerSchema = z.object({
  id: z.string().uuid(),
  email: z.string().email(),
  name: z.string(),
});

const catIdParamSchema = z.object({ catId: z.string().uuid() });
const catRecordParamSchema = z.object({ catId: z.string().uuid(), id: z.string().uuid() });
const historyQuerySchema = z.object({
  from: z.string().date().optional(),
  to: z.string().date().optional(),
});

// PATCH /cats/{catId}(票 07,定案見票 06 Answer #3):birthdate 改用嚴格日期格式驗證,
// 並禁止未來日期。POST /cats 是否同步補強留給後續票處理,不在本票範圍。
const nonFutureDateSchema = z.string().date().refine(
  (value) => value <= new Date().toISOString().slice(0, 10),
  { message: "birthdate must not be in the future" },
);

const updateCatBodySchema = z.object({
  name: z.string().min(1).optional(),
  birthdate: nonFutureDateSchema.optional(),
  notes: z.string().optional(),
});

// 每個 Player route 進入點都要過這一關(ticket #13):驗證 Bearer access token,
// 再用 auth 的 canPlayer 檢查 catCare.access。回傳結果而非 Response——讓每個 handler
// 自己用當下正確型別的 c.json() 產生回應,避免 zod-openapi 的 typed response 型別檢查衝突。
async function authenticatePlayer(c: Context): Promise<AuthResult> {
  const authHeader = c.req.header("authorization");
  const token = authHeader?.startsWith("Bearer ") ? authHeader.slice("Bearer ".length) : undefined;

  if (!token) {
    return { ok: false, status: 401, error: "unauthorized" };
  }

  let playerId: string;
  try {
    playerId = (await verifyPlayerAccessToken(token)).playerId;
  } catch {
    return { ok: false, status: 401, error: "unauthorized" };
  }

  if (!(await canPlayer(playerId, "catCare.access"))) {
    return { ok: false, status: 403, error: "forbidden" };
  }

  return { ok: true, playerId };
}

export const catCareRoutes = new OpenAPIHono();

const createCatRoute = createRoute({
  method: "post",
  path: "/cats",
  tags: ["cat-care"],
  summary: "Create a cat (caller Player becomes its first member)",
  request: {
    body: {
      content: {
        "application/json": {
          schema: z.object({
            name: z.string().min(1),
            birthdate: z.string().optional(),
            notes: z.string().optional(),
          }),
        },
      },
    },
  },
  responses: {
    201: { description: "Cat created", content: { "application/json": { schema: catSchema } } },
    401: {
      description: "Missing or invalid access token",
      content: { "application/json": { schema: errorResponseSchema } },
    },
    403: {
      description: "Player lacks catCare.access",
      content: { "application/json": { schema: errorResponseSchema } },
    },
  },
});

catCareRoutes.openapi(createCatRoute, async (c) => {
  const auth = await authenticatePlayer(c);
  if (!auth.ok) return c.json({ error: auth.error }, auth.status);

  const body = c.req.valid("json");
  const cat = await service.createCat(auth.playerId, body);
  return c.json(cat, 201);
});

const listCatsRoute = createRoute({
  method: "get",
  path: "/cats",
  tags: ["cat-care"],
  summary: "List cats the caller Player belongs to",
  responses: {
    200: { description: "Cats", content: { "application/json": { schema: z.array(catSchema) } } },
    401: {
      description: "Missing or invalid access token",
      content: { "application/json": { schema: errorResponseSchema } },
    },
    403: {
      description: "Player lacks catCare.access",
      content: { "application/json": { schema: errorResponseSchema } },
    },
  },
});

catCareRoutes.openapi(listCatsRoute, async (c) => {
  const auth = await authenticatePlayer(c);
  if (!auth.ok) return c.json({ error: auth.error }, auth.status);

  const cats = await service.listCatsForPlayer(auth.playerId);
  return c.json(cats, 200);
});

const getCatRoute = createRoute({
  method: "get",
  path: "/cats/{catId}",
  tags: ["cat-care"],
  summary: "Get a single cat (caller must be a member)",
  request: { params: catIdParamSchema },
  responses: {
    200: { description: "Cat", content: { "application/json": { schema: catSchema } } },
    401: {
      description: "Missing or invalid access token",
      content: { "application/json": { schema: errorResponseSchema } },
    },
    403: {
      description: "Player lacks catCare.access",
      content: { "application/json": { schema: errorResponseSchema } },
    },
    404: {
      description: "Cat not found or caller is not a member",
      content: { "application/json": { schema: errorResponseSchema } },
    },
  },
});

catCareRoutes.openapi(getCatRoute, async (c) => {
  const auth = await authenticatePlayer(c);
  if (!auth.ok) return c.json({ error: auth.error }, auth.status);

  const { catId } = c.req.valid("param");
  const cat = await service.getCatForPlayer(catId, auth.playerId);
  if (!cat) {
    return c.json({ error: "not_found" }, 404);
  }

  return c.json(cat, 200);
});

const updateCatRoute = createRoute({
  method: "patch",
  path: "/cats/{catId}",
  tags: ["cat-care"],
  summary: "Update a cat's basic profile (name/birthdate/notes; caller must be a member)",
  request: {
    params: catIdParamSchema,
    body: { content: { "application/json": { schema: updateCatBodySchema } } },
  },
  responses: {
    200: { description: "Updated", content: { "application/json": { schema: catSchema } } },
    401: {
      description: "Missing or invalid access token",
      content: { "application/json": { schema: errorResponseSchema } },
    },
    403: {
      description: "Player lacks catCare.access",
      content: { "application/json": { schema: errorResponseSchema } },
    },
    404: {
      description: "Cat not found or caller is not a member",
      content: { "application/json": { schema: errorResponseSchema } },
    },
  },
});

catCareRoutes.openapi(updateCatRoute, async (c) => {
  const auth = await authenticatePlayer(c);
  if (!auth.ok) return c.json({ error: auth.error }, auth.status);

  const { catId } = c.req.valid("param");
  if (!(await service.isCatMember(catId, auth.playerId))) {
    return c.json({ error: "not_found" }, 404);
  }

  const body = c.req.valid("json");
  const cat = await service.updateCat(catId, body);
  return c.json(cat, 200);
});

const archiveCatRoute = createRoute({
  method: "delete",
  path: "/cats/{catId}",
  tags: ["cat-care"],
  summary: "Archive a cat (soft delete; caller must be a member)",
  request: { params: catIdParamSchema },
  responses: {
    200: { description: "Archived", content: { "application/json": { schema: catSchema } } },
    401: {
      description: "Missing or invalid access token",
      content: { "application/json": { schema: errorResponseSchema } },
    },
    403: {
      description: "Player lacks catCare.access",
      content: { "application/json": { schema: errorResponseSchema } },
    },
    404: {
      description: "Cat not found or caller is not a member",
      content: { "application/json": { schema: errorResponseSchema } },
    },
  },
});

catCareRoutes.openapi(archiveCatRoute, async (c) => {
  const auth = await authenticatePlayer(c);
  if (!auth.ok) return c.json({ error: auth.error }, auth.status);

  const { catId } = c.req.valid("param");
  if (!(await service.isCatMember(catId, auth.playerId))) {
    return c.json({ error: "not_found" }, 404);
  }

  const cat = await service.archiveCat(catId);
  return c.json(cat, 200);
});

const createBowelMovementRoute = createRoute({
  method: "post",
  path: "/cats/{catId}/bowel-movements",
  tags: ["cat-care"],
  summary: "Record a bowel movement for a cat",
  request: {
    params: catIdParamSchema,
    body: {
      content: {
        "application/json": {
          schema: z.object({
            recordedAt: z.string().datetime().optional(),
            stoolType: stoolTypeSchema.optional(),
            isAbnormal: z.boolean().optional(),
            notes: z.string().optional(),
          }),
        },
      },
    },
  },
  responses: {
    201: { description: "Recorded", content: { "application/json": { schema: bowelMovementSchema } } },
    401: {
      description: "Missing or invalid access token",
      content: { "application/json": { schema: errorResponseSchema } },
    },
    403: {
      description: "Player lacks catCare.access",
      content: { "application/json": { schema: errorResponseSchema } },
    },
    404: {
      description: "Cat not found or caller is not a member",
      content: { "application/json": { schema: errorResponseSchema } },
    },
  },
});

catCareRoutes.openapi(createBowelMovementRoute, async (c) => {
  const auth = await authenticatePlayer(c);
  if (!auth.ok) return c.json({ error: auth.error }, auth.status);

  const { catId } = c.req.valid("param");
  if (!(await service.isCatMember(catId, auth.playerId))) {
    return c.json({ error: "not_found" }, 404);
  }

  const body = c.req.valid("json");
  const record = await service.recordBowelMovement(catId, auth.playerId, body);
  return c.json(record, 201);
});

const listBowelMovementsRoute = createRoute({
  method: "get",
  path: "/cats/{catId}/bowel-movements",
  tags: ["cat-care"],
  summary: "List bowel movement history for a cat (optionally filtered by ?from=&to= date range)",
  request: { params: catIdParamSchema, query: historyQuerySchema },
  responses: {
    200: {
      description: "History",
      content: { "application/json": { schema: z.array(bowelMovementSchema) } },
    },
    401: {
      description: "Missing or invalid access token",
      content: { "application/json": { schema: errorResponseSchema } },
    },
    403: {
      description: "Player lacks catCare.access",
      content: { "application/json": { schema: errorResponseSchema } },
    },
    404: {
      description: "Cat not found or caller is not a member",
      content: { "application/json": { schema: errorResponseSchema } },
    },
  },
});

catCareRoutes.openapi(listBowelMovementsRoute, async (c) => {
  const auth = await authenticatePlayer(c);
  if (!auth.ok) return c.json({ error: auth.error }, auth.status);

  const { catId } = c.req.valid("param");
  if (!(await service.isCatMember(catId, auth.playerId))) {
    return c.json({ error: "not_found" }, 404);
  }

  const { from, to } = c.req.valid("query");
  const records = await service.listBowelMovements(catId, { from, to });
  return c.json(records, 200);
});

const updateBowelMovementRoute = createRoute({
  method: "patch",
  path: "/cats/{catId}/bowel-movements/{id}",
  tags: ["cat-care"],
  summary: "Edit a bowel movement record (only the recording Player may edit)",
  request: {
    params: catRecordParamSchema,
    body: {
      content: {
        "application/json": {
          schema: z.object({
            recordedAt: z.string().datetime().optional(),
            stoolType: stoolTypeSchema.optional(),
            isAbnormal: z.boolean().optional(),
            notes: z.string().optional(),
          }),
        },
      },
    },
  },
  responses: {
    200: { description: "Updated", content: { "application/json": { schema: bowelMovementSchema } } },
    401: {
      description: "Missing or invalid access token",
      content: { "application/json": { schema: errorResponseSchema } },
    },
    403: {
      description: "Player lacks catCare.access, or is not the original recorder",
      content: { "application/json": { schema: errorResponseSchema } },
    },
    404: {
      description: "Record not found for this cat",
      content: { "application/json": { schema: errorResponseSchema } },
    },
  },
});

catCareRoutes.openapi(updateBowelMovementRoute, async (c) => {
  const auth = await authenticatePlayer(c);
  if (!auth.ok) return c.json({ error: auth.error }, auth.status);

  const { catId, id } = c.req.valid("param");
  const body = c.req.valid("json");
  const result = await service.updateBowelMovement(catId, id, auth.playerId, body);
  if (result.kind === "not_found") return c.json({ error: "not_found" }, 404);
  if (result.kind === "forbidden") return c.json({ error: "forbidden" }, 403);
  return c.json(result.record, 200);
});

const deleteBowelMovementRoute = createRoute({
  method: "delete",
  path: "/cats/{catId}/bowel-movements/{id}",
  tags: ["cat-care"],
  summary: "Hard-delete a bowel movement record (only the recording Player may delete)",
  request: { params: catRecordParamSchema },
  responses: {
    204: { description: "Deleted" },
    401: {
      description: "Missing or invalid access token",
      content: { "application/json": { schema: errorResponseSchema } },
    },
    403: {
      description: "Player lacks catCare.access, or is not the original recorder",
      content: { "application/json": { schema: errorResponseSchema } },
    },
    404: {
      description: "Record not found for this cat",
      content: { "application/json": { schema: errorResponseSchema } },
    },
  },
});

catCareRoutes.openapi(deleteBowelMovementRoute, async (c) => {
  const auth = await authenticatePlayer(c);
  if (!auth.ok) return c.json({ error: auth.error }, auth.status);

  const { catId, id } = c.req.valid("param");
  const result = await service.deleteBowelMovement(catId, id, auth.playerId);
  if (result.kind === "not_found") return c.json({ error: "not_found" }, 404);
  if (result.kind === "forbidden") return c.json({ error: "forbidden" }, 403);
  return c.body(null, 204);
});

const createWeightRecordRoute = createRoute({
  method: "post",
  path: "/cats/{catId}/weight-records",
  tags: ["cat-care"],
  summary: "Record a weight measurement for a cat",
  request: {
    params: catIdParamSchema,
    body: {
      content: {
        "application/json": {
          schema: z.object({
            measuredAt: z.string().datetime().optional(),
            weightGrams: z.number().int().positive(),
            method: methodSchema.optional(),
            notes: z.string().optional(),
          }),
        },
      },
    },
  },
  responses: {
    201: { description: "Recorded", content: { "application/json": { schema: weightRecordSchema } } },
    401: {
      description: "Missing or invalid access token",
      content: { "application/json": { schema: errorResponseSchema } },
    },
    403: {
      description: "Player lacks catCare.access",
      content: { "application/json": { schema: errorResponseSchema } },
    },
    404: {
      description: "Cat not found or caller is not a member",
      content: { "application/json": { schema: errorResponseSchema } },
    },
  },
});

catCareRoutes.openapi(createWeightRecordRoute, async (c) => {
  const auth = await authenticatePlayer(c);
  if (!auth.ok) return c.json({ error: auth.error }, auth.status);

  const { catId } = c.req.valid("param");
  if (!(await service.isCatMember(catId, auth.playerId))) {
    return c.json({ error: "not_found" }, 404);
  }

  const body = c.req.valid("json");
  const record = await service.recordWeight(catId, auth.playerId, body);
  return c.json(record, 201);
});

const listWeightRecordsRoute = createRoute({
  method: "get",
  path: "/cats/{catId}/weight-records",
  tags: ["cat-care"],
  summary: "List weight history for a cat (optionally filtered by ?from=&to= date range)",
  request: { params: catIdParamSchema, query: historyQuerySchema },
  responses: {
    200: {
      description: "History",
      content: { "application/json": { schema: z.array(weightRecordSchema) } },
    },
    401: {
      description: "Missing or invalid access token",
      content: { "application/json": { schema: errorResponseSchema } },
    },
    403: {
      description: "Player lacks catCare.access",
      content: { "application/json": { schema: errorResponseSchema } },
    },
    404: {
      description: "Cat not found or caller is not a member",
      content: { "application/json": { schema: errorResponseSchema } },
    },
  },
});

catCareRoutes.openapi(listWeightRecordsRoute, async (c) => {
  const auth = await authenticatePlayer(c);
  if (!auth.ok) return c.json({ error: auth.error }, auth.status);

  const { catId } = c.req.valid("param");
  if (!(await service.isCatMember(catId, auth.playerId))) {
    return c.json({ error: "not_found" }, 404);
  }

  const { from, to } = c.req.valid("query");
  const records = await service.listWeightRecords(catId, { from, to });
  return c.json(records, 200);
});

const updateWeightRecordRoute = createRoute({
  method: "patch",
  path: "/cats/{catId}/weight-records/{id}",
  tags: ["cat-care"],
  summary: "Edit a weight record (only the measuring Player may edit)",
  request: {
    params: catRecordParamSchema,
    body: {
      content: {
        "application/json": {
          schema: z.object({
            measuredAt: z.string().datetime().optional(),
            weightGrams: z.number().int().positive().optional(),
            method: methodSchema.optional(),
            notes: z.string().optional(),
          }),
        },
      },
    },
  },
  responses: {
    200: { description: "Updated", content: { "application/json": { schema: weightRecordSchema } } },
    401: {
      description: "Missing or invalid access token",
      content: { "application/json": { schema: errorResponseSchema } },
    },
    403: {
      description: "Player lacks catCare.access, or is not the original measurer",
      content: { "application/json": { schema: errorResponseSchema } },
    },
    404: {
      description: "Record not found for this cat",
      content: { "application/json": { schema: errorResponseSchema } },
    },
  },
});

catCareRoutes.openapi(updateWeightRecordRoute, async (c) => {
  const auth = await authenticatePlayer(c);
  if (!auth.ok) return c.json({ error: auth.error }, auth.status);

  const { catId, id } = c.req.valid("param");
  const body = c.req.valid("json");
  const result = await service.updateWeightRecord(catId, id, auth.playerId, body);
  if (result.kind === "not_found") return c.json({ error: "not_found" }, 404);
  if (result.kind === "forbidden") return c.json({ error: "forbidden" }, 403);
  return c.json(result.record, 200);
});

const deleteWeightRecordRoute = createRoute({
  method: "delete",
  path: "/cats/{catId}/weight-records/{id}",
  tags: ["cat-care"],
  summary: "Hard-delete a weight record (only the measuring Player may delete)",
  request: { params: catRecordParamSchema },
  responses: {
    204: { description: "Deleted" },
    401: {
      description: "Missing or invalid access token",
      content: { "application/json": { schema: errorResponseSchema } },
    },
    403: {
      description: "Player lacks catCare.access, or is not the original measurer",
      content: { "application/json": { schema: errorResponseSchema } },
    },
    404: {
      description: "Record not found for this cat",
      content: { "application/json": { schema: errorResponseSchema } },
    },
  },
});

catCareRoutes.openapi(deleteWeightRecordRoute, async (c) => {
  const auth = await authenticatePlayer(c);
  if (!auth.ok) return c.json({ error: auth.error }, auth.status);

  const { catId, id } = c.req.valid("param");
  const result = await service.deleteWeightRecord(catId, id, auth.playerId);
  if (result.kind === "not_found") return c.json({ error: "not_found" }, 404);
  if (result.kind === "forbidden") return c.json({ error: "forbidden" }, 403);
  return c.body(null, 204);
});

const createFluidInjectionRoute = createRoute({
  method: "post",
  path: "/cats/{catId}/fluid-injections",
  tags: ["cat-care"],
  summary: "Record a subcutaneous fluid injection for a cat",
  request: {
    params: catIdParamSchema,
    body: { content: { "application/json": { schema: createFluidInjectionBodySchema } } },
  },
  responses: {
    201: { description: "Recorded", content: { "application/json": { schema: fluidInjectionSchema } } },
    401: {
      description: "Missing or invalid access token",
      content: { "application/json": { schema: errorResponseSchema } },
    },
    403: {
      description: "Player lacks catCare.access",
      content: { "application/json": { schema: errorResponseSchema } },
    },
    404: {
      description: "Cat not found or caller is not a member",
      content: { "application/json": { schema: errorResponseSchema } },
    },
  },
});

catCareRoutes.openapi(createFluidInjectionRoute, async (c) => {
  const auth = await authenticatePlayer(c);
  if (!auth.ok) return c.json({ error: auth.error }, auth.status);

  const { catId } = c.req.valid("param");
  if (!(await service.isCatMember(catId, auth.playerId))) {
    return c.json({ error: "not_found" }, 404);
  }

  const body = c.req.valid("json");
  const record = await service.recordFluidInjection(catId, auth.playerId, body);
  return c.json(record, 201);
});

const listFluidInjectionsRoute = createRoute({
  method: "get",
  path: "/cats/{catId}/fluid-injections",
  tags: ["cat-care"],
  summary: "List fluid injection history for a cat (optionally filtered by ?from=&to= date range)",
  request: { params: catIdParamSchema, query: historyQuerySchema },
  responses: {
    200: {
      description: "History",
      content: { "application/json": { schema: z.array(fluidInjectionSchema) } },
    },
    401: {
      description: "Missing or invalid access token",
      content: { "application/json": { schema: errorResponseSchema } },
    },
    403: {
      description: "Player lacks catCare.access",
      content: { "application/json": { schema: errorResponseSchema } },
    },
    404: {
      description: "Cat not found or caller is not a member",
      content: { "application/json": { schema: errorResponseSchema } },
    },
  },
});

catCareRoutes.openapi(listFluidInjectionsRoute, async (c) => {
  const auth = await authenticatePlayer(c);
  if (!auth.ok) return c.json({ error: auth.error }, auth.status);

  const { catId } = c.req.valid("param");
  if (!(await service.isCatMember(catId, auth.playerId))) {
    return c.json({ error: "not_found" }, 404);
  }

  const { from, to } = c.req.valid("query");
  const records = await service.listFluidInjections(catId, { from, to });
  return c.json(records, 200);
});

const updateFluidInjectionRoute = createRoute({
  method: "patch",
  path: "/cats/{catId}/fluid-injections/{id}",
  tags: ["cat-care"],
  summary: "Edit a fluid injection record (only the injecting Player may edit)",
  request: {
    params: catRecordParamSchema,
    body: { content: { "application/json": { schema: updateFluidInjectionBodySchema } } },
  },
  responses: {
    200: { description: "Updated", content: { "application/json": { schema: fluidInjectionSchema } } },
    400: {
      description: "site/fluidType 'other' free-text field is missing or set when not allowed",
      content: { "application/json": { schema: errorResponseSchema } },
    },
    401: {
      description: "Missing or invalid access token",
      content: { "application/json": { schema: errorResponseSchema } },
    },
    403: {
      description: "Player lacks catCare.access, or is not the original injector",
      content: { "application/json": { schema: errorResponseSchema } },
    },
    404: {
      description: "Record not found for this cat",
      content: { "application/json": { schema: errorResponseSchema } },
    },
  },
});

catCareRoutes.openapi(updateFluidInjectionRoute, async (c) => {
  const auth = await authenticatePlayer(c);
  if (!auth.ok) return c.json({ error: auth.error }, auth.status);

  const { catId, id } = c.req.valid("param");
  const body = c.req.valid("json");
  const result = await service.updateFluidInjection(catId, id, auth.playerId, body);
  if (result.kind === "not_found") return c.json({ error: "not_found" }, 404);
  if (result.kind === "forbidden") return c.json({ error: "forbidden" }, 403);
  if (result.kind === "invalid") return c.json({ error: result.message }, 400);
  return c.json(result.record, 200);
});

const deleteFluidInjectionRoute = createRoute({
  method: "delete",
  path: "/cats/{catId}/fluid-injections/{id}",
  tags: ["cat-care"],
  summary: "Hard-delete a fluid injection record (only the injecting Player may delete)",
  request: { params: catRecordParamSchema },
  responses: {
    204: { description: "Deleted" },
    401: {
      description: "Missing or invalid access token",
      content: { "application/json": { schema: errorResponseSchema } },
    },
    403: {
      description: "Player lacks catCare.access, or is not the original injector",
      content: { "application/json": { schema: errorResponseSchema } },
    },
    404: {
      description: "Record not found for this cat",
      content: { "application/json": { schema: errorResponseSchema } },
    },
  },
});

catCareRoutes.openapi(deleteFluidInjectionRoute, async (c) => {
  const auth = await authenticatePlayer(c);
  if (!auth.ok) return c.json({ error: auth.error }, auth.status);

  const { catId, id } = c.req.valid("param");
  const result = await service.deleteFluidInjection(catId, id, auth.playerId);
  if (result.kind === "not_found") return c.json({ error: "not_found" }, 404);
  if (result.kind === "forbidden") return c.json({ error: "forbidden" }, 403);
  return c.body(null, 204);
});

const listCatPlayersRoute = createRoute({
  method: "get",
  path: "/cats/{catId}/players",
  tags: ["cat-care"],
  summary: "List the Players (co-caretakers) currently on a cat (caller must be a member)",
  request: { params: catIdParamSchema },
  responses: {
    200: {
      description: "Members",
      content: { "application/json": { schema: z.array(invitedPlayerSchema) } },
    },
    401: {
      description: "Missing or invalid access token",
      content: { "application/json": { schema: errorResponseSchema } },
    },
    403: {
      description: "Player lacks catCare.access",
      content: { "application/json": { schema: errorResponseSchema } },
    },
    404: {
      description: "Cat not found or caller is not a member",
      content: { "application/json": { schema: errorResponseSchema } },
    },
  },
});

catCareRoutes.openapi(listCatPlayersRoute, async (c) => {
  const auth = await authenticatePlayer(c);
  if (!auth.ok) return c.json({ error: auth.error }, auth.status);

  const { catId } = c.req.valid("param");
  if (!(await service.isCatMember(catId, auth.playerId))) {
    return c.json({ error: "not_found" }, 404);
  }

  const players = await service.listCatPlayers(catId);
  return c.json(players, 200);
});

const invitePlayerRoute = createRoute({
  method: "post",
  path: "/cats/{catId}/players",
  tags: ["cat-care"],
  summary: "Invite an existing Player (by email) to join a cat (caller must be a member)",
  request: {
    params: catIdParamSchema,
    body: {
      content: {
        "application/json": {
          schema: z.object({ email: z.string().email() }),
        },
      },
    },
  },
  responses: {
    201: { description: "Joined", content: { "application/json": { schema: invitedPlayerSchema } } },
    401: {
      description: "Missing or invalid access token",
      content: { "application/json": { schema: errorResponseSchema } },
    },
    403: {
      description: "Player lacks catCare.access",
      content: { "application/json": { schema: errorResponseSchema } },
    },
    404: {
      description: "Cat not found, caller is not a member, or no Player exists for that email",
      content: { "application/json": { schema: errorResponseSchema } },
    },
  },
});

catCareRoutes.openapi(invitePlayerRoute, async (c) => {
  const auth = await authenticatePlayer(c);
  if (!auth.ok) return c.json({ error: auth.error }, auth.status);

  const { catId } = c.req.valid("param");
  if (!(await service.isCatMember(catId, auth.playerId))) {
    return c.json({ error: "not_found" }, 404);
  }

  const { email } = c.req.valid("json");
  const result = await service.invitePlayer(catId, email);
  if (result.kind === "player_not_found") return c.json({ error: "player_not_found" }, 404);
  return c.json(result.player, 201);
});

const leaveCatRoute = createRoute({
  method: "delete",
  path: "/cats/{catId}/players/me",
  tags: ["cat-care"],
  summary: "Leave a cat (caller only; the chip-registration custodian must transfer first)",
  request: { params: catIdParamSchema },
  responses: {
    204: { description: "Left" },
    401: {
      description: "Missing or invalid access token",
      content: { "application/json": { schema: errorResponseSchema } },
    },
    403: {
      description: "Player lacks catCare.access",
      content: { "application/json": { schema: errorResponseSchema } },
    },
    404: {
      description: "Caller is not a member of this cat",
      content: { "application/json": { schema: errorResponseSchema } },
    },
    409: {
      description: "Caller is the chip-registration custodian, or leaving would orphan the cat",
      content: { "application/json": { schema: errorResponseSchema } },
    },
  },
});

catCareRoutes.openapi(leaveCatRoute, async (c) => {
  const auth = await authenticatePlayer(c);
  if (!auth.ok) return c.json({ error: auth.error }, auth.status);

  const { catId } = c.req.valid("param");
  const result = await service.leaveCat(catId, auth.playerId);
  if (result.kind === "not_found") return c.json({ error: "not_found" }, 404);
  if (result.kind === "conflict") return c.json({ error: result.reason }, 409);
  return c.body(null, 204);
});

const setChipPlayerRoute = createRoute({
  method: "put",
  path: "/cats/{catId}/chip-player",
  tags: ["cat-care"],
  summary: "Set or transfer the chip-registration custodian (target must already be a member)",
  request: {
    params: catIdParamSchema,
    body: {
      content: {
        "application/json": {
          schema: z.object({ email: z.string().email() }),
        },
      },
    },
  },
  responses: {
    200: { description: "Updated", content: { "application/json": { schema: catSchema } } },
    401: {
      description: "Missing or invalid access token",
      content: { "application/json": { schema: errorResponseSchema } },
    },
    403: {
      description: "Player lacks catCare.access",
      content: { "application/json": { schema: errorResponseSchema } },
    },
    404: {
      description: "Cat not found, caller is not a member, or no Player exists for that email",
      content: { "application/json": { schema: errorResponseSchema } },
    },
    409: {
      description: "Target Player is not yet a member of this cat",
      content: { "application/json": { schema: errorResponseSchema } },
    },
  },
});

catCareRoutes.openapi(setChipPlayerRoute, async (c) => {
  const auth = await authenticatePlayer(c);
  if (!auth.ok) return c.json({ error: auth.error }, auth.status);

  const { catId } = c.req.valid("param");
  if (!(await service.isCatMember(catId, auth.playerId))) {
    return c.json({ error: "not_found" }, 404);
  }

  const { email } = c.req.valid("json");
  const result = await service.setChipPlayer(catId, email);
  if (result.kind === "player_not_found") return c.json({ error: "player_not_found" }, 404);
  if (result.kind === "not_a_member") return c.json({ error: "not_a_member" }, 409);
  return c.json(result.cat, 200);
});
