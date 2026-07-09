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
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
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
