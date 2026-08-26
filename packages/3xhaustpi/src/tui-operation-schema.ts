import type { DatabaseSync } from "node:sqlite";

export function migrateTuiOperationSchema(database: DatabaseSync): void {
	database.exec("BEGIN IMMEDIATE");
	try {
		database.exec(`
			CREATE TABLE IF NOT EXISTS tui_request_queue (
				request_id TEXT PRIMARY KEY,
				canonical_path TEXT NOT NULL,
				position INTEGER NOT NULL,
				fingerprint TEXT NOT NULL,
				objective TEXT NOT NULL,
				images_json TEXT,
				binding_version INTEGER,
				conversation_generation INTEGER,
				session_id TEXT,
				provider TEXT,
				model TEXT,
				account_id TEXT,
				thinking_level TEXT,
				status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'completed', 'failed')),
				created_at TEXT NOT NULL,
				updated_at TEXT NOT NULL,
				owner_id TEXT,
				lease_epoch INTEGER NOT NULL DEFAULT 0,
				lease_expires_at TEXT,
				effect_id TEXT,
				outcome TEXT,
				execution_sequence INTEGER NOT NULL DEFAULT 0,
				execution_snapshot TEXT
			) STRICT;
		`);
		const columns = new Set(
			(database.prepare("PRAGMA table_info(tui_request_queue)").all() as Array<{ name: string }>).map(
				({ name }) => name,
			),
		);
		const migrations = [
			["owner_id", "ALTER TABLE tui_request_queue ADD COLUMN owner_id TEXT"],
			["lease_epoch", "ALTER TABLE tui_request_queue ADD COLUMN lease_epoch INTEGER NOT NULL DEFAULT 0"],
			["lease_expires_at", "ALTER TABLE tui_request_queue ADD COLUMN lease_expires_at TEXT"],
			["effect_id", "ALTER TABLE tui_request_queue ADD COLUMN effect_id TEXT"],
			["outcome", "ALTER TABLE tui_request_queue ADD COLUMN outcome TEXT"],
			[
				"execution_sequence",
				"ALTER TABLE tui_request_queue ADD COLUMN execution_sequence INTEGER NOT NULL DEFAULT 0",
			],
			["execution_snapshot", "ALTER TABLE tui_request_queue ADD COLUMN execution_snapshot TEXT"],
			["binding_version", "ALTER TABLE tui_request_queue ADD COLUMN binding_version INTEGER"],
			["conversation_generation", "ALTER TABLE tui_request_queue ADD COLUMN conversation_generation INTEGER"],
			["session_id", "ALTER TABLE tui_request_queue ADD COLUMN session_id TEXT"],
			["provider", "ALTER TABLE tui_request_queue ADD COLUMN provider TEXT"],
			["model", "ALTER TABLE tui_request_queue ADD COLUMN model TEXT"],
			["account_id", "ALTER TABLE tui_request_queue ADD COLUMN account_id TEXT"],
			["images_json", "ALTER TABLE tui_request_queue ADD COLUMN images_json TEXT"],
			["thinking_level", "ALTER TABLE tui_request_queue ADD COLUMN thinking_level TEXT"],
		] as const;
		for (const [column, statement] of migrations) {
			if (!columns.has(column)) database.exec(statement);
		}
		database.exec(`
			CREATE UNIQUE INDEX IF NOT EXISTS tui_request_queue_active_fingerprint
				ON tui_request_queue(canonical_path, fingerprint)
				WHERE status IN ('queued', 'running');
			CREATE TABLE IF NOT EXISTS tui_agent_sessions (
				canonical_path TEXT PRIMARY KEY,
				session_id TEXT NOT NULL,
				updated_at TEXT NOT NULL
			) STRICT;
			CREATE TABLE IF NOT EXISTS tui_conversation_heads (
				canonical_path TEXT PRIMARY KEY,
				generation INTEGER NOT NULL CHECK (generation >= 0),
				session_id TEXT,
				updated_at TEXT NOT NULL
			) STRICT;
			CREATE TABLE IF NOT EXISTS tui_session_quarantine (
				canonical_path TEXT NOT NULL,
				generation INTEGER NOT NULL,
				session_id TEXT NOT NULL,
				reason TEXT NOT NULL,
				quarantined_at TEXT NOT NULL,
				PRIMARY KEY (canonical_path, generation, session_id)
			) STRICT;
			CREATE TABLE IF NOT EXISTS tui_session_account_exclusions (
				canonical_path TEXT NOT NULL,
				scope_key TEXT NOT NULL,
				account_id TEXT NOT NULL,
				updated_at TEXT NOT NULL,
				PRIMARY KEY (canonical_path, scope_key, account_id)
			) STRICT;
			CREATE TABLE IF NOT EXISTS tui_session_provider_accounts (
				canonical_path TEXT NOT NULL,
				scope_key TEXT NOT NULL,
				provider_id TEXT NOT NULL,
				account_id TEXT NOT NULL,
				updated_at TEXT NOT NULL,
				PRIMARY KEY (canonical_path, scope_key, provider_id)
			) STRICT;
			CREATE TABLE IF NOT EXISTS tui_project_preferences (
				canonical_path TEXT NOT NULL,
				preference_key TEXT NOT NULL,
				preference_value TEXT NOT NULL,
				updated_at TEXT NOT NULL,
				PRIMARY KEY (canonical_path, preference_key)
			) STRICT;
			CREATE TABLE IF NOT EXISTS tui_project_goal (
				canonical_path TEXT PRIMARY KEY,
				goal_text TEXT NOT NULL CHECK (
					length(goal_text) BETWEEN 1 AND 500
					AND instr(goal_text, char(0)) = 0
				),
				status TEXT NOT NULL CHECK (status IN ('active', 'completed')),
				updated_at TEXT NOT NULL
			) STRICT;
			CREATE TRIGGER IF NOT EXISTS tui_project_goal_text_insert
				BEFORE INSERT ON tui_project_goal
				WHEN length(NEW.goal_text) NOT BETWEEN 1 AND 500
					OR instr(NEW.goal_text, char(0)) <> 0
				BEGIN
					SELECT RAISE(ABORT, 'invalid project goal text');
				END;
			CREATE TRIGGER IF NOT EXISTS tui_project_goal_text_update
				BEFORE UPDATE OF goal_text ON tui_project_goal
				WHEN length(NEW.goal_text) NOT BETWEEN 1 AND 500
					OR instr(NEW.goal_text, char(0)) <> 0
				BEGIN
					SELECT RAISE(ABORT, 'invalid project goal text');
				END;
			INSERT OR IGNORE INTO tui_conversation_heads(canonical_path, generation, session_id, updated_at)
				SELECT canonical_path, 0, session_id, updated_at FROM tui_agent_sessions;
			CREATE TABLE IF NOT EXISTS tui_execution_events (
				request_id TEXT NOT NULL REFERENCES tui_request_queue(request_id) ON DELETE CASCADE,
				sequence INTEGER NOT NULL CHECK (sequence > 0),
				event_json TEXT NOT NULL,
				created_at TEXT NOT NULL,
				PRIMARY KEY (request_id, sequence)
			) STRICT;
			CREATE TRIGGER IF NOT EXISTS tui_execution_events_contiguous
				BEFORE INSERT ON tui_execution_events
				WHEN NEW.sequence <> COALESCE(
					(SELECT execution_sequence + 1 FROM tui_request_queue WHERE request_id = NEW.request_id), 0
				)
				BEGIN
					SELECT RAISE(ABORT, 'TUI execution event sequence is not contiguous');
				END;
			CREATE TRIGGER IF NOT EXISTS tui_execution_events_immutable_update
				BEFORE UPDATE ON tui_execution_events
				BEGIN
					SELECT RAISE(ABORT, 'TUI execution events are immutable');
				END;
			CREATE TRIGGER IF NOT EXISTS tui_execution_events_immutable_delete
				BEFORE DELETE ON tui_execution_events
				BEGIN
					SELECT RAISE(ABORT, 'TUI execution events are immutable');
				END;
		`);
		database.exec("COMMIT");
	} catch (error) {
		database.exec("ROLLBACK");
		throw error;
	}
}
