import type { Context } from "hono";
import { env } from "../../shared/env.js";

const HEADER_NAME = "x-eve-to-parker-key";

// 驗證 eve → parker-api 方向的共享密鑰(票 07/08 定案),供各情境(票 20/22/24)的 callback
// route 共用——這幾支 route 不是 Player 呼叫,不走 authenticatePlayer,而是服務對服務認證。
export function verifyEveCallback(c: Context): boolean {
  const provided = c.req.header(HEADER_NAME);
  return Boolean(env.EVE_TO_PARKER_KEY) && provided === env.EVE_TO_PARKER_KEY;
}
