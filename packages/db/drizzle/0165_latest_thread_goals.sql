CREATE TABLE IF NOT EXISTS `latest_thread_goals` (
	`thread_id` text PRIMARY KEY NOT NULL,
	`sequence` integer
);
--> statement-breakpoint
INSERT OR IGNORE INTO latest_thread_goals(thread_id)
SELECT DISTINCT thread_id FROM events INDEXED BY events_thread_state_thread_sequence_idx
WHERE type IN ('thread/goal/updated', 'thread/goal/cleared', 'thread/extensionState/updated');
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS latest_thread_goals_insert AFTER INSERT ON events
WHEN (NEW.type IN ('thread/goal/updated', 'thread/goal/cleared', 'thread/extensionState/updated')
    AND (NEW.type <> 'thread/extensionState/updated' OR json_extract(NEW.data, '$.kind') = 'provider-codex/goal'))
BEGIN
  INSERT INTO latest_thread_goals(thread_id, sequence)
  SELECT NEW.thread_id, NEW.sequence WHERE (NEW.type IN ('thread/goal/updated', 'thread/goal/cleared', 'thread/extensionState/updated')
    AND (NEW.type <> 'thread/extensionState/updated' OR json_extract(NEW.data, '$.kind') = 'provider-codex/goal'))
  ON CONFLICT(thread_id) DO UPDATE SET sequence = CASE WHEN latest_thread_goals.sequence IS NULL THEN (
    SELECT sequence FROM events INDEXED BY events_thread_state_thread_sequence_idx
    WHERE thread_id = NEW.thread_id
      AND type IN ('thread/goal/updated', 'thread/goal/cleared', 'thread/extensionState/updated')
      AND (type <> 'thread/extensionState/updated' OR json_extract(data, '$.kind') = 'provider-codex/goal')
    ORDER BY sequence DESC LIMIT 1
  ) ELSE excluded.sequence END
  WHERE latest_thread_goals.sequence IS NULL OR excluded.sequence > latest_thread_goals.sequence;
END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS latest_thread_goals_delete AFTER DELETE ON events
WHEN OLD.type IN ('thread/goal/updated', 'thread/goal/cleared', 'thread/extensionState/updated')
  AND EXISTS (SELECT 1 FROM latest_thread_goals WHERE thread_id = OLD.thread_id AND (sequence IS NULL OR sequence = OLD.sequence))
BEGIN
  DELETE FROM latest_thread_goals WHERE thread_id = OLD.thread_id AND (sequence IS NULL OR sequence = OLD.sequence);
  INSERT OR IGNORE INTO latest_thread_goals(thread_id, sequence)
  SELECT thread_id, sequence FROM events INDEXED BY events_thread_state_thread_sequence_idx
  WHERE thread_id = OLD.thread_id AND (type IN ('thread/goal/updated', 'thread/goal/cleared', 'thread/extensionState/updated')
    AND (type <> 'thread/extensionState/updated' OR json_extract(data, '$.kind') = 'provider-codex/goal'))
  ORDER BY sequence DESC LIMIT 1;
END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS latest_thread_goals_update AFTER UPDATE OF thread_id, sequence, type, data ON events
WHEN (OLD.type IN ('thread/goal/updated', 'thread/goal/cleared', 'thread/extensionState/updated')
    AND (OLD.type <> 'thread/extensionState/updated' OR json_extract(OLD.data, '$.kind') = 'provider-codex/goal')) OR (NEW.type IN ('thread/goal/updated', 'thread/goal/cleared', 'thread/extensionState/updated')
    AND (NEW.type <> 'thread/extensionState/updated' OR json_extract(NEW.data, '$.kind') = 'provider-codex/goal'))
BEGIN
  DELETE FROM latest_thread_goals WHERE thread_id = OLD.thread_id AND (sequence IS NULL OR sequence = OLD.sequence);
  INSERT OR IGNORE INTO latest_thread_goals(thread_id, sequence)
  SELECT thread_id, sequence FROM events INDEXED BY events_thread_state_thread_sequence_idx
  WHERE thread_id = OLD.thread_id AND (type IN ('thread/goal/updated', 'thread/goal/cleared', 'thread/extensionState/updated')
    AND (type <> 'thread/extensionState/updated' OR json_extract(data, '$.kind') = 'provider-codex/goal'))
  ORDER BY sequence DESC LIMIT 1;
  INSERT INTO latest_thread_goals(thread_id, sequence)
  SELECT NEW.thread_id, NEW.sequence WHERE (NEW.type IN ('thread/goal/updated', 'thread/goal/cleared', 'thread/extensionState/updated')
    AND (NEW.type <> 'thread/extensionState/updated' OR json_extract(NEW.data, '$.kind') = 'provider-codex/goal'))
  ON CONFLICT(thread_id) DO UPDATE SET sequence = CASE WHEN latest_thread_goals.sequence IS NULL THEN (
    SELECT sequence FROM events INDEXED BY events_thread_state_thread_sequence_idx
    WHERE thread_id = NEW.thread_id
      AND type IN ('thread/goal/updated', 'thread/goal/cleared', 'thread/extensionState/updated')
      AND (type <> 'thread/extensionState/updated' OR json_extract(data, '$.kind') = 'provider-codex/goal')
    ORDER BY sequence DESC LIMIT 1
  ) ELSE excluded.sequence END
  WHERE latest_thread_goals.sequence IS NULL OR excluded.sequence > latest_thread_goals.sequence;
END;
