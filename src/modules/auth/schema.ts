import { randomUUID } from "node:crypto";
import { pgSchema, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";

export const authSchema = pgSchema("auth");

export const players = authSchema.table("players", {
  id: uuid("id")
    .primaryKey()
    .$defaultFn(() => randomUUID()),
  googleSub: text("google_sub").notNull().unique(),
  email: text("email").notNull().unique(),
  name: text("name").notNull(),
  avatarUrl: text("avatar_url"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const refreshTokens = authSchema.table("refresh_tokens", {
  id: uuid("id")
    .primaryKey()
    .$defaultFn(() => randomUUID()),
  playerId: uuid("player_id")
    .notNull()
    .references(() => players.id, { onDelete: "cascade" }),
  tokenHash: text("token_hash").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// Player-RBAC:粗粒度開關,每個 service 一條 `<service>.access` 規則(見 docs/services/auth.md)
export const playerGrants = authSchema.table(
  "player_grants",
  {
    id: uuid("id")
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    playerId: uuid("player_id")
      .notNull()
      .references(() => players.id, { onDelete: "cascade" }),
    rule: text("rule").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [unique().on(table.playerId, table.rule)],
);
