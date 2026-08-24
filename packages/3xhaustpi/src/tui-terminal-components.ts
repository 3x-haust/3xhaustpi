import type { Component } from "@earendil-works/pi-tui";
import { terminalBelowFloor, terminalFloorLines } from "./tui-layout-frame.ts";
import type { TuiLiveCore } from "./tui-live-state.ts";

export class FloorNotice implements Component {
	private readonly state: TuiLiveCore["state"];

	constructor(state: TuiLiveCore["state"]) {
		this.state = state;
	}

	render(width: number): string[] {
		this.state.terminalBelowFloor = terminalBelowFloor(width, process.stdout.rows || 36);
		return this.state.terminalBelowFloor ? [...terminalFloorLines(width, process.stdout.rows || 36)] : [];
	}

	invalidate(): void {}
}

export class SupportedTerminalComponent implements Component {
	private readonly component: Component;
	private readonly reserveRow: boolean;
	private readonly beforeRender: ((width: number) => void) | undefined;

	constructor(component: Component, reserveRow = false, beforeRender?: (width: number) => void) {
		this.component = component;
		this.reserveRow = reserveRow;
		this.beforeRender = beforeRender;
	}

	render(width: number): string[] {
		if (terminalBelowFloor(width, process.stdout.rows || 36)) return [];
		this.beforeRender?.(width);
		const lines = this.component.render(width);
		return this.reserveRow && lines.length === 0 ? [" ".repeat(Math.max(1, width))] : lines;
	}

	invalidate(): void {
		this.component.invalidate();
	}
}
