import { serve } from "@hono/node-server";
import app from "./app.js";
import { env } from "./shared/env.js";

serve({ fetch: app.fetch, port: env.PORT }, (info) => {
  console.log(`parker-api listening on port ${info.port}`);
});
