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
  createdAt: z.string(),
});

const bowelMovementSchema = z.object({
  id: z.string().uuid(),
  catId: z.string().uuid(),
  recordedBy: z.string().uuid(),
  recordedAt: z.string(),
  stoolType: z.string().nullable().optional(),
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
  method: z.string().nullable().optional(),
  notes: z.string().nullable().optional(),
  createdAt: z.string(),
});

const catIdParamSchema = z.object({ catId: z.string().uuid() });

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
            stoolType: z.string().optional(),
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
  summary: "List bowel movement history for a cat",
  request: { params: catIdParamSchema },
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

  const records = await service.listBowelMovements(catId);
  return c.json(records, 200);
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
            method: z.string().optional(),
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
  summary: "List weight history for a cat",
  request: { params: catIdParamSchema },
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

  const records = await service.listWeightRecords(catId);
  return c.json(records, 200);
});
