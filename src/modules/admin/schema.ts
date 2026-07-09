import { randomUUID } from "node:crypto";
import { type AnyPgColumn, pgSchema, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";

export const adminSchema = pgSchema("admin");

// Role 目錄:SuperAdmin(所有 admin.* 規則,以角色名稱判斷,見 service.ts 的 hasAdminRule)/
// Viewer(逐條 admin.* 規則,存在 role_rules)。見 docs/services/admin.md「Role 目錄」。
export const roles = adminSchema.table("roles", {
  id: uuid("id")
    .primaryKey()
    .$defaultFn(() => randomUUID()),
  name: text("name").notNull().unique(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const roleRules = adminSchema.table(
  "role_rules",
  {
    id: uuid("id")
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    roleId: uuid("role_id")
      .notNull()
      .references(() => roles.id, { onDelete: "cascade" }),
    rule: text("rule").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [unique().on(table.roleId, table.rule)],
);

// role_id null = 申請待審核中(ADR-0001);審核核准 = 指派一個 role_id。
export const users = adminSchema.table("users", {
  id: uuid("id")
    .primaryKey()
    .$defaultFn(() => randomUUID()),
  googleSub: text("google_sub").notNull().unique(),
  email: text("email").notNull().unique(),
  name: text("name").notNull(),
  avatarUrl: text("avatar_url"),
  roleId: uuid("role_id").references(() => roles.id),
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
