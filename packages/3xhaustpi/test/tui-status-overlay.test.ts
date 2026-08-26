import { describe, expect, it } from "vitest";
import { TuiStatusOverlay, type TuiStatusSnapshot } from "../src/tui-status-overlay.ts";
import { cellWidth, stripAnsi } from "../src/tui-text.ts";

const complete: TuiStatusSnapshot = {
	projectPath: "/Users/test/프로젝트/3xhaustpi",
	provider: "anthropic",
	model: "claude-sonnet-4-6",
	reasoning: "high",
	phase: "working",
	sessionId: "session-01",
	contextTokens: 12_345,
	contextLimit: 200_000,
	latestResponse: {
		source: "provider turn",
		outputTokens: 842,
		tokensPerSecond: 18.4,
		cacheHitPercent: 96.2,
		durationMs: 4_520,
	},
	cacheWarm: {
		enabled: true,
		state: "fresh",
		iteration: 2,
		nextWakeAt: Date.UTC(2026, 0, 1, 14, 32),
		estimatedSavingsUsd: 0.08,
	},
	activeCount: 2,
	pendingCount: 1,
	changedFileCount: 3,
};

function harness(
	snapshot: TuiStatusSnapshot = complete,
	rows = 24,
): {
	readonly overlay: TuiStatusOverlay;
	readonly closed: () => boolean;
} {
	let closed = false;
	return {
		overlay: new TuiStatusOverlay(snapshot, () => rows, {
			close: () => {
				closed = true;
			},
			invalidate: () => {},
		}),
		closed: () => closed,
	};
}

describe("TuiStatusOverlay", () => {
	it("renders the typed snapshot and labels turn-local measurements", () => {
		const rendered = stripAnsi(harness().overlay.render(76).join("\n"));

		expect(rendered).toContain("Status");
		expect(rendered).toContain("/Users/test/프로젝트/3xhaustpi");
		expect(rendered).toContain("anthropic");
		expect(rendered).toContain("claude-sonnet-4-6");
		expect(rendered).toContain("high");
		expect(rendered).toContain("working");
		expect(rendered).toContain("session-01");
		expect(rendered).toContain("12.3K/200K (6.2%)");
		expect(rendered).toContain("Latest response · provider turn");
		expect(rendered).toContain("842 out");
		expect(rendered).toContain("18.4 tok/s");
		expect(rendered).toContain("96.2% cache");
		expect(rendered).toContain("4.5s");
		expect(rendered).toContain("Prompt cache");
		expect(rendered).toContain("Next wake");
		expect(rendered).toContain("iteration 2");
		expect(rendered).toContain("est. savings $0.08");
		expect(rendered).toContain("2 active requests");
		expect(rendered).toContain("1 pending request");
		expect(rendered).toContain("3 changed");
	});

	it("renders unknowns rather than inventing zero values", () => {
		const rendered = stripAnsi(
			harness({
				projectPath: "/tmp/project",
				provider: "",
				model: "",
				reasoning: "",
				phase: "idle",
				activeCount: 0,
				pendingCount: 0,
			})
				.overlay.render(72)
				.join("\n"),
		);

		expect(rendered).toContain("Provider  —");
		expect(rendered).toContain("Model  —");
		expect(rendered).toContain("Reasoning  —");
		expect(rendered).toContain("Session  —");
		expect(rendered).toContain("Context  —");
		expect(rendered).toContain("Latest response  —");
		expect(rendered).toContain("0 active requests");
		expect(rendered).toContain("0 pending requests");
		expect(rendered).not.toContain("0 changed");
	});

	it("stays within the shared width and forty-percent height bounds", () => {
		const lines = harness(complete, 8).overlay.render(120);

		expect(lines.length).toBeLessThanOrEqual(8);
		expect(lines.every((line) => cellWidth(stripAnsi(line)) <= 76)).toBe(true);
	});

	it("keeps compact CJK and sanitized ANSI-safe rows in bounds", () => {
		const lines = harness({ ...complete, projectPath: "/긴/프로젝트\u001b[2J/安全" }, 4).overlay.render(36);
		const rendered = lines.join("\n");

		expect(lines.length).toBeLessThanOrEqual(4);
		expect(lines.every((line) => cellWidth(stripAnsi(line)) <= 36)).toBe(true);
		expect(rendered).not.toContain("\u001b[2J");
		expect(stripAnsi(rendered)).toContain("프로젝트");
	});

	it("closes on q or Escape and remains read-only", () => {
		const first = harness();
		first.overlay.handleInput("q");
		expect(first.closed()).toBe(true);
		expect(complete.activeCount).toBe(2);

		const second = harness();
		second.overlay.handleInput("\u001b");
		expect(second.closed()).toBe(true);
	});
});
