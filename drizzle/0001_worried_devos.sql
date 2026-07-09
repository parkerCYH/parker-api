CREATE SCHEMA "admin";
--> statement-breakpoint
CREATE TABLE "admin"."refresh_tokens" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "admin"."role_rules" (
	"id" uuid PRIMARY KEY NOT NULL,
	"role_id" uuid NOT NULL,
	"rule" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "role_rules_role_id_rule_unique" UNIQUE("role_id","rule")
);
--> statement-breakpoint
CREATE TABLE "admin"."roles" (
	"id" uuid PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "roles_name_unique" UNIQUE("name")
);
--> statement-breakpoint
CREATE TABLE "admin"."users" (
	"id" uuid PRIMARY KEY NOT NULL,
	"google_sub" text NOT NULL,
	"email" text NOT NULL,
	"name" text NOT NULL,
	"avatar_url" text,
	"role_id" uuid,
	"approved_by" uuid,
	"approved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_google_sub_unique" UNIQUE("google_sub"),
	CONSTRAINT "users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
ALTER TABLE "admin"."refresh_tokens" ADD CONSTRAINT "refresh_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "admin"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admin"."role_rules" ADD CONSTRAINT "role_rules_role_id_roles_id_fk" FOREIGN KEY ("role_id") REFERENCES "admin"."roles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admin"."users" ADD CONSTRAINT "users_role_id_roles_id_fk" FOREIGN KEY ("role_id") REFERENCES "admin"."roles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admin"."users" ADD CONSTRAINT "users_approved_by_users_id_fk" FOREIGN KEY ("approved_by") REFERENCES "admin"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
-- Role 目錄種子資料(docs/services/admin.md「Role 目錄」):SuperAdmin 用角色名稱直接放行所有
-- admin.* 規則(見 service.ts 的 hasAdminRule),不需要在 role_rules 逐條列舉;Viewer 的具體
-- admin.* 唯讀規則留到有實際可管理的資料時再補(目前 cat-care 等 service 還沒有 admin 端點)。
INSERT INTO "admin"."roles" ("id", "name") VALUES (gen_random_uuid(), 'SuperAdmin'), (gen_random_uuid(), 'Viewer');