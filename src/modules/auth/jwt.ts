import { Jwt } from "hono/utils/jwt";

const ACCESS_TOKEN_TTL_SECONDS = 15 * 60;

export interface AccessTokenPayload {
  playerId: string;
  exp: number;
}

function getJwtSecret(): string {
  const secret = process.env.JWT_SECRET;
  if (!secret) {
    throw new Error("JWT_SECRET is not configured");
  }
  return secret;
}

export async function signAccessToken(playerId: string): Promise<string> {
  const exp = Math.floor(Date.now() / 1000) + ACCESS_TOKEN_TTL_SECONDS;
  return Jwt.sign({ playerId, exp }, getJwtSecret());
}

export async function verifyAccessToken(token: string): Promise<AccessTokenPayload> {
  const payload = await Jwt.verify(token, getJwtSecret(), "HS256");
  return payload as unknown as AccessTokenPayload;
}
