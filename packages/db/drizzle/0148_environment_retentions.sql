CREATE TABLE `environment_retentions` (
	`id` text PRIMARY KEY NOT NULL,
	`environment_id` text NOT NULL,
	`project_id` text NOT NULL,
	`host_id` text NOT NULL,
	`owner_thread_id` text,
	`provider_id` text NOT NULL,
	`original_path` text,
	`kept_path` text,
	`state` text NOT NULL,
	`message` text NOT NULL,
	`closed_at` integer,
	`closed_proof` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `environment_retentions_host_state_idx` ON `environment_retentions` (`host_id`,`state`);--> statement-breakpoint
CREATE INDEX `environment_retentions_environment_idx` ON `environment_retentions` (`environment_id`);--> statement-breakpoint
CREATE INDEX `environment_retentions_project_idx` ON `environment_retentions` (`project_id`);--> statement-breakpoint
CREATE INDEX `environment_retentions_thread_idx` ON `environment_retentions` (`owner_thread_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `environment_retentions_environment_kept_idx` ON `environment_retentions` (`environment_id`,`kept_path`);