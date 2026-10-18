CREATE TABLE IF NOT EXISTS `fork_thread_row_states` (
	`thread_id` text PRIMARY KEY NOT NULL,
	`statuses_json` text DEFAULT '{}' NOT NULL,
	`progress_json` text,
	`updated_at` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`thread_id`) REFERENCES `threads`(`id`) ON UPDATE no action ON DELETE cascade
);
