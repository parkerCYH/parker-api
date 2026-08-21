import { describe, expect, it, vi } from "vitest";
import app from "./app.js";

// AUTH_APP_DOMAINS/ADMIN_DASHBOARD_URL 的測試值見 vitest.config.ts。
const CAT_CARE_ORIGIN = "http://test.cat-care.local";
const ADMIN_DASHBOARD_ORIGIN = "http://test.admin-dashboard.local";
const UNKNOWN_ORIGIN = "http://unregistered.example.com";

describe("GET /health (票 10)", () => {
  it("有 VERCEL_GIT_COMMIT_SHA 時,commit 欄位回傳其值", async () => {
    // VERCEL_GIT_COMMIT_SHA 的測試值見 vitest.config.ts,預設 "test-commit-sha"。
    const res = await app.request("/health");

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok", commit: "test-commit-sha" });
  });

  it("沒有 VERCEL_GIT_COMMIT_SHA 時,commit 欄位回傳 null", async () => {
    // env 是模組載入時一次性驗證的單例(shared/env.ts),要模擬「缺這個變數」的狀態
    // 得先 stub 成空字串(t3-env 的 emptyStringAsUndefined 會把它當未設定處理)、
    // 重置模組快取,再動態重新載入 app,才能拿到一份用新環境變數建構出來的 app 實例。
    vi.stubEnv("VERCEL_GIT_COMMIT_SHA", "");
    vi.resetModules();
    const { default: freshApp } = await import("./app.js");

    const res = await freshApp.request("/health");

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok", commit: null });

    vi.unstubAllEnvs();
  });
});

describe("GET /pin (票 03)", () => {
  it("回 200 ok,且不含 /health 的 commit 欄位", async () => {
    const res = await app.request("/pin");

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok" });
  });
});

describe("CORS (ticket #29)", () => {
  it("echoes Access-Control-Allow-Origin for a registered Player app origin", async () => {
    const res = await app.request("/api/v1/cat-care/cats", {
      headers: { origin: CAT_CARE_ORIGIN },
    });
    expect(res.headers.get("access-control-allow-origin")).toBe(CAT_CARE_ORIGIN);
  });

  it("echoes Access-Control-Allow-Origin for the registered Admin Dashboard origin", async () => {
    const res = await app.request("/api/v1/admin/users", {
      headers: { origin: ADMIN_DASHBOARD_ORIGIN },
    });
    expect(res.headers.get("access-control-allow-origin")).toBe(ADMIN_DASHBOARD_ORIGIN);
  });

  it("omits Access-Control-Allow-Origin for an unregistered origin", async () => {
    const res = await app.request("/api/v1/cat-care/cats", {
      headers: { origin: UNKNOWN_ORIGIN },
    });
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("handles a preflight OPTIONS request without reaching the route handler", async () => {
    const res = await app.request("/api/v1/cat-care/cats", {
      method: "OPTIONS",
      headers: {
        origin: CAT_CARE_ORIGIN,
        "access-control-request-method": "POST",
        "access-control-request-headers": "authorization,content-type",
      },
    });

    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-origin")).toBe(CAT_CARE_ORIGIN);
    expect(res.headers.get("access-control-allow-methods")).toContain("POST");
    expect(res.headers.get("access-control-allow-headers")).toContain("Authorization");
  });

  it("does not send CORS headers on unregistered-origin preflight", async () => {
    const res = await app.request("/api/v1/cat-care/cats", {
      method: "OPTIONS",
      headers: {
        origin: UNKNOWN_ORIGIN,
        "access-control-request-method": "GET",
      },
    });

    expect(res.headers.get("access-control-allow-origin")).toBeNull();
  });
});
