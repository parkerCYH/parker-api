ALTER TABLE "cat_care"."cats" ADD COLUMN "chip_player_id" uuid;
--> statement-breakpoint
ALTER TABLE "cat_care"."cats" ADD CONSTRAINT "cats_chip_player_id_players_id_fk" FOREIGN KEY ("chip_player_id") REFERENCES "app_auth"."players"("id") ON DELETE no action ON UPDATE no action;