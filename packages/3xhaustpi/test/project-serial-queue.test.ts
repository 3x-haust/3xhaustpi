import { describe, expect, it } from "vitest";
import { ProjectSerialQueue } from "../src/project-serial-queue.ts";

describe("ProjectSerialQueue", () => {
	it("serializes different account runtimes for the same project", async () => {
		const queue = new ProjectSerialQueue();
		const events: string[] = [];
		let releaseFirst: (() => void) | undefined;
		let announceFirstStart: (() => void) | undefined;
		const firstStarted = new Promise<void>((resolve) => {
			announceFirstStart = resolve;
		});
		const firstGate = new Promise<void>((resolve) => {
			releaseFirst = resolve;
		});
		const first = queue.run("/project", async () => {
			events.push("first-start");
			announceFirstStart?.();
			await firstGate;
			events.push("first-end");
		});
		const second = queue.run("/project", async () => {
			events.push("second-start");
		});

		await firstStarted;
		expect(events).toEqual(["first-start"]);
		releaseFirst?.();
		await Promise.all([first, second]);
		expect(events).toEqual(["first-start", "first-end", "second-start"]);
	});
});
