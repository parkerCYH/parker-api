# parker-api

單一 Modular Monolith,同時撐起 5 個獨立 side project 加上一個管理它們的後台。這份 glossary 定義跨越整個專案的核心詞彙,避免「使用者」這種詞在不同情境下混用。

## Language

**Player**:
任一 side project(cat-care、fit-track、rent-sniper、weather,以及未來新增的 app)的終端使用者。大部分 Player 透過 `auth` service 取得全域帳號;`fit-track` 是例外,有自己獨立的 Player 帳號系統,不掛在 `auth` 底下。
_Avoid_: User(當指的是終端使用者時一律用 Player,不用 User)、使用者、Account

**User**:
Admin Dashboard 的操作者,也就是管理 5 個 app 的後台管理員。User 透過 `auth` 登入,並套用 Admin Dashboard 專屬的 RBAC 規則來決定能管哪些 app、哪些資料。
_Avoid_: Player、Admin、管理員(當作名詞使用時一律用 User)

**Admin Dashboard**:
管理 5 個 side project 的後台 app。登入驗證掛在 `auth` 底下,但操作者是 User,不是 Player。可能開放給 Parker 之外的其他 User 登入,因此需要獨立的一套 RBAC。管轄範圍涵蓋全部 5 個 app,包含 `fit-track` —— 即使 fit-track 的 Player 帳號系統獨立於 `auth` 之外,Admin Dashboard 仍能管理它,因為「Player 登入機制獨不獨立」跟「User 能不能在後台管理這個 app」是兩件事。
_Avoid_: 後台、管理後台
