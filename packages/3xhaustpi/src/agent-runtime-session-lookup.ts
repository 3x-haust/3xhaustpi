import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";

export class AgentSessionNotFoundError extends Error {
	readonly sessionId: string;

	constructor(sessionId: string) {
		super(`Agent session not found for this project: ${sessionId}`);
		this.name = "AgentSessionNotFoundError";
		this.sessionId = sessionId;
	}
}

export async function findAgentSessionPath(
	projectRoot: string,
	requestedSessionId: string,
	sessionDir?: string,
): Promise<string> {
	const match = (await SessionManager.list(projectRoot, sessionDir)).find(({ id }) => id === requestedSessionId);
	if (!match) throw new AgentSessionNotFoundError(requestedSessionId);
	return match.path;
}

export async function openAgentSessionManager(
	projectRoot: string,
	requestedSessionId: string | undefined,
	sessionDir?: string,
): Promise<SessionManager> {
	if (!requestedSessionId) {
		return sessionDir ? SessionManager.create(projectRoot, sessionDir) : SessionManager.create(projectRoot);
	}
	return SessionManager.open(
		await findAgentSessionPath(projectRoot, requestedSessionId, sessionDir),
		sessionDir,
		projectRoot,
	);
}

export function canonicalProjectRoot(projectRoot: string): string {
	const absoluteRoot = resolve(projectRoot);
	try {
		return realpathSync(absoluteRoot);
	} catch {
		return absoluteRoot;
	}
}
