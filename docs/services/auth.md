# auth

## 目的

`auth` 是整個 parker-api 的門神,其他四個 service 都要透過它來判斷使用者能不能用。裡面會有 user 的設計,登入方式用 Google Auth,另外也會做 RBAC 權限控管,之後想加什麼規則就一條一條加進去。一開始最基本的規則,其實就是拿來判斷其他四個 service 能不能被使用而已。

RBAC 的 rule 命名採用 `service.resource.action` 的格式,大 service 用 camelCase,例如 `catCare.info.view`。

## 可能功能

- User 註冊 / 登入
- Google OAuth 登入串接
- User 基本資料管理
- RBAC 角色與權限規則設計
- 提供其他四個 service 查詢「這個 user 有沒有權限用我」的介面
- 之後可以陸續新增更多 rule
