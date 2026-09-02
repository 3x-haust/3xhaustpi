import type { DatabaseSync } from "node:sqlite";

export function migrateTuiSideChatSchema(database: DatabaseSync): void {
	database.exec(`
		CREATE TABLE IF NOT EXISTS tui_side_chats (
			canonical_path TEXT PRIMARY KEY,
			chat_id TEXT NOT NULL UNIQUE,
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL
		) STRICT;
		CREATE TABLE IF NOT EXISTS tui_side_turns (
			turn_id TEXT PRIMARY KEY,
			chat_id TEXT NOT NULL REFERENCES tui_side_chats(chat_id) ON DELETE CASCADE,
			sequence INTEGER NOT NULL CHECK (sequence > 0),
			question TEXT NOT NULL,
			answer TEXT,
			status TEXT NOT NULL CHECK (status IN ('running', 'completed', 'failed', 'canceled')),
			provider TEXT NOT NULL,
			model TEXT NOT NULL,
			account_id TEXT,
			thinking_level TEXT NOT NULL,
			owner_id TEXT,
			lease_epoch INTEGER NOT NULL DEFAULT 0,
			lease_expires_at TEXT,
			outcome TEXT,
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL,
			UNIQUE(chat_id, sequence),
			CHECK (
				(status = 'completed' AND answer IS NOT NULL)
				OR (status <> 'completed' AND answer IS NULL)
			)
		) STRICT;
		CREATE UNIQUE INDEX IF NOT EXISTS tui_side_turns_one_running
			ON tui_side_turns(chat_id) WHERE status = 'running';
		CREATE INDEX IF NOT EXISTS tui_side_turns_completed
			ON tui_side_turns(chat_id, sequence) WHERE status = 'completed';
	`);
}
