import { describe, expect, it, vi } from "vitest";
import { ReadonlyOutputOverlay, type ReadonlyOutputOverlayState } from "../src/tui-readonly-output-overlay.ts";
import { cellWidth, stripAnsi } from "../src/tui-text.ts";

function harness(
	options: {
		readonly rows?: number;
		readonly state?: ReadonlyOutputOverlayState;
		readonly output?: string;
		readonly cancel?: () => void;
	} = {},
) {
	let rows = options.rows ?? 20;
	let closed = false;
	const invalidate = vi.fn();
	const overlay = new ReadonlyOutputOverlay("BTW", () => rows, {
		close: () => {
			closed = true;
		},
		invalidate,
		...(options.cancel ? { cancel: options.cancel } : {}),
	});
	if (options.output !== undefined) overlay.setText(options.output);
	if (options.state !== undefined) overlay.setState(options.state);
	return {
		overlay,
		invalidate,
		closed: () => closed,
		setRows: (value: number) => {
			rows = value;
		},
	};
}

function plain(overlay: ReadonlyOutputOverlay, columns = 40): string[] {
	return overlay.render(columns).map(stripAnsi);
}

describe("ReadonlyOutputOverlay", () => {
	it("renders a typed title and mutable running, complete, and failure states", () => {
		const context = harness({ output: "partial", state: "running" });

		expect(plain(context.overlay).join("\n")).toContain("BTW");
		expect(plain(context.overlay).join("\n")).toContain("running");
		context.overlay.appendText(" result");
		expect(plain(context.overlay).join("\n")).toContain("partial result");
		context.overlay.setState("complete");
		expect(plain(context.overlay).join("\n")).toContain("complete");
		context.overlay.setState("failure");
		expect(plain(context.overlay).join("\n")).toContain("failure");
		expect(context.invalidate).toHaveBeenCalledTimes(4);
	});

	it("cancels running work on Escape, then closes", () => {
		const cancel = vi.fn();
		const context = harness({ state: "running", cancel });

		context.overlay.handleInput("\u001b");

		expect(cancel).toHaveBeenCalledOnce();
		expect(context.closed()).toBe(true);
	});

	it("never cancels terminal output and accepts q only in a terminal state", () => {
		const runningCancel = vi.fn();
		const running = harness({ state: "running", cancel: runningCancel });
		running.overlay.handleInput("q");
		expect(running.closed()).toBe(false);
		expect(runningCancel).not.toHaveBeenCalled();

		for (const state of ["complete", "failure"] as const) {
			const cancel = vi.fn();
			const context = harness({ state, cancel });
			context.overlay.handleInput("q");
			expect(context.closed()).toBe(true);
			expect(cancel).not.toHaveBeenCalled();
		}
	});

	it("closes terminal output on Escape without invoking cancel", () => {
		const cancel = vi.fn();
		const context = harness({ state: "complete", cancel });

		context.overlay.handleInput("\u001b");

		expect(context.closed()).toBe(true);
		expect(cancel).not.toHaveBeenCalled();
	});

	it("sanitizes title and streamed output controls", () => {
		const overlay = new ReadonlyOutputOverlay("Review\u001b[2J", () => 20, {
			close: () => {},
			invalidate: () => {},
		});
		overlay.appendText("safe\u001b]0;PWNED\u0007 text\u0000");
		const rendered = overlay.render(40).join("\n");

		expect(rendered).not.toContain("\u001b[2J");
		expect(rendered).not.toContain("\u001b]0;");
		expect(stripAnsi(rendered)).toContain("Review");
		expect(stripAnsi(rendered)).toContain("safe text");
	});

	it("wraps graphemes and CJK inside terminal cell bounds", () => {
		const context = harness({
			output: "가나다라마바사 가족👨‍👩‍👧‍👦 e\u0301 끝".repeat(5),
			state: "complete",
		});
		const rendered = context.overlay.render(17);

		expect(rendered.every((line) => cellWidth(stripAnsi(line)) <= 17)).toBe(true);
		expect(stripAnsi(rendered.join("\n"))).toContain("👨‍👩‍👧‍👦");
		expect(stripAnsi(rendered.join("\n"))).toContain("e\u0301");
	});

	it("supports row, page, home, and end navigation with a current/live counter", () => {
		const output = Array.from({ length: 30 }, (_, index) => `row-${String(index + 1).padStart(2, "0")}`).join("\n");
		const context = harness({ output, state: "complete", rows: 20 });

		expect(plain(context.overlay).at(-1)).toContain("30/30 rows · live");
		context.overlay.handleInput("\u001b[A");
		expect(plain(context.overlay).at(-1)).toContain("29/30 rows");
		context.overlay.handleInput("\u001b[5~");
		expect(plain(context.overlay).at(-1)).toContain("24/30 rows");
		context.overlay.handleInput("\u001b[H");
		expect(plain(context.overlay).at(-1)).toContain("5/30 rows");
		context.overlay.handleInput("\u001b[B");
		expect(plain(context.overlay).at(-1)).toContain("6/30 rows");
		context.overlay.handleInput("\u001b[6~");
		expect(plain(context.overlay).at(-1)).toContain("11/30 rows");
		context.overlay.handleInput("\u001b[F");
		expect(plain(context.overlay).at(-1)).toContain("30/30 rows · live");
	});

	it("follows appended stream output only while live", () => {
		const context = harness({ output: Array.from({ length: 12 }, (_, index) => `line-${index + 1}`).join("\n") });
		plain(context.overlay);
		context.overlay.handleInput("\u001b[A");
		context.overlay.appendText("\nline-13");
		expect(plain(context.overlay).at(-1)).toContain("11/13 rows");
		context.overlay.handleInput("\u001b[F");
		context.overlay.appendText("\nline-14");
		expect(plain(context.overlay).at(-1)).toContain("14/14 rows · live");
	});

	it("uses at most forty percent of the live terminal height and reflows on resize", () => {
		const context = harness({ output: "content\n".repeat(20), rows: 25 });
		expect(context.overlay.render(40)).toHaveLength(10);

		context.setRows(10);
		const compact = context.overlay.render(40);
		expect(compact).toHaveLength(4);
		expect(stripAnsi(compact.at(-1) ?? "")).toMatch(/\d+\/\d+ rows/u);
	});
});
