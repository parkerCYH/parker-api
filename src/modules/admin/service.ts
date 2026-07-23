import { createHash, randomBytes } from "node:crypto";
import type { GoogleProfile } from "../auth/index.js";
import { listRoles, roleHasRule } from "../rbac/index.js";
import { env } from "../../shared/env.js";
import { signAdminAccessToken } from "./jwt.js";
import * as repo from "./repository.js";

const REFRESH_TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const LOGIN_EXCHANGE_CODE_TTL_MS = 60 * 1000;

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function isBootstrapOwnerEmail(email: string): boolean {
  const allowlist = env.SUPER_ADMIN_EMAILS.split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
  return allowlist.includes(email.toLowerCase());
}

// rbac 只匯出 listRoles(),沒有 findByName——Role 目錄很小,直接查全部再找同名的就夠了。
async function findRoleIdByName(name: string): Promise<string | undefined> {
  const roles = await listRoles();
  return roles.find((role) => role.name === name)?.id;
}

function toPublicUser(user: {
  id: string;
  email: string;
  name: string;
  avatarUrl: string | null;
  roleId: string | null;
  rejectedAt: Date | null;
}) {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    avatarUrl: user.avatarUrl,
    status: user.roleId ? ("approved" as const) : user.rejectedAt ? ("rejected" as const) : ("pending" as const),
  };
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
  | { status: "approved"; user: ReturnType<typeof toPublicUser> };

// ADR-0001:User 不是自動註冊,是「申請 → 待審核 → 既有 User 核准」,除非命中下面兩種
// 自動核准情境之一:
//   1. 邀請白名單(Owner 預先登記 email + Role)——優先順序最高,是日常「已知會加入的人」用的
//   2. SUPER_ADMIN_EMAILS bootstrap——系統剛啟動、還沒有任何 User 可以核准或維護白名單時的
//      一次性特判,略過審核直接核准為 Owner(ADR-0007:Owner 才是 SuperAdmin 的規則超集)
// 兩者都沒命中才落回原本「建立待審核紀錄」的流程。
export async function applyOrLoginWithGoogleProfile(profile: GoogleProfile): Promise<ApplyOrLoginResult> {
  let user = await repo.findUserByGoogleSub(profile.sub);

  if (!user) {
    const whitelistEntry = await repo.findWhitelistEntryByEmail(profile.email);

    if (whitelistEntry) {
      user = await repo.createUser({
        googleSub: profile.sub,
        email: profile.email,
        name: profile.name,
        avatarUrl: profile.picture,
        roleId: whitelistEntry.roleId,
        approvedBy: whitelistEntry.createdBy,
        approvedAt: new Date(),
      });
    } else {
      const isBootstrap = isBootstrapOwnerEmail(profile.email);
      const ownerRoleId = isBootstrap ? await findRoleIdByName("Owner") : undefined;

      user = await repo.createUser({
        googleSub: profile.sub,
        email: profile.email,
        name: profile.name,
        avatarUrl: profile.picture,
        roleId: ownerRoleId,
        approvedAt: ownerRoleId ? new Date() : undefined,
      });
    }
  }

  if (!user.roleId) {
    return { status: "pending", userId: user.id };
  }

  return { status: "approved", user: toPublicUser(user) };
}

export async function refreshSession(rawRefreshToken: string) {
  const stored = await repo.findValidRefreshToken(hashToken(rawRefreshToken));

  if (!stored || stored.expiresAt < new Date()) {
    throw new Error("invalid_refresh_token");
  }

  const accessToken = await signAdminAccessToken(stored.userId);
  return { accessToken };
}

// ADR-0008:核准登入不直接把 token 帶在導回 Admin Dashboard 的網址上(User 能碰的資料範圍
// 比 Player 大得多,token 短暫出現在網址列/瀏覽器歷史/log 裡的風險不值得省一支 API),改發
// 一組短效(60 秒)、單次使用的 exchange code,由 Admin Dashboard 的後端伺服器對伺服器換
// 真正的 token。Player 登入(auth module)不受影響,維持 ADR-0006 原本的做法。
export async function createLoginExchangeCode(userId: string): Promise<string> {
  const code = randomBytes(32).toString("hex");

  await repo.insertLoginExchangeCode({
    codeHash: hashToken(code),
    userId,
    expiresAt: new Date(Date.now() + LOGIN_EXCHANGE_CODE_TTL_MS),
  });

  return code;
}

export async function exchangeLoginCode(rawCode: string) {
  const stored = await repo.findValidLoginExchangeCode(hashToken(rawCode));

  if (!stored || stored.expiresAt < new Date()) {
    throw new Error("invalid_exchange_code");
  }

  await repo.markLoginExchangeCodeUsed(stored.id);

  const user = await repo.findUserById(stored.userId);
  if (!user) {
    throw new Error("user_not_found");
  }

  const session = await issueSession(user.id);
  return { ...session, user: toPublicUser(user) };
}

// ADR-0007:沒有角色名稱特判——一個 Role 能做什麼完全由 rbac.role_rules 裡實際塞了哪些規則
// 決定。canUser 只是查這個 User 的 roleId,再問 rbac 這個 roleId 有沒有這條規則。
export async function canUser(userId: string, rule: string): Promise<boolean> {
  const user = await repo.findUserById(userId);
  if (!user || !user.roleId) return false;

  return roleHasRule(user.roleId, rule);
}

export async function canApproveUsers(userId: string): Promise<boolean> {
  return canUser(userId, "admin.users.approve");
}

export async function approveUser(callerId: string, targetUserId: string, roleName: string) {
  const roleId = await findRoleIdByName(roleName);
  if (!roleId) {
    throw new Error("unknown_role");
  }

  const user = await repo.updateUserRole(targetUserId, {
    roleId,
    approvedBy: callerId,
    approvedAt: new Date(),
  });

  if (!user) {
    throw new Error("user_not_found");
  }

  return toPublicUser(user);
}

export async function canManageWhitelist(userId: string): Promise<boolean> {
  return canUser(userId, "admin.whitelist.manage");
}

export async function canViewUsers(userId: string): Promise<boolean> {
  return canUser(userId, "admin.users.view");
}

export async function listUsers(status?: repo.UserStatus) {
  const rows = await repo.listUsers(status);
  return rows.map(toPublicUser);
}

export async function rejectUser(targetUserId: string) {
  const user = await repo.rejectUser(targetUserId);
  if (!user) {
    throw new Error("user_not_found");
  }
  return toPublicUser(user);
}

export async function addToWhitelist(callerId: string, email: string, roleName: string) {
  const roleId = await findRoleIdByName(roleName);
  if (!roleId) {
    throw new Error("unknown_role");
  }

  return repo.upsertWhitelistEntry({ email, roleId, createdBy: callerId });
}

export async function listWhitelist() {
  return repo.listWhitelistEntries();
}

export async function removeFromWhitelist(email: string): Promise<void> {
  return repo.deleteWhitelistEntryByEmail(email);
}
