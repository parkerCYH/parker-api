import { randomUUID } from "node:crypto";
import { type AnyPgColumn, pgSchema, text, timestamp, uuid } from "drizzle-orm/pg-core";

export const adminSchema = pgSchema("admin");

// role_id null = 申請待審核中(ADR-0001);審核核准 = 指派一個 role_id。role_id 指回
// rbac.roles.id(ADR-0007)——跟 cat-care 指回 auth.players 的道理一樣,drizzle-kit 的 loader
// 不解析跨 module 的相對路徑匯入,所以不用 Drizzle 的 .references() 匯入 rbac/schema.ts,
// 實際的跨 schema FK constraint 手動加在 migration SQL 裡。
export const users = adminSchema.table("users", {
  id: uuid("id")
    .primaryKey()
    .$defaultFn(() => randomUUID()),
  googleSub: text("google_sub").notNull().unique(),
  email: text("email").notNull().unique(),
  name: text("name").notNull(),
  avatarUrl: text("avatar_url"),
  roleId: uuid("role_id"),
  approvedBy: uuid("approved_by").references((): AnyPgColumn => users.id),
  approvedAt: timestamp("approved_at", { withTimezone: true }),
  // 三態(ticket #19):role_id 有值 = 已核准;role_id 空 + rejected_at 空 = 待審核;
  // role_id 空 + rejected_at 有值 = 已拒絕。
  rejectedAt: timestamp("rejected_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// 邀請白名單(ADR-0001 的 Whitelist 段落):命中的 email 登入時直接核准、套用指定的 role_id,
// 不用走「建立待審核紀錄 → 手動核准」。role_id 一樣指回 rbac.roles.id(見上面 users 的註解,
// 同樣的跨 module 限制,不用 Drizzle 的 .references())。
export const inviteWhitelist = adminSchema.table("invite_whitelist", {
  id: uuid("id")
    .primaryKey()
    .$defaultFn(() => randomUUID()),
  email: text("email").notNull().unique(),
  roleId: uuid("role_id").notNull(),
  createdBy: uuid("created_by")
    .notNull()
    .references(() => users.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// 一次性登入 exchange code(ADR-0008):User 核准登入後,callback 不直接把 token 帶在導回
// Admin Dashboard 的網址上,而是先發一組短效、單次使用的 code,由 Admin Dashboard 的後端
// 拿去換真正的 token(伺服器對伺服器,不會出現在瀏覽器網址列/歷史紀錄/log)。
export const loginExchangeCodes = adminSchema.table("login_exchange_codes", {
  id: uuid("id")
    .primaryKey()
    .$defaultFn(() => randomUUID()),
  codeHash: text("code_hash").notNull(),
  userId: uuid("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  usedAt: timestamp("used_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const refreshTokens = adminSchema.table("refresh_tokens", {
  id: uuid("id")
    .primaryKey()
    .$defaultFn(() => randomUUID()),
  userId: uuid("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  tokenHash: text("token_hash").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
