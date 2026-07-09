import { swaggerUI } from "@hono/swagger-ui";
import { OpenAPIHono } from "@hono/zod-openapi";
import { errorHandler } from "./shared/error-handler.js";
import { authRoutes } from "./modules/auth/index.js";
import { adminRoutes } from "./modules/admin/index.js";

const app = new OpenAPIHono();

app.onError(errorHandler);

app.get("/health", (c) => c.json({ status: "ok" }));

app.route("/api/v1/auth", authRoutes);
app.route("/api/v1/admin", adminRoutes);

app.doc("/openapi.json", {
  openapi: "3.0.0",
  info: {
    title: "parker-api",
    version: "0.1.0",
  },
});

app.get("/docs", swaggerUI({ url: "/openapi.json" }));

export default app;
