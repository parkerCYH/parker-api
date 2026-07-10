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

**例外**:`cats.chip_player_id` 代表這隻貓的晶片登記責任人(概念上對應政府寵物登記的晶片,但不存實際晶片編號),是 `cat_players` 均等規則之外唯一的特殊身分。注意這個欄位刻意不叫 `owner_player_id`——「Owner」在這個專案已經是 User-RBAC 的 Role 名稱(見 `CONTEXT.md`、`docs/services/admin.md`),跟這裡「貓的晶片責任人」是完全不同的概念,取名要避開衝突。

```
cat_care.cats
  id           uuid PK
  name         text not null
  birthdate    date null
  notes        text null
  archived_at     timestamptz null  (封存/軟刪除,見下方「尚未涵蓋的路由」決議)
  chip_player_id  uuid null -> auth.players.id  (晶片登記責任人,見上方「例外」說明)
  created_at      timestamptz not null default now()

cat_care.cat_players  (多對多中間表,不分角色)
  cat_id     -> cat_care.cats.id
  player_id  -> auth.players.id
  PRIMARY KEY (cat_id, player_id)

cat_care.bowel_movements
  id           uuid PK
  cat_id       -> cat_care.cats.id
  recorded_by  -> auth.players.id  (誰記錄的)
  recorded_at  timestamptz not null
  stool_type   text null   (2026-07-10 改列舉,見下方「字串轉 enum」決議;DB 欄位維持 text,由 API 層 z.enum 驗證)
  is_abnormal  boolean not null default false
  notes        text null
  created_at   timestamptz not null default now()

cat_care.weight_records
  id            uuid PK
  cat_id        -> cat_care.cats.id
  measured_by   -> auth.players.id
  measured_at   timestamptz not null
  weight_grams  integer not null  (固定公克,避免單位混亂)
  method        text null  (2026-07-10 改列舉,見下方「字串轉 enum」決議;DB 欄位維持 text,由 API 層 z.enum 驗證)
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
| GET | `/cats/{catId}/bowel-movements` | 排便紀錄列表(支援 `?from=&to=` 日期區間篩選) |
| POST | `/cats/{catId}/weight-records` | 新增體重紀錄 |
| GET | `/cats/{catId}/weight-records` | 體重紀錄列表(支援 `?from=&to=` 日期區間篩選) |
| DELETE | `/cats/{catId}` | 封存貓咪(設定 `archived_at`,非硬刪除) |
| PATCH | `/cats/{catId}/bowel-movements/{id}` | 編輯排便紀錄(僅限 `recorded_by` 本人) |
| PATCH | `/cats/{catId}/weight-records/{id}` | 編輯體重紀錄(僅限 `measured_by` 本人) |
| POST | `/cats/{catId}/players` | 邀請 Player 加入(body `{ email }`,查 `auth.players` 既有帳號) |
| DELETE | `/cats/{catId}/players/me` | 自己退出(僅限本人;持有 `chip_player_id` 身分者不可退出,須先轉移) |
| PUT | `/cats/{catId}/chip-player` | 設定/轉移晶片登記責任人(目標須先是成員) |

`GET /cats`、`GET /cats/{catId}` 預設排除已封存的貓咪。

**已知缺口(2026-07-10 第二輪發現,見下方「尚未涵蓋的路由」)**:`catSchema` 目前沒有回傳 `chipPlayerId`,也沒有任何端點能讀出一隻貓目前的 `cat_players` 成員名單——寫入操作(邀請/退出/轉移)都做了,讀取沒有對應補上。

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

## 已定案並實作完成的決策記錄

以下原本是規格文件中的開放問題,已於 2026-07-10 定案並實作完成:

- 刪除貓咪採**封存**(`cats.archived_at`),不做硬刪除——歷史健康紀錄即使貓咪過世或停止追蹤仍有回顧價值
- `/bowel-movements/{id}`、`/weight-records/{id}` 新增 **PATCH 編輯**,不維持純唯讀——手動輸入健康數據容易打錯,純新增/刪除重打會弄亂歷史紀錄的時序
- Admin Dashboard gateway 對已封存的貓咪維持**可見**,與 Player app 排除已封存的行為不同
- `cat_players` 邀請:`POST /cats/{catId}/players` 用 email 查 `auth.players` 既有帳號並加入,不做邀請碼/連結——cat-care 是家庭共用工具,邀請對象都是已知的家人/朋友,不需要公開產品那種邀請碼機制
- `cat_players` 退出:`DELETE /cats/{catId}/players/me` 僅限本人自己退出,不能移除他人
- 新增 `cats.chip_player_id`(晶片登記責任人,概念對應寵物晶片登記,不存實際晶片編號):設定時必須先是 `cat_players` 成員;一旦設定就不會被清空,只能轉移給另一位現有成員;持有此身分者不能直接退出 `cat_players`,須先轉移責任人身分給別人。沒有 `chip_player_id` 的貓維持原規則:不能退到零成員(避免貓變孤兒、Player app 側沒有任何人能管理,雖然 Admin gateway 仍看得到)
- 排便/體重歷史列表新增 `?from=&to=` 日期區間篩選,不做 pagination——單一家庭小工具的紀錄量不會大到需要分頁

## 字串轉 enum(2026-07-10 定案,待實作)

盤點 cat-care 所有 API 的 string 欄位,只有以下兩個原本標記「自由文字或小型分級」的欄位改列舉,其餘(`name`、`notes` 全部、`email`)維持自由文字/格式驗證,不列舉。DB 欄位維持 `text`,比照 `admin` module 現有的 `userStatusSchema`/`roleNameSchema` 做法,只在 API 層用 `z.enum([...])` 驗證,不建 Postgres enum type、不加 CHECK constraint:

- `bowel_movements.stoolType`:`normal`(正常)/ `hard`(偏硬)/ `soft`(偏軟或糊狀)/ `watery`(水便)/ `bloody`(帶血)/ `mucous`(有黏液)。與既有的 `isAbnormal` boolean 互補——`isAbnormal` 標記異常,`stoolType` 描述具體形狀
- `weight_records.method`:`catScale`(貓用體重計)/ `holdAndSubtract`(抱著稱+人重相減)/ `other`(其他,避免日後真的出現第三種量測方式被固定值鎖死)

實際的英文 key 命名由實作時對齊既有慣例微調即可,不需要另外確認。

## 尚未涵蓋的路由(2026-07-10 第二輪,前端試接後發現)

- **`GET /cats/{catId}/players`(缺,應補)**:讀出一隻貓目前的 `cat_players` 成員名單。邀請/退出/轉移晶片登記人這些寫入操作都做了,但完全沒有對應的讀取端點,前端「共同照護者區塊」做不出來。
- **`catSchema` 補上 `chipPlayerId`(缺,應補)**:`GET /cats`、`GET /cats/{catId}` 目前不回傳 `chipPlayerId`,即使已經用 `PUT /cats/{catId}/chip-player` 設定過。這是回應欄位漏掉,不是設計問題。
- **`DELETE /cats/{catId}/bowel-movements/{id}`、`DELETE /cats/{catId}/weight-records/{id}`(缺,應補)**:目前單筆紀錄只有 PATCH 編輯,沒有刪除。整隻貓的封存邏輯(保留歷史回顧價值)不適用單筆數據點——打錯整筆想刪掉是合理需求,不需要比照封存做軟刪除,直接 hard delete,權限比照 PATCH 限本人。
- **排便歷史 `isAbnormal` query 篩選(不補)**:跟「不做 pagination」是同一個判斷——單一家庭小工具的紀錄量小到可以整批抓回來,前端拿到 `isAbnormal` 欄位後自己 `.filter()` 幾乎零成本,不值得為了一個 boolean 篩選多開後端 query 參數。若未來資料量成長到真的需要 pagination,這個判斷要重新評估(屆時篩選才會變成前端做不到的事)。
