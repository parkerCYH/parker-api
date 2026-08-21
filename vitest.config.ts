import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    // *.scan.test.ts:ADR-0004 的例外——原始碼靜態掃描,不是 e2e,不打 Postgres。
    include: ["src/**/*.e2e.test.ts", "src/**/*.scan.test.ts"],
    passWithNoTests: true,
    // usage-log middleware(票 04)是掛在整個 app 上的全域 side effect,每個 e2e 測試打的每個
    // request 都會寫進同一張 usage_log.requests 表。usage-log 自己的測試需要靠「前後 count
    // 差多少」斷言,若不同測試檔平行跑會彼此污染這個全域計數,因此關掉檔案間平行執行。
    fileParallelism: false,
    env: {
      DATABASE_URL:
        process.env.TEST_DATABASE_URL ?? "postgres://parker:parker@localhost:5432/parker_api_test",
      JWT_SECRET: process.env.JWT_SECRET ?? "test-jwt-secret",
      GOOGLE_CLIENT_ID: process.env.GOOGLE_CLIENT_ID ?? "test-google-client-id",
      GOOGLE_CLIENT_SECRET: process.env.GOOGLE_CLIENT_SECRET ?? "test-google-client-secret",
      GOOGLE_REDIRECT_URI:
        process.env.GOOGLE_REDIRECT_URI ?? "http://localhost:3001/api/v1/auth/google/callback",
      ADMIN_GOOGLE_REDIRECT_URI:
        process.env.ADMIN_GOOGLE_REDIRECT_URI ??
        "http://localhost:3001/api/v1/admin/login/google/callback",
      ADMIN_DASHBOARD_URL: process.env.ADMIN_DASHBOARD_URL ?? "http://test.admin-dashboard.local",
      AUTH_APP_DOMAINS:
        process.env.AUTH_APP_DOMAINS ??
        JSON.stringify({
          "test.cat-care.local": {
            app: "catCare",
            redirectUrl: "http://test.cat-care.local/login/callback",
          },
          // 給跨 module 測試用:證明「已透過某個 app 登入、拿到有效 token」跟「對 catCare 有
          // 權限」是兩件事——一個只登入過 otherApp 的 Player 仍然會被 cat-care 自己的
          // canPlayer(playerId, 'catCare.access') 擋下來(見 cat-care/routes.e2e.test.ts)。
          "test.other-app.local": {
            app: "otherApp",
            redirectUrl: "http://test.other-app.local/login/callback",
          },
        }),
      EVE_BASE_URL: process.env.EVE_BASE_URL ?? "http://127.0.0.1:38173",
      PARKER_TO_EVE_KEY: process.env.PARKER_TO_EVE_KEY ?? "test-parker-to-eve-key",
      EVE_TO_PARKER_KEY: process.env.EVE_TO_PARKER_KEY ?? "test-eve-to-parker-key",
      PARKER_API_BASE_URL: process.env.PARKER_API_BASE_URL ?? "http://test.parker-api.local",
      VERCEL_GIT_COMMIT_SHA: process.env.VERCEL_GIT_COMMIT_SHA ?? "test-commit-sha",
    },
  },
});
