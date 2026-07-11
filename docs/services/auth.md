# auth

## 目的

`auth` 是整個 parker-api 的門神,其他 service 都要透過它來判斷 Player 能不能用。裡面會有 Player 的設計,登入方式用 Google Auth,另外也會做 RBAC 權限控管,之後想加什麼規則就一條一條加進去。

RBAC 的 rule 命名採用 `service.resource.action` 的格式,大 service 用 camelCase。

## Player-RBAC:粗粒度開關

現階段不做細粒度的 resource/action 區分,每個 service 只有一條規則,固定用 `access` 當 action,決定這個 Player 能不能用整個 service,例如 `catCare.access`、`billSplit.access`。之後如果真的需要更細的權限(例如「只能看自己的資料」vs「能看全部」),再依同樣命名慣例新增規則即可,不需要改變架構。

## Session / Token 機制

採 **短效 JWT(access token)+ 可撤銷的 refresh token** 的混合方案:

- Player 用 Google OAuth 登入成功後,`auth` 簽發一組:
  - **access token**:短效期 JWT(例如 15 分鐘),內含 `playerId`。其他 service 收到 request 時只驗證簽章跟 `exp`,不查資料庫,符合 Player-RBAC in-process function call 的精神——大部分 request 完全不打資料庫。
  - **refresh token**:存在 `auth.refresh_tokens` 表,效期較長(例如 7 天),用來換發新的 access token。換發當下才會查一次資料庫,順便確認這個 Player 有沒有被撤銷。
- 這個機制平衡了「大部分請求不查資料庫」的效能,跟「撤銷後最多等一個 access token 效期(15 分鐘)就會生效」的安全性,比起純 JWT(撤銷幾乎不會生效)跟純 server-side session(每個 request 都要查表)都更折衷。

```
auth.refresh_tokens
  id           uuid PK
  player_id    -> auth.players.id
  token_hash   text not null   (存 hash,不存明文)
  expires_at   timestamptz not null
  revoked_at   timestamptz null
  created_at   timestamptz not null default now()
```

## 各 app 有自己的登入介面,但登入機制/身分完全共用

每個 side project(cat-care、rent-sniper、weather、bill-split)有自己的前端、自己的登入畫面,但實際的 Google OAuth 交換、Player 身分、JWT/refresh token 機制完全共用同一套 `auth`,不會像 `fit-track` 一樣獨立出去。

前端**不需要傳任何額外參數**。`auth` 讀取請求的 `Referer` header 取得發起登入的網域,查伺服器端維護的「網域 → app」對照表,`auth` 的 callback 收到後:

1. 用 `canPlayer(playerId, '<app>.access')` 檢查這個 Player 有沒有權限用這個 app,沒有就擋下來,不發 token
2. 通過後,依對照表把登入結果導回對應的網址

若 `Referer` 缺失(瀏覽器隱私設定、或前端設了 `Referrer-Policy: no-referrer`)導致查不到對應的 app,直接回 400 拒絕,不做預設 app 的 fallback。**導回網址不接受前端指定**,只能是對照表裡登記過的網址,避免 open redirect。詳見 `docs/adr/0006-app-scoped-login-redirect.md`。

## Google 授權失敗/取消的處理(2026-07-10 定案,待實作)

原本的實作只處理了成功路徑,使用者在 Google 同意畫面按取消、或 Google token 交換/取 profile 失敗時,會停在 `parker-api` 自己的網域看到一坨 JSON,cat-care 等前端完全沒有機會接手顯示友善訊息。定案:

- 只要 `state` cookie 能正確解碼出 `payload.redirectUrl`(不管有沒有 `code`),就一律 302 導回 `${redirectUrl}?error=<code>`——`access_denied`(使用者取消)、`google_auth_failed`(token 交換或取 profile 失敗)。跟成功路徑一樣是「導回 app、用 query param 帶結果」,前端只要多檢查一個 `error` 參數
- 只有真正的 CSRF 情境(`state` cookie 不存在、或跟 query 的 `state` 對不上,通常是 state cookie 5 分鐘 `maxAge` 過期或請求被竄改)才維持原本的 400 JSON——這種情況本來就不知道該導去哪個 app,無法安全地 redirect
- 目前 `forbidden_app`(403,Player 通過 Google 驗證但沒有這個 app 的權限)**不在這次範圍內**——那是另一個已知的業務邏輯分支(見上方權限檢查),回應形狀要不要改成一致的 redirect-with-error 是獨立的決定,沒有一併定案

cat-care(以及其他共用 `auth` 的 app)前端拿到 `redirectUrl` 上的 `?error=` 之後,不要嘗試解析 `accessToken`/`refreshToken`,改顯示對應的失敗訊息(例如「登入已取消,請重新登入」)並提供重試入口即可。

## cat-care 登入即自動授權(2026-07-10 定案,待實作)

`<app>.access` 這條粗粒度開關原本設計成需要另外核准/授予(見上方「Player-RBAC:粗粒度開關」),但一直沒有任何管道能發 `catCare.access`——沒有對外端點、沒有 bootstrap,連開發者自己測都得直接下 SQL。實測時發現這件事,PM session 討論後定案:

- **只針對 `cat-care` 這個 app**:Google 授權成功、`payload.app === "catCare"` 時,登入 callback 在檢查 `canPlayer` 之前先呼叫 `grantAccess(player.id, "catCare.access")`(`grantAccess` 本身用 `onConflictDoNothing`,天生 idempotent,不用先查有沒有再決定要不要發)。實務上等於 cat-care 的 `forbidden_app` 403 分支永遠不會被觸發——任何完成 Google 登入的人都能用 cat-care
- **理由**:`cat-care` 的每一支 API(除了 `POST /cats`)都已經要求呼叫者是該貓的 `cat_players` 成員,真正的資料存取邊界早就由 email 邀請制的 `cat_players` 管住。`catCare.access` 這道關卡在有了 `cat_players` 之後,實際上只剩下「擋住還沒被邀請、也還沒建過貓的人」這個作用,不值得為此另外維護一套核准機制——cat-care 是家庭共用的健康記錄工具,不是要嚴格控管的系統
- **不影響其他 app**:這次只改 cat-care 這一條分支,`fit-track`、`rent-sniper`、`weather`、`bill-split` 的 `<app>.access` 檢查維持原樣(需要人工授予)。這幾個 service 的規劃本身也還沒定案(見 Parker-API 實作前規劃 Map 的 frontier),各自要不要比照 cat-care 開放登入,等各自規劃時再決定,不在這次範圍
- **`POST /cats` 沒有額外邀請門檻**:任何登入過 cat-care 的人都能直接建立新貓、自己成為第一個成員。這維持現況(ticket #13 本來就是這樣設計),這次沒有一併重新討論

詳見 `docs/services/cat-care.md`。

## 可能功能

- Player 註冊 / 登入
- Google OAuth 登入串接
- Player 基本資料管理
- RBAC 角色與權限規則設計
- 提供其他 service 查詢「這個 Player 有沒有權限用我」的介面(驗證 JWT,不需額外查詢)
- 之後可以陸續新增更多 rule
