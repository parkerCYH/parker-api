CREATE SCHEMA "rbac";
--> statement-breakpoint
CREATE TABLE "rbac"."role_rules" (
	"id" uuid PRIMARY KEY NOT NULL,
	"role_id" uuid NOT NULL,
	"rule" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "role_rules_role_id_rule_unique" UNIQUE("role_id","rule")
);
--> statement-breakpoint
CREATE TABLE "rbac"."roles" (
	"id" uuid PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "roles_name_unique" UNIQUE("name")
);
--> statement-breakpoint
ALTER TABLE "rbac"."role_rules" ADD CONSTRAINT "role_rules_role_id_roles_id_fk" FOREIGN KEY ("role_id") REFERENCES "rbac"."roles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
-- 把既有的 admin.roles / admin.role_rules 資料搬過來(ADR-0007),保留原本的 id,這樣 #18
-- 把 admin.users.role_id 的 FK 改指向 rbac.roles 時,既有資料的值不用另外 UPDATE 就對得上。
-- admin.roles / admin.role_rules 這兩張表本身留給 #18 處理(那張 ticket 才是 admin 真正切
-- 過去用 rbac 的地方),這裡只複製資料,不動舊表。
INSERT INTO "rbac"."roles" ("id", "name", "created_at")
SELECT "id", "name", "created_at" FROM "admin"."roles";

INSERT INTO "rbac"."role_rules" ("id", "role_id", "rule", "created_at")
SELECT "id", "role_id", "rule", "created_at" FROM "admin"."role_rules";