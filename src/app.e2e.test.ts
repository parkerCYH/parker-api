import { describe, expect, it } from "vitest";
import app from "./app.js";

// AUTH_APP_DOMAINS/ADMIN_DASHBOARD_URL 的測試值見 vitest.config.ts。
const CAT_CARE_ORIGIN = "http://test.cat-care.local";
const ADMIN_DASHBOARD_ORIGIN = "http://test.admin-dashboard.local";
const UNKNOWN_ORIGIN = "http://unregistered.example.com";

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
