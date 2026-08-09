import { randomUUID } from "node:crypto";
import { pgSchema, timestamp, uuid } from "drizzle-orm/pg-core";

export const usageLogSchema = pgSchema("usage_log");

// 只記錄「什麼時候有請求進來」,不分 route、不分 side project(票 02 定案)——
// 目的是抓整體使用時段的輪廓,不是細分到某個功能的用量分析。
export const requests = usageLogSchema.table("requests", {
  id: uuid("id")
    .primaryKey()
    .$defaultFn(() => randomUUID()),
  occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
});
