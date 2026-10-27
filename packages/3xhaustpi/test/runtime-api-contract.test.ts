import { describe, expect, expectTypeOf, it } from "vitest";
import type { CodingTaskEvent as RuntimeEvent } from "../src/coding-runtime.ts";
import type { CodingTaskEvent as ShippedEvent, ConversationInput as ShippedInput } from "../src/runtime-api.d.ts";
import type { ConversationInput as EntryInput } from "../src/runtime-entry.ts";

const eventContract: [
	RuntimeEvent extends ShippedEvent ? true : false,
	ShippedEvent extends RuntimeEvent ? true : false,
] = [true, true];

describe("published runtime declaration", () => {
	it("publishes the optional conversation cache key through both entry points", () => {
		expectTypeOf<EntryInput>().toEqualTypeOf<ShippedInput>();
		expectTypeOf<ShippedInput["promptCacheKey"]>().toEqualTypeOf<string | undefined>();
		expectTypeOf<ShippedInput["reasoningEffort"]>().toEqualTypeOf<
			"none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | undefined
		>();
	});

	it("matches the runtime event union in both directions", () => {
		expect(eventContract).toEqual([true, true]);
	});
});
