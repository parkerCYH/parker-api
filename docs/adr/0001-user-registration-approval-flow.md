# User(後台管理員)採申請 → 待審核 → 核准的註冊流程

Admin Dashboard 的 User 不是自動註冊(像 Player 一樣登入即建立帳號),也不是靠邀請連結,而是任何人都能用 Google OAuth 登入觸發「申請」,建立一筆無權限的待審核 User 紀錄,再由既有的 User 手動審核核准、賦予權限後才生效。選擇這個流程是因為 User 是能操作 5 個 app 後台資料的敏感身分,需要人為把關,但又不想維護一個手動塞資料庫白名單或另外發送邀請連結的流程。

## Bootstrap

第一個 User 沒有「既有 User」可以核准它,因此用環境變數(例如 `SUPER_ADMIN_EMAILS`)在系統啟動時寫死可信任的 email 清單。核准邏輯特判:email 在這份清單裡的申請,略過審核直接視為已核准的 User(`approved_by` 為 null)。之後這些人登入後台,就能用正常審核流程核准其他人。

## Whitelist(小改:簡化常見情境的手動逐一核准)

在申請審核制之上加一張白名單表 `admin.invite_whitelist`(`email`、`role_id`、`created_by`、`created_at`),讓已知要加入的人不用走「申請 → 等 SuperAdmin 手動核准」,而是先被預先加入白名單、指定好 Role,登入時直接自動核准。

- 新增 **Owner** Role,是 SuperAdmin 的規則超集:擁有 SuperAdmin 的全部規則(核准 User、指派 Role、看全部資料),再加上專屬的 `admin.whitelist.manage` 規則(見 `docs/adr/0007-rbac-module-pure-rule-collections.md`——Role 是純粹的規則集合,`admin.whitelist.manage` 只是實際塞給 Owner、沒塞給 SuperAdmin 的一條普通規則,不是程式碼特判)。`SUPER_ADMIN_EMAILS` bootstrap 進來的 User 指派的是 Owner,不是 SuperAdmin
- 新增白名單時就指定 Role(`{ email, roleName }`),登入時若 email 命中白名單,直接核准並套用該 Role,不需要事後再手動指派
- 白名單核准進來的 User,`approved_by` 設成「新增這筆白名單的人」——單純留審核軌跡用,不作為權限判斷依據(權限判斷完全走 Role/rule,不看 `approved_by`)
- 沒有命中白名單的申請,維持原本「建立待審核紀錄,等有 `admin.users.approve` 規則的人手動核准」的流程,兩套機制並存,不互相取代
