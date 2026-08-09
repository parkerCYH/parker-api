import { swaggerUI } from "@hono/swagger-ui";
import { OpenAPIHono } from "@hono/zod-openapi";
import { cors } from "hono/cors";
import { env } from "./shared/env.js";
import { errorHandler } from "./shared/error-handler.js";
import { authRoutes, listAppOrigins } from "./modules/auth/index.js";
import { adminRoutes } from "./modules/admin/index.js";
import { catCareRoutes } from "./modules/cat-care/index.js";
import { eveRoutes } from "./modules/eve/index.js";
import { usageLogMiddleware } from "./modules/usage-log/index.js";

const app = new OpenAPIHono();

app.onError(errorHandler);

// 使用頻率紀錄(票 04):記錄所有請求發生的時間,排除 /pin 見 middleware 內部邏輯。
app.use("*", usageLogMiddleware);

// 允許清單複用既有的網域對照機制(ticket #29),不新增獨立的 CORS env var:
// Player app(cat-care 等)來自 AUTH_APP_DOMAINS,Admin Dashboard 來自 ADMIN_DASHBOARD_URL。
// 不開放萬用字元——這個專案已經有明確的網域對照表(ADR-0006),CORS 允許清單跟著走。
function getAllowedOrigins(): string[] {
  const origins = new Set(listAppOrigins());

  if (env.ADMIN_DASHBOARD_URL) {
    try {
      origins.add(new URL(env.ADMIN_DASHBOARD_URL).origin);
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

// commit 本機沒有 RENDER_GIT_COMMIT 時回 null,不因缺這個 Render 專屬變數而噴錯(票 07)。
app.get("/health", (c) => c.json({ status: "ok", commit: env.RENDER_GIT_COMMIT || null }));

// pin 保持喚醒專用 endpoint(票 03),不共用 /health:避免 pin 自己發出的請求污染使用頻率紀錄(票 04)。
// 不做任何業務邏輯,單純確認服務有在跑。
app.get("/pin", (c) => c.json({ status: "ok" }));

app.route("/api/v1/auth", authRoutes);
app.route("/api/v1/admin", adminRoutes);
app.route("/api/v1/cat-care", catCareRoutes);
// 票 17 walking skeleton：手動驗證 parker-api → eve 共享密鑰是否打通用，不含任何 Gemini/AI 邏輯。
app.route("/api/v1/debug/eve", eveRoutes);

app.doc("/openapi.json", {
  openapi: "3.0.0",
  info: {
    title: "parker-api",
    version: "0.1.0",
  },
});

app.get("/docs", swaggerUI({ url: "/openapi.json" }));

export default app;
