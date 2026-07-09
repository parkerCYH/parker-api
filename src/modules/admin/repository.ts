import { and, eq, isNull } from "drizzle-orm";
import { db } from "../../shared/db.js";
import { refreshTokens, users } from "./schema.js";

export async function findUserByGoogleSub(googleSub: string) {
  const [user] = await db.select().from(users).where(eq(users.googleSub, googleSub)).limit(1);
  return user;
}

export async function findUserById(id: string) {
  const [user] = await db.select().from(users).where(eq(users.id, id)).limit(1);
  return user;
}

export async function createUser(input: {
  googleSub: string;
  email: string;
  name: string;
  avatarUrl?: string;
  roleId?: string;
  approvedAt?: Date;
}) {
  const [user] = await db.insert(users).values(input).returning();
  return user;
}

export async function updateUserRole(
  userId: string,
  input: { roleId: string; approvedBy: string; approvedAt: Date },
) {
  const [user] = await db
    .update(users)
    .set({ ...input, updatedAt: new Date() })
    .where(eq(users.id, userId))
    .returning();
  return user;
}

export async function insertRefreshToken(input: { userId: string; tokenHash: string; expiresAt: Date }) {
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
