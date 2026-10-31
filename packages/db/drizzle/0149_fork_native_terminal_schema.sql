CREATE TABLE IF NOT EXISTS `fork_native_terminal_threads` (
	`thread_id` text PRIMARY KEY NOT NULL,
	`provider_id` text NOT NULL,
	`native_session_id` text,
	`terminal_session_id` text,
	`last_evidence_at` integer,
	`last_evidence_kind` text,
	`last_tool_call_at` integer,
	`last_tool_call_session_id` text,
	`initial_prompt` text,
	`initial_images` text,
	`model` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`thread_id`) REFERENCES `threads`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `fork_native_terminal_threads_session_idx` ON `fork_native_terminal_threads` (`provider_id`,`native_session_id`) WHERE "fork_native_terminal_threads"."native_session_id" IS NOT NULL;