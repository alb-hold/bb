CREATE TABLE IF NOT EXISTS `fork_device_handoff_attention` (
	`terminal_session_id` text PRIMARY KEY NOT NULL,
	`attention_seq` integer NOT NULL,
	FOREIGN KEY (`terminal_session_id`) REFERENCES `terminal_sessions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
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
CREATE INDEX IF NOT EXISTS `fork_terminal_output_host_retained_idx` ON `fork_terminal_output` (`host_id`,`retained_at`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `fork_terminal_tab_dismissals` (
	`terminal_session_id` text PRIMARY KEY NOT NULL,
	`host_id` text NOT NULL,
	`dismissed_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	FOREIGN KEY (`terminal_session_id`) REFERENCES `terminal_sessions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`host_id`) REFERENCES `hosts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `fork_terminal_tab_dismissals_host_expiry_idx` ON `fork_terminal_tab_dismissals` (`host_id`,`expires_at`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `fork_thread_row_states` (
	`thread_id` text PRIMARY KEY NOT NULL,
	`statuses_json` text DEFAULT '{}' NOT NULL,
	`progress_json` text,
	`updated_at` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`thread_id`) REFERENCES `threads`(`id`) ON UPDATE no action ON DELETE cascade
);
