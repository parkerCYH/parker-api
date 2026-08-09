CREATE SCHEMA "usage_log";
--> statement-breakpoint
CREATE TABLE "usage_log"."requests" (
	"id" uuid PRIMARY KEY NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL
);
