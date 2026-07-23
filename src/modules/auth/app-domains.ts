import { env } from "../../shared/env.js";

export interface AppDomainConfig {
  app: string;
  redirectUrl: string;
}

// 網域 → app 對照表(ADR-0006)。伺服器端維護,前端不用傳任何參數;導回網址只能是這裡登記過的,
// 避免 open redirect。格式見 .env.example 的 AUTH_APP_DOMAINS(JSON,key 是 host,不含 scheme)。
// 解析與驗證交給 src/shared/env.ts 的 schema,啟動時就會擋下格式錯誤,不再靜默降級成空表。
function loadAppDomainTable(): Record<string, AppDomainConfig> {
  return env.AUTH_APP_DOMAINS;
}

// Referer 而非 Origin:導去 /google 是瀏覽器頁面導轉(使用者點登入連結),不是 fetch/XHR,
// Origin header 在這種請求通常不會帶。缺失或查不到都回傳 undefined,呼叫端一律回 400,
// 不做預設 app 的 fallback。
export function resolveAppByReferer(referer: string | undefined): AppDomainConfig | undefined {
  if (!referer) return undefined;

  let host: string;
  try {
    host = new URL(referer).host;
  } catch {
    return undefined;
  }

  return loadAppDomainTable()[host];
}

// 給 CORS middleware 用(ticket #29):AUTH_APP_DOMAINS 裡每個 app 的 redirectUrl 網域部分,
// 不重複、不新增獨立的 CORS env var,跟 resolveAppByReferer 共用同一份設定。
export function listAppOrigins(): string[] {
  const table = loadAppDomainTable();
  const origins = new Set<string>();

  for (const config of Object.values(table)) {
    try {
      origins.add(new URL(config.redirectUrl).origin);
    } catch {
      // 格式錯誤的 redirectUrl 忽略,跟 resolveAppByReferer 對 Referer 的處理一樣寬鬆。
    }
  }

  return [...origins];
}
