import { randomUUID } from "node:crypto";
import { pgSchema, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";

export const rbacSchema = pgSchema("rbac");

// Role 只是一組 rule 的集合(ADR-0007)——這個 module 不知道「User」的存在,只認 roleId 跟
// rule 字串,不對任何角色名稱(SuperAdmin、Owner 等)做特判。
export const roles = rbacSchema.table("roles", {
  id: uuid("id")
    .primaryKey()
    .$defaultFn(() => randomUUID()),
  name: text("name").notNull().unique(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const roleRules = rbacSchema.table(
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
