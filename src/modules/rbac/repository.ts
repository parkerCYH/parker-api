import { and, eq } from "drizzle-orm";
import { db } from "../../shared/db.js";
import { roleRules, roles } from "./schema.js";

export async function listRoles() {
  return db.select().from(roles);
}

export async function createRole(name: string) {
  const [role] = await db.insert(roles).values({ name }).returning();
  return role;
}

export async function deleteRole(roleId: string): Promise<void> {
  await db.delete(roles).where(eq(roles.id, roleId));
}

export async function addRuleToRole(roleId: string, rule: string): Promise<void> {
  await db
    .insert(roleRules)
    .values({ roleId, rule })
    .onConflictDoNothing({ target: [roleRules.roleId, roleRules.rule] });
}

export async function removeRuleFromRole(roleId: string, rule: string): Promise<void> {
  await db.delete(roleRules).where(and(eq(roleRules.roleId, roleId), eq(roleRules.rule, rule)));
}

export async function roleHasRule(roleId: string, rule: string): Promise<boolean> {
  const [row] = await db
    .select({ id: roleRules.id })
    .from(roleRules)
    .where(and(eq(roleRules.roleId, roleId), eq(roleRules.rule, rule)))
    .limit(1);
  return Boolean(row);
}
