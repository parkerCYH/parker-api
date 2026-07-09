import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { errorHandler } from "./shared/error-handler.js";

const app = new Hono();

app.onError(errorHandler);

app.get("/health", (c) => c.json({ status: "ok" }));

const port = Number(process.env.PORT ?? 3000);

serve({ fetch: app.fetch, port }, (info) => {
  console.log(`parker-api listening on port ${info.port}`);
});

export default app;
