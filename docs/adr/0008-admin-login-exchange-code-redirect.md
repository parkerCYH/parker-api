# User 登入導回 Admin Dashboard 用一次性 exchange code,不直接帶 token

`admin` 的 Google OAuth callback(`/api/v1/admin/login/google/callback`)目前直接回 JSON,瀏覽器停在 `parker-api` 自己的網域,Admin Dashboard(獨立網域的 Next.js app)完全拿不到這個回應。修正方式:

- 新增 `ADMIN_DASHBOARD_URL` 設定(單一網址,不像 Player 登入的網域對照表——Admin Dashboard 只有一個,不需要對照表)
- 申請通過核准(200 情境):不直接回 token,而是產生一組短效期(例如 60 秒)、單次使用的 exchange code,存在伺服器端(記錄對應的 userId、有效期、是否已使用),導回 `${ADMIN_DASHBOARD_URL}/auth/callback?status=approved&code=<code>`
- Admin Dashboard 的後端(Next.js 的 server-side route/API route)收到這個 code 後,呼叫新端點 `POST /api/v1/admin/login/exchange` body `{ code }`,驗證 code 有效且未使用過、標記為已使用,現場簽發真正的 access/refresh token,回在 JSON body 裡(不是 URL)——這一步才是 token 真正離開 `parker-api` 的地方,而且是伺服器對伺服器的 POST,不會出現在瀏覽器網址列/歷史紀錄/log 裡
- 待審核(202 情境):沒有 token 要保護,直接導回 `${ADMIN_DASHBOARD_URL}/auth/callback?status=pending&userId=<uuid>`,`userId` 不是憑證,帶在 URL 沒有額外風險

考慮過直接比照 Player 登入(ADR-0006)把 accessToken/refreshToken 當 query param 導回去,做法更簡單、跟既有模式一致。但 User 能碰到的資料範圍(透過 Admin Dashboard 管理全部 side project)比單一 Player 大得多,token 短暫出現在 URL 裡的風險(瀏覽器歷史、伺服器 access log、Referer header 外洩給第三方頁面)不值得用「省一支 API」去換,所以 User 登入採用比 Player 登入更保守的一次性 exchange code 模式。Player 登入維持原樣不變。

## 附記(2026-07-11):cat-care 不比照加 server-side 這一層

實測 cat-care(純 Vite SPA)串接時撞到 CORS error,曾討論過要不要幫 cat-care 也加一層像 Admin Dashboard 那樣的後端(伺服器對伺服器轉發,順便繞開 CORS)。結論是不加,原因就是上面這段——admin 會有這層,是因為 User 的資料風險等級比較高,不是因為「這樣比較不會遇到 CORS」。cat-care 是單一家庭範圍的健康記錄工具,風險等級跟 admin 不是同一量級,沒有新理由推翻「Player 登入維持原樣」這個決定。CORS 用正常的手段解——在 `parker-api` 自己的 API 上加 CORS 白名單(見 #29),不透過幫前端多蓋一台伺服器來繞過去。
