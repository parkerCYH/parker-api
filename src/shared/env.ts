import { createEnv } from "@t3-oss/env-core";
import { z } from "zod";
import type { AppDomainConfig } from "../modules/auth/app-domains.js";

// 型別安全的環境變數集中存取點(票 01 定案):process.env.X 散落在十個檔案裡各自 `?? ""` 兜底,
// 缺漏的變數不會在啟動時被發現,而是拖到對應 route 被打到才噴出一句看不懂的業務錯誤(見
// parker-api-env-loading/spec.md)。改用 createEnv() 在啟動時一次驗證,缺漏或格式錯誤直接讓
// 進程無法啟動。
//
// DATABASE_URL、JWT_SECRET、AUTH_APP_DOMAINS 是「少了就無法正確運作」的必要變數,改成 required。
// 其餘變數(Google OAuth 相關、ADMIN_DASHBOARD_URL、SUPER_ADMIN_EMAILS)在系統生命週期的某些
// 階段本來就合法留空(例如還沒申請 Google OAuth client、還沒有需要 bootstrap 的 SuperAdmin),
// 維持原本 `?? ""` 的寬鬆語意,只是集中定義、給型別。
export const env = createEnv({
  server: {
    DATABASE_URL: z.string().min(1),
    JWT_SECRET: z.string().min(1),
    AUTH_APP_DOMAINS: z.string().transform((value, ctx) => {
      try {
        return JSON.parse(value) as Record<string, AppDomainConfig>;
      } catch {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: "AUTH_APP_DOMAINS must be valid JSON" });
        return z.NEVER;
      }
    }),
    PORT: z.coerce.number().int().positive().default(3001),
    GOOGLE_CLIENT_ID: z.string().default(""),
    GOOGLE_CLIENT_SECRET: z.string().default(""),
    GOOGLE_REDIRECT_URI: z.string().default(""),
    ADMIN_GOOGLE_REDIRECT_URI: z.string().default(""),
    ADMIN_DASHBOARD_URL: z.string().default(""),
    SUPER_ADMIN_EMAILS: z.string().default(""),
  },
  runtimeEnv: process.env,
  emptyStringAsUndefined: true,
});
