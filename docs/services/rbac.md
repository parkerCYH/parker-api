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

`admin` module 的 `canUser(userId, rule)` 內部實作是:查 `admin.users` 拿到這個 User 的 `roleId`,再呼叫這裡的 `roleHasRule(roleId, rule)`。

## Role/Rule 的管理介面

沿用 [`docs/adr/0005-per-service-admin-endpoints.md`](../adr/0005-per-service-admin-endpoints.md) 的 gateway 模式:Admin Dashboard 打 `admin` 的 `/api/v1/admin/roles*` 系列端點,`admin` 檢查呼叫者有沒有 `rbac.roles.manage` 規則,通過後才呼叫這裡匯出的管理函式。

## Role 種子資料(由 admin 那邊維護,這裡只存資料)

- **Owner**:SuperAdmin 的全部規則 + `rbac.roles.manage`(能管理 Role/Rule 本身)+ `admin.whitelist.manage`(能管理 `admin` module 的邀請白名單)
- **SuperAdmin**:所有 `admin.*` 規則(核准 User、指派 Role、看全部 side project 資料),但不含 `rbac.roles.manage`
- **Viewer**:各 service 的唯讀規則(例如 `admin.catCare.viewAll`)

之後新增規則,要記得同步決定哪些既有 Role 也要拿到這條規則(例如新規則通常也要塞進 SuperAdmin/Owner)。
