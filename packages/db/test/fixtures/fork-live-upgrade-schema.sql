CREATE TABLE "__drizzle_migrations" (
				id SERIAL PRIMARY KEY,
				hash text NOT NULL,
				created_at numeric
			);
CREATE TABLE `apikey` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text,
	`start` text,
	`prefix` text,
	`key` text NOT NULL,
	`referenceId` text NOT NULL,
	`refillInterval` integer,
	`refillAmount` integer,
	`lastRefillAt` integer,
	`enabled` integer NOT NULL,
	`rateLimitEnabled` integer NOT NULL,
	`rateLimitTimeWindow` integer NOT NULL,
	`rateLimitMax` integer NOT NULL,
	`requestCount` integer NOT NULL,
	`remaining` integer,
	`lastRequest` integer,
	`expiresAt` integer,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL,
	`permissions` text,
	`metadata` text,
	`configId` text NOT NULL,
	FOREIGN KEY (`referenceId`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
CREATE UNIQUE INDEX `apikey_key_unique` ON `apikey` (`key`);
CREATE INDEX `apikey_reference_id_idx` ON `apikey` (`referenceId`);
CREATE INDEX `apikey_config_id_idx` ON `apikey` (`configId`);
CREATE TABLE `user` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`email` text NOT NULL,
	`emailVerified` integer NOT NULL,
	`image` text,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL
);
CREATE UNIQUE INDEX `user_email_unique` ON `user` (`email`);
CREATE TABLE `environments` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`host_id` text NOT NULL,
	`path` text,
	`is_git_repo` integer DEFAULT false NOT NULL,
	`is_worktree` integer DEFAULT false NOT NULL,
	`branch_name` text,
	`base_branch` text,
	`default_branch` text,
	`merge_base_branch` text,
	`status` text DEFAULT 'provisioning' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL, `name` text, `environment_provider_id` text, `environment_provider_plugin_id` text, `provider_owns_path` integer DEFAULT false NOT NULL, `environment_provider_selection` text, `environment_provider_instance_key` text, `retire_at` integer, `teardown_attempt` integer DEFAULT 0 NOT NULL, `teardown_status` text, `teardown_message` text, `resource` text, `owner_thread_id` text, `attempt` integer DEFAULT 0 NOT NULL, `status_message` text, `pending_log` text DEFAULT '' NOT NULL, `claim_path` text,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`host_id`) REFERENCES `hosts`(`id`) ON UPDATE no action ON DELETE cascade
);
CREATE INDEX `environments_project_idx` ON `environments` (`project_id`);
CREATE INDEX `environments_status_idx` ON `environments` (`status`);
CREATE TABLE `host_daemon_sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`host_id` text NOT NULL,
	`instance_id` text NOT NULL,
	`host_name` text NOT NULL,
	`data_dir` text NOT NULL,
	`protocol_version` integer NOT NULL,
	`heartbeat_interval_ms` integer NOT NULL,
	`lease_timeout_ms` integer NOT NULL,
	`status` text NOT NULL,
	`lease_expires_at` integer NOT NULL,
	`closed_at` integer,
	`close_reason` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`host_id`) REFERENCES `hosts`(`id`) ON UPDATE no action ON DELETE cascade
);
CREATE INDEX `host_daemon_sessions_host_status_idx` ON `host_daemon_sessions` (`host_id`,`status`);
CREATE INDEX `host_daemon_sessions_host_latest_idx` ON `host_daemon_sessions` (`host_id`,`updated_at`,`created_at`,`id`);
CREATE TABLE `hosts` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`type` text NOT NULL,
	`destroyed_at` integer,
	`last_seen_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
, `last_rejected_protocol_version` integer, `connect_machine_id` text, `max_permission_mode` text DEFAULT 'full' NOT NULL, `machine_provider_id` text, `launch_key` text, `machine_inputs` text, `machine_attempt` integer DEFAULT 0 NOT NULL, `pending_log` text DEFAULT '' NOT NULL, `machine_operation_id` text, `server_access_provider_id` text, `server_access_grant_id` text, `resource` text, `phase` text DEFAULT 'active' NOT NULL, `suspended_at` integer, `status_message` text, `suspend_retry_at` integer, `remove_retry_at` integer, `teardown_attempt` integer DEFAULT 0 NOT NULL, `teardown_status` text);
CREATE INDEX `hosts_last_seen_idx` ON `hosts` (`last_seen_at`);
CREATE TABLE `maintenance_scan_cursors` (
	`id` text PRIMARY KEY NOT NULL,
	`policy` text NOT NULL,
	`version` integer NOT NULL,
	`item_kind` text NOT NULL,
	`output_path` text NOT NULL,
	`last_created_at` integer DEFAULT 0 NOT NULL,
	`last_event_id` text DEFAULT '' NOT NULL,
	`updated_at` integer NOT NULL
);
CREATE UNIQUE INDEX `maintenance_scan_cursors_path_idx` ON `maintenance_scan_cursors` (`policy`,`version`,`item_kind`,`output_path`);
CREATE TABLE `project_execution_defaults` (
	`project_id` text NOT NULL,
	`provider_id` text NOT NULL,
	`model` text NOT NULL,
	`service_tier` text NOT NULL,
	`reasoning_level` text NOT NULL,
	`permission_mode` text NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
CREATE TABLE `project_sources` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`type` text NOT NULL,
	`host_id` text,
	`path` text,
	`is_default` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL, `owns_path` integer DEFAULT false NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`host_id`) REFERENCES `hosts`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "project_sources_shape_check" CHECK((
        "project_sources"."type" = 'local_path' AND "project_sources"."host_id" IS NOT NULL AND "project_sources"."path" IS NOT NULL
      ))
);
CREATE INDEX `project_sources_project_idx` ON `project_sources` (`project_id`);
CREATE INDEX `project_sources_host_idx` ON `project_sources` (`host_id`);
CREATE UNIQUE INDEX `project_sources_project_host_idx` ON `project_sources` (`project_id`,`host_id`);
CREATE UNIQUE INDEX `project_sources_default_project_idx`
ON `project_sources` (`project_id`)
WHERE `is_default` = 1;
CREATE TABLE `projects` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
, `sort_key` text DEFAULT 'V' NOT NULL, `kind` text DEFAULT 'standard' NOT NULL, `deleted_at` integer, `git_remote_url` text);
CREATE INDEX `projects_updated_idx` ON `projects` (`updated_at`);
CREATE TABLE `prompt_history_entries` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`thread_id` text NOT NULL,
	`scope` text NOT NULL,
	`request_sequence` integer NOT NULL,
	`input` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`thread_id`) REFERENCES `threads`(`id`) ON UPDATE no action ON DELETE cascade
);
CREATE UNIQUE INDEX `prompt_history_entries_thread_request_idx` ON `prompt_history_entries` (`thread_id`,`request_sequence`);
CREATE INDEX `prompt_history_entries_project_scope_created_idx` ON `prompt_history_entries` (`project_id`,`scope`,`created_at`,`request_sequence`,`id`);
CREATE INDEX `prompt_history_entries_thread_scope_created_idx` ON `prompt_history_entries` (`thread_id`,`scope`,`created_at`,`request_sequence`,`id`);
CREATE INDEX `host_daemon_sessions_closed_prune_idx` ON `host_daemon_sessions` (`status`,`closed_at`,`id`);
CREATE TABLE `thread_dynamic_context_file_states` (
	`thread_id` text NOT NULL,
	`file_key` text NOT NULL,
	`content_status` text NOT NULL,
	`content_hash` text NOT NULL,
	`shown_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`thread_id`) REFERENCES `threads`(`id`) ON UPDATE no action ON DELETE cascade
);
CREATE UNIQUE INDEX `thread_dynamic_context_file_states_thread_file_idx` ON `thread_dynamic_context_file_states` (`thread_id`,`file_key`);
CREATE INDEX `projects_sort_idx` ON `projects` (`sort_key`,`id`);
CREATE UNIQUE INDEX `projects_personal_singleton_idx` ON `projects` (`kind`) WHERE "projects"."kind" = 'personal';
CREATE INDEX `projects_deleted_idx` ON `projects` (`deleted_at`);
CREATE TABLE "events" (
  `id` text PRIMARY KEY NOT NULL,
  `thread_id` text NOT NULL,
  `environment_id` text,
  `scope_kind` text NOT NULL,
  `turn_id` text,
  `provider_thread_id` text,
  `sequence` integer NOT NULL,
  `type` text NOT NULL,
  `item_id` text,
  `item_kind` text,
  `data` text DEFAULT '{}' NOT NULL,
  `created_at` integer NOT NULL, `parent_tool_call_id` text,
  FOREIGN KEY (`thread_id`) REFERENCES `threads`(`id`) ON UPDATE no action ON DELETE cascade,
  FOREIGN KEY (`environment_id`) REFERENCES `environments`(`id`) ON UPDATE no action ON DELETE set null,
  CONSTRAINT `events_scope_shape_check` CHECK (
    (
      (`scope_kind` = 'turn' AND `turn_id` IS NOT NULL)
      OR
      (`scope_kind` = 'thread' AND `turn_id` IS NULL)
    )
  )
);
CREATE UNIQUE INDEX `events_thread_sequence_idx` ON `events` (`thread_id`,`sequence`);
CREATE INDEX `events_thread_type_item_kind_sequence_idx` ON `events` (`thread_id`,`type`,`item_kind`,`sequence`);
CREATE INDEX `events_thread_type_sequence_idx` ON `events` (`thread_id`,`type`,`sequence`);
CREATE INDEX `events_thread_turn_type_item_sequence_idx` ON `events` (`thread_id`,`turn_id`,`type`,`item_id`,`sequence`);
CREATE INDEX `events_environment_idx` ON `events` (`environment_id`);
CREATE INDEX `events_completed_item_truncation_idx` ON `events` (`item_kind`,`created_at`,`id`) WHERE `type` = 'item/completed';
CREATE UNIQUE INDEX `project_execution_defaults_project_idx` ON `project_execution_defaults` (`project_id`);
CREATE TABLE "threads" (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`environment_id` text,
	`provider_id` text NOT NULL,
	`model_override` text,
	`reasoning_level_override` text,
	`title` text,
	`title_fallback` text,
	`status` text DEFAULT 'starting' NOT NULL,
	`parent_thread_id` text,
	`archived_at` integer,
	`pinned_at` integer,
	`pin_sort_key` text,
	`deleted_at` integer,
	`last_read_at` integer,
	`latest_attention_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL, `source_thread_id` text REFERENCES `threads`(`id`) ON DELETE set null, `origin_kind` text, "section_id" text REFERENCES "thread_sections"(id) ON DELETE SET NULL, `origin_plugin_id` text, `visibility` text DEFAULT 'visible' NOT NULL, "startup_context" text, `storage_deleted_at` integer, `lifecycle_owner_thread_id` text REFERENCES threads(id) ON DELETE RESTRICT, `parent_notifications` text DEFAULT 'auto' NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`environment_id`) REFERENCES `environments`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`parent_thread_id`) REFERENCES `threads`(`id`) ON UPDATE no action ON DELETE set null
);
CREATE INDEX `threads_project_updated_idx` ON `threads` (`project_id`,`updated_at`);
CREATE INDEX `threads_project_archived_deleted_idx` ON `threads` (`project_id`,`archived_at`,`deleted_at`,`id`);
CREATE INDEX `threads_pin_sort_idx` ON `threads` (`archived_at`,`deleted_at`,`pin_sort_key`,`id`) WHERE "threads"."pinned_at" IS NOT NULL;
CREATE INDEX `threads_environment_idx` ON `threads` (`environment_id`);
CREATE INDEX `threads_parent_idx` ON `threads` (`parent_thread_id`);
CREATE INDEX `threads_archived_status_idx` ON `threads` (`archived_at`,`status`);
CREATE INDEX `threads_environment_archived_deleted_idx` ON `threads` (`environment_id`,`archived_at`,`deleted_at`);
CREATE INDEX `threads_active_maintenance_idx` ON `threads` (`status`) WHERE "threads"."deleted_at" IS NULL;
CREATE INDEX `threads_source_origin_idx` ON `threads` (`source_thread_id`, `origin_kind`);
CREATE TABLE `thread_search_segments` (
  `id` text PRIMARY KEY NOT NULL,
  `thread_id` text NOT NULL,
  `source_kind` text NOT NULL,
  `source_key` text NOT NULL,
  `source_seq` integer,
  `text` text NOT NULL,
  `created_at` integer NOT NULL,
  `updated_at` integer NOT NULL,
  FOREIGN KEY (`thread_id`) REFERENCES `threads`(`id`) ON UPDATE no action ON DELETE cascade
);
CREATE UNIQUE INDEX `thread_search_segments_source_idx` ON `thread_search_segments` (`thread_id`, `source_kind`, `source_key`);
CREATE TABLE `app_theme` (
	`id` text PRIMARY KEY NOT NULL,
	`theme_id` text NOT NULL,
	`updated_at` integer NOT NULL
, `favicon_color` text DEFAULT 'default' NOT NULL);
CREATE TABLE "terminal_sessions" (
	`id` text PRIMARY KEY NOT NULL,
	`thread_id` text,
	`environment_id` text,
	`host_id` text NOT NULL,
	`daemon_session_id` text,
	`title` text NOT NULL,
	`initial_cwd` text NOT NULL,
	`cols` integer NOT NULL,
	`rows` integer NOT NULL,
	`status` text NOT NULL,
	`exit_code` integer,
	`close_reason` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`last_user_input_at` integer,
	FOREIGN KEY (`thread_id`) REFERENCES `threads`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`environment_id`) REFERENCES `environments`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`host_id`) REFERENCES `hosts`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`daemon_session_id`) REFERENCES `host_daemon_sessions`(`id`) ON UPDATE no action ON DELETE set null
);
CREATE INDEX `terminal_sessions_thread_status_updated_idx` ON `terminal_sessions` (`thread_id`,`status`,`updated_at`);
CREATE INDEX `terminal_sessions_environment_status_idx` ON `terminal_sessions` (`environment_id`,`status`);
CREATE INDEX `terminal_sessions_host_status_idx` ON `terminal_sessions` (`host_id`,`status`);
CREATE INDEX `terminal_sessions_daemon_session_idx` ON `terminal_sessions` (`daemon_session_id`);
CREATE TABLE "thread_sections" (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
CREATE TABLE `plugins` (
	`id` text PRIMARY KEY NOT NULL,
	`source` text NOT NULL,
	`root_dir` text NOT NULL,
	`version` text NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`installed_at` integer NOT NULL,
	`updated_at` integer NOT NULL
, `removed_at` integer, `provenance` text DEFAULT 'direct' NOT NULL, "catalog_entry_id" text, `source_kind` text DEFAULT 'path' NOT NULL, `source_path` text, `source_builtin_name` text, `source_npm_package` text, `source_npm_registry` text, `source_npm_requested_spec` text, `source_npm_spec_kind` text, `source_git_url` text, `source_git_subdirectory` text, `source_git_requested_ref` text, `source_git_ref_kind` text, `npm_resolved_version` text, `npm_integrity` text, `git_resolved_commit` text, `last_update_check_at` integer, `available_compatible_version` text, `newest_incompatible_version` text, `update_status_detail` text, `last_failure_version` text, `last_failure_at` integer, `last_failure_detail` text, `active_artifact_id` text REFERENCES plugin_artifacts(id), `normalization_version` integer DEFAULT 0 NOT NULL, `catalog_marketplace_name` text, `source_git_range` text, `source_git_tag_prefix` text, `source_git_resolved_tag` text, `enabled_follows_default` integer DEFAULT false NOT NULL);
CREATE TABLE `plugin_kv` (
	`plugin_id` text NOT NULL,
	`key` text NOT NULL,
	`value` text NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`plugin_id`, `key`)
);
CREATE TABLE `plugin_settings` (
	`plugin_id` text NOT NULL,
	`key` text NOT NULL,
	`value` text NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`plugin_id`, `key`)
);
CREATE TABLE `plugin_schedules` (
	`plugin_id` text NOT NULL,
	`name` text NOT NULL,
	`cron` text NOT NULL,
	`next_run_at` integer NOT NULL,
	`last_run_at` integer,
	`last_status` text,
	`last_error` text,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`plugin_id`, `name`)
);
CREATE TABLE `app_settings` (
	`id` text PRIMARY KEY NOT NULL,
	`caffeinate` integer DEFAULT false NOT NULL,
	`updated_at` integer NOT NULL
, `keybinding_overrides` text DEFAULT '[]' NOT NULL, `codex_memory_enabled` integer DEFAULT true NOT NULL, `claude_code_memory_enabled` integer DEFAULT true NOT NULL, `codex_subagents_disabled` integer DEFAULT false NOT NULL, `claude_code_subagents_disabled` integer DEFAULT false NOT NULL, `claude_code_workflows_disabled` integer DEFAULT false NOT NULL, `show_keyboard_hints` integer DEFAULT true NOT NULL, `show_unhandled_provider_events` integer DEFAULT false NOT NULL, `steer_active_thread_on_enter` integer DEFAULT false NOT NULL, `onboarding_completed_at` text);
CREATE TABLE "pending_interactions" (
	`id` text PRIMARY KEY NOT NULL,
	`thread_id` text NOT NULL,
	`origin_kind` text DEFAULT 'provider' NOT NULL,
	`turn_id` text,
	`provider_id` text,
	`provider_thread_id` text,
	`provider_request_id` text,
	`plugin_id` text,
	`renderer_id` text,
	`status` text NOT NULL,
	`payload` text NOT NULL,
	`resolution` text,
	`status_reason` text,
	`created_at` integer NOT NULL,
	`expires_at` integer,
	`resolved_at` integer,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`thread_id`) REFERENCES `threads`(`id`) ON UPDATE no action ON DELETE cascade
);
CREATE UNIQUE INDEX `pending_interactions_provider_request_idx` ON `pending_interactions` (`provider_id`,`provider_thread_id`,`provider_request_id`);
CREATE INDEX `pending_interactions_thread_created_idx` ON `pending_interactions` (`thread_id`,`created_at`);
CREATE INDEX `pending_interactions_thread_status_created_idx` ON `pending_interactions` (`thread_id`,`status`,`created_at`);
CREATE INDEX `pending_interactions_status_created_idx` ON `pending_interactions` (`status`,`created_at`);
CREATE INDEX `pending_interactions_plugin_status_created_idx` ON `pending_interactions` (`plugin_id`,`status`,`created_at`);
CREATE TABLE `thread_tabs` (
	`thread_id` text PRIMARY KEY NOT NULL,
	`tabs_json` text NOT NULL,
	`revision` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`thread_id`) REFERENCES `threads`(`id`) ON UPDATE no action ON DELETE cascade
);
CREATE TABLE `plugin_artifacts` (
	`id` text PRIMARY KEY NOT NULL,
	`plugin_id` text NOT NULL,
	`source_kind` text NOT NULL,
	`npm_resolved_version` text,
	`git_resolved_commit` text,
	`path` text NOT NULL,
	`integrity` text,
	`content_hash` text,
	`validation_result` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`validated_at` integer
, `git_checkout_root` text);
CREATE INDEX `plugin_artifacts_plugin_idx` ON `plugin_artifacts` (`plugin_id`);
CREATE TABLE `plugin_state_snapshots` (
	`id` text PRIMARY KEY NOT NULL,
	`plugin_id` text NOT NULL,
	`from_artifact_id` text,
	`to_artifact_id` text NOT NULL,
	`snapshot_path` text NOT NULL,
	`database_path` text,
	`state_path` text NOT NULL,
	`secrets_path` text,
	`registration_path` text,
	`status` text NOT NULL,
	`rollback_candidate_version` text,
	`rollback_source_fingerprint` text,
	`rollback_bb_version` text,
	`rollback_sdk_version` text,
	`rollback_detail` text,
	`created_at` integer NOT NULL,
	`retained_until` integer NOT NULL,
	`updated_at` integer NOT NULL
);
CREATE INDEX `plugin_state_snapshots_plugin_idx` ON `plugin_state_snapshots` (`plugin_id`);
CREATE INDEX `plugin_state_snapshots_retention_idx` ON `plugin_state_snapshots` (`retained_until`);
CREATE UNIQUE INDEX `thread_sections_name_idx` ON `thread_sections` (`name`);
CREATE INDEX `threads_section_archived_deleted_idx` ON `threads` (`section_id`,`archived_at`,`deleted_at`,`id`);
CREATE INDEX `threads_origin_plugin_archived_idx` ON `threads` (`origin_plugin_id`,`archived_at`);
CREATE UNIQUE INDEX `environments_project_host_path_idx` ON `environments` (`project_id`,`host_id`,`path`);
CREATE INDEX `environments_host_path_lookup_idx` ON `environments` (`host_id`,`path`);
CREATE INDEX `events_background_task_thread_type_item_sequence_idx` ON `events` (`thread_id`,`type`,`item_id`,`sequence`) WHERE "events"."item_kind" = 'backgroundTask';
CREATE TABLE "system_experiments" (
	`key` text PRIMARY KEY NOT NULL,
	`value` integer NOT NULL,
	`updated_at` integer NOT NULL
);
CREATE INDEX `thread_search_segments_thread_source_seq_idx` ON `thread_search_segments` (`thread_id`,`source_seq`);
CREATE TABLE `plugin_marketplace_icons` (
	`marketplace_name` text NOT NULL,
	`entry_id` text NOT NULL,
	`source_url` text NOT NULL,
	`content_type` text NOT NULL,
	`etag` text,
	`content_hash` text NOT NULL,
	`bytes` blob NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`marketplace_name`, `entry_id`)
);
CREATE TABLE `plugin_marketplaces` (
	`name` text PRIMARY KEY NOT NULL,
	`manifest_url` text NOT NULL,
	`manifest_json` text NOT NULL,
	`etag` text,
	`last_modified` text,
	`last_successful_refresh_at` integer,
	`last_attempted_refresh_at` integer,
	`last_error` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
, `source_kind` text DEFAULT 'https' NOT NULL, `source_git_ref` text, `source_git_commit` text, `stats_json` text, `source_git_subdirectory` text);
CREATE INDEX `events_item_lifecycle_thread_item_sequence_idx` ON `events` (`thread_id`,`item_id`,`sequence`) WHERE "events"."type" IN ('item/started', 'item/completed', 'item/backgroundTask/completed');
CREATE VIRTUAL TABLE `thread_search_segments_fts` USING fts5(
  `text`,
  tokenize = 'unicode61',
  prefix = '2 3'
);
CREATE TABLE 'thread_search_segments_fts_data'(id INTEGER PRIMARY KEY, block BLOB);
CREATE TABLE 'thread_search_segments_fts_idx'(segid, term, pgno, PRIMARY KEY(segid, term)) WITHOUT ROWID;
CREATE TABLE 'thread_search_segments_fts_content'(id INTEGER PRIMARY KEY, c0);
CREATE TABLE 'thread_search_segments_fts_docsize'(id INTEGER PRIMARY KEY, sz BLOB);
CREATE TABLE 'thread_search_segments_fts_config'(k PRIMARY KEY, v) WITHOUT ROWID;
CREATE TRIGGER `thread_search_segments_after_insert`
AFTER INSERT ON `thread_search_segments`
BEGIN
  INSERT INTO `thread_search_segments_fts` (`rowid`, `text`)
  VALUES (new.`rowid`, new.`text`);
END;
CREATE TRIGGER `thread_search_segments_after_delete`
AFTER DELETE ON `thread_search_segments`
BEGIN
  DELETE FROM `thread_search_segments_fts`
  WHERE `rowid` = old.`rowid`;
END;
CREATE TRIGGER `thread_search_segments_after_text_update`
AFTER UPDATE OF `id`, `text` ON `thread_search_segments`
BEGIN
  DELETE FROM `thread_search_segments_fts`
  WHERE `rowid` = old.`rowid`;

  INSERT INTO `thread_search_segments_fts` (`rowid`, `text`)
  VALUES (new.`rowid`, new.`text`);
END;
CREATE TABLE `app_settings_values` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL,
	`updated_at` integer NOT NULL
);
CREATE INDEX `events_parent_tool_call_thread_parent_sequence_idx` ON `events` (`thread_id`,`parent_tool_call_id`,`sequence`) WHERE "events"."parent_tool_call_id" IS NOT NULL;
CREATE INDEX `events_thread_state_thread_sequence_idx` ON `events` (`thread_id`,`sequence`) WHERE "events"."type" IN ('thread/goal/updated', 'thread/goal/cleared', 'thread/extensionState/updated');
CREATE INDEX `events_delegating_item_lookup_idx` ON `events` (`thread_id`,`item_id`,`sequence`,`item_kind`) WHERE "events"."item_kind" IN ('toolCall', 'delegation');
CREATE INDEX `events_plan_steps_thread_sequence_idx` ON `events` (`thread_id`,`sequence`) WHERE ("events"."item_kind" = 'planSteps' AND "events"."type" = 'item/completed') OR "events"."type" = 'turn/plan/updated';
CREATE TABLE `thread_conversation_outlines` (
	`thread_id` text PRIMARY KEY NOT NULL,
	`projection_key` text NOT NULL,
	`items_json` text NOT NULL,
	FOREIGN KEY (`thread_id`) REFERENCES `threads`(`id`) ON UPDATE no action ON DELETE cascade
);
CREATE TABLE fork_detached_threads (
      thread_id TEXT PRIMARY KEY,
      host_id TEXT NOT NULL,
      expires_at INTEGER NOT NULL
    );
CREATE INDEX fork_detached_threads_host
      ON fork_detached_threads (host_id);
CREATE TABLE fork_queued_message_dispatch_retries (
      queued_message_id TEXT PRIMARY KEY NOT NULL
        REFERENCES queued_thread_messages(id) ON DELETE CASCADE,
      thread_id TEXT NOT NULL,
      attempt INTEGER NOT NULL,
      next_attempt_at INTEGER NOT NULL,
      last_error TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );
CREATE INDEX fork_queued_message_dispatch_retries_due_idx
      ON fork_queued_message_dispatch_retries (next_attempt_at, queued_message_id)
  ;
CREATE TABLE fork_worker_event_keys (
      replay_key TEXT PRIMARY KEY,
      created_at INTEGER NOT NULL
    );
CREATE INDEX fork_worker_event_keys_created_at
      ON fork_worker_event_keys (created_at);
CREATE TABLE fork_thread_execution_reports (
      thread_id TEXT PRIMARY KEY NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
      model TEXT NOT NULL,
      reasoning_level TEXT,
      permission_mode TEXT,
      service_tier TEXT,
      reported_at INTEGER NOT NULL
    );
CREATE TABLE fork_project_provider_execution_defaults (
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      provider_id TEXT NOT NULL,
      model TEXT NOT NULL,
      reasoning_level TEXT NOT NULL,
      permission_mode TEXT NOT NULL,
      service_tier TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (project_id, provider_id)
    );
CREATE TABLE fork_thread_spend_daily (
      day TEXT NOT NULL,
      thread_id TEXT NOT NULL,
      provider_id TEXT NOT NULL,
      model TEXT NOT NULL,
      input_tokens INTEGER NOT NULL DEFAULT 0,
      cached_input_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      reasoning_output_tokens INTEGER NOT NULL DEFAULT 0,
      total_tokens INTEGER NOT NULL DEFAULT 0,
      weighted_units REAL NOT NULL DEFAULT 0,
      turns INTEGER NOT NULL DEFAULT 0,
      first_event_at INTEGER NOT NULL,
      last_event_at INTEGER NOT NULL,
      PRIMARY KEY (day, thread_id, provider_id, model)
    );
CREATE INDEX fork_thread_spend_daily_day_idx
      ON fork_thread_spend_daily (day)
  ;
CREATE TABLE fork_thread_spend_cursor (
      thread_id TEXT NOT NULL,
      provider_thread_id TEXT NOT NULL,
      last_sequence INTEGER NOT NULL,
      last_total_tokens INTEGER NOT NULL,
      first_sequence INTEGER NOT NULL,
      history_complete INTEGER NOT NULL DEFAULT 0,
      last_turn_id TEXT,
      last_model TEXT,
      PRIMARY KEY (thread_id, provider_thread_id)
    );
CREATE TABLE fork_spend_prices (
      provider_id TEXT NOT NULL,
      model TEXT NOT NULL,
      input_usd_per_mtok REAL NOT NULL,
      cached_input_usd_per_mtok REAL NOT NULL,
      output_usd_per_mtok REAL NOT NULL,
      PRIMARY KEY (provider_id, model)
    );
CREATE TABLE fork_spend_assessments (
      topic TEXT PRIMARY KEY NOT NULL,
      requested_at INTEGER NOT NULL,
      window_from TEXT NOT NULL,
      window_to TEXT NOT NULL,
      payload_sha256 TEXT NOT NULL,
      response TEXT NOT NULL,
      host TEXT NOT NULL,
      thread_id TEXT NOT NULL
    );
CREATE INDEX fork_events_file_change_truncation_idx
      ON events (created_at, id)
      WHERE item_kind = 'fileChange'
        AND type IN ('item/started', 'item/completed');
CREATE INDEX `environments_provider_instance_idx` ON `environments` (`environment_provider_id`,`environment_provider_instance_key`);
CREATE TABLE `retained_event_outputs` (
	`event_id` text PRIMARY KEY NOT NULL,
	`output_path` text NOT NULL,
	`value` text NOT NULL,
	`expires_at` integer NOT NULL,
	FOREIGN KEY (`event_id`) REFERENCES `events`(`id`) ON UPDATE no action ON DELETE cascade
);
CREATE INDEX `retained_event_outputs_expiry_idx` ON `retained_event_outputs` (`expires_at`,`event_id`);
CREATE TABLE `ui_preferences` (
	`key` text PRIMARY KEY NOT NULL,
	`value_json` text NOT NULL,
	`revision` integer NOT NULL,
	`updated_at` integer NOT NULL
);
CREATE INDEX `environments_claim_idx` ON `environments` (`host_id`,`claim_path`);
CREATE TABLE `environment_hook_operations` (
	`id` text PRIMARY KEY NOT NULL,
	`operation_id` text NOT NULL,
	`host_id` text NOT NULL,
	`path` text NOT NULL,
	`kind` text NOT NULL,
	`started_at` integer NOT NULL,
	`finished_at` integer,
	`error` text
);
CREATE UNIQUE INDEX `hosts_live_launch_key_idx` ON `hosts` (`launch_key`) WHERE "hosts"."destroyed_at" is null;
CREATE TABLE `thread_plugin_metadata` (
	`thread_id` text NOT NULL,
	`plugin_id` text NOT NULL,
	`metadata_json` text NOT NULL,
	PRIMARY KEY(`thread_id`, `plugin_id`),
	FOREIGN KEY (`thread_id`) REFERENCES `threads`(`id`) ON UPDATE no action ON DELETE cascade
);
CREATE TABLE fork_workspace_write_claims (
    host_id TEXT NOT NULL,
    workspace_path TEXT NOT NULL,
    thread_id TEXT NOT NULL,
    owner_token TEXT NOT NULL,
    acquired_at INTEGER NOT NULL,
    heartbeat_at INTEGER NOT NULL,
    PRIMARY KEY (host_id, workspace_path)
  );
CREATE INDEX fork_workspace_write_claims_thread
  ON fork_workspace_write_claims (thread_id);
CREATE TABLE fork_workspace_file_observations (
      host_id TEXT NOT NULL,
      workspace_path TEXT NOT NULL,
      file_path TEXT NOT NULL,
      window_start INTEGER NOT NULL,
      thread_ids TEXT NOT NULL,
      observed_at INTEGER NOT NULL,
      PRIMARY KEY (host_id, workspace_path, file_path, window_start)
    );
CREATE TABLE fork_workspace_collisions (
      host_id TEXT NOT NULL,
      workspace_path TEXT NOT NULL,
      file_path TEXT NOT NULL,
      window_start INTEGER NOT NULL,
      thread_a TEXT NOT NULL,
      thread_b TEXT NOT NULL,
      noticed_at INTEGER NOT NULL,
      PRIMARY KEY (host_id, workspace_path, file_path, window_start, thread_a, thread_b)
    );
CREATE INDEX fork_workspace_file_observations_retention
      ON fork_workspace_file_observations (observed_at);
CREATE INDEX fork_workspace_collisions_retention
      ON fork_workspace_collisions (noticed_at);
CREATE TABLE `provider_model_catalogs` (
	`host_id` text NOT NULL,
	`provider_id` text NOT NULL,
	`scope_key` text NOT NULL,
	`fingerprint` text NOT NULL,
	`models_json` text NOT NULL,
	`selected_only_models_json` text NOT NULL,
	`fetched_at` integer NOT NULL,
	PRIMARY KEY(`host_id`, `provider_id`, `scope_key`),
	FOREIGN KEY (`host_id`) REFERENCES `hosts`(`id`) ON UPDATE no action ON DELETE cascade
);
CREATE INDEX `threads_lifecycle_owner_idx` ON `threads` (`lifecycle_owner_thread_id`);
CREATE TABLE `project_attachment_backfills` (
	`project_id` text PRIMARY KEY NOT NULL,
	`phase` text NOT NULL,
	`thread_cursor` text NOT NULL,
	`input_cursor` integer NOT NULL,
	`input_id` text NOT NULL,
	`input_sequence` integer NOT NULL,
	`attempted_at` integer NOT NULL,
	`error` text,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
CREATE TABLE `project_attachment_threads` (
	`attachment_id` text NOT NULL,
	`thread_id` text NOT NULL,
	PRIMARY KEY(`attachment_id`, `thread_id`),
	FOREIGN KEY (`attachment_id`) REFERENCES `project_attachments`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`thread_id`) REFERENCES `threads`(`id`) ON UPDATE no action ON DELETE cascade
);
CREATE INDEX `project_attachment_threads_thread_idx` ON `project_attachment_threads` (`thread_id`);
CREATE TABLE `project_attachments` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`stored_path` text NOT NULL,
	`original_name` text NOT NULL,
	`mime_type` text,
	`size_bytes` integer NOT NULL,
	`created_at` integer NOT NULL,
	`ready_at` integer,
	`deletion_claimed_at` integer,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "project_attachments_size_check" CHECK("project_attachments"."size_bytes" >= 0)
);
CREATE UNIQUE INDEX `project_attachments_project_path_idx` ON `project_attachments` (`project_id`,`stored_path`);
CREATE INDEX `project_attachments_project_created_idx` ON `project_attachments` (`project_id`,`created_at`);
CREATE INDEX `project_attachments_deletion_idx` ON `project_attachments` (`project_id`,`deletion_claimed_at`,`id`) WHERE "project_attachments"."deletion_claimed_at" IS NOT NULL;
CREATE INDEX `threads_project_id_idx` ON `threads` (`project_id`,`id`);
CREATE TABLE `environment_variables` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`project_id` text,
	`name` text NOT NULL,
	`ciphertext` text NOT NULL,
	`encryption_version` integer NOT NULL,
	`note` text,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
CREATE UNIQUE INDEX `environment_variables_global_name` ON `environment_variables` (`name`) WHERE "environment_variables"."project_id" IS NULL;
CREATE UNIQUE INDEX `environment_variables_project_name` ON `environment_variables` (`project_id`,`name`) WHERE "environment_variables"."project_id" IS NOT NULL;
CREATE TABLE `thread_pruning_cursors` (
	`policy` text NOT NULL,
	`scope` text DEFAULT '' NOT NULL,
	`thread_id` text,
	`version` integer NOT NULL,
	`last_thread_id` text DEFAULT '' NOT NULL,
	`current_thread_id` text,
	`step` integer DEFAULT 0 NOT NULL,
	`sequence` integer DEFAULT 0 NOT NULL,
	`upper_sequence` integer DEFAULT 0 NOT NULL,
	`cycle` integer DEFAULT 0 NOT NULL,
	`latest_root_sequence` integer DEFAULT 0 NOT NULL,
	`latest_context_sequence` integer DEFAULT 0 NOT NULL,
	`probe_event_id` text,
	`probe_phase` integer DEFAULT 0 NOT NULL,
	`probe_sequence` integer DEFAULT 0 NOT NULL,
	`probe_witness_id` text,
	`updated_at` integer NOT NULL, `work_revision` integer DEFAULT 0 NOT NULL,
	PRIMARY KEY(`policy`, `scope`),
	FOREIGN KEY (`thread_id`) REFERENCES `threads`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "thread_pruning_cursors_scope_check" CHECK("thread_pruning_cursors"."scope" = coalesce("thread_pruning_cursors"."thread_id", ''))
);
CREATE INDEX `thread_pruning_cursors_thread_idx` ON `thread_pruning_cursors` (`thread_id`);
CREATE INDEX `events_provider_identity_idx` ON `events` (`provider_thread_id`,`created_at`) WHERE "events"."type" = 'thread/identity';
CREATE TABLE `ui_preference_defaults` (
	`key` text PRIMARY KEY NOT NULL,
	`value_json` text NOT NULL
);
CREATE INDEX `environments_provider_lifecycle_idx` ON `environments` (`environment_provider_id`) WHERE "environments"."status" <> 'destroyed' OR "environments"."teardown_status" IS NOT 'removed';
CREATE UNIQUE INDEX `environments_owner_thread_idx` ON `environments` (`owner_thread_id`) WHERE "environments"."owner_thread_id" IS NOT NULL;
CREATE INDEX `prompt_history_entries_created_idx` ON `prompt_history_entries` (`created_at`,`request_sequence`,`id`);
CREATE TABLE fork_thread_turn_spend (
      thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
      turn_id TEXT NOT NULL,
      provider_thread_id TEXT NOT NULL,
      input_tokens INTEGER,
      cached_input_tokens INTEGER,
      output_tokens INTEGER,
      reasoning_output_tokens INTEGER,
      total_tokens INTEGER NOT NULL,
      updated_at INTEGER NOT NULL, model TEXT, model_mixed INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (thread_id, turn_id, provider_thread_id)
    );
CREATE INDEX fork_thread_turn_spend_thread_idx
      ON fork_thread_turn_spend (thread_id, turn_id)
  ;
CREATE INDEX fork_events_item_completion_lookup_idx ON events (thread_id, item_id, type, parent_tool_call_id);
CREATE TABLE fork_thread_turn_spend_repair (
      thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
      turn_id TEXT NOT NULL,
      repaired_at INTEGER NOT NULL,
      PRIMARY KEY (thread_id, turn_id)
    );
CREATE TABLE fork_thread_spend_rollup_repair (
      thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
      repaired_at INTEGER NOT NULL,
      PRIMARY KEY (thread_id)
    );
CREATE TABLE fork_thread_spawners (
      thread_id TEXT PRIMARY KEY NOT NULL,
      spawned_by_thread_id TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
CREATE TABLE `thread_pruning_work` (
	`policy` text NOT NULL,
	`thread_id` text NOT NULL,
	`revision` integer DEFAULT 1 NOT NULL,
	PRIMARY KEY(`policy`, `thread_id`),
	FOREIGN KEY (`thread_id`) REFERENCES `threads`(`id`) ON UPDATE no action ON DELETE cascade
);
CREATE INDEX `thread_pruning_work_thread_idx` ON `thread_pruning_work` (`thread_id`);
CREATE INDEX `hosts_pending_provider_idx` ON `hosts` (`machine_provider_id`) WHERE "hosts"."destroyed_at" IS NULL AND "hosts"."phase" <> 'destroyed';
CREATE INDEX `threads_deleted_cleanup_idx` ON `threads` (`deleted_at`) WHERE "threads"."deleted_at" IS NOT NULL;
CREATE TABLE fork_native_terminal_threads (
      thread_id TEXT PRIMARY KEY NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
      provider_id TEXT NOT NULL,
      native_session_id TEXT,
      terminal_session_id TEXT,
      initial_prompt TEXT,
      model TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    , initial_images TEXT);
CREATE UNIQUE INDEX fork_native_terminal_threads_session_idx
      ON fork_native_terminal_threads (provider_id, native_session_id)
      WHERE native_session_id IS NOT NULL;
CREATE TABLE fork_native_terminal_tool_credentials (
      thread_id TEXT PRIMARY KEY NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
      terminal_session_id TEXT NOT NULL,
      credential_hash TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
CREATE TABLE fork_terminal_attention (
      terminal_session_id TEXT PRIMARY KEY NOT NULL
        REFERENCES terminal_sessions(id) ON DELETE CASCADE,
      seq INTEGER NOT NULL CHECK (seq >= 0),
      daemon_seq INTEGER,
      kind TEXT NOT NULL CHECK (kind IN ('bell', 'osc-9', 'osc-99', 'osc-777')),
      title TEXT,
      body TEXT,
      attention_at INTEGER NOT NULL,
      cleared_at INTEGER,
      updated_at INTEGER NOT NULL
    );
CREATE TABLE "queued_thread_messages" (
	`id` text PRIMARY KEY NOT NULL,
	`system_notice` text,
	`thread_id` text NOT NULL,
	`content` text NOT NULL,
	`sender_thread_id` text,
	`origin` text,
	`origin_plugin_id` text,
	`requested_by_initiator` text,
	`requested_by_thread_id` text,
	`model` text NOT NULL,
	`reasoning_level` text NOT NULL,
	`permission_mode` text NOT NULL,
	`service_tier` text NOT NULL,
	`group_with_next` integer DEFAULT false NOT NULL,
	`state` text NOT NULL,
	`send_at` integer,
	`waiting_on` text,
	`wait_holder` text,
	`failure_reason` text,
	`failure_count` integer DEFAULT 0 NOT NULL,
	`next_attempt_at` integer,
	`payload_kind` text DEFAULT 'inline' NOT NULL,
	`retry_of_turn_request_id` text,
	`retry_attempt` integer,
	`retry_reason` text,
	`claimed_at` integer,
	`claim_token` text,
	`edit_held_until` integer,
	`sort_key` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`thread_id`) REFERENCES `threads`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "queued_thread_messages_state_check" CHECK(CASE `state`
        WHEN 'claimed' THEN `claimed_at` IS NOT NULL
        WHEN 'failed_retrying' THEN `claimed_at` IS NULL AND `failure_reason` IS NOT NULL AND `next_attempt_at` IS NOT NULL
        WHEN 'failed_exhausted' THEN `claimed_at` IS NULL AND `failure_reason` IS NOT NULL AND `next_attempt_at` IS NULL
        WHEN 'scheduled' THEN `claimed_at` IS NULL AND `failure_reason` IS NULL AND `send_at` IS NOT NULL
        WHEN 'waiting' THEN `claimed_at` IS NULL AND `failure_reason` IS NULL AND `send_at` IS NULL AND `waiting_on` IS NOT NULL
        WHEN 'queued' THEN `claimed_at` IS NULL AND `failure_reason` IS NULL AND `send_at` IS NULL AND `waiting_on` IS NULL
        ELSE 0
      END),
	CONSTRAINT "queued_thread_messages_claim_check" CHECK((`claimed_at` IS NULL) = (`claim_token` IS NULL)),
	CONSTRAINT "queued_thread_messages_failure_check" CHECK((`failure_reason` IS NULL AND `failure_count` = 0 AND `next_attempt_at` IS NULL)
        OR (`failure_reason` IS NOT NULL AND `failure_count` > 0)),
	CONSTRAINT "queued_thread_messages_schedule_check" CHECK(`send_at` IS NULL OR `waiting_on` IS NOT NULL),
	CONSTRAINT "queued_thread_messages_wait_holder_check" CHECK(`wait_holder` IS (CASE WHEN json_extract(`waiting_on`, '$.kind') = 'plugin' THEN 'plugin:' || json_extract(`waiting_on`, '$.pluginId') END))
);
CREATE INDEX `queued_thread_messages_thread_created_idx` ON `queued_thread_messages` (`thread_id`,`created_at`,`id`);
CREATE INDEX `queued_thread_messages_thread_sort_idx` ON `queued_thread_messages` (`thread_id`,`sort_key`,`id`);
CREATE INDEX `queued_thread_messages_due_idx` ON `queued_thread_messages` (`state`,`send_at`,`id`);
CREATE INDEX `queued_thread_messages_retry_idx` ON `queued_thread_messages` (`state`,`next_attempt_at`,`id`);
CREATE INDEX `queued_thread_messages_wait_holder_idx` ON `queued_thread_messages` (`wait_holder`,`id`) WHERE "queued_thread_messages"."wait_holder" IS NOT NULL;
CREATE TABLE `fork_thread_row_states` (
	`thread_id` text PRIMARY KEY NOT NULL,
	`statuses_json` text DEFAULT '{}' NOT NULL,
	`progress_json` text,
	`updated_at` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`thread_id`) REFERENCES `threads`(`id`) ON UPDATE no action ON DELETE cascade
);
CREATE TABLE `fork_terminal_output` (
	`terminal_session_id` text PRIMARY KEY NOT NULL,
	`host_id` text NOT NULL,
	`chunks_json` text NOT NULL,
	`byte_length` integer NOT NULL,
	`retained_at` integer NOT NULL,
	`expires_at` integer,
	FOREIGN KEY (`terminal_session_id`) REFERENCES `terminal_sessions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`host_id`) REFERENCES `hosts`(`id`) ON UPDATE no action ON DELETE cascade
);
CREATE INDEX `fork_terminal_output_host_retained_idx` ON `fork_terminal_output` (`host_id`,`retained_at`);
CREATE TABLE `fork_terminal_tab_dismissals` (
	`terminal_session_id` text PRIMARY KEY NOT NULL,
	`host_id` text NOT NULL,
	`dismissed_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	FOREIGN KEY (`terminal_session_id`) REFERENCES `terminal_sessions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`host_id`) REFERENCES `hosts`(`id`) ON UPDATE no action ON DELETE cascade
);
CREATE INDEX `fork_terminal_tab_dismissals_host_expiry_idx` ON `fork_terminal_tab_dismissals` (`host_id`,`expires_at`);
CREATE TABLE `fork_device_handoff_attention` (
	`terminal_session_id` text PRIMARY KEY NOT NULL,
	`attention_seq` integer NOT NULL,
	FOREIGN KEY (`terminal_session_id`) REFERENCES `terminal_sessions`(`id`) ON UPDATE no action ON DELETE cascade
);
INSERT INTO __drizzle_migrations VALUES(NULL,'adb1a266ae472f7893108b9dd06408de788b8a9d950c1c51fa510f5d009b29ff',1778891867195);
INSERT INTO __drizzle_migrations VALUES(NULL,'ae33954639f381d869c676374d5e9a9bc21f9e4b5fc7d4691b900ff9ead10870',1779139400000);
INSERT INTO __drizzle_migrations VALUES(NULL,'640e7080a3a9c140afdbaa48d059f97e7ab7ceb5ed315c9f5f0bae9389c213b0',1779139400001);
INSERT INTO __drizzle_migrations VALUES(NULL,'6809e29ab953b40044a4d17857e7f64caa1226814875a9da40e607bb5246b025',1779139400002);
INSERT INTO __drizzle_migrations VALUES(NULL,'cc696b4ceeccc725f959b6d0223ad87c9669c46bbcbda75a2e88f7d0b8377423',1779230683658);
INSERT INTO __drizzle_migrations VALUES(NULL,'26e2f7694fe7ce9101a9afb091e3e66e73c258a776aa5695b3b91baceb7938fd',1779417575414);
INSERT INTO __drizzle_migrations VALUES(NULL,'cf740c7c7ce28bce685d715d61d0e7113e7de9400dd3f6883eb79d1d76d78186',1779821204585);
INSERT INTO __drizzle_migrations VALUES(NULL,'d6e56edc731e1faea31e0fd404076ae271a4d32ee7d7db066e0de8b30eac96c4',1779943370189);
INSERT INTO __drizzle_migrations VALUES(NULL,'2a0bdfc588cb145599f84a84c7b17f7fc660fb9b9199d89ff1a0d6be8f9bd45f',1779990051923);
INSERT INTO __drizzle_migrations VALUES(NULL,'585a302ce0d11aca06f9d6d1fa1e400651ad368f24a7a15f65648dd21032491d',1780022553737);
INSERT INTO __drizzle_migrations VALUES(NULL,'93c3a773a4e79ff6c5c5917a9bcb4f2bfb2783ce8adf43f19df907f6eab085fd',1780353769697);
INSERT INTO __drizzle_migrations VALUES(NULL,'333e0ae58372a8c13754c43adae6509bc71cba952bc6ee3447618592d9da3b90',1780372340947);
INSERT INTO __drizzle_migrations VALUES(NULL,'d6fef98f84f2c1b2ed57b5de8b44a0b0ddab8010312783dac2327f53fcedc548',1780456749906);
INSERT INTO __drizzle_migrations VALUES(NULL,'9f38f66e3ead089e7cb0b103e350087dedd57bd5e07c3cd467f001e0164d64fa',1780614650350);
INSERT INTO __drizzle_migrations VALUES(NULL,'71aa75a569ee40eb3cce9ddaa38fd7e0ca6db8131f4f79da36425c0b9296e009',1780687798956);
INSERT INTO __drizzle_migrations VALUES(NULL,'13e38883e758cf412c1abcdaa5674935fdcbb2871a90444c92e573d667a174ea',1780687798957);
INSERT INTO __drizzle_migrations VALUES(NULL,'ad30180db07c6834b5427e499a367f29df316cea064dda7d921d40b656593ee7',1780692763264);
INSERT INTO __drizzle_migrations VALUES(NULL,'d486b030fcfdbfa6a9a75ebb3b000cf5fc2ed07601422edcc5aff54b797c733d',1780718665310);
INSERT INTO __drizzle_migrations VALUES(NULL,'6f911713459414248e4ff5559984bb2d4c21b465ea80875907cd3e554c8f9382',1780719536955);
INSERT INTO __drizzle_migrations VALUES(NULL,'0bfadd34fa6ede32f2e373cc20ea2f5b92ea883c85cd3963b9152101466ce234',1780719536956);
INSERT INTO __drizzle_migrations VALUES(NULL,'594cf4c0c420bc14f5add474f95b023554bc5176d253677a3ffb1fe1c49b9966',1780722411156);
INSERT INTO __drizzle_migrations VALUES(NULL,'d0507b4c4912b4b2100f468c15f9484cff3236d3b31bf05d1e093ff860dec2c5',1780786997623);
INSERT INTO __drizzle_migrations VALUES(NULL,'0df5f197130c7240ebb743286105ba6dc1a9529847b516bcc1bca4684220c2b5',1780786997624);
INSERT INTO __drizzle_migrations VALUES(NULL,'4066c09cd74de080b16c5a2e915b8282484d64f9b45c8a00278f5cadd5fbc432',1780973302146);
INSERT INTO __drizzle_migrations VALUES(NULL,'c0c8836086aceadb10875a1f7c3163e58afe1ba061639d7dba70697a48650528',1781067867735);
INSERT INTO __drizzle_migrations VALUES(NULL,'078e5cfcea6ee38a9788cbc78eb96d44e5d7c795d2b1b8dc5fab3ea7f9d7101f',1781104752480);
INSERT INTO __drizzle_migrations VALUES(NULL,'fbeb0ec22829fc39d933929557e0dbbb6d654181f7ad68d6fed93f4edd27e45b',1781107791352);
INSERT INTO __drizzle_migrations VALUES(NULL,'39d0d0efa5ee1e6a3dc1985b273a6d954374efe46a899f85edfacabbbdb2a10b',1781213816184);
INSERT INTO __drizzle_migrations VALUES(NULL,'c398947c5d36a03ae62ea90e9c09e527b351ea8f7c290c3f5e8a59eacf2ccf1d',1781214774803);
INSERT INTO __drizzle_migrations VALUES(NULL,'f7d3a7573355786f361c91b1e2a8d647811e1ed2ce04655c43976656d836bf5e',1781221107024);
INSERT INTO __drizzle_migrations VALUES(NULL,'3ac9ee04bc28ffa86e71ea4269ef77bf96795f9ec8784c08daf691779ec0c916',1781299832942);
INSERT INTO __drizzle_migrations VALUES(NULL,'57c844093b343c39194547099f382534dd8b0b34b9d742f1873f6a119e56f79d',1781403656069);
INSERT INTO __drizzle_migrations VALUES(NULL,'60ea3776242e971bf5474612ea372162c860360413fe021c9262e4a669306ffd',1781557200000);
INSERT INTO __drizzle_migrations VALUES(NULL,'59c96fb961513570ba7765b36a0318b1996bcb9e64f49fcfad538995c309b5c2',1781557300000);
INSERT INTO __drizzle_migrations VALUES(NULL,'2c35705eb0ad1c912907cba3f223046db034ad926b0aa61d8a50cd6ed3563ab0',1781557400000);
INSERT INTO __drizzle_migrations VALUES(NULL,'3116412ce3df6fcfd4f1147fede79f4cdf2bf3eb20dd172b5ac6cee987074dbc',1781557500000);
INSERT INTO __drizzle_migrations VALUES(NULL,'7e0c19f7b661a163b59e693c715a83832661f30421b6cbc8115ef1e6230e128b',1781647572409);
INSERT INTO __drizzle_migrations VALUES(NULL,'1a61c1335f1a0737ddab141fefada04e3dd1fe55d430a2b9a1324e8edef9a9f3',1781653023172);
INSERT INTO __drizzle_migrations VALUES(NULL,'661cd41d4be04eb6f324877e030b25218924abd88c3a74ced08b7ede2f4e91dd',1781660000000);
INSERT INTO __drizzle_migrations VALUES(NULL,'6fc7071ac6397cc785b11d8ac78523ace5044c9f68a4f90e6f3765eac13ee8be',1781660000001);
INSERT INTO __drizzle_migrations VALUES(NULL,'b964879b79697de859e7028f2c43ca67074583b159c0794eae58465368d2860d',1781660000002);
INSERT INTO __drizzle_migrations VALUES(NULL,'f256e3a3b0d2abfff9643283a8386d576712aadc02c1d62ea9255c94166275e4',1781660000003);
INSERT INTO __drizzle_migrations VALUES(NULL,'17cbfcadd2a104fde0e1ac3bcc60167a7846f32d074ae6a3f405c0610a1f73ae',1781917615702);
INSERT INTO __drizzle_migrations VALUES(NULL,'8a5bed6bb1077474f1ceb269ccd0de37ba1c50a22e524140bf6bd5d8a3c08ca0',1782173519934);
INSERT INTO __drizzle_migrations VALUES(NULL,'b4b0f65337aa3ca71713c957e630a7d3ebf6db76a7b390056521a4230b3f6480',1782249376381);
INSERT INTO __drizzle_migrations VALUES(NULL,'42e4d98a334ccb62f113801e2149386d7abb21fabd5dbedeb2fd2df329bdb100',1782251367423);
INSERT INTO __drizzle_migrations VALUES(NULL,'212469434936451aa0b2a601f5a63f388f410141d94c47c2b4704481ab1cdfb6',1782252763916);
INSERT INTO __drizzle_migrations VALUES(NULL,'b4e0497804e46e0a0b0b8c31975b062152d551bac49c3c2e80932567b4085dcd',1782273194188);
INSERT INTO __drizzle_migrations VALUES(NULL,'7ab0b93aa71c25ffba166580f481986114dee6c330eeaede59c4fcd738c07211',1782360574681);
INSERT INTO __drizzle_migrations VALUES(NULL,'e28b7d3145a2f27573127bba59db2c5760fb54311ac3f5411d475f54d43f2936',1782944919237);
INSERT INTO __drizzle_migrations VALUES(NULL,'1313c744fbc1320b6e8eeecb1e29734aed8d12a65ef62f10d3e34986c5e09178',1782946738155);
INSERT INTO __drizzle_migrations VALUES(NULL,'0cf426a3278a1165ea7870344bb6370df3bbd5b6c61716ad3f5f41097f692dbc',1782948149272);
INSERT INTO __drizzle_migrations VALUES(NULL,'84713aa0ad53d404c177bd03447cf725ef7587b44b9e29d87e983149b7390336',1782952170023);
INSERT INTO __drizzle_migrations VALUES(NULL,'7c84358e653ad86bd61f52dddd01ffbbdf3dd67bfe76f5aea3687e84312422f6',1783265400374);
INSERT INTO __drizzle_migrations VALUES(NULL,'8e67413001e0f0e611cb6c8b7b2adc9c61cf42b5b8a15c71d6549e4e74f0f783',1783351082402);
INSERT INTO __drizzle_migrations VALUES(NULL,'5c2ebe4be074e15f66a35e244f84cc9d95ebacfc3128add41abf71cb6315a28e',1783354375744);
INSERT INTO __drizzle_migrations VALUES(NULL,'93a79ed6b65dc415ec9be41f624c0a073391ff0b70b8182cb6ce3162b5eda8cc',1783464830533);
INSERT INTO __drizzle_migrations VALUES(NULL,'08f8e438dbb7a5dd7b3fa4b36591e0e88661e8a172417e35615c1087a04014d3',1783488303729);
INSERT INTO __drizzle_migrations VALUES(NULL,'3350ab0ca1f5cb8854c7818a99ae5051de2e4b47683e133ec5abc3ba58be0d72',1783554416332);
INSERT INTO __drizzle_migrations VALUES(NULL,'7d4a104bb9899b325e166fb5345a92c8f2eb2d5a204f1ff72ca2b1a5fc1f583c',1783626227375);
INSERT INTO __drizzle_migrations VALUES(NULL,'0aeba921462baeb21824d1a858518f05cacfaa004b4a45dcd5f101c39621cdc5',1783663695773);
INSERT INTO __drizzle_migrations VALUES(NULL,'9486335ec00e61691c814af88a53fb2f718336baf9cfcb6a11dc31a080960663',1783721756867);
INSERT INTO __drizzle_migrations VALUES(NULL,'a3624509ee3c7c128ac81822b6a95ec7aca840a3866017edc996ecbd4e931b52',1783729089579);
INSERT INTO __drizzle_migrations VALUES(NULL,'f84c8a0c25aec456922398d896555f7765331f85040f80fd5175015d2802dd72',1783741514031);
INSERT INTO __drizzle_migrations VALUES(NULL,'6b73accf9a1700631b6cdd75c598c71c8d126f99ccbbc082e7b9ad1baef5f606',1783808433737);
INSERT INTO __drizzle_migrations VALUES(NULL,'848eef8d9b05a092dedd2fa5232f43311bb79493268cd769b551e456bffab030',1783809378708);
INSERT INTO __drizzle_migrations VALUES(NULL,'3bc2aa82297e47d394ce6f86d0085626ce54f7112ac45afef52b0ea15cec230c',1783917774403);
INSERT INTO __drizzle_migrations VALUES(NULL,'23d73ab09eb41ddfc476ba5344ec56251b471abaf5aa98fc8b37956c396a90e8',1783979475769);
INSERT INTO __drizzle_migrations VALUES(NULL,'d9c84d991584a469fc44d763bb37080203d271516750926e906302810d0f6ab0',1783990869150);
INSERT INTO __drizzle_migrations VALUES(NULL,'a094698914893cd3510326f452dcdb3edfaa82dd2d294b2c8ce20d631047ffb5',1783996567564);
INSERT INTO __drizzle_migrations VALUES(NULL,'7cb4e6fa70b6715205bedf27addf71600f8ff8726433f65e13a0152bc64fc816',1784044149805);
INSERT INTO __drizzle_migrations VALUES(NULL,'9096664cbd9c678eb240e53d27d6e2dd28b362386ddc6e9ac9f991698ad12817',1784086639143);
INSERT INTO __drizzle_migrations VALUES(NULL,'aaa2cbf779ee44aed15201c9d9c0d01a2bec4349aafe49b4ff422ec8d1668f0c',1784132965255);
INSERT INTO __drizzle_migrations VALUES(NULL,'7b3ebd7351ceda7c757d3ae62afd653e8915cc52a6664f1e46f862f4ed71749e',1784156543551);
INSERT INTO __drizzle_migrations VALUES(NULL,'3a79abc330171955eeb6106d57d1533cdcdb9e6e32ceb5268eaf590c1a0208ff',1784188800245);
INSERT INTO __drizzle_migrations VALUES(NULL,'53053712e3a1e91aa3ca337ac689ee325902a4bf2a4dfefcfeb100e25fe34fc5',1784216319756);
INSERT INTO __drizzle_migrations VALUES(NULL,'b0eba844fb3f488b8e3d2813bcdcf95b1a676c0ee779e7e4f85c799e3edaac1a',1784257485616);
INSERT INTO __drizzle_migrations VALUES(NULL,'6ecb23481d6e5b098ab41dccdf10eb8106034494935c05565e94026e7c81c1e7',1784301355776);
INSERT INTO __drizzle_migrations VALUES(NULL,'7d1d0c4a08eb09944fa741ffeb79b919c0cb07b30a49c2853325c9859f3d9b93',1784311522462);
INSERT INTO __drizzle_migrations VALUES(NULL,'3fad6f398ccf769badc20bb5a2e9c7a015c6d651678fc161ecebddace736321c',1784586995458);
INSERT INTO __drizzle_migrations VALUES(NULL,'3c39c14f42331ff9c07dd30ce8f8de6ad450854319bb1f8a0e778fe1c86c7e94',1784689864429);
INSERT INTO __drizzle_migrations VALUES(NULL,'1fe7dd567f3bfa6cc295925a342cb87687a629ca49f132ca96f9de85d0b38424',1785358316123);
INSERT INTO __drizzle_migrations VALUES(NULL,'76f2af05f1cd9acd527c25935dfac8cec13607070771f5da685d099c90f8a42b',1785434970796);
INSERT INTO __drizzle_migrations VALUES(NULL,'2a3667c7900eaec4550903de0953dcc5274f6be19d4961921e266d442d841a64',1785607816930);
INSERT INTO __drizzle_migrations VALUES(NULL,'3a411ccab6ca1519bbfd7dfe5986093b8ef3d62b819181a8d63188ce58cf0656',1785800787885);
INSERT INTO __drizzle_migrations VALUES(NULL,'1a5a7b4d6ca14b179c78d218a56bd909822ccd173c5a97911401a3ffaa2e23f0',1785947206119);
INSERT INTO __drizzle_migrations VALUES(NULL,'b4c8565ea3bf4a3bb4bf2c0faa0e96e11bd15ba5f7b2d8cd3764cc76d479cb3e',1785996189362);
INSERT INTO __drizzle_migrations VALUES(NULL,'8ad4be4b8bc491371c79bcefae4aa1cbc40a2df94b7f6dfcff1e5fa63bcc7f52',1786043536668);
INSERT INTO __drizzle_migrations VALUES(NULL,'2e291fac022875289dbfeddeab2c694ceb7c678ace8d3723007ac3b011d9928d',1786223263495);
INSERT INTO __drizzle_migrations VALUES(NULL,'ad4e2c086b93a9d177dcf650afb65e65b72c940f34d433751b1bbf18c42029a4',1786228557657);
INSERT INTO __drizzle_migrations VALUES(NULL,'c332458ef5b567f4a2283d13e36b5296671178431396e27ac7eb9801575b99cf',1786384629899);
INSERT INTO __drizzle_migrations VALUES(NULL,'a5f48de22f2b7ca9bc69c4c1bc9cda01384a362447cf1aee860854803b7d1791',1786416023798);
INSERT INTO __drizzle_migrations VALUES(NULL,'e63e22672442bd29e71a08ce4fd367e2f5976d7663ecb43978c85bb420b9be85',1786468375011);
INSERT INTO __drizzle_migrations VALUES(NULL,'34bc9d7699311c61a42adb1781618f95795be7f445badfe6cf2a439a30cf14a1',1786565524902);
INSERT INTO __drizzle_migrations VALUES(NULL,'971d3a8ee11320029b49d2ec8f66cd8e6fdf7037484675b3cf87c542255dd994',1786719546233);
INSERT INTO __drizzle_migrations VALUES(NULL,'be9818be13e647635a1e7565f1cafc80b792c381600f66ebf598c5d99a77ff2c',1786722013088);
INSERT INTO __drizzle_migrations VALUES(NULL,'e7098c67aedcc9aabcda306a0bb03e12c1013edad42d753e5b84f29b1d1fbed5',1786722089647);
INSERT INTO __drizzle_migrations VALUES(NULL,'4bf34aec4242fbd28890cecbbde5ac6aae2dbb40533d56db48db6639dd5eed92',1786722321775);
INSERT INTO __drizzle_migrations VALUES(NULL,'3902bd0575c70be3470f7c68d68823540d2cff77cb970a690b5afeb7c810bd71',1786745604262);
INSERT INTO __drizzle_migrations VALUES(NULL,'16e8e2f3c94038256d96e4e1922ef14d9326fcf8bb513dee5f3eb22e1734c274',1787001047515);
INSERT INTO __drizzle_migrations VALUES(NULL,'2b9860f1b7ffb385c67531088b9fcda233626802a1cda5fc1a579c14b5b9f5e7',1787031224925);
INSERT INTO __drizzle_migrations VALUES(NULL,'ab622990c25d0b0f93b2a23d45ca0886c18de822f40cd3a9849c75b5f76d15cc',1787108435805);
INSERT INTO __drizzle_migrations VALUES(NULL,'6fae719c1c31a764373accb55a8453548b02b416cb902d6c7228c908ef772e56',1787163393338);
INSERT INTO __drizzle_migrations VALUES(NULL,'9428a2e9e9dcf61a8d7b3d431257e7472956eb8be97f576a0a8bc1c8300198e1',1787181956957);
INSERT INTO __drizzle_migrations VALUES(NULL,'33cedeb7b7f2e121ac6f5ac0d8d1cdeb11cba50d53c33802f64fb4cc6ec13253',1787212680694);
INSERT INTO __drizzle_migrations VALUES(NULL,'195d874498a4a8daec3ebde13f7d64473345228d3b521357443da6ec54d3f465',1787288444172);
INSERT INTO __drizzle_migrations VALUES(NULL,'a6156fcccd400330d8e65fafdd567af25ac12a0649cf2db8024c5dc1f3f10150',1787305850786);
INSERT INTO __drizzle_migrations VALUES(NULL,'da63f96688d22f8b573b0673d1ba9e72051fde268f27052607231cb25bfae584',1787331095369);
INSERT INTO __drizzle_migrations VALUES(NULL,'0ae872521ffd026ae67358c2ab016176711bf7477aa77060076c1100a0b30790',1787613751578);
INSERT INTO __drizzle_migrations VALUES(NULL,'c9ced750de5290719e05a9289ab15f65eddec720c212f6691d8a4a85d3d372d4',1787680413251);
INSERT INTO __drizzle_migrations VALUES(NULL,'d20d9adcb87dff95eeaec80fb1f0a11103f7d4874f5d1f83b328f150ecfc8fd9',1787951141606);
INSERT INTO __drizzle_migrations VALUES(NULL,'98b60b18ff3452c7bb338b730d871e12dc7e746d5769db0e46af68ca6f848762',1788219579088);
INSERT INTO __drizzle_migrations VALUES(NULL,'7a606a2adf66e34d01fd7388d242a1babf4fa08f1782a6683590dab511d2bf82',1788280102293);
INSERT INTO __drizzle_migrations VALUES(NULL,'1ea53a0233b29a66e2cdcb1677ce12c1417fddf89894d2a997797122586a4f07',1788893744236);
INSERT INTO __drizzle_migrations VALUES(NULL,'dc94fe7d94bd58cabf267c865a2866d95faa5b82f08ad650fac27ad248e8d31b',1788898395603);
INSERT INTO __drizzle_migrations VALUES(NULL,'d0cba61bdc7c76a0cb9e56acb28bf8be6873f488e4249b6b4a95ad5f51354970',1788908496395);
INSERT INTO __drizzle_migrations VALUES(NULL,'a083771588e92fffd918caab96781295d731410289be1fabce22b397212c23c2',1789075667774);
INSERT INTO __drizzle_migrations VALUES(NULL,'56190de7e154b675cfef5a8350831798da79c1ca7b1ac8d3411f6c13216c87c9',1789081162875);
INSERT INTO __drizzle_migrations VALUES(NULL,'771dcbb3da7b33817135a88562552c205e0ba463d4fb5554073f070a5940079a',1789175706080);
INSERT INTO __drizzle_migrations VALUES(NULL,'3b52dfb51f2407eca60e371643fa9a690226dbf280ab20bc7a1428934a65401c',1789226927698);
INSERT INTO __drizzle_migrations VALUES(NULL,'7825fbf8f83d1ea73d281d258230d247984197576e33c3993067793a921a8a40',1789421366079);
INSERT INTO __drizzle_migrations VALUES(NULL,'0005bb1993d019d88e07ee53664c1539fe4bf2caf43e923ecccb94a99dac0282',1789517219955);
INSERT INTO __drizzle_migrations VALUES(NULL,'bdb50ff7532f6e19c7072403841ac794071cb3cf9929330eb38e4a25878aeac5',1789582058249);
INSERT INTO __drizzle_migrations VALUES(NULL,'8d1607049db3aa47d1462439d1c884c2af3249fdf7c9cf4800c19f91b107df25',1789583950442);
INSERT INTO __drizzle_migrations VALUES(NULL,'33028875ada0d56d985732aef140bba65c630821503f2b729f2e7a777add2e4d',1789586944199);
INSERT INTO __drizzle_migrations VALUES(NULL,'6544312020a1075521bf4658997d924008a07769b8d63655248fc00169418e14',1789588549270);
INSERT INTO __drizzle_migrations VALUES(NULL,'88db16127e08c30acad181c787cc61638bd8e2d01bbae332ab58f9db53b18002',1789607725218);
INSERT INTO __drizzle_migrations VALUES(NULL,'79e48d9fb8ad714d6d7294444bc3a3d95bd9e5316b79f483298237cf1770b4d2',1789925496816);
INSERT INTO __drizzle_migrations VALUES(NULL,'0255288a71d9243e596718162094e775b48e432cd7ce95f2ef0ddcd2100fc6ce',1790008317938);
INSERT INTO __drizzle_migrations VALUES(NULL,'ce08aecb1ce3d82d9ec11dd5a4a8ef20332ce783937a609a0e99a28f844adba6',1790009314673);
INSERT INTO __drizzle_migrations VALUES(NULL,'effe6742241a63e10b91e9d64aeb5cc768e4f4eaf59940c6454462ba6d9a4743',1790016310646);
INSERT INTO __drizzle_migrations VALUES(NULL,'638c9de3b48d4977abe64b07d2a8e0ef4915e6b79ea362d80f0bf4568217fa4b',1790230932025);
INSERT INTO __drizzle_migrations VALUES(NULL,'34086c32a5765e290293be611f00de29327ad1903e663f11b93d88eacfb95f7f',1790322211064);
INSERT INTO __drizzle_migrations VALUES(NULL,'db9691fc4d924f6b5127014a21ea322590a9b62c5adc905d688ffa2777b9e359',1790613729994);
INSERT INTO __drizzle_migrations VALUES(NULL,'710ddf746e6444a29dfbeec907d1fd9bef9866bb642ff8e1ffb359673824b8f8',1790738477751);
INSERT INTO __drizzle_migrations VALUES(NULL,'e78d21751efadc2a2bf294a1a80cc4de753889bd3dcc2cce41f07e49e480ce95',1790794077074);
INSERT INTO __drizzle_migrations VALUES(NULL,'28a43e605a4e3019572be13d9b973948ca1db49ac4b1305cedd639ec34e2240a',1790889888606);
INSERT INTO __drizzle_migrations VALUES(NULL,'321b0a441d5a3fcc52561732c1357da6de0495786051664042c018e0cda70e8c',1790900209592);
INSERT INTO __drizzle_migrations VALUES(NULL,'cdfcfc577badf3ead0d14bbd585a9b69a7f8b8e3ae0c9c4c1925e73df1d54ba7',1791399370294);
INSERT INTO __drizzle_migrations VALUES(NULL,'bd05585327645a26ce4f11dc8bbc5d21d987537cd48cd282ab324ad393cb232e',1791402653913);
INSERT INTO __drizzle_migrations VALUES(NULL,'305cd6985428d7880ab47e12617da7ca26084ddbac6ea1f81762aabd44869944',1791411660016);
INSERT INTO __drizzle_migrations VALUES(NULL,'fe84986e62bf4077b0e35cbe7013513dd11476dc1b75fe131763559291800a26',1791414564985);
INSERT INTO __drizzle_migrations VALUES(NULL,'79542ad9056ba0cd4ed4e3480c94118893e84101fa8edd6bf317ecd494a2db3d',1791840325007);
INSERT INTO __drizzle_migrations VALUES(NULL,'49c11f683673c7ec8f583f3ce20a5b24e300b144eadda999c7ec6f9600d800a3',1792010323040);
INSERT INTO __drizzle_migrations VALUES(NULL,'b8fa8f61705f7b55adec8132507dd3971e81c68ced79a695da93933fe79471c8',1792163858066);
INSERT INTO __drizzle_migrations VALUES(NULL,'90b205d666e99138352efae6af5551e935cab778618a890065d28f1407b9d5a3',1792183118231);
INSERT INTO __drizzle_migrations VALUES(NULL,'b56954240864756e3184bcd8ebd30f67927fd01aee72f6a9ec00741e1da0b5d7',1792193667184);
INSERT INTO __drizzle_migrations VALUES(NULL,'f3510b4d8ca3b2f0d801d13204f9fc3d4f29f7f4bdab521b108a84b20f49dd7e',1792200133276);
INSERT INTO __drizzle_migrations VALUES(NULL,'f183424ddc7c72177e60979b040b7a024c964a78d5fce3733d90b02f3154f566',1792262861731);
