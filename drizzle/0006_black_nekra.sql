CREATE TABLE "admin"."invite_whitelist" (
	"id" uuid PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"role_id" uuid NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "invite_whitelist_email_unique" UNIQUE("email")
);
--> statement-breakpoint
ALTER TABLE "admin"."invite_whitelist" ADD CONSTRAINT "invite_whitelist_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "admin"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
-- 跨 schema 外鍵指回 rbac.roles(同 admin.users.role_id 的道理,drizzle-kit 的 loader 不解析
-- 跨 module 的相對路徑匯入,schema.ts 沒有用 Drizzle 的 .references() 宣告這條)。
ALTER TABLE "admin"."invite_whitelist" ADD CONSTRAINT "invite_whitelist_role_id_rbac_roles_id_fk" FOREIGN KEY ("role_id") REFERENCES "rbac"."roles"("id") ON DELETE no action ON UPDATE no action;