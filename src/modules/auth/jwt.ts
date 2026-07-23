import { Jwt } from "hono/utils/jwt";
import { env } from "../../shared/env.js";

const ACCESS_TOKEN_TTL_SECONDS = 15 * 60;

export interface AccessTokenPayload {
  playerId: string;
  exp: number;
}

export async function signAccessToken(playerId: string): Promise<string> {
  const exp = Math.floor(Date.now() / 1000) + ACCESS_TOKEN_TTL_SECONDS;
  return Jwt.sign({ playerId, exp }, env.JWT_SECRET);
}

export async function verifyAccessToken(token: string): Promise<AccessTokenPayload> {
  const payload = await Jwt.verify(token, env.JWT_SECRET, "HS256");
  return payload as unknown as AccessTokenPayload;
}
