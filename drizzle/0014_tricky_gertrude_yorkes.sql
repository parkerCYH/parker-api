CREATE TABLE "cat_care"."conversations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"cat_id" uuid NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "cat_care"."messages" (
	"id" uuid PRIMARY KEY NOT NULL,
	"conversation_id" uuid NOT NULL,
	"role" text NOT NULL,
	"content" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "cat_care"."conversations" ADD CONSTRAINT "conversations_cat_id_cats_id_fk" FOREIGN KEY ("cat_id") REFERENCES "cat_care"."cats"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cat_care"."messages" ADD CONSTRAINT "messages_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "cat_care"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
-- 跨 schema 外鍵指回 auth.players(見 CONTEXT.md「共用帳號機制」)。drizzle-kit 的 loader 不解析
-- 跨 module 的相對路徑匯入,schema.ts 故意不用 Drizzle 的 .references() 宣告這條,手動補在這裡。
ALTER TABLE "cat_care"."conversations" ADD CONSTRAINT "conversations_created_by_players_id_fk" FOREIGN KEY ("created_by") REFERENCES "app_auth"."players"("id") ON DELETE no action ON UPDATE no action;