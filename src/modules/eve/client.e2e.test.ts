import { createServer, type Server } from "node:http";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { env } from "../../shared/env.js";
import { pingEve, requestBloodworkRecognition, requestChatReply, requestHealthAdvice } from "./client.js";

// 用一個模擬 eve /ping 驗證行為的假伺服器（帶正確共享密鑰回 200、否則回 401）取代真正的
// apps/eve，讓票 17 的 walking skeleton 契約可以在 CI 重現，不依賴真的 eve 服務跑起來。
// 監聽的位置固定對應 vitest.config.ts 設的 EVE_BASE_URL/PARKER_TO_EVE_KEY 測試值。
let server: Server;

beforeAll(async () => {
  server = createServer((req, res) => {
    const key = req.headers["x-parker-to-eve-key"];
    if (req.url === "/ping" && key === env.PARKER_TO_EVE_KEY) {
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ok: true }));
      return;
    }
    res.writeHead(401, { "content-type": "application/json" }).end(JSON.stringify({ ok: false }));
  });

  const url = new URL(env.EVE_BASE_URL);
  await new Promise<void>((resolve) => server.listen(Number(url.port), url.hostname, resolve));
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("pingEve (票 17 walking skeleton)", () => {
  it("帶正確的 PARKER_TO_EVE_KEY 打 eve /ping 成功", async () => {
    const result = await pingEve();
    expect(result).toEqual({ ok: true, status: 200 });
  });

  it("帶錯誤或缺少密鑰打 eve /ping 會被拒絕", async () => {
    const url = new URL("/ping", env.EVE_BASE_URL);

    const wrongKey = await fetch(url, { headers: { "x-parker-to-eve-key": "wrong-key" } });
    expect(wrongKey.status).toBe(401);

    const missingKey = await fetch(url);
    expect(missingKey.status).toBe(401);
  });
});

// eve 真的斷線/連不上(DNS 失敗、連線被拒、逾時)時 fetch 本身會 throw,不是回傳非 2xx 的
// Response——這種情況下每個呼叫端都要能跟「eve 回了非 2xx」一樣被優雅地歸類成「打不到 eve」,
// 不能讓例外往上炸穿變成 app.onError 兜底的通用 500(手動驗證票 25 時發現的缺口)。
// 用 vi.stubGlobal 讓 fetch 直接 reject,模擬連線層例外(跟上面用假伺服器回應 4xx/2xx 是不同層次
// 的失敗)。
describe("eve 連線層例外(fetch 本身 throw,不是回傳非 2xx)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function stubFetchToThrow() {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("fetch failed");
      }),
    );
  }

  it("pingEve 優雅回傳 ok:false,不會讓例外往外拋", async () => {
    stubFetchToThrow();
    await expect(pingEve()).resolves.toEqual({ ok: false, status: 0 });
  });

  it("requestBloodworkRecognition 優雅回傳 ok:false,不會讓例外往外拋", async () => {
    stubFetchToThrow();
    const result = await requestBloodworkRecognition({
      photo: { data: Buffer.from("fake"), mediaType: "image/jpeg", filename: "test.jpg" },
      jobId: "job-1",
      callbackUrl: "http://parker-api.test/callback",
    });
    expect(result).toEqual({ ok: false, status: 0 });
  });

  it("requestChatReply 優雅回傳 eve_unreachable,不會讓例外往外拋", async () => {
    stubFetchToThrow();
    const result = await requestChatReply({
      catCareData: {
        cat: { name: "test", birthdate: null, notes: null },
        bowelMovements: [],
        weightRecords: [],
        fluidInjections: [],
        bloodworkRecords: [],
      },
      messages: [{ role: "user", content: "hi" }],
    });
    expect(result).toEqual({ kind: "eve_unreachable" });
  });

  it("requestHealthAdvice 優雅回傳 eve_unreachable,不會讓例外往外拋", async () => {
    stubFetchToThrow();
    const result = await requestHealthAdvice([]);
    expect(result).toEqual({ kind: "eve_unreachable" });
  });
});
