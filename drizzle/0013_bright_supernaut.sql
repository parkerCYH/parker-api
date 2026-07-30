CREATE TABLE "cat_care"."health_advice" (
	"id" uuid PRIMARY KEY NOT NULL,
	"requested_by" uuid NOT NULL,
	"advice" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "cat_care"."health_advice_bloodwork_records" (
	"health_advice_id" uuid NOT NULL,
	"bloodwork_record_id" uuid NOT NULL,
	CONSTRAINT "health_advice_bloodwork_records_health_advice_id_bloodwork_record_id_pk" PRIMARY KEY("health_advice_id","bloodwork_record_id")
);
--> statement-breakpoint
ALTER TABLE "cat_care"."health_advice_bloodwork_records" ADD CONSTRAINT "health_advice_bloodwork_records_health_advice_id_health_advice_id_fk" FOREIGN KEY ("health_advice_id") REFERENCES "cat_care"."health_advice"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cat_care"."health_advice_bloodwork_records" ADD CONSTRAINT "health_advice_bloodwork_records_bloodwork_record_id_bloodwork_records_id_fk" FOREIGN KEY ("bloodwork_record_id") REFERENCES "cat_care"."bloodwork_records"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
-- 跨 schema 外鍵指回 auth.players(見 CONTEXT.md「共用帳號機制」)。drizzle-kit 的 loader 不解析
-- 跨 module 的相對路徑匯入,schema.ts 故意不用 Drizzle 的 .references() 宣告這條,手動補在這裡。
ALTER TABLE "cat_care"."health_advice" ADD CONSTRAINT "health_advice_requested_by_players_id_fk" FOREIGN KEY ("requested_by") REFERENCES "app_auth"."players"("id") ON DELETE no action ON UPDATE no action;