import { env } from "../../shared/env.js";
import type { BloodworkValues, HealthAdviceContent } from "../cat-care/schema.js";

// eve 真的斷線/連不上時(DNS 失敗、連線被拒、逾時),fetch 本身會 throw 而不是回傳非 2xx
// 的 Response——這種情況下每個呼叫端都要能跟「eve 回了非 2xx」一樣被歸類成「打不到 eve」,
// 不能讓例外往上炸穿 service.ts 變成 app.onError 兜底的通用 500。集中在這裡包一層 try/catch,
// 呼叫端只需要多處理 res 為 null 的情況即可。
async function safeFetch(url: string | URL, init?: RequestInit): Promise<Response | null> {
  try {
    return await fetch(url, init);
  } catch {
    return null;
  }
}

export type EvePingResult = { ok: boolean; status: number };

// 票 17 walking skeleton：帶票 07 定案的第一組共享密鑰打 eve 的 /ping，
// 證明 parker-api → eve 的認證機制打通。不含任何 Gemini/AI 呼叫。
export async function pingEve(): Promise<EvePingResult> {
  const res = await safeFetch(new URL("/ping", env.EVE_BASE_URL), {
    headers: { "x-parker-to-eve-key": env.PARKER_TO_EVE_KEY },
  });
  if (!res) return { ok: false, status: 0 };

  return { ok: res.ok, status: res.status };
}

export type RequestEveResult = { ok: boolean; status: number };

// 票 20:發起照片辨識作業。帶第一組共享密鑰,以 multipart/form-data 把照片 + job id +
// callback URL 一起送給 eve 的 /bloodwork/recognize。eve 只需回 2xx 代表「已接下這個作業」,
// 實際辨識結果透過 callbackUrl 非同步回報(票 08 定案),這裡不等待、不解析辨識結果本身。
export async function requestBloodworkRecognition(args: {
  photo: { data: Buffer; mediaType: string; filename: string };
  jobId: string;
  callbackUrl: string;
}): Promise<RequestEveResult> {
  const formData = new FormData();
  formData.set("jobId", args.jobId);
  formData.set("callbackUrl", args.callbackUrl);
  formData.set(
    "photo",
    new Blob([new Uint8Array(args.photo.data)], { type: args.photo.mediaType }),
    args.photo.filename,
  );

  const res = await safeFetch(new URL("/bloodwork/recognize", env.EVE_BASE_URL), {
    method: "POST",
    headers: { "x-parker-to-eve-key": env.PARKER_TO_EVE_KEY },
    body: formData,
  });
  if (!res) return { ok: false, status: 0 };

  return { ok: res.ok, status: res.status };
}

export type ChatCatCareData = {
  cat: { name: string; birthdate: string | null; notes: string | null };
  bowelMovements: unknown[];
  weightRecords: unknown[];
  fluidInjections: unknown[];
  bloodworkRecords: unknown[];
};

export type ChatMessage = { role: "user" | "assistant"; content: string };

export type RequestChatReplyResult = { kind: "ok"; response: Response } | { kind: "eve_unreachable" };

// 票 24:對話聊天情境,HTTP POST + 串流回應(票 15 定案)。使用者全部 cat-care 資料由
// parker-api 蒐集後隨請求一併送給 eve,而不是讓 eve 反過來呼叫 parker-api 的讀取 API——
// 兩種都符合票 15 的架構定案,選這個做法是因為 parker-api 本來就有現成的資料存取邏輯
// (repository.ts 的各個 listXxx),不需要為 eve 另開一組認證/讀取端點,也省了一次來回。
// 不像 requestHealthAdvice 解析完整 JSON 回應,這裡直接把 eve 的串流 Response 原樣交回,
// 呼叫端(service.ts)負責邊轉發邊蒐集完整文字存檔。
export async function requestChatReply(payload: {
  catCareData: ChatCatCareData;
  messages: ChatMessage[];
}): Promise<RequestChatReplyResult> {
  const res = await safeFetch(new URL("/chat", env.EVE_BASE_URL), {
    method: "POST",
    headers: { "content-type": "application/json", "x-parker-to-eve-key": env.PARKER_TO_EVE_KEY },
    body: JSON.stringify(payload),
  });
  if (!res || !res.ok || !res.body) return { kind: "eve_unreachable" };

  return { kind: "ok", response: res };
}

export type RequestHealthAdviceResult =
  | { kind: "ok"; advice: HealthAdviceContent }
  | { kind: "eve_unreachable" };

// 票 22:健康建議情境,通訊模式是同步等待(票 14 定案,不套用票 08 的 job id + callback),
// 所以跟 requestBloodworkRecognition 不同,這裡要直接解析 eve 的回應內容當作結果回傳,
// 不是只看 2xx 就結束。
export async function requestHealthAdvice(records: BloodworkValues[]): Promise<RequestHealthAdviceResult> {
  const res = await safeFetch(new URL("/health-advice", env.EVE_BASE_URL), {
    method: "POST",
    headers: { "content-type": "application/json", "x-parker-to-eve-key": env.PARKER_TO_EVE_KEY },
    body: JSON.stringify({ records }),
  });
  if (!res || !res.ok) return { kind: "eve_unreachable" };

  const advice = (await res.json()) as HealthAdviceContent;
  return { kind: "ok", advice };
}
