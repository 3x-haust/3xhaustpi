import type { DatabaseSync } from "node:sqlite";

export function migrateStateSchema(database: DatabaseSync): void {
	database.exec(`
		CREATE TABLE IF NOT EXISTS projects (
			project_id TEXT PRIMARY KEY,
			canonical_path TEXT NOT NULL UNIQUE,
			created_at TEXT NOT NULL
		) STRICT;
		CREATE TABLE IF NOT EXISTS chats (
			session_id TEXT PRIMARY KEY,
			project_id TEXT NOT NULL REFERENCES projects(project_id),
			status TEXT NOT NULL CHECK (status IN ('idle', 'queued', 'running', 'paused', 'failed', 'completed')),
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL
		) STRICT;
		CREATE TABLE IF NOT EXISTS request_queue (
			request_id TEXT PRIMARY KEY,
			session_id TEXT NOT NULL REFERENCES chats(session_id),
			position INTEGER NOT NULL,
			fingerprint TEXT NOT NULL,
			payload TEXT NOT NULL,
			status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'failed', 'completed', 'indeterminate')),
			created_at TEXT NOT NULL,
			UNIQUE (session_id, fingerprint)
		) STRICT;
		CREATE TABLE IF NOT EXISTS checkpoints (
			session_id TEXT PRIMARY KEY REFERENCES chats(session_id),
			generation INTEGER NOT NULL,
			payload TEXT NOT NULL,
			updated_at TEXT NOT NULL
		) STRICT;
		CREATE TABLE IF NOT EXISTS provider_outbox (
			request_id TEXT PRIMARY KEY REFERENCES request_queue(request_id),
			generation INTEGER NOT NULL,
			state TEXT NOT NULL CHECK (state IN ('queued', 'dispatching', 'accepted', 'settled', 'indeterminate')),
			payload_digest TEXT NOT NULL,
			provider_request_id TEXT,
			updated_at TEXT NOT NULL
		) STRICT;
		CREATE TABLE IF NOT EXISTS observations (
			observation_id TEXT PRIMARY KEY,
			session_id TEXT NOT NULL REFERENCES chats(session_id),
			payload TEXT NOT NULL,
			created_at TEXT NOT NULL
		) STRICT;
		CREATE TABLE IF NOT EXISTS observation_sessions (
			session_id TEXT NOT NULL REFERENCES chats(session_id),
			observation_id TEXT NOT NULL REFERENCES observations(observation_id),
			created_at TEXT NOT NULL,
			PRIMARY KEY (session_id, observation_id)
		) STRICT;
		CREATE TABLE IF NOT EXISTS patch_journal (
			patch_id TEXT PRIMARY KEY,
			session_id TEXT NOT NULL REFERENCES chats(session_id),
			base_revision TEXT NOT NULL,
			state TEXT NOT NULL CHECK (state IN ('proposed', 'approved', 'applied', 'conflict', 'rejected')),
			payload TEXT NOT NULL,
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL
		) STRICT;
	`);
}
