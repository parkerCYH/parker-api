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

  const res = await fetch(new URL("/bloodwork/recognize", env.EVE_BASE_URL), {
    method: "POST",
    headers: { "x-parker-to-eve-key": env.PARKER_TO_EVE_KEY },
    body: formData,
  });
  return { ok: res.ok, status: res.status };
}
