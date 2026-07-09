-- DROP TABLE ... CASCADE 底下已經會連帶砍掉 admin.users.role_id 依賴 admin.roles 的 FK
-- constraint,所以這裡不用(也不能)再手動 DROP CONSTRAINT "users_role_id_roles_id_fk"——
-- drizzle-kit 原本自動產生的那一行拿掉了,CASCADE 已經處理過。
ALTER TABLE "admin"."role_rules" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "admin"."roles" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP TABLE "admin"."role_rules" CASCADE;--> statement-breakpoint
DROP TABLE "admin"."roles" CASCADE;--> statement-breakpoint
-- 新的 role_id FK 指回 rbac.roles(ADR-0007)。#17 的 migration 複製既有 admin.roles 資料到
-- rbac.roles 時保留了原本的 id,所以既有 admin.users.role_id 的值不用另外 UPDATE 就對得上。
ALTER TABLE "admin"."users" ADD CONSTRAINT "users_role_id_rbac_roles_id_fk" FOREIGN KEY ("role_id") REFERENCES "rbac"."roles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
-- Owner Role(ADR-0007):SuperAdmin 的規則超集 + rbac.roles.manage(能管理 Role/Rule 本身)+
-- admin.whitelist.manage(見 ADR-0001 的 Whitelist 段落,#16 才會真的用到)。
INSERT INTO "rbac"."roles" ("id", "name")
VALUES (gen_random_uuid(), 'Owner');

-- SuperAdmin「擁有所有 admin.* 規則」現在必須是真的塞進 role_rules,不能再靠角色名稱特判繞過
-- 檢查(ADR-0007)。這裡枚舉的是目前程式碼裡實際用到的兩條 admin.* 規則。
INSERT INTO "rbac"."role_rules" ("id", "role_id", "rule")
SELECT gen_random_uuid(), r."id", t.rule
FROM "rbac"."roles" r
CROSS JOIN (VALUES ('admin.users.approve'), ('admin.catCare.viewAll')) AS t(rule)
WHERE r."name" = 'SuperAdmin'
ON CONFLICT ("role_id", "rule") DO NOTHING;

-- Owner = SuperAdmin 的規則 + 兩條專屬規則
INSERT INTO "rbac"."role_rules" ("id", "role_id", "rule")
SELECT gen_random_uuid(), r."id", t.rule
FROM "rbac"."roles" r
CROSS JOIN (
  VALUES ('admin.users.approve'), ('admin.catCare.viewAll'), ('rbac.roles.manage'), ('admin.whitelist.manage')
) AS t(rule)
WHERE r."name" = 'Owner'
ON CONFLICT ("role_id", "rule") DO NOTHING;
