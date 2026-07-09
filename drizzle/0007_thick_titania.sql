ALTER TABLE "admin"."users" ADD COLUMN "rejected_at" timestamp with time zone;--> statement-breakpoint
-- 新規則 admin.users.view(ticket #19):唯讀資訊,Owner/SuperAdmin/Viewer 都能看 User 列表。
INSERT INTO "rbac"."role_rules" ("id", "role_id", "rule")
SELECT gen_random_uuid(), r."id", 'admin.users.view'
FROM "rbac"."roles" r
WHERE r."name" IN ('Owner', 'SuperAdmin', 'Viewer')
ON CONFLICT ("role_id", "rule") DO NOTHING;