import { env } from "../../shared/env.js";

export type EvePingResult = { ok: boolean; status: number };

// 票 17 walking skeleton：帶票 07 定案的第一組共享密鑰打 eve 的 /ping，
// 證明 parker-api → eve 的認證機制打通。不含任何 Gemini/AI 呼叫。
export async function pingEve(): Promise<EvePingResult> {
  const res = await fetch(new URL("/ping", env.EVE_BASE_URL), {
    headers: { "x-parker-to-eve-key": env.PARKER_TO_EVE_KEY },
  });
  return { ok: res.ok, status: res.status };
}
