# cat-care

## 目的

主要服務對象是我家的貓。牠目前腎臟有點問題,需要做飲食控制,所以需要記錄牠拉屎的時間跟量體重的時間,方便追蹤健康狀況。

## 可能功能

- 記錄貓咪排便時間
- 記錄貓咪體重與量測時間
- 依賴 `auth` service 做登入驗證
- 查看歷史紀錄

## 資料表設計

貓咪本身是獨立實體(`cats`),與 `auth.players` 是多對多關係(透過 `cat_players` 中間表),方便未來多隻貓、或多個 Player 共同管理同一隻貓,不需要重新設計 schema。中間表不分角色,所有列在其中的 Player 權限均等——cat-care 是家庭共用的健康記錄工具,不需要像權限管理系統那樣細分。

```
cat_care.cats
  id           uuid PK
  name         text not null
  birthdate    date null
  notes        text null
  archived_at  timestamptz null  (封存/軟刪除,見下方「尚未涵蓋的路由」決議)
  created_at   timestamptz not null default now()

cat_care.cat_players  (多對多中間表,不分角色)
  cat_id     -> cat_care.cats.id
  player_id  -> auth.players.id
  PRIMARY KEY (cat_id, player_id)

cat_care.bowel_movements
  id           uuid PK
  cat_id       -> cat_care.cats.id
  recorded_by  -> auth.players.id  (誰記錄的)
  recorded_at  timestamptz not null
  stool_type   text null   (自由文字或小型分級,不用 enum)
  is_abnormal  boolean not null default false
  notes        text null
  created_at   timestamptz not null default now()

cat_care.weight_records
  id            uuid PK
  cat_id        -> cat_care.cats.id
  measured_by   -> auth.players.id
  measured_at   timestamptz not null
  weight_grams  integer not null  (固定公克,避免單位混亂)
  method        text null  (自由文字/小型分級,例如「抱著稱+人重相減」、「貓用體重計」)
  notes         text null
  created_at    timestamptz not null default now()
```

## API 一覽:Player app vs Admin Dashboard

### Player app(cat-care 自己的 API)

掛在 `/api/v1/cat-care/*`,每支都要 Player Bearer token,並通過 `canPlayer(playerId, "catCare.access")` 檢查。Swagger tag:`cat-care`。

| Method | Path | 說明 |
|---|---|---|
| POST | `/cats` | 新增貓咪 |
| GET | `/cats` | 列出貓咪 |
| GET | `/cats/{catId}` | 單一貓咪詳情 |
| POST | `/cats/{catId}/bowel-movements` | 新增排便紀錄 |
| GET | `/cats/{catId}/bowel-movements` | 排便紀錄列表 |
| POST | `/cats/{catId}/weight-records` | 新增體重紀錄 |
| GET | `/cats/{catId}/weight-records` | 體重紀錄列表 |
| DELETE | `/cats/{catId}` | 封存貓咪(設定 `archived_at`,非硬刪除) |
| PATCH | `/cats/{catId}/bowel-movements/{id}` | 編輯排便紀錄(僅限 `recorded_by` 本人) |
| PATCH | `/cats/{catId}/weight-records/{id}` | 編輯體重紀錄(僅限 `measured_by` 本人) |

`GET /cats`、`GET /cats/{catId}` 預設排除已封存的貓咪。

### Admin Dashboard(透過 admin 的 gateway route)

cat-care 不開任何對外端點給 Admin Dashboard 直接打,也不需要知道 User/RBAC 的存在。以下端點實際掛在 `/api/v1/admin/cat-care/*`(Swagger tag:`admin`),要 User Bearer token 並通過 `admin.catCare.viewAll` 規則檢查;`admin` module 通過檢查後才 in-process 呼叫 `cat-care` 從 `index.ts` 額外匯出的資料存取函式(例如 `listAllCats()`)取得跨 Player 的全部資料。權限檢查(`canUser`)完全由 `admin` module 負責,詳見 [`docs/adr/0005-per-service-admin-endpoints.md`](../adr/0005-per-service-admin-endpoints.md)。

| Method | Path | 說明 |
|---|---|---|
| GET | `/cat-care/cats` | 全部 Player 的貓咪列表 |
| GET | `/cat-care/cats/{catId}` | 單一貓咪詳情 |
| GET | `/cat-care/cats/{catId}/bowel-movements` | 該貓排便歷史 |
| GET | `/cat-care/cats/{catId}/weight-records` | 該貓體重歷史 |
| GET | `/cat-care/players` | cat-care 相關 Player 列表 |
| GET | `/cat-care/players/{playerId}` | 單一 Player 詳情 |

Admin gateway 預設**包含**已封存的貓咪及其歷史紀錄(不像 Player app 那樣排除)——健康追蹤資料在貓咪封存後(過世/停止追蹤)仍有回顧價值,回應多一個 `archivedAt` 欄位供前端判斷即可。

## 尚未涵蓋的路由(已定案,待實作)

以下原本是規格文件中的開放問題,已於 2026-07-10 定案,尚未實作,見對應 ticket:

- 刪除貓咪採**封存**(`cats.archived_at`),不做硬刪除——歷史健康紀錄即使貓咪過世或停止追蹤仍有回顧價值
- `/bowel-movements/{id}`、`/weight-records/{id}` 新增 **PATCH 編輯**,不維持純唯讀——手動輸入健康數據容易打錯,純新增/刪除重打會弄亂歷史紀錄的時序
- Admin Dashboard gateway 對已封存的貓咪維持**可見**,與 Player app 排除已封存的行為不同
