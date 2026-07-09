export { authRoutes } from "./routes.js";
export { canPlayer, grantAccess, revokeAccess } from "./service.js";
export { buildGoogleAuthUrl, exchangeGoogleCode } from "./google-oauth.js";
export type { GoogleProfile } from "./google-oauth.js";
