# admin (Admin Dashboard)

## 目的

管理其他 5 個 side project 的後台 app。操作者是 `User`,跟一般 side project 的 `Player` 是完全不同的身分概念(詳見 [`CONTEXT.md`](../../CONTEXT.md))。登入驗證掛在 `auth` 底下,但可能開放給 Parker 之外的其他 User 登入,因此需要獨立的一套 RBAC。

## 帳號與權限設計

- User 透過 `auth` 的 Google OAuth 登入,但不會像 Player 一樣登入即自動建立帳號 —— 採「申請 → 待審核 → 既有 User 核准」的流程,詳見 [`docs/adr/0001-user-registration-approval-flow.md`](../adr/0001-user-registration-approval-flow.md)
- 第一個 User 由 `SUPER_ADMIN_EMAILS` 環境變數指定,略過審核直接生效,解決系統剛啟動時「沒有既有 User 可以核准」的問題
- User RBAC 跟 Player RBAC 是兩套獨立規則表,共用 `namespace.resource.action` 命名慣例(例如 `admin.fitTrack.viewPlayers`),但各自存放在不同的規則表,語意上不混用
- User RBAC 有 Role 分層:規則(`admin.*`)綁在 Role 上,核准或調整 User 時只需指派 Role,不用逐條勾規則

## 管轄範圍

管理全部 5 個 side project,包含 `fit-track`。`fit-track` 的 Player 帳號系統雖然獨立於 `auth` 之外,但這只影響 Player 登入機制,不影響 Admin Dashboard 對它的管理權限。

## 資料庫

獨立的 `admin` schema,存放 User 表與 User RBAC 規則表,跟 `auth` schema(管 Player 帳號與 Player RBAC)分開。

## 可能功能

- User 申請登入(Google OAuth)/ 待審核狀態
- 既有 User 審核並核准新申請、指派 Role
- Role 與 `admin.*` 規則的管理介面
- 檢視 / 管理 5 個 side project(含 fit-track)的資料
