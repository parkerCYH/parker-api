import { randomUUID } from "node:crypto";

type BloodworkJob = { catId: string; playerId: string };

// 照片辨識作業的暫存對照表(jobId → catId/playerId),供票 20 的非同步 callback 流程找回
// 這筆辨識結果該寫進哪隻貓、記在誰名下。刻意用 process 內記憶體、不落地 DB——job 的生命週期
// 極短(單次辨識請求到 eve callback 回來之間),遺失一筆待處理 job(例如 process 重啟)的
// 後果只是使用者需要重新上傳一次照片,不值得為此新增一張 migration/資料表。
const jobs = new Map<string, BloodworkJob>();

export function createBloodworkJob(catId: string, playerId: string): string {
  const jobId = randomUUID();
  jobs.set(jobId, { catId, playerId });
  return jobId;
}

// 一次性消費:callback 到達(或發起失敗要回收)後即從對照表移除,同一個 jobId 的第二次
// callback 會被視為未知作業。
export function consumeBloodworkJob(jobId: string): BloodworkJob | undefined {
  const job = jobs.get(jobId);
  if (job) jobs.delete(jobId);
  return job;
}
