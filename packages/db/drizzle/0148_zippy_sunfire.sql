CREATE TABLE IF NOT EXISTS `fork_device_handoff_attention` (
	`terminal_session_id` text PRIMARY KEY NOT NULL,
	`attention_seq` integer NOT NULL,
	FOREIGN KEY (`terminal_session_id`) REFERENCES `terminal_sessions`(`id`) ON UPDATE no action ON DELETE cascade
);
