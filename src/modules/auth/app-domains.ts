export interface AppDomainConfig {
  app: string;
  redirectUrl: string;
}

// 網域 → app 對照表(ADR-0006)。伺服器端維護,前端不用傳任何參數;導回網址只能是這裡登記過的,
// 避免 open redirect。格式見 .env.example 的 AUTH_APP_DOMAINS(JSON,key 是 host,不含 scheme)。
function loadAppDomainTable(): Record<string, AppDomainConfig> {
  const raw = process.env.AUTH_APP_DOMAINS;
  if (!raw) return {};

  try {
    return JSON.parse(raw) as Record<string, AppDomainConfig>;
  } catch {
    return {};
  }
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
