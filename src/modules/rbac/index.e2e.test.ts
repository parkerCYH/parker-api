import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  addRuleToRole,
  createRole,
  deleteRole,
  listRoles,
  removeRuleFromRole,
  roleHasRule,
} from "./index.js";

describe("rbac", () => {
  it("creates a Role and lists it", async () => {
    const role = await createRole(`Test-${randomUUID()}`);

    const roles = await listRoles();
    expect(roles.some((r) => r.id === role.id)).toBe(true);
  });

  it("addRuleToRole grants the rule, removeRuleFromRole revokes it", async () => {
    const role = await createRole(`Test-${randomUUID()}`);

    expect(await roleHasRule(role.id, "some.resource.action")).toBe(false);

    await addRuleToRole(role.id, "some.resource.action");
    expect(await roleHasRule(role.id, "some.resource.action")).toBe(true);

    await removeRuleFromRole(role.id, "some.resource.action");
    expect(await roleHasRule(role.id, "some.resource.action")).toBe(false);
  });

  it("roleHasRule is false for a rule the Role was never given", async () => {
    const role = await createRole(`Test-${randomUUID()}`);
    expect(await roleHasRule(role.id, "never.granted.rule")).toBe(false);
  });

  it("roleHasRule is false for a Role that doesn't exist", async () => {
    expect(await roleHasRule(randomUUID(), "any.rule.here")).toBe(false);
  });

  it("addRuleToRole is idempotent (same role+rule twice doesn't error)", async () => {
    const role = await createRole(`Test-${randomUUID()}`);

    await addRuleToRole(role.id, "dup.rule.check");
    await addRuleToRole(role.id, "dup.rule.check");

    expect(await roleHasRule(role.id, "dup.rule.check")).toBe(true);
  });

  it("deleteRole removes the Role and cascades its rules", async () => {
    const role = await createRole(`Test-${randomUUID()}`);
    await addRuleToRole(role.id, "some.resource.action");

    await deleteRole(role.id);

    const roles = await listRoles();
    expect(roles.some((r) => r.id === role.id)).toBe(false);
    expect(await roleHasRule(role.id, "some.resource.action")).toBe(false);
  });

  it("preserved the existing SuperAdmin/Viewer Roles and rules migrated from admin (ADR-0007)", async () => {
    const roles = await listRoles();
    const names = roles.map((r) => r.name);

    expect(names).toContain("SuperAdmin");
    expect(names).toContain("Viewer");

    const viewer = roles.find((r) => r.name === "Viewer");
    expect(viewer).toBeDefined();
    expect(await roleHasRule(viewer!.id, "admin.catCare.viewAll")).toBe(true);
  });
});
