import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.e2e.test.ts"],
    passWithNoTests: true,
    env: {
      DATABASE_URL:
        process.env.TEST_DATABASE_URL ?? "postgres://parker:parker@localhost:5432/parker_api_test",
      JWT_SECRET: process.env.JWT_SECRET ?? "test-jwt-secret",
      GOOGLE_CLIENT_ID: process.env.GOOGLE_CLIENT_ID ?? "test-google-client-id",
      GOOGLE_CLIENT_SECRET: process.env.GOOGLE_CLIENT_SECRET ?? "test-google-client-secret",
      GOOGLE_REDIRECT_URI:
        process.env.GOOGLE_REDIRECT_URI ?? "http://localhost:3000/api/v1/auth/google/callback",
    },
  },
});
