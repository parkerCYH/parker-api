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

登入時,前端在導去 Google 的請求上帶一個 `app` 參數(例如 `GET /api/v1/auth/google?app=catCare`),透過 OAuth 的 `state` 帶過 callback。`auth` 的 callback 收到後:

1. 用 `canPlayer(playerId, '<app>.access')` 檢查這個 Player 有沒有權限用這個 app,沒有就擋下來,不發 token
2. 通過後,依 `app` 名稱查伺服器端維護的「app → 導回網址」對照表,把登入結果導回對應的 app

**導回網址不接受前端指定**,只能是 `auth` 自己設定檔/環境變數裡登記過的網址,前端只能傳 app 名稱——避免前端能任意指定 redirect 網址造成 open redirect 風險。詳見 `docs/adr/0006-app-scoped-login-redirect.md`。

## 可能功能

- Player 註冊 / 登入
- Google OAuth 登入串接
- Player 基本資料管理
- RBAC 角色與權限規則設計
- 提供其他 service 查詢「這個 Player 有沒有權限用我」的介面(驗證 JWT,不需額外查詢)
- 之後可以陸續新增更多 rule
