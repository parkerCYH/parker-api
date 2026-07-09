# 模組化程式碼結構,搭配 colocated e2e 測試

`src/modules/<service>/` 每個資料夾對應一個 PostgreSQL schema(名稱一致),內部固定分成 `schema.ts`(Drizzle 表定義)、`routes.ts`(Hono OpenAPI 路由 + Zod 驗證)、`service.ts`(商業邏輯)、`repository.ts`(純資料庫存取)、`index.ts`(對外公開介面)。其他 module 只能 import 對方的 `index.ts`,不能直接碰內部檔案 —— 這是唯一強制模組邊界的方式(例如 `cat-care` 查權限只能呼叫 `auth` 的 `canPlayer`,不能直接查 `auth` 的表)。

測試只做 e2e,不特別寫 unit test,測試檔跟 module 放在一起(`routes.e2e.test.ts`),用 Vitest + Hono 的 `app.request()` 直接打整條 API 路徑,接真的 Postgres(本機 `docker-compose.yml` 裡獨立的 `parker_api_test` 資料庫,不用 Testcontainers)。選擇只做 e2e 而非額外分層寫 unit test,是因為單人開發下,e2e 涵蓋「路由 + 驗證 + 商業邏輯 + 資料庫」整條路徑最貼近真實使用情境,維護一份測試比維護 unit + e2e 兩份更省力;選擇打真的 Postgres 而非 mock/Testcontainers,是因為本機開發環境已經有 Docker Compose 的 Postgres,重用它比額外引入新工具更簡單。
