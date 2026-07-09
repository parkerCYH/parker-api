# parker-api 專案說明

這個專案的核心精神很簡單:**用一個精簡的單體 (Monolith) 後端,同時撐起五個完全獨立的 Side Project**。這份文件會把整個架構、資料流,還有一些技術上的設計邏輯整理清楚,方便之後回頭看的時候快速抓到重點。

---

## 🎯 專案核心架構

`parker-api` 走的是模組化單體 (Modular Monolith) 的路線。雖然所有服務都寫在同一個專案裡、跑在同一個 Docker 容器裡,但程式碼跟資料庫結構都盡量保持解耦,彼此不會黏在一起。

### 後端框架選擇

框架選用 Hono,並且用傳統 Node.js 的方式跑,而不是 Edge Function。這樣可以完全避開 Edge Function 冷啟動的問題,讓伺服器穩穩地跑在本地 Docker 環境裡,回應速度也比較有保障。

### 資料驗證與安全防線

API 最前面一定會先過 Zod 這一關。不管是前端(React、Next.js、Flutter 等等)傳過來的網址參數還是 JSON 資料,都要先通過 Zod 的型別檢查。這樣髒資料在進到商業邏輯之前就會被擋下來,不會汙染後面的流程。

### 資料庫映射

資料庫這邊用 Drizzle ORM,負責串接 TypeScript 跟 PostgreSQL。因為 Drizzle 的 Schema 是純 TypeScript 寫的,可以直接跟 Zod 搭配使用,而且底層本來就會強制用「參數化查詢 (Parameterized Queries)」,從根本上避免 SQL Injection 的問題。

---

## 🗄️ 資料庫模組化設計

為了讓五個不同的專案可以塞進同一個資料庫裡又不互相打架,這邊用了 PostgreSQL 的多 Schema(命名空間)機制,把每個專案的資料表在實體上分開。

### 命名空間規劃

資料庫會切成五個 Schema:`auth`、`cat_care`、`fit_track`、`rent_sniper`、`weather`。除了 `auth` 之外,其他四個 Schema 平常互不干涉,維持乾淨。

### 共用帳號機制

`auth` 裡的 `users` 表是整個架構的核心。使用者註冊之後拿到的 user ID,就是全域通用的憑證。其他專案(像 `cat-care` 的貓咪資料表、`weather` 的通知設定表)在設計資料表的時候,都會用跨 Schema 外鍵指回 `auth.users` 的 ID。這樣就能做到「一組帳號,通吃好幾個 Side Project」。

(補充:`fit-track` 比較特別,因為會開放給朋友使用,帳號系統是完全獨立的,細節請看 [`docs/services/fit-track.md`](docs/services/fit-track.md)。)

---

## 🛡️ 資安防禦與錯誤處理機制

以前直接拼 SQL 字串總是讓人提心吊膽,所以這次架構上直接做了兩層防護。

### 強制參數化查詢

不管是用 Drizzle 的高階查詢語法,還是比較彈性的 `sql` 模板字串,變數都會自動被編譯成 PostgreSQL 的安全 placeholder。使用者輸入的內容永遠只會被當成「資料」處理,不會被當成可執行的 SQL 指令,基本上沒有被打穿的空間。

### 錯誤訊息隔離

Hono 的入口會掛一個全域的錯誤攔截器。只要 Drizzle 或資料庫底層出現任何非預期的錯誤,詳細的 SQL 錯誤跟資料庫結構問題都只會寫進後端的 Docker log,不會傳出去。前端拿到的一律是模糊、安全的客製化 JSON 錯誤訊息,避免有心人士靠錯誤訊息反推資料庫設計。

---

## 🌐 API 路由與 Swagger 文件自動化

考慮到之後會有多個前端(Vite、Next、iOS、Flutter)要串接,路由跟文件這邊採取一體化設計,盡量省事。

### 模組化路由

API 路徑會照功能嚴格切分,例如 `/api/v1/auth/*`、`/api/v1/cat-care/*`。這樣開發不同專案的時候,要打哪個服務一目了然,彼此不會互相干擾。

### 路由 + 驗證 + 文件三合一

透過 Hono 的 OpenAPI 套件,路由定義、Zod 欄位驗證、還有 Swagger 文件的 JSON,都會在同一段程式碼裡一次生成。後端路由寫好之後,本地的 `/docs` 頁面就會自動更新出 Swagger UI,不用再手動刻 YAML 文件。

---

## 📚 各服務詳細規劃

各 Side Project 的目的跟功能規劃,整理在 `docs/services` 資料夾裡,另外還有一個管理這些服務的 Admin Dashboard:

- [`docs/services/auth.md`](docs/services/auth.md)
- [`docs/services/cat-care.md`](docs/services/cat-care.md)
- [`docs/services/fit-track.md`](docs/services/fit-track.md)
- [`docs/services/rent-sniper.md`](docs/services/rent-sniper.md)
- [`docs/services/weather.md`](docs/services/weather.md)
- [`docs/services/bill-split.md`](docs/services/bill-split.md)
- [`docs/services/admin.md`](docs/services/admin.md) — 管理其他 service 的後台 app
