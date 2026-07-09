# Player 身分驗證採短效 JWT + 可撤銷 refresh token,不用純 server-side session

`auth` 簽發短效期(例如 15 分鐘)的 JWT 作為 access token,其他 service 只驗證簽章與 `exp`,不查資料庫;搭配存在 `auth.refresh_tokens` 表、效期較長且可撤銷的 refresh token,換發 access token 時才查一次資料庫。考慮過純 server-side session(每個 request 都查表,撤銷即時生效)與純 JWT(完全不查表,但撤銷幾乎不會生效),選擇這個混合方案是因為它讓大部分 request 不必查資料庫,同時把撤銷延遲限制在一個 access token 效期之內,是效能與安全之間的折衷。
