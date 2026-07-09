import { and, eq, isNull } from "drizzle-orm";
import { db } from "../../shared/db.js";
import { refreshTokens, roleRules, roles, users } from "./schema.js";

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

export async function findRoleByName(name: string) {
  const [role] = await db.select().from(roles).where(eq(roles.name, name)).limit(1);
  return role;
}

// 判斷一個 User 有沒有某條 admin.* 規則:SuperAdmin 用角色名稱直接放行(見 docs/services/admin.md
// 「SuperAdmin:擁有所有 admin.* 規則」),其他角色逐條查 role_rules。
export async function findUserRoleName(userId: string): Promise<string | undefined> {
  const [row] = await db
    .select({ roleName: roles.name })
    .from(users)
    .innerJoin(roles, eq(users.roleId, roles.id))
    .where(eq(users.id, userId))
    .limit(1);
  return row?.roleName;
}

export async function roleHasRule(roleId: string, rule: string): Promise<boolean> {
  const [row] = await db
    .select({ id: roleRules.id })
    .from(roleRules)
    .where(and(eq(roleRules.roleId, roleId), eq(roleRules.rule, rule)))
    .limit(1);
  return Boolean(row);
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
