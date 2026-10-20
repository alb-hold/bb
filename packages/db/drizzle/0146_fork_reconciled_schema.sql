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
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS fork_detached_threads (
      thread_id TEXT PRIMARY KEY,
      host_id TEXT NOT NULL,
      expires_at INTEGER NOT NULL
    );
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS fork_detached_threads_host
      ON fork_detached_threads (host_id);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS fork_queued_message_dispatch_retries (
      queued_message_id TEXT PRIMARY KEY NOT NULL
        REFERENCES queued_thread_messages(id) ON DELETE CASCADE,
      thread_id TEXT NOT NULL,
      attempt INTEGER NOT NULL,
      next_attempt_at INTEGER NOT NULL,
      last_error TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS fork_queued_message_dispatch_retries_due_idx
      ON fork_queued_message_dispatch_retries (next_attempt_at, queued_message_id);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS fork_worker_event_keys (
      replay_key TEXT PRIMARY KEY,
      created_at INTEGER NOT NULL
    );
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS fork_worker_event_keys_created_at
      ON fork_worker_event_keys (created_at);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS fork_thread_execution_reports (
      thread_id TEXT PRIMARY KEY NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
      model TEXT NOT NULL,
      reasoning_level TEXT,
      permission_mode TEXT,
      service_tier TEXT,
      reported_at INTEGER NOT NULL
    );
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS fork_project_provider_execution_defaults (
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      provider_id TEXT NOT NULL,
      model TEXT NOT NULL,
      reasoning_level TEXT NOT NULL,
      permission_mode TEXT NOT NULL,
      service_tier TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (project_id, provider_id)
    );
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS fork_thread_spend_daily (
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
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS fork_thread_spend_daily_day_idx
      ON fork_thread_spend_daily (day);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS fork_thread_spend_cursor (
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
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS fork_spend_prices (
      provider_id TEXT NOT NULL,
      model TEXT NOT NULL,
      input_usd_per_mtok REAL NOT NULL,
      cached_input_usd_per_mtok REAL NOT NULL,
      output_usd_per_mtok REAL NOT NULL,
      PRIMARY KEY (provider_id, model)
    );
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS fork_spend_assessments (
      topic TEXT PRIMARY KEY NOT NULL,
      requested_at INTEGER NOT NULL,
      window_from TEXT NOT NULL,
      window_to TEXT NOT NULL,
      payload_sha256 TEXT NOT NULL,
      response TEXT NOT NULL,
      host TEXT NOT NULL,
      thread_id TEXT NOT NULL
    );
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS fork_events_file_change_truncation_idx
      ON events (created_at, id)
      WHERE item_kind = 'fileChange'
        AND type IN ('item/started', 'item/completed');
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS fork_workspace_write_claims (
    host_id TEXT NOT NULL,
    workspace_path TEXT NOT NULL,
    thread_id TEXT NOT NULL,
    owner_token TEXT NOT NULL,
    acquired_at INTEGER NOT NULL,
    heartbeat_at INTEGER NOT NULL,
    PRIMARY KEY (host_id, workspace_path)
  );
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS fork_workspace_write_claims_thread
  ON fork_workspace_write_claims (thread_id);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS fork_workspace_file_observations (
      host_id TEXT NOT NULL,
      workspace_path TEXT NOT NULL,
      file_path TEXT NOT NULL,
      window_start INTEGER NOT NULL,
      thread_ids TEXT NOT NULL,
      observed_at INTEGER NOT NULL,
      PRIMARY KEY (host_id, workspace_path, file_path, window_start)
    );
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS fork_workspace_collisions (
      host_id TEXT NOT NULL,
      workspace_path TEXT NOT NULL,
      file_path TEXT NOT NULL,
      window_start INTEGER NOT NULL,
      thread_a TEXT NOT NULL,
      thread_b TEXT NOT NULL,
      noticed_at INTEGER NOT NULL,
      PRIMARY KEY (host_id, workspace_path, file_path, window_start, thread_a, thread_b)
    );
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS fork_workspace_file_observations_retention
      ON fork_workspace_file_observations (observed_at);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS fork_workspace_collisions_retention
      ON fork_workspace_collisions (noticed_at);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS fork_thread_turn_spend (
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
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS fork_thread_turn_spend_thread_idx
      ON fork_thread_turn_spend (thread_id, turn_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS fork_events_item_completion_lookup_idx ON events (thread_id, item_id, type, parent_tool_call_id);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS fork_thread_turn_spend_repair (
      thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
      turn_id TEXT NOT NULL,
      repaired_at INTEGER NOT NULL,
      PRIMARY KEY (thread_id, turn_id)
    );
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS fork_thread_spend_rollup_repair (
      thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
      repaired_at INTEGER NOT NULL,
      PRIMARY KEY (thread_id)
    );
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS fork_thread_spawners (
      thread_id TEXT PRIMARY KEY NOT NULL,
      spawned_by_thread_id TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS fork_native_terminal_threads (
      thread_id TEXT PRIMARY KEY NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
      provider_id TEXT NOT NULL,
      native_session_id TEXT,
      terminal_session_id TEXT,
      initial_prompt TEXT,
      model TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    , initial_images TEXT);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS fork_native_terminal_threads_session_idx
      ON fork_native_terminal_threads (provider_id, native_session_id)
      WHERE native_session_id IS NOT NULL;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS fork_native_terminal_tool_credentials (
      thread_id TEXT PRIMARY KEY NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
      terminal_session_id TEXT NOT NULL,
      credential_hash TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS fork_terminal_attention (
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
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `terminal_sessions_status_thread_idx` ON `terminal_sessions` (`status`,`thread_id`);
