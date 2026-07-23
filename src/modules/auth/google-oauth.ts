import { env } from "../../shared/env.js";

const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_USERINFO_URL = "https://www.googleapis.com/oauth2/v3/userinfo";

export interface GoogleProfile {
  sub: string;
  email: string;
  name: string;
  picture?: string;
}

// redirectUri 由呼叫端明確傳入(不在這裡讀寫死的環境變數):auth(Player 登入)跟 admin
// (User 申請/登入)是兩條不同的 callback 路徑,各自要在 Google OAuth client 註冊各自的
// redirect URI,共用同一個值會導致其中一邊的 token 交換失敗(Google 要求兩次請求的
// redirect_uri 完全一致)。
export function buildGoogleAuthUrl(state: string, redirectUri: string): string {
  const params = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: "openid email profile",
    state,
  });

  return `${GOOGLE_AUTH_URL}?${params.toString()}`;
}

export async function exchangeGoogleCode(code: string, redirectUri: string): Promise<GoogleProfile> {
  const tokenRes = await fetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
    }),
  });

  if (!tokenRes.ok) {
    throw new Error("google_token_exchange_failed");
  }

  const { access_token: accessToken } = (await tokenRes.json()) as { access_token: string };

  const profileRes = await fetch(GOOGLE_USERINFO_URL, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (!profileRes.ok) {
    throw new Error("google_userinfo_failed");
  }

  return (await profileRes.json()) as GoogleProfile;
}
