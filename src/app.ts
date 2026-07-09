import { Hono } from "hono";
import { errorHandler } from "./shared/error-handler.js";
import { authRoutes } from "./modules/auth/index.js";

const app = new Hono();

app.onError(errorHandler);

app.get("/health", (c) => c.json({ status: "ok" }));

app.route("/api/v1/auth", authRoutes);

export default app;
