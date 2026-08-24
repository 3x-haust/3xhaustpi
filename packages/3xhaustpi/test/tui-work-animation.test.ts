import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	cellWidth,
	formatResponseMetrics,
	formatTuiActivityLine,
	retainTuiActivityDetail,
	stripAnsi,
	updateTuiCapabilityActivity,
} from "../src/tui.ts";
import { providerReportedCacheHitRatio } from "../src/tui-activity-state.ts";
import { grayscaleShimmer } from "../src/tui-text.ts";

let inheritedNoColor: string | undefined;
let inheritedTerm: string | undefined;

beforeEach(() => {
	inheritedNoColor = process.env.NO_COLOR;
	inheritedTerm = process.env.TERM;
	delete process.env.NO_COLOR;
	process.env.TERM = "xterm-256color";
});

afterEach(() => {
	if (inheritedNoColor === undefined) delete process.env.NO_COLOR;
	else process.env.NO_COLOR = inheritedNoColor;
	if (inheritedTerm === undefined) delete process.env.TERM;
	else process.env.TERM = inheritedTerm;
});

describe("active work shimmer", () => {
	it("reports retained-prefix cache hit without charging the appended suffix", () => {
		expect(providerReportedCacheHitRatio(172, 828, 0)).toBe(1);
		expect(providerReportedCacheHitRatio(172, 828, 172)).toBeCloseTo(0.828);
		expect(
			formatResponseMetrics({
				input: 172,
				output: 8,
				cacheRead: 828,
				cacheWrite: 0,
				durationMs: 1_000,
			}),
		).toContain("Cache hit 100.0%");
	});

	it("moves a grayscale luminance sweep without changing text or width", () => {
		const first = formatTuiActivityLine({
			status: "running",
			detail: "searchText",
			animationFrame: 0,
		});
		const second = formatTuiActivityLine({
			status: "running",
			detail: "searchText",
			animationFrame: 1,
		});

		expect(stripAnsi(first)).toBe("• Working (searchText · esc to interrupt)");
		expect(stripAnsi(second)).toBe(stripAnsi(first));
		expect(second).not.toBe(first);
		expect(cellWidth(stripAnsi(second))).toBe(cellWidth(stripAnsi(first)));
		for (const frame of [first, second]) {
			const whiteGlyphs = Array.from(frame.matchAll(/\u001b\[38;5;255m(.)\u001b\[0m/gu), (match) => match[1] ?? "");
			expect(whiteGlyphs).toHaveLength(1);
			expect(whiteGlyphs[0]?.trim()).not.toBe("");
			expect(frame).not.toMatch(/\u001b\[38;5;(245|250)m/gu);
		}
	});

	it("retains capability detail across timer-only redraws", () => {
		expect(retainTuiActivityDetail("read…", undefined)).toBe("read…");
		expect(retainTuiActivityDetail("read…", "")).toBe("");
	});

	it("never inserts styling inside one grapheme cluster", () => {
		const previousNoColor = process.env.NO_COLOR;
		const previousTerm = process.env.TERM;
		delete process.env.NO_COLOR;
		process.env.TERM = "xterm-256color";
		try {
			const family = "👨‍👩‍👧‍👦";
			const rendered = grayscaleShimmer(family, 0);
			expect(stripAnsi(rendered)).toBe(family);
			expect(rendered.match(/\u001b\[/gu)).toHaveLength(2);
		} finally {
			if (previousNoColor === undefined) delete process.env.NO_COLOR;
			else process.env.NO_COLOR = previousNoColor;
			if (previousTerm === undefined) delete process.env.TERM;
			else process.env.TERM = previousTerm;
		}
	});

	it("keeps a concurrent sibling active when another capability completes", () => {
		let active: readonly string[] = [];
		active = updateTuiCapabilityActivity(active, "read", "started");
		active = updateTuiCapabilityActivity(active, "searchText", "started");
		active = updateTuiCapabilityActivity(active, "searchText", "completed");
		expect(active).toEqual(["read"]);
		active = updateTuiCapabilityActivity(active, "read", "completed");
		expect(active).toEqual([]);
	});
});
