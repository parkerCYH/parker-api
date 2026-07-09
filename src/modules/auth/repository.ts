import { and, eq, isNull } from "drizzle-orm";
import { db } from "../../shared/db.js";
import { players, playerGrants, refreshTokens } from "./schema.js";

export async function findPlayerByGoogleSub(googleSub: string) {
  const [player] = await db.select().from(players).where(eq(players.googleSub, googleSub)).limit(1);
  return player;
}

export async function createPlayer(input: {
  googleSub: string;
  email: string;
  name: string;
  avatarUrl?: string;
}) {
  const [player] = await db.insert(players).values(input).returning();
  return player;
}

export async function insertRefreshToken(input: {
  playerId: string;
  tokenHash: string;
  expiresAt: Date;
}) {
  const [row] = await db.insert(refreshTokens).values(input).returning();
  return row;
}

export async function findValidRefreshToken(tokenHash: string) {
  const [row] = await db
    .select()
    .from(refreshTokens)
    .where(and(eq(refreshTokens.tokenHash, tokenHash), isNull(refreshTokens.revokedAt)))
    .limit(1);
  return row;
}

export async function hasGrant(playerId: string, rule: string): Promise<boolean> {
  const [row] = await db
    .select({ id: playerGrants.id })
    .from(playerGrants)
    .where(and(eq(playerGrants.playerId, playerId), eq(playerGrants.rule, rule)))
    .limit(1);
  return Boolean(row);
}

export async function grantAccess(playerId: string, rule: string): Promise<void> {
  await db
    .insert(playerGrants)
    .values({ playerId, rule })
    .onConflictDoNothing({ target: [playerGrants.playerId, playerGrants.rule] });
}

export async function revokeAccess(playerId: string, rule: string): Promise<void> {
  await db.delete(playerGrants).where(and(eq(playerGrants.playerId, playerId), eq(playerGrants.rule, rule)));
}
