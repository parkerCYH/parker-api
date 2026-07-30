import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { env } from "../../shared/env.js";
import { pingEve } from "./client.js";

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
