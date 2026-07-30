import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { pingEve } from "./client.js";

export const eveRoutes = new OpenAPIHono();

const pingRoute = createRoute({
  method: "get",
  path: "/ping",
  tags: ["eve"],
  summary: "帶共享密鑰打 apps/eve 的 /ping，驗證 parker-api → eve 認證機制（票 17 walking skeleton）",
  responses: {
    200: {
      description: "轉發 eve 回應的狀態（ok 反映 eve 是否回 2xx）",
      content: { "application/json": { schema: z.object({ ok: z.boolean(), status: z.number() }) } },
    },
  },
});

eveRoutes.openapi(pingRoute, async (c) => {
  const result = await pingEve();
  return c.json(result, 200);
});
