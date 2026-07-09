# RBAC 邏輯搬到獨立的 rbac module,Role 是純粹的規則集合

新增頂層 module `src/modules/rbac/`,對應獨立的 `rbac` PostgreSQL schema,把原本放在 `admin` schema 的 `roles`、`role_rules` 兩張表搬過去。`rbac/index.ts` 只匯出純粹的角色/規則操作:`roleHasRule(roleId, rule)`、`createRole(name)`、`deleteRole(roleId)`、`addRuleToRole(roleId, rule)`、`removeRuleFromRole(roleId, rule)`、`listRoles()`——這個 module **不知道「User」的存在**,只認得 `roleId` 跟 `rule` 字串。

程式碼不再對角色名稱做特判(移除現有 `admin/service.ts` 裡「`roleName === "SuperAdmin"` 直接放行」的邏輯)。任何 Role 能做什麼,完全由它在 `rbac.role_rules` 裡實際被賦予了哪些 rule 決定,不是靠角色名稱在程式碼裡繞過檢查。`admin` module 的 `canUser(userId, rule)` 改成:先查 `admin.users` 拿到這個 User 的 `roleId`,再呼叫 `rbac` 的 `roleHasRule(roleId, rule)`,`admin` 完全不需要知道某個角色是不是「特殊」。

SuperAdmin 要擁有所有 `admin.*` 規則,做法是把每一條規則實際塞進 `rbac.role_rules`(schema migration 的種子資料),之後新增規則時要記得同步塞給 SuperAdmin/Owner。Owner 是 SuperAdmin 的規則清單再加上 `rbac.roles.manage`(建立/刪除 Role、編輯 Role 的規則清單,這個管理能力本身也只是一條普通規則,不是額外的程式碼特例)。Role/Rule 的管理沿用 ADR-0005 的 gateway 模式:Admin Dashboard 打 `admin` 的 `/api/v1/admin/roles*`,`admin` 檢查呼叫者是否有 `rbac.roles.manage` 後,呼叫 `rbac` 匯出的管理函式。

考慮過維持現有的角色名稱特判(較少程式碼),但這樣「這個 Role 實際握有哪些權限」沒辦法從資料庫一眼查到,要翻程式碼才找得到特例,而且每加一個「全權」角色(例如這次的 Owner)都要多加一條特例,特例只會越疊越多。改成純粹的規則集合後,任何角色的權限都能直接查 `rbac.role_rules` 得到答案,查完就是全部事實,不用另外理解程式碼裡藏了什麼特殊分支。
