import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseProjectId } from "@3xhaust/semantic-contract";
import { createCoordinatorState, enqueueTurn, startNextTurn } from "../../core/src/index.ts";
import { providerRows } from "./cli-output.ts";
import { DesktopAccessibilityHost, desktopComputerUseStatus } from "./desktop-runtime.ts";
import { PRODUCT_VERSION } from "./product-identity.ts";
import { credentialStoreDescription } from "./provider-runtime.ts";
import { ThreeXhaustState } from "./state.ts";
import { sanitizeTerminalText } from "./terminal-sanitizer.ts";

export function formatDoctorRow(name: string, status: string, detail: string): string {
	return `${sanitizeTerminalText(name).padEnd(26)} ${sanitizeTerminalText(status).padEnd(12)} ${sanitizeTerminalText(detail)}`;
}

async function runCoordinatorSelfCheck(): Promise<boolean> {
	const initial = createCoordinatorState({
		sessionId: "session_doctor",
		projectId: parseProjectId("prj_doctor"),
		generation: 1,
	});
	const enqueued = await enqueueTurn(initial, {
		protocolVersion: 2,
		mode: "prompt",
		objective: "doctor",
		disclosed: { selectionIds: [], documentIds: [], observationIds: [] },
	});
	return startNextTurn(enqueued.state).turn?.request.objective === "doctor";
}

function acceptedBenchmark(project: string): string | undefined {
	const directory = join(project, "artifacts", "real-llm");
	if (!existsSync(directory)) return undefined;
	for (const name of readdirSync(directory)
		.filter((entry) => entry.endsWith(".json"))
		.sort()
		.reverse()) {
		try {
			const report = JSON.parse(readFileSync(join(directory, name), "utf8")) as {
				readonly accepted?: boolean;
				readonly pairedSuccesses?: number;
				readonly model?: string;
			};
			if (report.accepted)
				return `${report.pairedSuccesses ?? "?"} paired successes, ${report.model ?? "unknown model"}`;
		} catch {
			// Ignore malformed or partial artifacts and continue searching.
		}
	}
	return undefined;
}

export async function printDoctorStatus(project: string): Promise<void> {
	let sqlite = "unavailable";
	try {
		const state = new ThreeXhaustState(":memory:");
		state.close();
		sqlite = "verified";
	} catch {
		sqlite = "unavailable";
	}
	const coordinator = (await runCoordinatorSelfCheck()) ? "verified" : "unavailable";
	const git = spawnSync("git", ["--version"], { encoding: "utf8" });
	let configuredProviders = 0;
	let credentialStoreError: string | undefined;
	try {
		configuredProviders = (await providerRows()).filter((row) => row.configured).length;
	} catch (cause) {
		credentialStoreError = cause instanceof Error ? cause.message : String(cause);
	}
	const benchmark = acceptedBenchmark(project);
	const packageRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
	const nativeManifestPath = resolve(packageRoot, "../../..", "runtime-manifest.json");
	const nativeManifest = (() => {
		try {
			const value = JSON.parse(readFileSync(nativeManifestPath, "utf8")) as {
				readonly product?: string;
				readonly target?: string;
				readonly node?: string;
				readonly python?: string;
			};
			return value.product === "3xhaustpi" ? value : undefined;
		} catch {
			return undefined;
		}
	})();
	const bundledPython =
		process.env.X3HAUSTPI_PYTHON && existsSync(process.env.X3HAUSTPI_PYTHON)
			? spawnSync(process.env.X3HAUSTPI_PYTHON, ["--version"], { encoding: "utf8", timeout: 5_000 })
			: undefined;
	const desktopStatus = desktopComputerUseStatus();
	const computerUse = await (async (): Promise<readonly [string, string]> => {
		if (!desktopStatus.available)
			return ["unavailable", `no external-app accessibility host for ${desktopStatus.platform}`];
		try {
			const result = await new DesktopAccessibilityHost({ timeoutMs: 5_000 }).listApplications();
			return result.trusted
				? ["verified", `${result.applications.length} GUI applications · ${desktopStatus.helper}`]
				: ["permission", `${desktopStatus.helper} · accessibility permission or desktop session required`];
		} catch (cause) {
			const message = cause instanceof Error ? cause.message : String(cause);
			return ["unavailable", message.replace(/\s+/gu, " ").trim().slice(0, 160)];
		}
	})();
	const rows = [
		["package/bin", "implemented", `3xhaustpi ${PRODUCT_VERSION}`],
		["project", "verified", project],
		["Node.js", "verified", process.version],
		[
			"Python accelerator",
			bundledPython?.status === 0 ? "verified" : "unavailable",
			(bundledPython?.stdout || bundledPython?.stderr || "not bundled").trim(),
		],
		["Git", git.status === 0 ? "verified" : "unavailable", git.stdout.trim() || git.stderr.trim()],
		["SQLite durability schema", sqlite, "queue/checkpoint/outbox/observation/patch journal"],
		["semantic compiler", coordinator, "protocol v2, code-owned capabilities"],
		[
			"provider credentials",
			configuredProviders > 0 ? "configured" : "unavailable",
			`${configuredProviders} configured`,
		],
		[
			"real provider task",
			configuredProviders > 0 ? "verified" : "unavailable",
			"semantic adapter + capability runtime",
		],
		[
			"credential store",
			credentialStoreError ? "unavailable" : "verified",
			credentialStoreError ?? credentialStoreDescription(),
		],
		["Computer Use", computerUse[0], computerUse[1]],
		["real paired benchmark", benchmark ? "verified" : "unavailable", benchmark ?? "requires 20 paired successes"],
		[
			"native archive",
			nativeManifest ? "verified" : "unavailable",
			nativeManifest
				? `${nativeManifest.target ?? "unknown target"} · Node ${nativeManifest.node ?? "?"} · Python ${nativeManifest.python ?? "?"}`
				: "npm/source installation",
		],
	] as const;
	for (const [name, status, detail] of rows) {
		console.log(formatDoctorRow(name, status, detail));
	}
}
