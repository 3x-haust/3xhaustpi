import { describe, expect, it } from "vitest";
import {
	SettingsOverlay,
	type SettingsOverlayActions,
	type SettingsOverlaySnapshot,
} from "../src/tui-settings-overlay.ts";
import { cellWidth, stripAnsi } from "../src/tui-text.ts";

const initial: SettingsOverlaySnapshot = {
	models: [
		{ provider: "anthropic", model: "claude-opus-4-7" },
		{ provider: "openai", model: "gpt-5.6-terra" },
		{ provider: "로컬", model: "긴-한국어-모델" },
	],
	currentModel: { provider: "anthropic", model: "claude-opus-4-7" },
	reasoning: "medium",
	cacheWarmEnabled: false,
};

function harness(rows = 12): {
	readonly overlay: SettingsOverlay;
	readonly calls: string[];
	readonly closed: () => boolean;
} {
	const calls: string[] = [];
	let closed = false;
	const actions: SettingsOverlayActions = {
		selectModel: async (entry) => {
			calls.push(`model:${entry.provider}/${entry.model}`);
			return { ...initial, currentModel: entry };
		},
		selectReasoning: async (reasoning) => {
			calls.push(`reasoning:${reasoning}`);
			return { ...initial, reasoning };
		},
		setCacheWarm: async (enabled) => {
			calls.push(`cache-warm:${enabled ? "on" : "off"}`);
			return { ...initial, cacheWarmEnabled: enabled };
		},
		openSkills: () => calls.push("integration:skills"),
		openMcpServers: () => calls.push("integration:mcp"),
		openHooks: () => calls.push("integration:hooks"),
		openComputerAccess: () => calls.push("integration:computer"),
		close: () => {
			closed = true;
		},
		invalidate: () => {},
	};
	return {
		overlay: new SettingsOverlay(initial, () => rows, actions),
		calls,
		closed: () => closed,
	};
}

const enter = "\r";
const down = "\u001b[B";
const escapeKey = "\u001b";

async function settle(): Promise<void> {
	await Promise.resolve();
	await Promise.resolve();
}

describe("SettingsOverlay", () => {
	it("renders compact root rows with current values", () => {
		const rendered = stripAnsi(harness().overlay.render(72).join("\n"));
		expect(rendered).toContain("Settings");
		expect(rendered).toContain("Model");
		expect(rendered).toContain("anthropic/claude-opus-4-7");
		expect(rendered).toContain("Reasoning");
		expect(rendered).toContain("medium");
		expect(rendered).toContain("Integrations");
	});

	it("lists every model, marks current, and applies the returned snapshot", async () => {
		const context = harness();
		context.overlay.handleInput(enter);
		let rendered = stripAnsi(context.overlay.render(72).join("\n"));
		expect(rendered).toContain("● anthropic/claude-opus-4-7");
		expect(rendered).toContain("○ openai/gpt-5.6-terra");
		expect(rendered).toContain("○ 로컬/긴-한국어-모델");

		context.overlay.handleInput(down);
		context.overlay.handleInput(enter);
		await settle();

		expect(context.calls).toEqual(["model:openai/gpt-5.6-terra"]);
		rendered = stripAnsi(context.overlay.render(72).join("\n"));
		expect(rendered).toContain("● openai/gpt-5.6-terra");
	});

	it("places the current model first regardless of registry order", () => {
		const overlay = new SettingsOverlay(
			{ ...initial, currentModel: { provider: "openai", model: "gpt-5.6-terra" } },
			() => 12,
			{
				selectModel: async () => initial,
				selectReasoning: async () => initial,
				setCacheWarm: async () => initial,
				openSkills() {},
				openMcpServers() {},
				openHooks() {},
				openComputerAccess() {},
				close() {},
				invalidate() {},
			},
		);
		overlay.handleInput(enter);

		const rendered = stripAnsi(overlay.render(72).join("\n"));

		expect(rendered.indexOf("● openai/gpt-5.6-terra")).toBeLessThan(rendered.indexOf("○ anthropic/claude-opus-4-7"));
	});

	it("filters the model catalog from printable keyboard input", () => {
		const context = harness();
		context.overlay.handleInput(enter);
		for (const key of "openai") context.overlay.handleInput(key);

		const rendered = stripAnsi(context.overlay.render(72).join("\n"));

		expect(rendered).toContain("Filter: openai");
		expect(rendered).toContain("openai/gpt-5.6-terra");
		expect(rendered).not.toContain("anthropic/claude-opus-4-7");
	});

	it("keeps integrations reachable inside a four-row budget", () => {
		const context = harness(4);
		context.overlay.handleInput(down);
		context.overlay.handleInput(down);
		context.overlay.handleInput(down);
		context.overlay.handleInput(enter);

		const rendered = stripAnsi(context.overlay.render(36).join("\n"));

		expect(rendered).toContain("Settings · Integrations");
		expect(rendered).toContain("Skills");
	});

	it("offers all reasoning levels and updates the current marker", async () => {
		const context = harness();
		context.overlay.handleInput(down);
		context.overlay.handleInput(enter);
		const rendered = stripAnsi(context.overlay.render(72).join("\n"));
		for (const level of ["off", "minimal", "low", "medium", "high", "xhigh"]) {
			expect(rendered).toContain(level);
		}
		expect(rendered).toContain("● medium");

		context.overlay.handleInput(down);
		context.overlay.handleInput(enter);
		await settle();
		expect(context.calls).toEqual(["reasoning:minimal"]);
		expect(stripAnsi(context.overlay.render(72).join("\n"))).toContain("● minimal");
	});

	it("enables paid cache warming only from its explicit settings branch", async () => {
		const context = harness();
		context.overlay.handleInput(down);
		context.overlay.handleInput(down);
		context.overlay.handleInput(enter);
		expect(stripAnsi(context.overlay.render(72).join("\n"))).toContain("May send paid background requests");
		context.overlay.handleInput(down);
		context.overlay.handleInput(enter);
		await settle();
		expect(context.calls).toEqual(["cache-warm:on"]);
	});

	it("delegates each integration and escapes one depth before closing", () => {
		const context = harness();
		context.overlay.handleInput(down);
		context.overlay.handleInput(down);
		context.overlay.handleInput(down);
		context.overlay.handleInput(enter);
		context.overlay.handleInput(down);
		context.overlay.handleInput(enter);
		expect(context.calls).toEqual(["integration:mcp"]);

		context.overlay.handleInput(escapeKey);
		expect(context.closed()).toBe(false);
		expect(stripAnsi(context.overlay.render(72).join("\n"))).toContain("Settings");
		context.overlay.handleInput(escapeKey);
		expect(context.closed()).toBe(true);
	});

	it("is height-bounded, CJK-safe, and keeps reverse selection with NO_COLOR", () => {
		const inherited = process.env.NO_COLOR;
		const inheritedTerm = process.env.TERM;
		process.env.NO_COLOR = "1";
		process.env.TERM = "xterm-256color";
		try {
			const overlay = harness(6).overlay;
			overlay.handleInput(enter);
			const lines = overlay.render(30);
			expect(lines.length).toBeLessThanOrEqual(6);
			expect(lines.every((line) => cellWidth(stripAnsi(line)) <= 30)).toBe(true);
			expect(lines.join("\n")).toContain("\u001b[7m");
		} finally {
			if (inherited === undefined) delete process.env.NO_COLOR;
			else process.env.NO_COLOR = inherited;
			if (inheritedTerm === undefined) delete process.env.TERM;
			else process.env.TERM = inheritedTerm;
		}
	});
});
