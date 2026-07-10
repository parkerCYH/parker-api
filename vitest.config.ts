import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    // *.scan.test.ts:ADR-0004 的例外——原始碼靜態掃描,不是 e2e,不打 Postgres。
    include: ["src/**/*.e2e.test.ts", "src/**/*.scan.test.ts"],
    passWithNoTests: true,
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
    },
  },
});
