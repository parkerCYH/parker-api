# admin (Admin Dashboard)

## 目的

管理其他 side project 的後台 app。操作者是 `User`,跟一般 side project 的 `Player` 是完全不同的身分概念(詳見 [`CONTEXT.md`](../../CONTEXT.md))。登入驗證掛在 `auth` 底下,但可能開放給 Parker 之外的其他 User 登入,因此需要獨立的一套 RBAC。

## 帳號與權限設計

- User 透過 `auth` 的 Google OAuth 登入,但不會像 Player 一樣登入即自動建立帳號 —— 採「申請 → 待審核 → 既有 User 核准」的流程,詳見 [`docs/adr/0001-user-registration-approval-flow.md`](../adr/0001-user-registration-approval-flow.md)
- 第一個 User 由 `SUPER_ADMIN_EMAILS` 環境變數指定,略過審核直接生效,解決系統剛啟動時「沒有既有 User 可以核准」的問題
- User RBAC 跟 Player RBAC 是兩套獨立規則表,共用 `namespace.resource.action` 命名慣例(例如 `admin.fitTrack.viewPlayers`),但各自存放在不同的規則表,語意上不混用
- User RBAC 有 Role 分層:規則(`admin.*`)綁在 Role 上,核准或調整 User 時只需指派 Role,不用逐條勾規則
- `admin` module 對外曝露 `canUser(userId, rule)`,跟 `auth` module 曝露的 `canPlayer(playerId, rule)` 是完全平行的介面,自己內部使用(不曝露給其他 service)

## Admin Dashboard 只打 admin 的 API(Gateway 模式)

Admin Dashboard 前端**只呼叫 `admin` module 的 API**(例如 `GET /api/v1/admin/cat-care/cats`),不會直接打 `cat-care` 等其他 service 的端點。`admin` 的 route 先用 `canUser` 做權限檢查,通過後用 in-process function call 呼叫其他 service module 額外從 `index.ts` 匯出的資料存取函式(例如 `cat-care` 匯出 `listAllCats()`)取得/操作資料再回傳。其他 service 不需要自己開對外端點給 Admin Dashboard,也不需要知道 User/RBAC 的存在——這件事完全在 `admin` 這一層做掉。詳見 [`docs/adr/0005-per-service-admin-endpoints.md`](../adr/0005-per-service-admin-endpoints.md)。

## Role 目錄

先設計 2 個 Role,不做按 service 拆分的精細角色(目前 Admin Dashboard 使用者主要是 Parker 自己,「其他人也可能登入」還只是預留的可能性):

- **SuperAdmin**:擁有所有 `admin.*` 規則,含審核新 User、指派 Role 的權限本身
- **Viewer**:對每個 service 只有唯讀規則(例如 `admin.catCare.viewAll`、`admin.billSplit.viewAll`),不能改資料、不能審核新 User

之後如果真的有多人協作、需要按 service 分工(例如朋友只負責管理 bill-split),再依同樣命名慣例新增更細的 Role。

## 前端技術

Next.js(React),與其他前端保持一致的技術棧慣例,方便共用元件、共用 Hono OpenAPI 產生的 Zod 型別。詳見 [`docs/adr/0003-admin-dashboard-nextjs.md`](../adr/0003-admin-dashboard-nextjs.md)。

## 管轄範圍

管理全部其他 side project,包含 `fit-track`。`fit-track` 的 Player 帳號系統雖然獨立於 `auth` 之外,但這只影響 Player 登入機制,不影響 Admin Dashboard 對它的管理權限。

## 資料庫

獨立的 `admin` schema,存放 User 表與 User RBAC 規則表,跟 `auth` schema(管 Player 帳號與 Player RBAC)分開。

## 可能功能

- User 申請登入(Google OAuth)/ 待審核狀態
- 既有 User 審核並核准新申請、指派 Role(SuperAdmin / Viewer)
- Role 與 `admin.*` 規則的管理介面
- 檢視 / 管理其他 side project(含 fit-track)的資料
