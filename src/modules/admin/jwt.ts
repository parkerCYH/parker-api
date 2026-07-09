import { Jwt } from "hono/utils/jwt";

const ACCESS_TOKEN_TTL_SECONDS = 15 * 60;

export interface AdminAccessTokenPayload {
  userId: string;
  exp: number;
}

function getJwtSecret(): string {
  const secret = process.env.JWT_SECRET;
  if (!secret) {
    throw new Error("JWT_SECRET is not configured");
  }
  return secret;
}

export async function signAdminAccessToken(userId: string): Promise<string> {
  const exp = Math.floor(Date.now() / 1000) + ACCESS_TOKEN_TTL_SECONDS;
  return Jwt.sign({ userId, exp }, getJwtSecret());
}

export async function verifyAdminAccessToken(token: string): Promise<AdminAccessTokenPayload> {
  const payload = await Jwt.verify(token, getJwtSecret(), "HS256");
  return payload as unknown as AdminAccessTokenPayload;
}
