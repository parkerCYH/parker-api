CREATE TABLE "cat_care"."fluid_injections" (
	"id" uuid PRIMARY KEY NOT NULL,
	"cat_id" uuid NOT NULL,
	"injected_by" uuid NOT NULL,
	"injected_at" timestamp with time zone NOT NULL,
	"site" text NOT NULL,
	"site_other" text,
	"volume_ml" integer NOT NULL,
	"fluid_type" text NOT NULL,
	"fluid_type_other" text,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "cat_care"."fluid_injections" ADD CONSTRAINT "fluid_injections_cat_id_cats_id_fk" FOREIGN KEY ("cat_id") REFERENCES "cat_care"."cats"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cat_care"."fluid_injections" ADD CONSTRAINT "fluid_injections_injected_by_players_id_fk" FOREIGN KEY ("injected_by") REFERENCES "app_auth"."players"("id") ON DELETE no action ON UPDATE no action;