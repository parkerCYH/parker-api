export { authRoutes } from "./routes.js";
export { canPlayer, grantAccess, revokeAccess } from "./service.js";
export { buildGoogleAuthUrl, exchangeGoogleCode } from "./google-oauth.js";
export type { GoogleProfile } from "./google-oauth.js";
// 給其他有 Player 路由的 module 用(見 docs/services/auth.md「其他 service 收到 request 時只
// 驗證簽章跟 exp,不查資料庫」):in-process 呼叫,不是新的 HTTP 往返,一樣不查資料庫。
export { verifyAccessToken as verifyPlayerAccessToken } from "./jwt.js";
