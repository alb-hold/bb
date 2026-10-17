CREATE TABLE IF NOT EXISTS `fork_terminal_tab_dismissals` (
	`terminal_session_id` text PRIMARY KEY NOT NULL,
	`host_id` text NOT NULL,
	`dismissed_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	FOREIGN KEY (`terminal_session_id`) REFERENCES `terminal_sessions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`host_id`) REFERENCES `hosts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `fork_terminal_tab_dismissals_host_expiry_idx` ON `fork_terminal_tab_dismissals` (`host_id`,`expires_at`);
