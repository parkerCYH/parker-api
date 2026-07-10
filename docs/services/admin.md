# admin (Admin Dashboard)

## 目的

管理其他 side project 的後台 app。操作者是 `User`,跟一般 side project 的 `Player` 是完全不同的身分概念(詳見 [`CONTEXT.md`](../../CONTEXT.md))。登入驗證掛在 `auth` 底下,但可能開放給 Parker 之外的其他 User 登入,因此需要獨立的一套 RBAC。

## 帳號與權限設計

- User 透過 `auth` 的 Google OAuth 登入,但不會像 Player 一樣登入即自動建立帳號 —— 採「申請 → 待審核 → 既有 User 核准」的流程,詳見 [`docs/adr/0001-user-registration-approval-flow.md`](../adr/0001-user-registration-approval-flow.md)
- 登入完成後導回 Admin Dashboard(獨立網域的 Next.js app),不直接把 token 放進 URL——核准的情境用一次性 exchange code,前端後端再拿 code 換 token(POST,不進 URL);待審核的情境直接帶 `status=pending&userId` 導回(不是憑證,沒有額外風險)。詳見 [`docs/adr/0008-admin-login-exchange-code-redirect.md`](../adr/0008-admin-login-exchange-code-redirect.md)
- 第一個 User 由 `SUPER_ADMIN_EMAILS` 環境變數指定,略過審核直接生效,解決系統剛啟動時「沒有既有 User 可以核准」的問題
- **白名單**:只有握有 `admin.whitelist.manage` 規則的 Role(即 Owner)可以管理一份 `admin.invite_whitelist`(email + 預先指定的 Role),命中白名單的申請登入時直接自動核准,不用等手動逐一審核。`SUPER_ADMIN_EMAILS` bootstrap 進來的 User 指派的就是 Owner。詳見 ADR-0001 的 Whitelist 段落
- User RBAC 跟 Player RBAC 是兩套獨立規則表,共用 `namespace.resource.action` 命名慣例(例如 `admin.fitTrack.viewPlayers`),但各自存放在不同的規則表,語意上不混用
- Role/Rule 本身的儲存與管理搬到獨立的 `rbac` module(見 [`docs/services/rbac.md`](rbac.md)、[`docs/adr/0007-rbac-module-pure-rule-collections.md`](../adr/0007-rbac-module-pure-rule-collections.md))——Role 只是一組 rule 的集合,程式碼不對任何角色名稱特判,一個 Role 能做什麼完全由它實際擁有哪些 rule 決定
- `admin` module 對外曝露 `canUser(userId, rule)`,跟 `auth` module 曝露的 `canPlayer(playerId, rule)` 是完全平行的介面,自己內部使用(不曝露給其他 service);內部實作是查 `admin.users` 拿到 `roleId`,再呼叫 `rbac` 的 `roleHasRule(roleId, rule)`

## Admin Dashboard 只打 admin 的 API(Gateway 模式)

Admin Dashboard 前端**只呼叫 `admin` module 的 API**(例如 `GET /api/v1/admin/cat-care/cats`),不會直接打 `cat-care` 等其他 service 的端點。`admin` 的 route 先用 `canUser` 做權限檢查,通過後用 in-process function call 呼叫其他 service module 額外從 `index.ts` 匯出的資料存取函式(例如 `cat-care` 匯出 `listAllCats()`)取得/操作資料再回傳。其他 service 不需要自己開對外端點給 Admin Dashboard,也不需要知道 User/RBAC 的存在——這件事完全在 `admin` 這一層做掉。詳見 [`docs/adr/0005-per-service-admin-endpoints.md`](../adr/0005-per-service-admin-endpoints.md)。

## Role 目錄

先設計 3 個 Role,不做按 service 拆分的精細角色(目前 Admin Dashboard 使用者主要是 Parker 自己,「其他人也可能登入」還只是預留的可能性)。每個 Role 都是普通的規則集合,差別只在於 `rbac.role_rules` 裡實際塞了哪些規則,程式碼不對名稱特判:

- **Owner**:SuperAdmin 的全部規則,再加上 `rbac.roles.manage`(新增/刪除 Role、編輯 Role 的規則清單)與 `admin.whitelist.manage`(管理白名單)這兩條專屬規則。`SUPER_ADMIN_EMAILS` bootstrap 進來的 User 指派這個 Role
- **SuperAdmin**:所有 `admin.*` 規則(審核新 User、指派 Role、看全部 side project 資料),但不含 `rbac.roles.manage`
- **Viewer**:對每個 service 只有唯讀規則(例如 `admin.catCare.viewAll`、`admin.billSplit.viewAll`),不能改資料、不能審核新 User

之後如果真的有多人協作、需要按 service 分工(例如朋友只負責管理 bill-split),再依同樣命名慣例新增更細的 Role。

## 前端技術

Next.js(React),與其他前端保持一致的技術棧慣例,方便共用元件、共用 Hono OpenAPI 產生的 Zod 型別。詳見 [`docs/adr/0003-admin-dashboard-nextjs.md`](../adr/0003-admin-dashboard-nextjs.md)。

## 管轄範圍

管理全部其他 side project,包含 `fit-track`。`fit-track` 的 Player 帳號系統雖然獨立於 `auth` 之外,但這只影響 Player 登入機制,不影響 Admin Dashboard 對它的管理權限。

## 資料庫

獨立的 `admin` schema,存放 User 表與白名單,跟 `auth` schema(管 Player 帳號與 Player RBAC)分開。Role 與 Rule 本身存在另一個獨立的 `rbac` schema(見 [`docs/services/rbac.md`](rbac.md)),不是 `admin` schema 的一部分。

## 可能功能

- User 申請登入(Google OAuth)/ 待審核狀態
- 既有 User 審核並核准新申請、指派 Role(Owner / SuperAdmin / Viewer)
- 白名單管理(新增/移除,登入時自動核准)
- 檢視 / 管理其他 side project(含 fit-track)的資料
