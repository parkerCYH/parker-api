import { swaggerUI } from "@hono/swagger-ui";
import { OpenAPIHono } from "@hono/zod-openapi";
import { cors } from "hono/cors";
import { errorHandler } from "./shared/error-handler.js";
import { authRoutes, listAppOrigins } from "./modules/auth/index.js";
import { adminRoutes } from "./modules/admin/index.js";
import { catCareRoutes } from "./modules/cat-care/index.js";

const app = new OpenAPIHono();

app.onError(errorHandler);

// 允許清單複用既有的網域對照機制(ticket #29),不新增獨立的 CORS env var:
// Player app(cat-care 等)來自 AUTH_APP_DOMAINS,Admin Dashboard 來自 ADMIN_DASHBOARD_URL。
// 不開放萬用字元——這個專案已經有明確的網域對照表(ADR-0006),CORS 允許清單跟著走。
function getAllowedOrigins(): string[] {
  const origins = new Set(listAppOrigins());

  if (process.env.ADMIN_DASHBOARD_URL) {
    try {
      origins.add(new URL(process.env.ADMIN_DASHBOARD_URL).origin);
    } catch {
      // 格式錯誤就當沒設定,跟其餘網域解析邏輯一樣寬鬆處理。
    }
  }

  return [...origins];
}

app.use(
  "/api/v1/*",
  cors({
    origin: (origin) => (getAllowedOrigins().includes(origin) ? origin : undefined),
    allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE"],
    allowHeaders: ["Authorization", "Content-Type"],
  }),
);

app.get("/health", (c) => c.json({ status: "ok" }));

app.route("/api/v1/auth", authRoutes);
app.route("/api/v1/admin", adminRoutes);
app.route("/api/v1/cat-care", catCareRoutes);

app.doc("/openapi.json", {
  openapi: "3.0.0",
  info: {
    title: "parker-api",
    version: "0.1.0",
  },
});

app.get("/docs", swaggerUI({ url: "/openapi.json" }));

export default app;
