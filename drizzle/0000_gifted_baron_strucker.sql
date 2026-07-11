CREATE SCHEMA "app_auth";
--> statement-breakpoint
CREATE TABLE "app_auth"."player_grants" (
	"id" uuid PRIMARY KEY NOT NULL,
	"player_id" uuid NOT NULL,
	"rule" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "player_grants_player_id_rule_unique" UNIQUE("player_id","rule")
);
--> statement-breakpoint
CREATE TABLE "app_auth"."players" (
	"id" uuid PRIMARY KEY NOT NULL,
	"google_sub" text NOT NULL,
	"email" text NOT NULL,
	"name" text NOT NULL,
	"avatar_url" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "players_google_sub_unique" UNIQUE("google_sub"),
	CONSTRAINT "players_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "app_auth"."refresh_tokens" (
	"id" uuid PRIMARY KEY NOT NULL,
	"player_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "app_auth"."player_grants" ADD CONSTRAINT "player_grants_player_id_players_id_fk" FOREIGN KEY ("player_id") REFERENCES "app_auth"."players"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app_auth"."refresh_tokens" ADD CONSTRAINT "refresh_tokens_player_id_players_id_fk" FOREIGN KEY ("player_id") REFERENCES "app_auth"."players"("id") ON DELETE cascade ON UPDATE no action;