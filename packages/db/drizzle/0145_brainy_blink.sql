CREATE TABLE IF NOT EXISTS `fork_terminal_output` (
	`terminal_session_id` text PRIMARY KEY NOT NULL,
	`host_id` text NOT NULL,
	`chunks_json` text NOT NULL,
	`byte_length` integer NOT NULL,
	`retained_at` integer NOT NULL,
	`expires_at` integer,
	FOREIGN KEY (`terminal_session_id`) REFERENCES `terminal_sessions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`host_id`) REFERENCES `hosts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `fork_terminal_output_host_retained_idx` ON `fork_terminal_output` (`host_id`,`retained_at`);
