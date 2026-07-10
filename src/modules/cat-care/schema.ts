import { randomUUID } from "node:crypto";
import { boolean, date, integer, pgSchema, primaryKey, text, timestamp, uuid } from "drizzle-orm/pg-core";

export const catCareSchema = pgSchema("cat_care");

// player_id/recorded_by/measured_by 都指回 auth.players.id(見 CONTEXT.md「共用帳號機制」的
// 跨 schema 外鍵慣例),但這裡刻意不用 Drizzle 的 .references() 匯入 auth/schema.ts——
// drizzle-kit 的 loader 不會解析跨 module 的相對路徑匯入(`.js` 對應 `.ts` 來源),而 cat-care
// 本來就不需要對 players 做 typed join,只需要一個 opaque 的 player id。實際的 FK constraint
// 手動加在 migration SQL 裡(見 drizzle/ 底下這次 generate 出來的檔案)。

// 貓咪是獨立實體,跟 auth.players 多對多(見 docs/services/cat-care.md),方便未來多隻貓
// 或多個 Player 共同管理同一隻貓。中間表不分角色,所有列在其中的 Player 權限均等。
export const cats = catCareSchema.table("cats", {
  id: uuid("id")
    .primaryKey()
    .$defaultFn(() => randomUUID()),
  name: text("name").notNull(),
  birthdate: date("birthdate"),
  notes: text("notes"),
  archivedAt: timestamp("archived_at", { withTimezone: true }),
  // 晶片登記責任人(見 docs/services/cat-care.md「例外」段落)——刻意不叫 owner_player_id,
  // 避免跟 User-RBAC 的 Owner Role 撞名。跨 module FK,理由同上,手動加在 migration SQL。
  chipPlayerId: uuid("chip_player_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const catPlayers = catCareSchema.table(
  "cat_players",
  {
    catId: uuid("cat_id")
      .notNull()
      .references(() => cats.id, { onDelete: "cascade" }),
    playerId: uuid("player_id").notNull(),
  },
  (table) => [primaryKey({ columns: [table.catId, table.playerId] })],
);

export const bowelMovements = catCareSchema.table("bowel_movements", {
  id: uuid("id")
    .primaryKey()
    .$defaultFn(() => randomUUID()),
  catId: uuid("cat_id")
    .notNull()
    .references(() => cats.id, { onDelete: "cascade" }),
  recordedBy: uuid("recorded_by").notNull(),
  recordedAt: timestamp("recorded_at", { withTimezone: true }).notNull(),
  stoolType: text("stool_type"),
  isAbnormal: boolean("is_abnormal").notNull().default(false),
  notes: text("notes"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const weightRecords = catCareSchema.table("weight_records", {
  id: uuid("id")
    .primaryKey()
    .$defaultFn(() => randomUUID()),
  catId: uuid("cat_id")
    .notNull()
    .references(() => cats.id, { onDelete: "cascade" }),
  measuredBy: uuid("measured_by").notNull(),
  measuredAt: timestamp("measured_at", { withTimezone: true }).notNull(),
  weightGrams: integer("weight_grams").notNull(),
  method: text("method"),
  notes: text("notes"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
