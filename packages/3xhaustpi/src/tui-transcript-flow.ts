import { ASSISTANT_DISPLAY_NAME } from "./product-identity.ts";

export interface TranscriptFeedHooks {
	readonly push: (entry: string) => number;
	readonly replace: (index: number, entry: string) => void;
}

/**
 * Owns the assistant response flow in the transcript: streaming deltas update
 * one unlabeled prose entry in place. Runtime telemetry belongs in the status
 * rail rather than the conversation transcript.
 */
export class AssistantTranscriptFlow {
	readonly #hooks: TranscriptFeedHooks;
	#streamIndex: number | undefined;
	#streamed = "";

	constructor(push: TranscriptFeedHooks["push"], replace: TranscriptFeedHooks["replace"]) {
		this.#hooks = { push, replace };
	}

	delta(value: string): void {
		if (!value) return;
		this.#streamed += value;
		const entry = `${ASSISTANT_DISPLAY_NAME} ${this.#streamed}`;
		if (this.#streamIndex === undefined) this.#streamIndex = this.#hooks.push(entry);
		else this.#hooks.replace(this.#streamIndex, entry);
	}

	complete(text: string): void {
		const entry = `${ASSISTANT_DISPLAY_NAME} ${text}`;
		if (this.#streamIndex !== undefined) this.#hooks.replace(this.#streamIndex, entry);
		else this.#hooks.push(entry);
		this.#streamIndex = undefined;
		this.#streamed = "";
	}

	reset(): void {
		this.#streamIndex = undefined;
		this.#streamed = "";
	}
}
