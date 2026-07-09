import { createHash, randomBytes } from "node:crypto";
import type { GoogleProfile } from "./google-oauth.js";
import { signAccessToken } from "./jwt.js";
import * as repo from "./repository.js";

const REFRESH_TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

async function issueSession(playerId: string) {
  const accessToken = await signAccessToken(playerId);

  const refreshToken = randomBytes(32).toString("hex");
  await repo.insertRefreshToken({
    playerId,
    tokenHash: hashToken(refreshToken),
    expiresAt: new Date(Date.now() + REFRESH_TOKEN_TTL_MS),
  });

  return { accessToken, refreshToken };
}

export async function loginWithGoogleProfile(profile: GoogleProfile) {
  const player =
    (await repo.findPlayerByGoogleSub(profile.sub)) ??
    (await repo.createPlayer({
      googleSub: profile.sub,
      email: profile.email,
      name: profile.name,
      avatarUrl: profile.picture,
    }));

  const session = await issueSession(player.id);

  return {
    ...session,
    player: {
      id: player.id,
      email: player.email,
      name: player.name,
      avatarUrl: player.avatarUrl,
    },
  };
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
