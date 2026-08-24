import { describe, expect, it } from "vitest";
import type { CodingTaskEvent as RuntimeEvent } from "../src/coding-runtime.ts";
import type { CodingTaskEvent as ShippedEvent } from "../src/runtime-api.d.ts";

const eventContract: [
	RuntimeEvent extends ShippedEvent ? true : false,
	ShippedEvent extends RuntimeEvent ? true : false,
] = [true, true];

describe("published runtime declaration", () => {
	it("matches the runtime event union in both directions", () => {
		expect(eventContract).toEqual([true, true]);
	});
});
