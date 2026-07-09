# Admin Dashboard 只打 `admin` 的 API,由 `admin` module 當 gateway 呼叫其他 service

Admin Dashboard 前端只呼叫 `admin` module 的 API(例如 `GET /api/v1/admin/cat-care/cats`)。`admin` module 的 route 先用 `canUser(userId, rule)` 做權限檢查,通過後再用 in-process function call,呼叫其他 service module 額外從 `index.ts` 匯出的資料存取函式(例如 `cat-care` 匯出 `listAllCats()`)取得/操作資料並回傳。其他 service 不需要自己開任何對外 HTTP 端點給 Admin Dashboard 用,也不需要知道 User/RBAC 的存在——它們只需要多匯出幾個給 `admin` 呼叫的函式,權限檢查完全在 `admin` 這一層完成。

考慮過讓每個 service 自己開一組獨立的 `/admin/*` 端點(各自檢查 `canUser`),但那樣 Admin Dashboard 要面對散落在多個 service 的 API base path,每個 service 都要重複寫一份 OpenAPI 路由文件,而且每個 service 都要額外認識 User 這個身分概念。改用 `admin` 當單一入口後,Admin Dashboard 的 API 介面統一收斂在 `admin` 一處,其他 service 只需要多匯出「資料存取」層級的函式,不需要多一層路由,也不需要知道 User/RBAC 的存在——跟 Player/User 完全分離的既有原則一致。
