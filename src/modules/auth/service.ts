import { createHash, randomBytes } from "node:crypto";
import type { GoogleProfile } from "./google-oauth.js";
import { signAccessToken } from "./jwt.js";
import * as repo from "./repository.js";

const REFRESH_TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function toPublicPlayer(player: { id: string; email: string; name: string; avatarUrl: string | null }) {
  return { id: player.id, email: player.email, name: player.name, avatarUrl: player.avatarUrl };
}

// Google profile 換成一個 auth.players 列,找不到就自動註冊(Player 不像 User 需要審核)。
// 跟 issueSession 分開:ADR-0006 要求先確認這個 Player 有沒有特定 app 的權限,沒有的話
// 即使 Google 那邊交換成功,也不發 session token。
export async function findOrCreatePlayer(profile: GoogleProfile) {
  const player =
    (await repo.findPlayerByGoogleSub(profile.sub)) ??
    (await repo.createPlayer({
      googleSub: profile.sub,
      email: profile.email,
      name: profile.name,
      avatarUrl: profile.picture,
    }));

  return toPublicPlayer(player);
}

export async function issueSession(playerId: string) {
  const accessToken = await signAccessToken(playerId);

  const refreshToken = randomBytes(32).toString("hex");
  await repo.insertRefreshToken({
    playerId,
    tokenHash: hashToken(refreshToken),
    expiresAt: new Date(Date.now() + REFRESH_TOKEN_TTL_MS),
  });

  return { accessToken, refreshToken };
}

export async function refreshSession(rawRefreshToken: string) {
  const stored = await repo.findValidRefreshToken(hashToken(rawRefreshToken));

  if (!stored || stored.expiresAt < new Date()) {
    throw new Error("invalid_refresh_token");
  }

  const accessToken = await signAccessToken(stored.playerId);
  return { accessToken };
}

export async function canPlayer(playerId: string, rule: string): Promise<boolean> {
  return repo.hasGrant(playerId, rule);
}

export const grantAccess = repo.grantAccess;
export const revokeAccess = repo.revokeAccess;
