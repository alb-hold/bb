CREATE TABLE IF NOT EXISTS `fork_terminal_holder_sessions` (
	`terminal_id` text PRIMARY KEY NOT NULL,
	`confirmed_at` integer NOT NULL,
	FOREIGN KEY (`terminal_id`) REFERENCES `terminal_sessions`(`id`) ON UPDATE no action ON DELETE cascade
);
