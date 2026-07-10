# rbac

## 目的

管理 User RBAC 的 Role 與 Rule 本身,是一個純粹的內部 module——不對外開放 HTTP 端點,只被 `admin` module 呼叫。詳見 [`docs/adr/0007-rbac-module-pure-rule-collections.md`](../adr/0007-rbac-module-pure-rule-collections.md)。

## 核心概念

Role 只是一組 rule 的集合,程式碼不對任何角色名稱(SuperAdmin、Owner 等)做特判——一個 Role 能做什麼,完全由它在 `rbac.role_rules` 裡實際被賦予了哪些 rule 決定。

## 資料表設計

```
rbac.roles
  id           uuid PK
  name         text not null unique
  created_at   timestamptz not null default now()

rbac.role_rules
  id         uuid PK
  role_id    -> rbac.roles.id
  rule       text not null   (namespace.resource.action,例如 admin.catCare.viewAll)
  UNIQUE (role_id, rule)
  created_at timestamptz not null default now()
```

## 對外介面(給 admin module 呼叫,不對外開 HTTP)

- `roleHasRule(roleId, rule): Promise<boolean>`
- `createRole(name): Promise<Role>`
- `deleteRole(roleId): Promise<void>`
- `addRuleToRole(roleId, rule): Promise<void>`
- `removeRuleFromRole(roleId, rule): Promise<void>`
- `listRoles(): Promise<Role[]>`
- `listRulesForRole(roleId): Promise<string[]>` — 這個 Role 目前實際擁有的規則
- `KNOWN_RULES` — 見下方「規則目錄」

`admin` module 的 `canUser(userId, rule)` 內部實作是:查 `admin.users` 拿到這個 User 的 `roleId`,再呼叫這裡的 `roleHasRule(roleId, rule)`。

## 規則目錄(KNOWN_RULES)

`rbac.role_rules` 只記錄「哪個 Role 有哪條規則」,不記錄「系統裡總共存在哪些規則」——rule 字串是程式碼裡每個 `canUser(...)` 呼叫點隨手寫出來的自由文字,沒有集中登記。為了讓 Owner 在管理介面能從一份完整清單勾選、而不是手動打字,`rbac` module 額外維護一個**靜態常數清單** `KNOWN_RULES`(`{ rule, description }[]`),列出目前系統裡每一條會被檢查的 rule。

這份清單需要人工同步:任何人在程式碼裡新增一個 `canUser(...)` 呼叫用到新的 rule 字串,都要記得同時把它加進 `KNOWN_RULES`,否則這條規則雖然「檢查邏輯上有效」,但管理介面挑不到、只能靠手動打字授權。為了不讓這件事只能靠人記得,新增了一支靜態掃描測試防呆(見 `docs/adr/0004-module-structure-and-e2e-testing.md` 的例外段落):掃描原始碼裡所有 `canUser(...)` 呼叫點的 rule 字串,斷言全部都在 `KNOWN_RULES` 裡,漏掉就會讓測試紅燈。

目前的 `KNOWN_RULES`(User-RBAC 專用,不含 Player-RBAC 的 `<service>.access` 這類規則——那是另一套系統):

- `admin.users.view` — 讀取 User 清單
- `admin.users.approve` — 核准/拒絕申請、調整既有 User 的 Role
- `admin.whitelist.manage` — 管理邀請白名單
- `rbac.roles.manage` — 管理 Role/Rule 本身
- `admin.catCare.viewAll` — 查看 cat-care 的全部資料(gateway)

之後新增 service 的 gateway route,通常也會多一條 `admin.<service>.viewAll` 之類的規則,記得同步加進這份清單。

## Role/Rule 的管理介面

沿用 [`docs/adr/0005-per-service-admin-endpoints.md`](../adr/0005-per-service-admin-endpoints.md) 的 gateway 模式:Admin Dashboard 打 `admin` 的 `/api/v1/admin/roles*` 系列端點,`admin` 檢查呼叫者有沒有 `rbac.roles.manage` 規則,通過後才呼叫這裡匯出的管理函式。

## Role 種子資料(由 admin 那邊維護,這裡只存資料)

- **Owner**:SuperAdmin 的全部規則 + `rbac.roles.manage`(能管理 Role/Rule 本身)+ `admin.whitelist.manage`(能管理 `admin` module 的邀請白名單)
- **SuperAdmin**:所有 `admin.*` 規則(核准 User、指派 Role、看全部 side project 資料),但不含 `rbac.roles.manage`
- **Viewer**:各 service 的唯讀規則(例如 `admin.catCare.viewAll`)

之後新增規則,要記得同步決定哪些既有 Role 也要拿到這條規則(例如新規則通常也要塞進 SuperAdmin/Owner)。
