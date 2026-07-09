CREATE SCHEMA "cat_care";
--> statement-breakpoint
CREATE TABLE "cat_care"."bowel_movements" (
	"id" uuid PRIMARY KEY NOT NULL,
	"cat_id" uuid NOT NULL,
	"recorded_by" uuid NOT NULL,
	"recorded_at" timestamp with time zone NOT NULL,
	"stool_type" text,
	"is_abnormal" boolean DEFAULT false NOT NULL,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "cat_care"."cat_players" (
	"cat_id" uuid NOT NULL,
	"player_id" uuid NOT NULL,
	CONSTRAINT "cat_players_cat_id_player_id_pk" PRIMARY KEY("cat_id","player_id")
);
--> statement-breakpoint
CREATE TABLE "cat_care"."cats" (
	"id" uuid PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"birthdate" date,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "cat_care"."weight_records" (
	"id" uuid PRIMARY KEY NOT NULL,
	"cat_id" uuid NOT NULL,
	"measured_by" uuid NOT NULL,
	"measured_at" timestamp with time zone NOT NULL,
	"weight_grams" integer NOT NULL,
	"method" text,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "cat_care"."bowel_movements" ADD CONSTRAINT "bowel_movements_cat_id_cats_id_fk" FOREIGN KEY ("cat_id") REFERENCES "cat_care"."cats"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cat_care"."cat_players" ADD CONSTRAINT "cat_players_cat_id_cats_id_fk" FOREIGN KEY ("cat_id") REFERENCES "cat_care"."cats"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cat_care"."weight_records" ADD CONSTRAINT "weight_records_cat_id_cats_id_fk" FOREIGN KEY ("cat_id") REFERENCES "cat_care"."cats"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
-- 跨 schema 外鍵指回 auth.players(見 CONTEXT.md「共用帳號機制」)。drizzle-kit 的 loader 不解析
-- 跨 module 的相對路徑匯入,schema.ts 故意不用 Drizzle 的 .references() 宣告這幾條,手動補在這裡。
ALTER TABLE "cat_care"."cat_players" ADD CONSTRAINT "cat_players_player_id_players_id_fk" FOREIGN KEY ("player_id") REFERENCES "auth"."players"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cat_care"."bowel_movements" ADD CONSTRAINT "bowel_movements_recorded_by_players_id_fk" FOREIGN KEY ("recorded_by") REFERENCES "auth"."players"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cat_care"."weight_records" ADD CONSTRAINT "weight_records_measured_by_players_id_fk" FOREIGN KEY ("measured_by") REFERENCES "auth"."players"("id") ON DELETE no action ON UPDATE no action;