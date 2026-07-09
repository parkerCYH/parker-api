import { and, eq, isNotNull, isNull } from "drizzle-orm";
import { db } from "../../shared/db.js";
import { inviteWhitelist, refreshTokens, users } from "./schema.js";

export type UserStatus = "pending" | "approved" | "rejected";

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
  approvedBy?: string;
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

export async function rejectUser(userId: string) {
  const [user] = await db
    .update(users)
    .set({ rejectedAt: new Date(), updatedAt: new Date() })
    .where(eq(users.id, userId))
    .returning();
  return user;
}

export async function listUsers(status?: UserStatus) {
  if (status === "pending") {
    return db.select().from(users).where(and(isNull(users.roleId), isNull(users.rejectedAt)));
  }
  if (status === "rejected") {
    return db.select().from(users).where(and(isNull(users.roleId), isNotNull(users.rejectedAt)));
  }
  if (status === "approved") {
    return db.select().from(users).where(isNotNull(users.roleId));
  }
  return db.select().from(users);
}

export async function findWhitelistEntryByEmail(email: string) {
  const [entry] = await db
    .select()
    .from(inviteWhitelist)
    .where(eq(inviteWhitelist.email, email))
    .limit(1);
  return entry;
}

export async function listWhitelistEntries() {
  return db.select().from(inviteWhitelist);
}

// upsert:Owner 改指定 email 的預先核准 Role 是合理的操作,不用先刪再加。
export async function upsertWhitelistEntry(input: { email: string; roleId: string; createdBy: string }) {
  const [entry] = await db
    .insert(inviteWhitelist)
    .values(input)
    .onConflictDoUpdate({
      target: inviteWhitelist.email,
      set: { roleId: input.roleId, createdBy: input.createdBy },
    })
    .returning();
  return entry;
}

export async function deleteWhitelistEntryByEmail(email: string): Promise<void> {
  await db.delete(inviteWhitelist).where(eq(inviteWhitelist.email, email));
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
