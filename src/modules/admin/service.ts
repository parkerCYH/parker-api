import { createHash, randomBytes } from "node:crypto";
import type { GoogleProfile } from "../auth/index.js";
import { signAdminAccessToken } from "./jwt.js";
import * as repo from "./repository.js";

const REFRESH_TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function isSuperAdminEmail(email: string): boolean {
  const allowlist = (process.env.SUPER_ADMIN_EMAILS ?? "")
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
  return allowlist.includes(email.toLowerCase());
}

function toPublicUser(user: {
  id: string;
  email: string;
  name: string;
  avatarUrl: string | null;
}) {
  return { id: user.id, email: user.email, name: user.name, avatarUrl: user.avatarUrl };
}

async function issueSession(userId: string) {
  const accessToken = await signAdminAccessToken(userId);

  const refreshToken = randomBytes(32).toString("hex");
  await repo.insertRefreshToken({
    userId,
    tokenHash: hashToken(refreshToken),
    expiresAt: new Date(Date.now() + REFRESH_TOKEN_TTL_MS),
  });

  return { accessToken, refreshToken };
}

export type ApplyOrLoginResult =
  | { status: "pending"; userId: string }
  | {
      status: "approved";
      accessToken: string;
      refreshToken: string;
      user: ReturnType<typeof toPublicUser>;
    };

// ADR-0001:User 不是自動註冊,是「申請 → 待審核 → 既有 User 核准」;SUPER_ADMIN_EMAILS
// 是第一個 User 的 bootstrap 特判,略過審核直接核准(見 docs/adr/0001)。
export async function applyOrLoginWithGoogleProfile(profile: GoogleProfile): Promise<ApplyOrLoginResult> {
  let user = await repo.findUserByGoogleSub(profile.sub);

  if (!user) {
    const isBootstrapSuperAdmin = isSuperAdminEmail(profile.email);
    const superAdminRole = isBootstrapSuperAdmin ? await repo.findRoleByName("SuperAdmin") : undefined;

    user = await repo.createUser({
      googleSub: profile.sub,
      email: profile.email,
      name: profile.name,
      avatarUrl: profile.picture,
      roleId: superAdminRole?.id,
      approvedAt: superAdminRole ? new Date() : undefined,
    });
  }

  if (!user.roleId) {
    return { status: "pending", userId: user.id };
  }

  const session = await issueSession(user.id);
  return { status: "approved", ...session, user: toPublicUser(user) };
}

export async function refreshSession(rawRefreshToken: string) {
  const stored = await repo.findValidRefreshToken(hashToken(rawRefreshToken));

  if (!stored || stored.expiresAt < new Date()) {
    throw new Error("invalid_refresh_token");
  }

  const accessToken = await signAdminAccessToken(stored.userId);
  return { accessToken };
}

// 「namespace.resource.action」規則檢查:SuperAdmin 用角色名稱直接放行,其他角色逐條查 role_rules。
export async function canUser(userId: string, rule: string): Promise<boolean> {
  const user = await repo.findUserById(userId);
  if (!user || !user.roleId) return false;

  const roleName = await repo.findUserRoleName(userId);
  if (roleName === "SuperAdmin") return true;

  return repo.roleHasRule(user.roleId, rule);
}

export async function canApproveUsers(userId: string): Promise<boolean> {
  return canUser(userId, "admin.users.approve");
}

export async function approveUser(callerId: string, targetUserId: string, roleName: string) {
  const role = await repo.findRoleByName(roleName);
  if (!role) {
    throw new Error("unknown_role");
  }

  const user = await repo.updateUserRole(targetUserId, {
    roleId: role.id,
    approvedBy: callerId,
    approvedAt: new Date(),
  });

  if (!user) {
    throw new Error("user_not_found");
  }

  return toPublicUser(user);
}
