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
