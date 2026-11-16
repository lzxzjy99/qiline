CREATE TABLE `qiline_rooms` (
	`code` text PRIMARY KEY NOT NULL,
	`a_token_hash` text NOT NULL,
	`b_token_hash` text,
	`state_json` text NOT NULL,
	`revision` integer DEFAULT 0 NOT NULL,
	`a_seen` integer NOT NULL,
	`b_seen` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`expires_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `qiline_rooms_expiry` ON `qiline_rooms` (`expires_at`);