import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import type { Context } from "hono";
import { canPlayer, verifyPlayerAccessToken } from "../auth/index.js";
import { verifyEveCallback } from "../eve/index.js";
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

// 34 項驗血欄位(票 04/18 定案):全部選填,只檢查型別為數字,不做值域檢查——PATCH 允許傳
// null 明確清空既有數值。同一份 shape 同時當 create/update body 與 read/response schema 用
// (兩邊語意本來就一樣:所有欄位皆選填),避免 34 個欄位在這支檔案裡重複列 2~3 次。
const bloodworkValueSchema = z.number().nullable().optional();
const bloodworkValuesSchema = z.object({
  glu: bloodworkValueSchema,
  crea: bloodworkValueSchema,
  bun: bloodworkValueSchema,
  bunCrea: bloodworkValueSchema,
  tp: bloodworkValueSchema,
  alb: bloodworkValueSchema,
  glob: bloodworkValueSchema,
  albGlob: bloodworkValueSchema,
  alt: bloodworkValueSchema,
  alkp: bloodworkValueSchema,
  fpl: bloodworkValueSchema,
  na: bloodworkValueSchema,
  k: bloodworkValueSchema,
  naK: bloodworkValueSchema,
  cl: bloodworkValueSchema,
  osmCalc: bloodworkValueSchema,
  tt4: bloodworkValueSchema,
  wbc: bloodworkValueSchema,
  lym: bloodworkValueSchema,
  mono: bloodworkValueSchema,
  gran: bloodworkValueSchema,
  lymPercent: bloodworkValueSchema,
  monPercent: bloodworkValueSchema,
  graPercent: bloodworkValueSchema,
  hgb: bloodworkValueSchema,
  hct: bloodworkValueSchema,
  rbc: bloodworkValueSchema,
  mcv: bloodworkValueSchema,
  mch: bloodworkValueSchema,
  mchc: bloodworkValueSchema,
  rdwPercent: bloodworkValueSchema,
  rdwa: bloodworkValueSchema,
  plt: bloodworkValueSchema,
  mpv: bloodworkValueSchema,
});

const bloodworkStatusSchema = z.enum(["draft", "confirmed"]);

const bloodworkRecordSchema = z
  .object({
    id: z.string().uuid(),
    catId: z.string().uuid(),
    recordedBy: z.string().uuid(),
    recordedAt: z.string(),
    status: bloodworkStatusSchema,
    createdAt: z.string(),
  })
  .merge(bloodworkValuesSchema);

const bloodworkBodySchema = z
  .object({
    recordedAt: z.string().datetime().optional(),
  })
  .merge(bloodworkValuesSchema);

// PATCH 專用:多接受 status(票 21 定案的 draft→confirmed 轉換)。POST 不套用這個 schema,
// 公開建立路徑仍固定寫 confirmed(票 18 定案),不開放呼叫端指定其他狀態。
const updateBloodworkBodySchema = bloodworkBodySchema.extend({
  status: z.literal("confirmed").optional(),
});

// 票 20:POST /cats/{catId}/bloodwork-records/recognize 的 multipart/form-data body。
// z.instanceof(File) 本身在 zod-to-openapi 底下會產生空 schema({}),導致 orval 產生的前端
// 型別是 unknown(票 21 codegen 時發現這個落差)——用 .openapi() 明確標成 binary,讓產生的
// OpenAPI spec 正確描述這個欄位是檔案上傳。
const recognizeBloodworkBodySchema = z.object({
  photo: z.instanceof(File).openapi({ type: "string", format: "binary" }),
});

const recognizeBloodworkResponseSchema = z.object({ jobId: z.string() });

// 票 20:eve callback 帶 job id 定位作業(票 08 定案),不走 Player 認證(見 verifyEveCallback)。
const bloodworkCallbackParamSchema = z.object({ jobId: z.string() });

// success 附票 04/18 定案的 34 項欄位,failed 不附任何結構化數據(票 08 定案)。
const bloodworkRecognitionCallbackBodySchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("success"), data: bloodworkValuesSchema }),
  z.object({ status: z.literal("failed") }),
]);

// 票 22:健康建議,分「異常指標」「可能原因」「建議行動」三區塊(票 14 定案)。
const healthAdviceContentSchema = z.object({
  abnormalFindings: z.array(z.string()),
  possibleCauses: z.array(z.string()),
  recommendedActions: z.array(z.string()),
});

const requestHealthAdviceBodySchema = z.object({
  bloodworkRecordIds: z.array(z.string().uuid()).min(1),
});

const healthAdviceSchema = z.object({
  id: z.string().uuid(),
  requestedBy: z.string().uuid(),
  advice: healthAdviceContentSchema,
  bloodworkRecordIds: z.array(z.string().uuid()),
  createdAt: z.string(),
});

// 票 24:對話聊天情境,對話串(conversation)本身的形狀,不含訊息內容(訊息只在送出時
// 以串流回應轉發,沒有另外開 GET 端點——比照票 22 的先例:AC 沒要求就不多補,留給票 25 視
// 實際 UI 需求決定要不要補這支)。
const conversationSchema = z.object({
  id: z.string().uuid(),
  catId: z.string().uuid(),
  createdBy: z.string().uuid(),
  createdAt: z.string(),
});

const createMessageBodySchema = z.object({
  content: z.string().min(1),
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

const createBloodworkRecordRoute = createRoute({
  method: "post",
  path: "/cats/{catId}/bloodwork-records",
  tags: ["cat-care"],
  summary: "Manually record a bloodwork report for a cat (always created as confirmed)",
  request: {
    params: catIdParamSchema,
    body: { content: { "application/json": { schema: bloodworkBodySchema } } },
  },
  responses: {
    201: { description: "Recorded", content: { "application/json": { schema: bloodworkRecordSchema } } },
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

catCareRoutes.openapi(createBloodworkRecordRoute, async (c) => {
  const auth = await authenticatePlayer(c);
  if (!auth.ok) return c.json({ error: auth.error }, auth.status);

  const { catId } = c.req.valid("param");
  if (!(await service.isCatMember(catId, auth.playerId))) {
    return c.json({ error: "not_found" }, 404);
  }

  const body = c.req.valid("json");
  const record = await service.recordBloodworkRecord(catId, auth.playerId, body);
  return c.json(record, 201);
});

const listBloodworkRecordsRoute = createRoute({
  method: "get",
  path: "/cats/{catId}/bloodwork-records",
  tags: ["cat-care"],
  summary: "List bloodwork records for a cat (optionally filtered by ?from=&to= date range)",
  request: { params: catIdParamSchema, query: historyQuerySchema },
  responses: {
    200: {
      description: "History",
      content: { "application/json": { schema: z.array(bloodworkRecordSchema) } },
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

catCareRoutes.openapi(listBloodworkRecordsRoute, async (c) => {
  const auth = await authenticatePlayer(c);
  if (!auth.ok) return c.json({ error: auth.error }, auth.status);

  const { catId } = c.req.valid("param");
  if (!(await service.isCatMember(catId, auth.playerId))) {
    return c.json({ error: "not_found" }, 404);
  }

  const { from, to } = c.req.valid("query");
  const records = await service.listBloodworkRecords(catId, { from, to });
  return c.json(records, 200);
});

const updateBloodworkRecordRoute = createRoute({
  method: "patch",
  path: "/cats/{catId}/bloodwork-records/{id}",
  tags: ["cat-care"],
  summary: "Edit a bloodwork record's fields (only the recording Player may edit)",
  request: {
    params: catRecordParamSchema,
    body: { content: { "application/json": { schema: updateBloodworkBodySchema } } },
  },
  responses: {
    200: { description: "Updated", content: { "application/json": { schema: bloodworkRecordSchema } } },
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

catCareRoutes.openapi(updateBloodworkRecordRoute, async (c) => {
  const auth = await authenticatePlayer(c);
  if (!auth.ok) return c.json({ error: auth.error }, auth.status);

  const { catId, id } = c.req.valid("param");
  const body = c.req.valid("json");
  const result = await service.updateBloodworkRecord(catId, id, auth.playerId, body);
  if (result.kind === "not_found") return c.json({ error: "not_found" }, 404);
  if (result.kind === "forbidden") return c.json({ error: "forbidden" }, 403);
  return c.json(result.record, 200);
});

const deleteBloodworkRecordRoute = createRoute({
  method: "delete",
  path: "/cats/{catId}/bloodwork-records/{id}",
  tags: ["cat-care"],
  summary: "Hard-delete a bloodwork record (only the recording Player may delete)",
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

catCareRoutes.openapi(deleteBloodworkRecordRoute, async (c) => {
  const auth = await authenticatePlayer(c);
  if (!auth.ok) return c.json({ error: auth.error }, auth.status);

  const { catId, id } = c.req.valid("param");
  const result = await service.deleteBloodworkRecord(catId, id, auth.playerId);
  if (result.kind === "not_found") return c.json({ error: "not_found" }, 404);
  if (result.kind === "forbidden") return c.json({ error: "forbidden" }, 403);
  return c.body(null, 204);
});

const recognizeBloodworkRoute = createRoute({
  method: "post",
  path: "/cats/{catId}/bloodwork-records/recognize",
  tags: ["cat-care"],
  summary:
    "Upload a bloodwork report photo for AI recognition (async; result lands as a draft record once eve calls back)",
  request: {
    params: catIdParamSchema,
    body: { content: { "multipart/form-data": { schema: recognizeBloodworkBodySchema } } },
  },
  responses: {
    202: {
      description: "Recognition job accepted by eve",
      content: { "application/json": { schema: recognizeBloodworkResponseSchema } },
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
    502: {
      description: "eve did not accept the recognition request",
      content: { "application/json": { schema: errorResponseSchema } },
    },
  },
});

catCareRoutes.openapi(recognizeBloodworkRoute, async (c) => {
  const auth = await authenticatePlayer(c);
  if (!auth.ok) return c.json({ error: auth.error }, auth.status);

  const { catId } = c.req.valid("param");
  if (!(await service.isCatMember(catId, auth.playerId))) {
    return c.json({ error: "not_found" }, 404);
  }

  const { photo } = c.req.valid("form");
  const result = await service.startBloodworkRecognition(catId, auth.playerId, {
    data: Buffer.from(await photo.arrayBuffer()),
    mediaType: photo.type || "image/jpeg",
    filename: photo.name || "bloodwork.jpg",
  });

  if (result.kind === "eve_unreachable") {
    return c.json({ error: "eve_unreachable" }, 502);
  }

  return c.json({ jobId: result.jobId }, 202);
});

const requestHealthAdviceRoute = createRoute({
  method: "post",
  path: "/cats/{catId}/bloodwork-records/health-advice",
  tags: ["cat-care"],
  summary:
    "Get AI-generated health advice for one or more bloodwork records (synchronous; caller must be a member)",
  request: {
    params: catIdParamSchema,
    body: { content: { "application/json": { schema: requestHealthAdviceBodySchema } } },
  },
  responses: {
    200: {
      description: "Advice generated and saved",
      content: { "application/json": { schema: healthAdviceSchema } },
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
      description: "Cat not found, caller is not a member, or a bloodworkRecordId does not belong to this cat",
      content: { "application/json": { schema: errorResponseSchema } },
    },
    502: {
      description: "eve did not return advice",
      content: { "application/json": { schema: errorResponseSchema } },
    },
  },
});

catCareRoutes.openapi(requestHealthAdviceRoute, async (c) => {
  const auth = await authenticatePlayer(c);
  if (!auth.ok) return c.json({ error: auth.error }, auth.status);

  const { catId } = c.req.valid("param");
  if (!(await service.isCatMember(catId, auth.playerId))) {
    return c.json({ error: "not_found" }, 404);
  }

  const { bloodworkRecordIds } = c.req.valid("json");
  const result = await service.getHealthAdvice(catId, auth.playerId, bloodworkRecordIds);
  if (result.kind === "not_found") return c.json({ error: "not_found" }, 404);
  if (result.kind === "eve_unreachable") return c.json({ error: "eve_unreachable" }, 502);
  return c.json(result.advice, 200);
});

const listHealthAdviceHistoryRoute = createRoute({
  method: "get",
  path: "/cats/{catId}/bloodwork-records/{id}/health-advice",
  tags: ["cat-care"],
  summary: "List previously generated health advice for a bloodwork record (票 23; avoids re-calling eve)",
  request: { params: catRecordParamSchema },
  responses: {
    200: {
      description: "History (newest first; empty array if none generated yet)",
      content: { "application/json": { schema: z.array(healthAdviceSchema) } },
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
      description: "Cat not found, caller is not a member, or record does not belong to this cat",
      content: { "application/json": { schema: errorResponseSchema } },
    },
  },
});

catCareRoutes.openapi(listHealthAdviceHistoryRoute, async (c) => {
  const auth = await authenticatePlayer(c);
  if (!auth.ok) return c.json({ error: auth.error }, auth.status);

  const { catId, id } = c.req.valid("param");
  if (!(await service.isCatMember(catId, auth.playerId))) {
    return c.json({ error: "not_found" }, 404);
  }

  const result = await service.getHealthAdviceHistory(catId, id);
  if (result.kind === "not_found") return c.json({ error: "not_found" }, 404);
  return c.json(result.advice, 200);
});

const createConversationRoute = createRoute({
  method: "post",
  path: "/cats/{catId}/conversations",
  tags: ["cat-care"],
  summary: "Start a new chat conversation thread for a cat (caller must be a member)",
  request: { params: catIdParamSchema },
  responses: {
    201: { description: "Created", content: { "application/json": { schema: conversationSchema } } },
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

catCareRoutes.openapi(createConversationRoute, async (c) => {
  const auth = await authenticatePlayer(c);
  if (!auth.ok) return c.json({ error: auth.error }, auth.status);

  const { catId } = c.req.valid("param");
  if (!(await service.isCatMember(catId, auth.playerId))) {
    return c.json({ error: "not_found" }, 404);
  }

  const conversation = await service.createConversation(catId, auth.playerId);
  return c.json(conversation, 201);
});

const listConversationsRoute = createRoute({
  method: "get",
  path: "/cats/{catId}/conversations",
  tags: ["cat-care"],
  summary: "List chat conversation threads for a cat, newest first (caller must be a member)",
  request: { params: catIdParamSchema },
  responses: {
    200: {
      description: "Conversations",
      content: { "application/json": { schema: z.array(conversationSchema) } },
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

catCareRoutes.openapi(listConversationsRoute, async (c) => {
  const auth = await authenticatePlayer(c);
  if (!auth.ok) return c.json({ error: auth.error }, auth.status);

  const { catId } = c.req.valid("param");
  if (!(await service.isCatMember(catId, auth.playerId))) {
    return c.json({ error: "not_found" }, 404);
  }

  const conversations = await service.listConversations(catId);
  return c.json(conversations, 200);
});

const sendMessageRoute = createRoute({
  method: "post",
  path: "/cats/{catId}/conversations/{id}/messages",
  tags: ["cat-care"],
  summary:
    "Send a message in a conversation; synchronously streams eve's reply back chunk by chunk (票 15 定案), " +
    "then persists the full assistant reply once the stream ends",
  request: {
    params: catRecordParamSchema,
    body: { content: { "application/json": { schema: createMessageBodySchema } } },
  },
  responses: {
    // 200 故意不宣告 content(比照既有 204 路由的做法):實際回應是原樣轉發 eve 的 ReadableStream
    // (c.body()),不是可以套 zod schema 驗證的單一 JSON/text 值,zod-openapi 也沒有描述
    // streaming body 的 schema 型別可用。少一個 response 帶 content 會讓 zod-openapi 的
    // RouteHandler 型別退回允許 handler 直接回傳原生 Response(見 node_modules 型別定義),
    // 這裡就是靠這個逃生口讓 c.body(stream, ...) 通過型別檢查。
    200: {
      description: "Streamed assistant reply (text/plain, chunked)",
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
      description: "Cat not found, caller is not a member, or conversation does not belong to this cat",
      content: { "application/json": { schema: errorResponseSchema } },
    },
    502: {
      description: "eve did not accept the chat request",
      content: { "application/json": { schema: errorResponseSchema } },
    },
  },
});

catCareRoutes.openapi(sendMessageRoute, async (c) => {
  const auth = await authenticatePlayer(c);
  if (!auth.ok) return c.json({ error: auth.error }, auth.status);

  const { catId, id } = c.req.valid("param");
  if (!(await service.isCatMember(catId, auth.playerId))) {
    return c.json({ error: "not_found" }, 404);
  }

  const { content } = c.req.valid("json");
  const result = await service.sendMessage(catId, id, content);
  if (result.kind === "not_found") return c.json({ error: "not_found" }, 404);
  if (result.kind === "eve_unreachable") return c.json({ error: "eve_unreachable" }, 502);

  return c.body(result.stream, 200, { "content-type": "text/plain; charset=utf-8" });
});

const bloodworkRecognitionCallbackRoute = createRoute({
  method: "post",
  path: "/eve-callback/bloodwork-recognition/{jobId}",
  tags: ["cat-care"],
  summary:
    "eve → parker-api callback for a photo-recognition job (service-to-service; verified by shared key, not Player auth)",
  request: {
    params: bloodworkCallbackParamSchema,
    body: { content: { "application/json": { schema: bloodworkRecognitionCallbackBodySchema } } },
  },
  responses: {
    200: {
      description: "Accepted",
      content: { "application/json": { schema: z.object({ ok: z.boolean() }) } },
    },
    401: {
      description: "Missing or invalid eve → parker-api shared key",
      content: { "application/json": { schema: errorResponseSchema } },
    },
    404: {
      description: "Unknown or already-consumed job id",
      content: { "application/json": { schema: errorResponseSchema } },
    },
  },
});

catCareRoutes.openapi(bloodworkRecognitionCallbackRoute, async (c) => {
  if (!verifyEveCallback(c)) {
    return c.json({ error: "unauthorized" }, 401);
  }

  const { jobId } = c.req.valid("param");
  const body = c.req.valid("json");
  const result = await service.handleBloodworkRecognitionCallback(jobId, body);
  if (result.kind === "unknown_job") return c.json({ error: "not_found" }, 404);
  return c.json({ ok: true }, 200);
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
