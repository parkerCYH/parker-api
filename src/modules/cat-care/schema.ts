import { randomUUID } from "node:crypto";
import {
  boolean,
  date,
  doublePrecision,
  integer,
  pgSchema,
  primaryKey,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

export const catCareSchema = pgSchema("cat_care");

// DB 欄位維持 text,這兩個型別只是 Drizzle 端的編譯期標註,不是 Postgres enum/CHECK
// constraint(ticket #27)——實際驗證在 routes.ts 的 z.enum 做。
export type StoolType = "normal" | "hard" | "soft" | "watery" | "bloody" | "mucous";
export type Method = "catScale" | "holdAndSubtract" | "other";
export type FluidSite = "left" | "right" | "nape" | "other";
export type FluidType = "normalSaline" | "lactatedRingers" | "other";
// AI 辨識結果先落地為 draft,人工於 read-only/edit 兩態表單確認或修改後才轉為 confirmed
// (票 09 定案);手動填寫入口不經過 draft,建立時直接是 confirmed(票 13 定案)。
export type BloodworkStatus = "draft" | "confirmed";

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
  stoolType: text("stool_type").$type<StoolType>(),
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
  method: text("method").$type<Method>(),
  notes: text("notes"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const fluidInjections = catCareSchema.table("fluid_injections", {
  id: uuid("id")
    .primaryKey()
    .$defaultFn(() => randomUUID()),
  catId: uuid("cat_id")
    .notNull()
    .references(() => cats.id, { onDelete: "cascade" }),
  injectedBy: uuid("injected_by").notNull(),
  injectedAt: timestamp("injected_at", { withTimezone: true }).notNull(),
  site: text("site").notNull().$type<FluidSite>(),
  siteOther: text("site_other"),
  volumeMl: integer("volume_ml").notNull(),
  fluidType: text("fluid_type").notNull().$type<FluidType>(),
  fluidTypeOther: text("fluid_type_other"),
  notes: text("notes"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// 34 項驗血欄位(票 04 定案):生化 Catalyst One 面板 17 項 + CBC 血球面板 17 項,全部選填、
// 只存數值,不存參考區間。欄位命名(camelCase 對應的 snake_case 欄位)是本票新定案,供票 20
// (Gemini structured output schema)與票 22/24 沿用,保持全庫一致:
//   BUN/CREA → bunCrea、ALB/GLOB → albGlob、Na/K → naK、fPL → fpl,
//   LYM%/MON%/GRA%/RDW% → 對應 xxxPercent,其餘沿用原縮寫小寫。
export const bloodworkRecords = catCareSchema.table("bloodwork_records", {
  id: uuid("id")
    .primaryKey()
    .$defaultFn(() => randomUUID()),
  catId: uuid("cat_id")
    .notNull()
    .references(() => cats.id, { onDelete: "cascade" }),
  recordedBy: uuid("recorded_by").notNull(),
  recordedAt: timestamp("recorded_at", { withTimezone: true }).notNull(),
  // draft:票 20 的 AI 辨識路徑內部建立,confirmed:手動填寫或票 21 確認後轉入(票 09/13 定案)。
  status: text("status").notNull().$type<BloodworkStatus>(),
  // 生化 Catalyst One 面板(17 項)
  glu: doublePrecision("glu"),
  crea: doublePrecision("crea"),
  bun: doublePrecision("bun"),
  bunCrea: doublePrecision("bun_crea"),
  tp: doublePrecision("tp"),
  alb: doublePrecision("alb"),
  glob: doublePrecision("glob"),
  albGlob: doublePrecision("alb_glob"),
  alt: doublePrecision("alt"),
  alkp: doublePrecision("alkp"),
  fpl: doublePrecision("fpl"),
  na: doublePrecision("na"),
  k: doublePrecision("k"),
  naK: doublePrecision("na_k"),
  cl: doublePrecision("cl"),
  osmCalc: doublePrecision("osm_calc"),
  tt4: doublePrecision("tt4"),
  // CBC 血球分析面板(17 項)
  wbc: doublePrecision("wbc"),
  lym: doublePrecision("lym"),
  mono: doublePrecision("mono"),
  gran: doublePrecision("gran"),
  lymPercent: doublePrecision("lym_percent"),
  monPercent: doublePrecision("mon_percent"),
  graPercent: doublePrecision("gra_percent"),
  hgb: doublePrecision("hgb"),
  hct: doublePrecision("hct"),
  rbc: doublePrecision("rbc"),
  mcv: doublePrecision("mcv"),
  mch: doublePrecision("mch"),
  mchc: doublePrecision("mchc"),
  rdwPercent: doublePrecision("rdw_percent"),
  rdwa: doublePrecision("rdwa"),
  plt: doublePrecision("plt"),
  mpv: doublePrecision("mpv"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// 34 個數值欄位的 shape,從 table 定義推導、不手動重打一份清單(避免跟上面的欄位定義失去同步)。
// repository.ts/service.ts 用這個型別接手動填寫與票 20 內部 draft 建立路徑共用的輸入。
export type BloodworkValues = Omit<
  typeof bloodworkRecords.$inferInsert,
  "id" | "catId" | "recordedBy" | "recordedAt" | "status" | "createdAt"
>;
