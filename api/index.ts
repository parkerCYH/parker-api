import app from "../src/app.js";

// hono/vercel 的 handle(app) 預設 export（(req) => app.fetch(req)）在 Vercel Node.js
// runtime 下被誤判成舊式 (req, res) => void 簽名，回應被丟棄導致 request 掛住不回應
// （實測發現，非本機可重現）。改用具名 HTTP method export + runtime = "nodejs" 讓
// Vercel 用 Web-standard Request/Response 呼叫，避開這個相容性問題。
export const runtime = "nodejs";

export function GET(request: Request) {
  return app.fetch(request);
}
export function POST(request: Request) {
  return app.fetch(request);
}
export function PUT(request: Request) {
  return app.fetch(request);
}
export function PATCH(request: Request) {
  return app.fetch(request);
}
export function DELETE(request: Request) {
  return app.fetch(request);
}
export function OPTIONS(request: Request) {
  return app.fetch(request);
}
