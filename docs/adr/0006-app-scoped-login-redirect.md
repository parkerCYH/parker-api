# Player 登入用 domain 對照表判斷 app,不用前端傳參數

各 side project 有自己的登入介面,但共用同一個 `auth` 的 Google OAuth、Player 身分與 JWT/refresh token 機制。前端不需要在登入請求上額外帶任何參數(例如 `app=catCare`)——`auth` 讀取請求的 `Referer` header 取得發起登入的網域,查伺服器端維護的「網域 → app」對照表,決定:

1. 用 `canPlayer(playerId, '<app>.access')` 檢查這個 Player 有沒有權限用該 app
2. 登入完成後導回這個網域對應設定好的網址

`Referer` 而非 `Origin`,是因為導去 `/api/v1/auth/google` 是一般的瀏覽器頁面導轉(使用者點登入連結),不是 fetch/XHR——`Origin` header 在這種請求通常不會帶,`Referer` 才是瀏覽器導轉時記錄「從哪個頁面來」的機制。

若 `Referer` 缺失(使用者瀏覽器隱私設定、或前端自己設了 `Referrer-Policy: no-referrer`)導致查不到對應的 app,直接回 400 拒絕,不做預設 app 的 fallback——因為這些前端都是自己掌控的網站,可以確保不要設會阻擋 `Referer` 的 policy,比起 fallback 到某個預設 app、讓使用者悄悄登入錯 app 更安全。

導回網址一樣不接受前端指定,只能是對照表裡登記過的網址,避免 open redirect。
