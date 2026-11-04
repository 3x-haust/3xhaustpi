/**
 * Context compaction for long sessions.
 *
 * Pure functions for compaction logic. The session manager handles I/O,
 * and after compaction the session is reloaded.
 */

import type { AgentMessage, StreamFn, ThinkingLevel } from "@earendil-works/pi-agent-core";
import { contentText, type RetryCallbacks, type RetryPolicy, retryAssistantCall, uuidv7 } from "@earendil-works/pi-ai";
import type { AssistantMessage, Context, Model, SimpleStreamOptions, Usage } from "@earendil-works/pi-ai/compat";
import { completeSimple } from "@earendil-works/pi-ai/compat";
import { convertToLlm } from "../messages.ts";
import {
	buildSessionContext,
	type CompactionEntry,
	type SessionEntry,
	sessionEntryToContextMessages,
} from "../session-manager.ts";
import {
	computeFileLists,
	createFileOps,
	extractFileOpsFromMessage,
	type FileOperations,
	formatFileOperations,
	SUMMARIZATION_SYSTEM_PROMPT,
	serializeConversation,
} from "./utils.ts";

// ============================================================================
// File Operation Tracking
// ============================================================================

/** Details stored in CompactionEntry.details for file tracking */
export interface CompactionDetails {
	readFiles: string[];
	modifiedFiles: string[];
}

/**
 * Extract file operations from messages and previous compaction entries.
 */
function extractFileOperations(
	messages: AgentMessage[],
	entries: SessionEntry[],
	prevCompactionIndex: number,
): FileOperations {
	const fileOps = createFileOps();

	// Collect from previous compaction's details (if pi-generated)
	if (prevCompactionIndex >= 0) {
		const prevCompaction = entries[prevCompactionIndex] as CompactionEntry;
		if (!prevCompaction.fromHook && prevCompaction.details) {
			// fromHook field kept for session file compatibility
			const details = prevCompaction.details as CompactionDetails;
			if (Array.isArray(details.readFiles)) {
				for (const f of details.readFiles) fileOps.read.add(f);
			}
			if (Array.isArray(details.modifiedFiles)) {
				for (const f of details.modifiedFiles) fileOps.edited.add(f);
			}
		}
	}

	// Extract from tool calls in messages
	for (const msg of messages) {
		extractFileOpsFromMessage(msg, fileOps);
	}

	return fileOps;
}

// ============================================================================
// Message Extraction
// ============================================================================

/**
 * Extract AgentMessage from an entry if it produces one.
 * Returns undefined for entries that don't contribute to LLM context.
 */
function getMessageFromEntryForCompaction(entry: SessionEntry): AgentMessage | undefined {
	if (entry.type === "compaction") {
		return undefined;
	}
	return sessionEntryToContextMessages(entry)[0];
}

/** Result from compact() - SessionManager adds uuid/parentUuid when saving */
export interface CompactionResult<T = unknown> {
	summary: string;
	firstKeptEntryId: string;
	tokensBefore: number;
	estimatedTokensAfter?: number;
	/** Usage from the LLM call(s) that generated this summary, if available */
	usage?: Usage;
	/** Extension-specific data (e.g., ArtifactIndex, version markers for structured compaction) */
	details?: T;
}

function combineUsage(first: Usage, second: Usage): Usage {
	return {
		input: first.input + second.input,
		output: first.output + second.output,
		cacheRead: first.cacheRead + second.cacheRead,
		cacheWrite: first.cacheWrite + second.cacheWrite,
		...(first.cacheWrite1h !== undefined || second.cacheWrite1h !== undefined
			? { cacheWrite1h: (first.cacheWrite1h ?? 0) + (second.cacheWrite1h ?? 0) }
			: {}),
		...(first.reasoning !== undefined || second.reasoning !== undefined
			? { reasoning: (first.reasoning ?? 0) + (second.reasoning ?? 0) }
			: {}),
		totalTokens: first.totalTokens + second.totalTokens,
		cost: {
			input: first.cost.input + second.cost.input,
			output: first.cost.output + second.cost.output,
			cacheRead: first.cost.cacheRead + second.cost.cacheRead,
			cacheWrite: first.cost.cacheWrite + second.cost.cacheWrite,
			total: first.cost.total + second.cost.total,
		},
	};
}

// ============================================================================
// Types
// ============================================================================

export interface CompactionSettings {
	enabled: boolean;
	reserveTokens: number;
	keepRecentTokens: number;
}

export const DEFAULT_COMPACTION_SETTINGS: CompactionSettings = {
	enabled: true,
	reserveTokens: 16384,
	keepRecentTokens: 20000,
};

// ============================================================================
// Token calculation
// ============================================================================

/**
 * Calculate total context tokens from usage.
 * Uses the native totalTokens field when available, falls back to computing from components.
 */
export function calculateContextTokens(usage: Usage): number {
	return usage.totalTokens || usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
}

/**
 * Get usage from an assistant message if available.
 * Skips aborted, error, and all-zero usage messages as they don't have valid usage data.
 */
function getAssistantUsage(msg: AgentMessage): Usage | undefined {
	if (msg.role === "assistant" && "usage" in msg) {
		const assistantMsg = msg as AssistantMessage;
		if (
			assistantMsg.stopReason !== "aborted" &&
			assistantMsg.stopReason !== "error" &&
			assistantMsg.usage &&
			calculateContextTokens(assistantMsg.usage) > 0
		) {
			return assistantMsg.usage;
		}
	}
	return undefined;
}

/**
 * Find the last valid assistant message usage from session entries.
 */
export function getLastAssistantUsage(entries: SessionEntry[]): Usage | undefined {
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		if (entry.type === "message") {
			const usage = getAssistantUsage(entry.message);
			if (usage) return usage;
		}
	}
	return undefined;
}

export interface ContextUsageEstimate {
	tokens: number;
	usageTokens: number;
	trailingTokens: number;
	lastUsageIndex: number | null;
}

function getLastAssistantUsageInfo(messages: AgentMessage[]): { usage: Usage; index: number } | undefined {
	for (let i = messages.length - 1; i >= 0; i--) {
		const usage = getAssistantUsage(messages[i]);
		if (usage) return { usage, index: i };
	}
	return undefined;
}

/**
 * Estimate context tokens from messages, using the last assistant usage when available.
 * If there are messages after the last usage, estimate their tokens with estimateTokens.
 */
export function estimateContextTokens(messages: AgentMessage[]): ContextUsageEstimate {
	const usageInfo = getLastAssistantUsageInfo(messages);

	if (!usageInfo) {
		let estimated = 0;
		for (const message of messages) {
			estimated += estimateTokens(message);
		}
		return {
			tokens: estimated,
			usageTokens: 0,
			trailingTokens: estimated,
			lastUsageIndex: null,
		};
	}

	const usageTokens = calculateContextTokens(usageInfo.usage);
	let trailingTokens = 0;
	for (let i = usageInfo.index + 1; i < messages.length; i++) {
		trailingTokens += estimateTokens(messages[i]);
	}

	return {
		tokens: usageTokens + trailingTokens,
		usageTokens,
		trailingTokens,
		lastUsageIndex: usageInfo.index,
	};
}

/**
 * Check if compaction should trigger based on context usage.
 */
export function shouldCompact(contextTokens: number, contextWindow: number, settings: CompactionSettings): boolean {
	if (!settings.enabled) return false;
	return contextTokens > contextWindow - settings.reserveTokens;
}

// ============================================================================
// Cut point detection
// ============================================================================

const ESTIMATED_IMAGE_CHARS = 4800;

function estimateTextAndImageContentChars(content: string | Array<{ type: string; text?: string }>): number {
	if (typeof content === "string") {
		return content.length;
	}

	let chars = 0;
	for (const block of content) {
		if (block.type === "text" && block.text) {
			chars += block.text.length;
		} else if (block.type === "image") {
			chars += ESTIMATED_IMAGE_CHARS;
		}
	}
	return chars;
}

/**
 * Estimate token count for a message using chars/4 heuristic.
 * This is conservative (overestimates tokens).
 */
export function estimateTokens(message: AgentMessage): number {
	let chars = 0;

	switch (message.role) {
		case "user": {
			chars = estimateTextAndImageContentChars(
				(message as { content: string | Array<{ type: string; text?: string }> }).content,
			);
			return Math.ceil(chars / 4);
		}
		case "assistant": {
			const assistant = message as AssistantMessage;
			for (const block of assistant.content) {
				if (block.type === "text") {
					chars += block.text.length;
				} else if (block.type === "thinking") {
					chars += block.thinking.length;
				} else if (block.type === "toolCall") {
					chars += block.name.length + JSON.stringify(block.arguments).length;
				}
			}
			return Math.ceil(chars / 4);
		}
		case "custom":
		case "toolResult": {
			chars = estimateTextAndImageContentChars(message.content);
			return Math.ceil(chars / 4);
		}
		case "bashExecution": {
			chars = message.command.length + message.output.length;
			return Math.ceil(chars / 4);
		}
		case "branchSummary":
		case "compactionSummary": {
			chars = message.summary.length;
			return Math.ceil(chars / 4);
		}
	}

	return 0;
}

function isCutPointMessage(message: AgentMessage): boolean {
	switch (message.role) {
		case "user":
		case "assistant":
		case "bashExecution":
		case "custom":
		case "branchSummary":
		case "compactionSummary":
			return true;
		case "toolResult":
			return false;
	}
	return false;
}

function isTurnStartMessage(message: AgentMessage): boolean {
	switch (message.role) {
		case "user":
		case "bashExecution":
		case "custom":
		case "branchSummary":
		case "compactionSummary":
			return true;
		case "assistant":
		case "toolResult":
			return false;
	}
	return false;
}

function isTurnStartEntry(entry: SessionEntry): boolean {
	if (entry.type === "compaction") {
		return false;
	}
	return sessionEntryToContextMessages(entry).some(isTurnStartMessage);
}

/**
 * Find valid cut points: indices of context-visible user-like or assistant messages.
 * Never cut at tool results (they must follow their tool call).
 * When we cut at an assistant message with tool calls, its tool results follow it
 * and will be kept.
 */
function findValidCutPoints(entries: SessionEntry[], startIndex: number, endIndex: number): number[] {
	const cutPoints: number[] = [];
	for (let i = startIndex; i < endIndex; i++) {
		const entry = entries[i];
		if (entry.type === "compaction") {
			continue;
		}
		if (sessionEntryToContextMessages(entry).some(isCutPointMessage)) {
			cutPoints.push(i);
		}
	}
	return cutPoints;
}

/**
 * Find the context-visible user-role message that starts the turn containing the given entry index.
 * Returns -1 if no turn start found before the index.
 */
export function findTurnStartIndex(entries: SessionEntry[], entryIndex: number, startIndex: number): number {
	for (let i = entryIndex; i >= startIndex; i--) {
		if (isTurnStartEntry(entries[i])) {
			return i;
		}
	}
	return -1;
}

export interface CutPointResult {
	/** Index of first entry to keep */
	firstKeptEntryIndex: number;
	/** Index of user message that starts the turn being split, or -1 if not splitting */
	turnStartIndex: number;
	/** Whether this cut splits a turn (cut point is not a user message) */
	isSplitTurn: boolean;
}

/**
 * Find the cut point in session entries that keeps approximately `keepRecentTokens`.
 *
 * Algorithm: Walk backwards from newest, accumulating estimated message sizes.
 * Stop when we've accumulated >= keepRecentTokens. Cut at that point.
 *
 * Can cut at user OR assistant messages (never tool results). When cutting at an
 * assistant message with tool calls, its tool results come after and will be kept.
 *
 * Returns CutPointResult with:
 * - firstKeptEntryIndex: the entry index to start keeping from
 * - turnStartIndex: if cutting mid-turn, the user message that started that turn
 * - isSplitTurn: whether we're cutting in the middle of a turn
 *
 * Only considers entries between `startIndex` and `endIndex` (exclusive).
 */
export function findCutPoint(
	entries: SessionEntry[],
	startIndex: number,
	endIndex: number,
	keepRecentTokens: number,
): CutPointResult {
	const cutPoints = findValidCutPoints(entries, startIndex, endIndex);

	if (cutPoints.length === 0) {
		return { firstKeptEntryIndex: startIndex, turnStartIndex: -1, isSplitTurn: false };
	}

	// Walk backwards from newest, accumulating estimated message sizes
	let accumulatedTokens = 0;
	let cutIndex = cutPoints[0]; // Default: keep from first message (not header)

	for (let i = endIndex - 1; i >= startIndex; i--) {
		const entry = entries[i];
		const messageTokens = sessionEntryToContextMessages(entry).reduce(
			(sum, message) => sum + estimateTokens(message),
			0,
		);
		if (messageTokens === 0) continue;
		accumulatedTokens += messageTokens;

		// Check if we've exceeded the budget
		if (accumulatedTokens >= keepRecentTokens) {
			// Find the closest valid cut point at or after this entry
			for (let c = 0; c < cutPoints.length; c++) {
				if (cutPoints[c] >= i) {
					cutIndex = cutPoints[c];
					break;
				}
			}
			break;
		}
	}

	// Scan backwards from cutIndex to include adjacent metadata entries that do not affect context.
	while (cutIndex > startIndex) {
		const prevEntry = entries[cutIndex - 1];
		// Stop at compaction boundaries or context-visible entries.
		if (prevEntry.type === "compaction" || sessionEntryToContextMessages(prevEntry).length > 0) {
			break;
		}
		cutIndex--;
	}

	// Determine if this is a split turn
	const cutEntry = entries[cutIndex];
	const startsTurn = isTurnStartEntry(cutEntry);
	const turnStartIndex = startsTurn ? -1 : findTurnStartIndex(entries, cutIndex, startIndex);

	return {
		firstKeptEntryIndex: cutIndex,
		turnStartIndex,
		isSplitTurn: !startsTurn && turnStartIndex !== -1,
	};
}

// ============================================================================
// Summarization
// ============================================================================

const SUMMARIZATION_PROMPT = `The messages above are a conversation to summarize. Create a structured context checkpoint summary that another LLM will use to continue the work.

Use this EXACT format:

## Goal
[What is the user trying to accomplish? Can be multiple items if the session covers different tasks.]

## Constraints & Preferences
- [Any constraints, preferences, or requirements mentioned by user]
- [Or "(none)" if none were mentioned]

## Progress
### Done
- [x] [Completed tasks/changes]

### In Progress
- [ ] [Current work]

### Blocked
- [Issues preventing progress, if any]

## Key Decisions
- **[Decision]**: [Brief rationale]

## Operational Evidence
- [Exact commands and outcomes, validation evidence, unresolved errors/root causes, and delegated child session lineage]
- [Or "(none)" if no operational evidence exists]

## Next Steps
1. [Ordered list of what should happen next]

## Critical Context
- [Any data, examples, or references needed to continue]
- [Or "(none)" if not applicable]

Prioritize durable user instructions, explicit prohibitions, decisions and their rationale, unresolved work, and exact paths/tool identifiers needed to resume. Distinguish verified results from plans; never mark unverified work as done. Deduplicate repeated facts and collapse completed work that no longer affects continuation. Do not copy file-list metadata tags: file tracking is appended separately.
Keep each section concise. Preserve exact file paths, function names, and error messages.`;

const UPDATE_SUMMARIZATION_PROMPT = `The messages above are NEW conversation messages to incorporate into the existing summary provided in <previous-summary> tags.

Update the existing structured summary with new information. RULES:
- CARRY FORWARD every still-active user instruction, prohibition, decision, unresolved task/blocker, and continuation-critical fact from the previous summary, even when the new messages do not mention it
- ADD new progress, decisions, and context from the new messages
- UPDATE the Progress section: move items from "In Progress" to "Done" when completed
- UPDATE "Next Steps" based on what was accomplished
- PRESERVE exact file paths, function names, and error messages
- Remove constraints or unresolved work ONLY when the new messages explicitly supersede or resolve them; silence is not resolution
- Deduplicate facts and collapse completed historical detail before shortening active instructions or unresolved work
- Distinguish observed tool outcomes from plans and retain exact identifiers needed to resume
- Do not copy file-list metadata tags: file tracking is appended separately

Use this EXACT format:

## Goal
[Preserve existing goals, add new ones if the task expanded]

## Constraints & Preferences
- [Preserve existing, add new ones discovered]

## Progress
### Done
- [x] [Include previously done items AND newly completed items]

### In Progress
- [ ] [Current work - update based on progress]

### Blocked
- [Current blockers - remove if resolved]

## Key Decisions
- **[Decision]**: [Brief rationale] (preserve all previous, add new)

## Operational Evidence
- [Preserve exact commands/outcomes, validation evidence, unresolved errors/root causes, and delegated child session lineage]
- [Remove only evidence that is explicitly superseded and retain the replacement]

## Next Steps
1. [Update based on current state]

## Critical Context
- [Preserve important context, add new if needed]

Keep each section concise. Preserve exact file paths, function names, and error messages.`;

/** Bound generated memory independently of the much larger overflow reserve. */
function summaryOutputBudget(model: Model<string>, reserveTokens: number, splitPrefix = false): number {
	return Math.max(
		1,
		Math.min(
			Math.floor((splitPrefix ? 0.5 : 0.8) * reserveTokens),
			splitPrefix ? 2048 : 4096,
			Math.max(1, Math.floor(model.contextWindow / 4)),
			model.maxTokens > 0 ? model.maxTokens : Number.POSITIVE_INFINITY,
		),
	);
}

function createSummarizationOptions(
	model: Model<any>,
	maxTokens: number,
	apiKey: string | undefined,
	headers: Record<string, string> | undefined,
	env: Record<string, string> | undefined,
	signal: AbortSignal | undefined,
	thinkingLevel: ThinkingLevel | undefined,
): SimpleStreamOptions {
	const options: SimpleStreamOptions = { maxTokens, signal, apiKey, headers, env };
	if (model.reasoning && thinkingLevel && thinkingLevel !== "off") {
		options.reasoning = thinkingLevel;
	}
	return options;
}

/** Observes each actual provider response, not synthetic aborts during retry backoff. */
export type SummarizationResponseCallback = (response: AssistantMessage) => void;

/**
 * Shared choke point for every compaction/branch-summary summarization call. Wraps the
 * single LLM call in {@link retryAssistantCall} so transient stream drops (e.g.
 * `terminated`, socket close) honor the configured retry policy instead of failing
 * the whole compaction on the first attempt. Deterministic errors and aborts return
 * immediately (see {@link retryAssistantCall}).
 */
export async function completeSummarization(
	model: Model<any>,
	context: Context,
	options: SimpleStreamOptions,
	streamFn?: StreamFn,
	retry?: RetryPolicy,
	callbacks?: RetryCallbacks,
	onResponse?: SummarizationResponseCallback,
): Promise<AssistantMessage> {
	// Summaries are standalone requests, so isolate routing and avoid cache writes that cannot be reused.
	const requestOptions: SimpleStreamOptions = {
		...options,
		cacheRetention: "none",
		sessionId: uuidv7(),
	};
	const produce = async (): Promise<AssistantMessage> => {
		const response = await (streamFn
			? (await streamFn(model, context, requestOptions)).result()
			: completeSimple(model, context, requestOptions));
		onResponse?.(response);
		return response;
	};
	return retryAssistantCall(produce, retry, requestOptions.signal, callbacks);
}

/**
 * Generate a summary of the conversation using the LLM.
 * If previousSummary is provided, uses the update prompt to merge.
 */
export async function generateSummary(
	currentMessages: AgentMessage[],
	model: Model<any>,
	reserveTokens: number,
	apiKey: string | undefined,
	headers?: Record<string, string>,
	signal?: AbortSignal,
	customInstructions?: string,
	previousSummary?: string,
	thinkingLevel?: ThinkingLevel,
	streamFn?: StreamFn,
	env?: Record<string, string>,
	retry?: RetryPolicy,
	callbacks?: RetryCallbacks,
	onResponse?: SummarizationResponseCallback,
): Promise<string> {
	return (
		await generateSummaryWithUsage(
			currentMessages,
			model,
			reserveTokens,
			apiKey,
			headers,
			signal,
			customInstructions,
			previousSummary,
			thinkingLevel,
			streamFn,
			env,
			retry,
			callbacks,
			onResponse,
		)
	).text;
}

/** Generate or update a conversation summary and return its provider usage. */
export async function generateSummaryWithUsage(
	currentMessages: AgentMessage[],
	model: Model<any>,
	reserveTokens: number,
	apiKey: string | undefined,
	headers?: Record<string, string>,
	signal?: AbortSignal,
	customInstructions?: string,
	previousSummary?: string,
	thinkingLevel?: ThinkingLevel,
	streamFn?: StreamFn,
	env?: Record<string, string>,
	retry?: RetryPolicy,
	callbacks?: RetryCallbacks,
	onResponse?: SummarizationResponseCallback,
): Promise<{ text: string; usage: Usage }> {
	const maxTokens = summaryOutputBudget(model, reserveTokens);
	const focus = customInstructions ? `\n\nAdditional focus: ${customInstructions}` : "";
	return summarizeInBatches(
		currentMessages,
		model,
		createSummarizationOptions(model, maxTokens, apiKey, headers, env, signal, thinkingLevel),
		SUMMARIZATION_PROMPT + focus,
		UPDATE_SUMMARIZATION_PROMPT + focus,
		previousSummary,
		"Summarization",
		streamFn,
		retry,
		callbacks,
		onResponse,
	);
}

function checkpointFragments(checkpoint: string, maxBytes: number): AgentMessage[] {
	const fragments: string[] = [];
	let fragment = "";
	let bytes = 0;
	for (const character of checkpoint) {
		const size = Buffer.byteLength(character, "utf8");
		if (bytes + size > maxBytes && fragment) {
			fragments.push(fragment);
			fragment = "";
			bytes = 0;
		}
		fragment += character;
		bytes += size;
	}
	if (fragment) fragments.push(fragment);
	return fragments.map((text, index) => ({
		role: "user",
		content: `[Previous checkpoint fragment ${index}]\n${text}`,
		timestamp: Date.now(),
	}));
}

function summaryPrompt(conversation: string, previous: string | undefined, instructions: string): string {
	const checkpoint = previous ? `<previous-summary>\n${previous}\n</previous-summary>\n\n` : "";
	return `<conversation>\n${conversation}\n</conversation>\n\n${checkpoint}${instructions}`;
}

/**
 * Fold oversized histories at message boundaries instead of silently dropping old instructions.
 * UTF-8 bytes are an intentionally conservative token upper bound (including CJK/base64).
 * No intermediate checkpoint is persisted: any failure leaves the original history intact.
 */
async function summarizeInBatches(
	messages: AgentMessage[],
	model: Model<string>,
	options: SimpleStreamOptions,
	initialPrompt: string,
	updatePrompt: string,
	previousSummary: string | undefined,
	label: string,
	streamFn?: StreamFn,
	retry?: RetryPolicy,
	callbacks?: RetryCallbacks,
	onResponse?: SummarizationResponseCallback,
	allowCheckpointSplit = true,
): Promise<{ text: string; usage: Usage }> {
	const serialized: string[] = [];
	for (const message of convertToLlm(messages)) {
		const text = serializeConversation([message]);
		if (!text) continue;
		// Keep a tool call and its results together so the outcome retains its command/path context.
		if (message.role === "toolResult" && serialized.length > 0) {
			serialized[serialized.length - 1] += `\n\n${text}`;
		} else {
			serialized.push(text);
		}
	}
	let index = 0;
	let summary = previousSummary;
	let usage: Usage | undefined;
	let consecutiveResizes = 0;
	// Leave framing headroom; output and UTF-8 input are different units, so adapt each request.
	const contextBudget = model.contextWindow - 256;
	do {
		if (options.signal?.aborted) throw new DOMException(`${label} aborted`, "AbortError");
		let instructions = `${summary ? updatePrompt : initialPrompt}\n\nKeep the checkpoint compact. Prefer active constraints and unfinished work over historical detail.`;
		let bytes = Buffer.byteLength(SUMMARIZATION_SYSTEM_PROMPT + summaryPrompt("", summary, instructions), "utf8");
		const nextBytes = index < serialized.length ? Buffer.byteLength(serialized[index], "utf8") : 0;
		let maxTokens = Math.min(options.maxTokens ?? 1, contextBudget - bytes - nextBytes);
		const resizeOnly = maxTokens < 1 && summary !== undefined && index < serialized.length;
		if (resizeOnly) {
			if (consecutiveResizes >= 2)
				throw new Error(`${label} failed: checkpoint resizing made insufficient progress`);
			instructions +=
				"\n\nCondense the previous checkpoint substantially before incorporating more messages. Deduplicate historical detail, but retain all active instructions, prohibitions, decisions, and unfinished work. Keep the same section format.";
			bytes = Buffer.byteLength(SUMMARIZATION_SYSTEM_PROMPT + summaryPrompt("", summary, instructions), "utf8");
			maxTokens = Math.min(options.maxTokens ?? 1, contextBudget - bytes);
		}
		if (maxTokens < 1) {
			if (summary && allowCheckpointSplit && consecutiveResizes < 2) {
				const sourceNote =
					"\n\nThe conversation contains ordered fragments of an existing checkpoint, not new user requests. Condense them without dropping active constraints, decisions, blockers, or unfinished work.";
				const resized = await summarizeInBatches(
					checkpointFragments(summary, Math.max(1, Math.floor(model.contextWindow / 4))),
					model,
					{
						...options,
						maxTokens: Math.max(1, Math.min(options.maxTokens ?? 1, 1024, Math.floor(model.contextWindow / 16))),
					},
					initialPrompt + sourceNote,
					updatePrompt + sourceNote,
					undefined,
					label,
					streamFn,
					retry,
					callbacks,
					onResponse,
					false,
				);
				if (Buffer.byteLength(resized.text, "utf8") >= Buffer.byteLength(summary, "utf8")) {
					throw new Error(`${label} failed: checkpoint resizing made no progress`);
				}
				summary = resized.text;
				usage = usage ? combineUsage(usage, resized.usage) : resized.usage;
				consecutiveResizes++;
				continue;
			}
			throw new Error(`${label} failed: a message or previous summary exceeds the summarization context budget`);
		}
		const inputBudget = contextBudget - maxTokens;
		const batch: string[] = [];
		while (!resizeOnly && index < serialized.length) {
			const messageBytes = Buffer.byteLength(serialized[index], "utf8") + (batch.length > 0 ? 2 : 0);
			if (bytes + messageBytes > inputBudget) break;
			batch.push(serialized[index++]);
			bytes += messageBytes;
		}
		const promptText = summaryPrompt(batch.join("\n\n"), summary, instructions);
		const response = await completeSummarization(
			model,
			{
				systemPrompt: SUMMARIZATION_SYSTEM_PROMPT,
				messages: [{ role: "user", content: [{ type: "text", text: promptText }], timestamp: Date.now() }],
			},
			{ ...options, maxTokens },
			streamFn,
			retry,
			callbacks,
			onResponse,
		);
		if (options.signal?.aborted || response.stopReason === "aborted") {
			throw new DOMException(options.signal?.aborted ? "Compaction cancelled" : `${label} aborted`, "AbortError");
		}
		if (response.stopReason === "error") {
			throw new Error(`${label} failed: ${response.errorMessage || "Unknown error"}`);
		}
		if (response.stopReason === "length") throw new Error(`${label} failed: summary was truncated`);
		const text = contentText(response.content);
		if (!text.trim()) throw new Error(`${label} failed: summary was empty`);
		if (resizeOnly) {
			if (Buffer.byteLength(text, "utf8") >= Buffer.byteLength(summary!, "utf8")) {
				throw new Error(`${label} failed: checkpoint resizing made no progress`);
			}
			consecutiveResizes++;
		} else {
			consecutiveResizes = 0;
		}
		summary = text;
		usage = usage ? combineUsage(usage, response.usage) : response.usage;
	} while (index < serialized.length);
	return { text: summary!, usage: usage! };
}

// ============================================================================
// Compaction Preparation (for extensions)
// ============================================================================

export interface CompactionPreparation {
	/** UUID of first entry to keep */
	firstKeptEntryId: string;
	/** Messages that will be summarized and discarded */
	messagesToSummarize: AgentMessage[];
	/** Messages that will be turned into turn prefix summary (if splitting) */
	turnPrefixMessages: AgentMessage[];
	/** Whether this is a split turn (cut point in middle of turn) */
	isSplitTurn: boolean;
	tokensBefore: number;
	/** Summary from previous compaction, for iterative update */
	previousSummary?: string;
	/** File operations extracted from messagesToSummarize */
	fileOps: FileOperations;
	/** Compaction settions from settings.jsonl	*/
	settings: CompactionSettings;
}

export function prepareCompaction(
	pathEntries: SessionEntry[],
	settings: CompactionSettings,
): CompactionPreparation | undefined {
	if (pathEntries.length > 0 && pathEntries[pathEntries.length - 1].type === "compaction") {
		return undefined;
	}

	let prevCompactionIndex = -1;
	for (let i = pathEntries.length - 1; i >= 0; i--) {
		if (pathEntries[i].type === "compaction") {
			prevCompactionIndex = i;
			break;
		}
	}

	let previousSummary: string | undefined;
	let boundaryStart = 0;
	if (prevCompactionIndex >= 0) {
		const prevCompaction = pathEntries[prevCompactionIndex] as CompactionEntry;
		previousSummary = prevCompaction.summary;
		// The generated footer is carried deterministically in details, not rewritten by the LLM.
		if (!prevCompaction.fromHook && prevCompaction.details) {
			const details = prevCompaction.details as Partial<CompactionDetails>;
			if (Array.isArray(details.readFiles) && Array.isArray(details.modifiedFiles)) {
				const footer = formatFileOperations(details.readFiles, details.modifiedFiles);
				if (footer && previousSummary.endsWith(footer)) {
					previousSummary = previousSummary.slice(0, -footer.length);
				}
			}
		}
		const firstKeptEntryIndex = pathEntries.findIndex((entry) => entry.id === prevCompaction.firstKeptEntryId);
		boundaryStart = firstKeptEntryIndex >= 0 ? firstKeptEntryIndex : prevCompactionIndex + 1;
	}
	const boundaryEnd = pathEntries.length;

	const tokensBefore = estimateContextTokens(buildSessionContext(pathEntries).messages).tokens;

	const cutPoint = findCutPoint(pathEntries, boundaryStart, boundaryEnd, settings.keepRecentTokens);

	// Get UUID of first kept entry
	const firstKeptEntry = pathEntries[cutPoint.firstKeptEntryIndex];
	if (!firstKeptEntry?.id) {
		return undefined; // Session needs migration
	}
	const firstKeptEntryId = firstKeptEntry.id;

	const historyEnd = cutPoint.isSplitTurn ? cutPoint.turnStartIndex : cutPoint.firstKeptEntryIndex;

	// Messages to summarize (will be discarded after summary)
	const messagesToSummarize: AgentMessage[] = [];
	for (let i = boundaryStart; i < historyEnd; i++) {
		const msg = getMessageFromEntryForCompaction(pathEntries[i]);
		if (msg) messagesToSummarize.push(msg);
	}

	// Messages for turn prefix summary (if splitting a turn)
	const turnPrefixMessages: AgentMessage[] = [];
	if (cutPoint.isSplitTurn) {
		for (let i = cutPoint.turnStartIndex; i < cutPoint.firstKeptEntryIndex; i++) {
			const msg = getMessageFromEntryForCompaction(pathEntries[i]);
			if (msg) turnPrefixMessages.push(msg);
		}
	}

	if (messagesToSummarize.length === 0 && turnPrefixMessages.length === 0) {
		return undefined;
	}

	// Extract file operations from messages and previous compaction
	const fileOps = extractFileOperations(messagesToSummarize, pathEntries, prevCompactionIndex);

	// Also extract file ops from turn prefix if splitting
	if (cutPoint.isSplitTurn) {
		for (const msg of turnPrefixMessages) {
			extractFileOpsFromMessage(msg, fileOps);
		}
	}

	return {
		firstKeptEntryId,
		messagesToSummarize,
		turnPrefixMessages,
		isSplitTurn: cutPoint.isSplitTurn,
		tokensBefore,
		previousSummary,
		fileOps,
		settings,
	};
}

// ============================================================================
// Main compaction function
// ============================================================================

const TURN_PREFIX_SUMMARIZATION_PROMPT = `This is the PREFIX of a turn that was too large to keep. The SUFFIX (recent work) is retained.

Summarize the prefix to provide context for the retained suffix:

## Original Request
[What did the user ask for in this turn?]

## Early Progress
- [Key decisions and work done in the prefix]

## Context for Suffix
- [Information needed to understand the retained recent work]

Preserve the user's active instructions and prohibitions, decisions and rationale, unfinished tasks, blockers, and exact file/tool identifiers needed for the suffix. Separate verified outcomes from planned work. Do not copy file-list metadata tags; tracking is appended separately.
Be concise. Focus on what's needed to understand the kept suffix.`;

/**
 * Generate summaries for compaction using prepared data.
 * Returns CompactionResult - SessionManager adds uuid/parentUuid when saving.
 *
 * @param preparation - Pre-calculated preparation from prepareCompaction()
 * @param customInstructions - Optional custom focus for the summary
 */
export async function compact(
	preparation: CompactionPreparation,
	model: Model<any>,
	apiKey: string | undefined,
	headers?: Record<string, string>,
	customInstructions?: string,
	signal?: AbortSignal,
	thinkingLevel?: ThinkingLevel,
	streamFn?: StreamFn,
	env?: Record<string, string>,
	retry?: RetryPolicy,
	callbacks?: RetryCallbacks,
	onResponse?: SummarizationResponseCallback,
): Promise<CompactionResult> {
	const {
		firstKeptEntryId,
		messagesToSummarize,
		turnPrefixMessages,
		isSplitTurn,
		tokensBefore,
		previousSummary,
		fileOps,
		settings,
	} = preparation;

	// Generate summaries and merge into one
	let summary: string;
	let summaryUsage: Usage;

	if (isSplitTurn && turnPrefixMessages.length > 0) {
		// Allocate 50% of the reserve to history (0.625 * 0.8), 30% to the prefix (0.6 * 0.5).
		const historyReserve = Math.floor(settings.reserveTokens * 0.625);
		// Reuse is safe only when the checkpoint fits its allocation even under the byte upper bound.
		const resizeHistory =
			previousSummary !== undefined &&
			Buffer.byteLength(previousSummary, "utf8") > summaryOutputBudget(model, historyReserve);
		const historyPromise =
			messagesToSummarize.length > 0 || resizeHistory
				? generateSummaryWithUsage(
						messagesToSummarize,
						model,
						historyReserve,
						apiKey,
						headers,
						signal,
						customInstructions,
						previousSummary,
						thinkingLevel,
						streamFn,
						env,
						retry,
						callbacks,
						onResponse,
					)
				: Promise.resolve(undefined);
		const [historyResult, turnPrefixResult] = await Promise.all([
			historyPromise,
			generateTurnPrefixSummary(
				turnPrefixMessages,
				model,
				Math.floor(settings.reserveTokens * 0.6),
				apiKey,
				headers,
				env,
				signal,
				thinkingLevel,
				streamFn,
				retry,
				callbacks,
				onResponse,
				customInstructions,
			),
		]);
		// With no newly compacted history, reuse a fitting checkpoint verbatim.
		const historyText = historyResult?.text ?? previousSummary ?? "No prior history.";
		// Merge into single summary
		summary = `${historyText}\n\n---\n\n**Turn Context (split turn):**\n\n${turnPrefixResult.text}`;
		summaryUsage = historyResult ? combineUsage(historyResult.usage, turnPrefixResult.usage) : turnPrefixResult.usage;
	} else {
		// Just generate history summary
		const result = await generateSummaryWithUsage(
			messagesToSummarize,
			model,
			settings.reserveTokens,
			apiKey,
			headers,
			signal,
			customInstructions,
			previousSummary,
			thinkingLevel,
			streamFn,
			env,
			retry,
			callbacks,
			onResponse,
		);
		summary = result.text;
		summaryUsage = result.usage;
	}

	// Compute file lists and append to summary
	const { readFiles, modifiedFiles } = computeFileLists(fileOps);
	summary += formatFileOperations(readFiles, modifiedFiles);

	if (!firstKeptEntryId) {
		throw new Error("First kept entry has no UUID - session may need migration");
	}

	return {
		summary,
		firstKeptEntryId,
		tokensBefore,
		usage: summaryUsage,
		details: { readFiles, modifiedFiles } as CompactionDetails,
	};
}

/**
 * Generate a summary for a turn prefix (when splitting a turn).
 */
async function generateTurnPrefixSummary(
	messages: AgentMessage[],
	model: Model<any>,
	reserveTokens: number,
	apiKey: string | undefined,
	headers?: Record<string, string>,
	env?: Record<string, string>,
	signal?: AbortSignal,
	thinkingLevel?: ThinkingLevel,
	streamFn?: StreamFn,
	retry?: RetryPolicy,
	callbacks?: RetryCallbacks,
	onResponse?: SummarizationResponseCallback,
	customInstructions?: string,
): Promise<{ text: string; usage: Usage }> {
	const maxTokens = summaryOutputBudget(model, reserveTokens, true);
	const focus = customInstructions ? `\n\nAdditional focus: ${customInstructions}` : "";
	return summarizeInBatches(
		messages,
		model,
		createSummarizationOptions(model, maxTokens, apiKey, headers, env, signal, thinkingLevel),
		TURN_PREFIX_SUMMARIZATION_PROMPT + focus,
		`${TURN_PREFIX_SUMMARIZATION_PROMPT}\n\nMerge new prefix messages into <previous-summary> using only the Original Request, Early Progress, and Context for Suffix sections above. Carry forward all active instructions, prohibitions, decisions, blockers, exact operational evidence, and unfinished work even when not repeated. Remove them only when explicitly superseded or resolved; silence is not resolution. Deduplicate completed historical detail.${focus}`,
		undefined,
		"Turn prefix summarization",
		streamFn,
		retry,
		callbacks,
		onResponse,
	);
}
