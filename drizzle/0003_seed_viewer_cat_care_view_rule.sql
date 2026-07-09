-- Viewer 的具體 admin.* 唯讀規則(留到 cat-care 有東西可管才補,見 ticket #12 的 resolution、
-- ticket #14):admin.catCare.viewAll,讓 admin 的 cat-care gateway route 能檢查權限。
-- 用 SELECT ... WHERE name = 'Viewer' 動態找 role_id,而不是寫死 UUID(migration 0001 生成時
-- 的 id 是 gen_random_uuid() 產生,無法在這裡預先知道)。
INSERT INTO "admin"."role_rules" ("id", "role_id", "rule")
SELECT gen_random_uuid(), "id", 'admin.catCare.viewAll'
FROM "admin"."roles"
WHERE "name" = 'Viewer';
