import type { MiddlewareHandler } from "hono";
import { recordRequest } from "./repository.js";

// 排除 /pin(票 03):pin 保持喚醒機制自己發出的請求不能污染使用頻率紀錄(票 02 定案)。
export const usageLogMiddleware: MiddlewareHandler = async (c, next) => {
  if (c.req.path !== "/pin") {
    await recordRequest();
  }
  await next();
};
