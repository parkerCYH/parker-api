import { describe, expect, it } from "vitest";
import app from "../../app.js";
import { countRequests } from "./index.js";

describe("usageLogMiddleware(票 04)", () => {
  it("記錄一般請求", async () => {
    const before = await countRequests();

    await app.request("/health");

    expect(await countRequests()).toBe(before + 1);
  });

  it("不記錄 /pin(票 03)", async () => {
    const before = await countRequests();

    await app.request("/pin");

    expect(await countRequests()).toBe(before);
  });
});
