CREATE TABLE "admin"."login_exchange_codes" (
	"id" uuid PRIMARY KEY NOT NULL,
	"code_hash" text NOT NULL,
	"user_id" uuid NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "admin"."login_exchange_codes" ADD CONSTRAINT "login_exchange_codes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "admin"."users"("id") ON DELETE cascade ON UPDATE no action;