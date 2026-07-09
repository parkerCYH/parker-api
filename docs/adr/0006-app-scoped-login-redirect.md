# Player 登入帶 app 參數,導回網址採伺服器端白名單

各 side project 有自己的登入介面,但共用同一個 `auth` 的 Google OAuth、Player 身分與 JWT/refresh token 機制。登入請求帶一個 `app` 名稱(例如 `catCare`),透過 OAuth `state` 帶過 callback,`auth` 的 callback 用它做兩件事:登入時用 `canPlayer(playerId, '<app>.access')` 順便檢查這個 Player 有沒有權限用該 app,以及查伺服器端維護的「app → 導回網址」對照表決定登入完成後導去哪裡。

考慮過讓前端直接帶一個 `redirectUrl` 參數,`auth` 登入完直接導過去,這樣加新 app 不用改 `auth` 的設定。但這等於讓 `auth` 相信任何呼叫端指定的網址,若沒有嚴謹的白名單驗證,就是一個 open redirect 漏洞,可能被用來把使用者導去釣魚頁面。改用伺服器端設定的對照表,前端只能傳 app 名稱、不能指定實際網址,雖然加新 app 時要多一步設定,但杜絕了這個風險。
