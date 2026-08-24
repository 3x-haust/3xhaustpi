import { dim, failure, muted, sanitizeTerminalText, stripAnsi, warning } from "./tui-text.ts";

export type TuiTranscriptRole =
	| "you"
	| "threeXhaust"
	| "thought"
	| "metrics"
	| "tool"
	| "agent"
	| "notice"
	| "system"
	| "error"
	| "approval";

export interface TuiTranscriptTemplate {
	readonly role: TuiTranscriptRole;
	readonly label: string;
	readonly content: string;
}

export function formatSubmittedPromptTurn(objective: string, inserted: boolean): string | undefined {
	return inserted ? `You ${objective}` : undefined;
}

export function formatTranscriptEntry(value: string): TuiTranscriptTemplate {
	const visible = stripAnsi(sanitizeTerminalText(value)).trimStart();
	const without = (pattern: RegExp) => visible.replace(pattern, "").trimStart();
	if (/^(You|User|사용자)\b/u.test(visible)) {
		return { role: "you", label: "", content: without(/^(You|User|사용자)\s*/u) };
	}
	const assistantPrefix = /^(3xhaustPi|3xhaustpi|3xhaust|Assistant)\b/u;
	if (assistantPrefix.test(visible)) {
		return {
			role: "threeXhaust",
			label: "",
			content: without(/^(3xhaustPi|3xhaustpi|3xhaust|Assistant)\s*/u),
		};
	}
	if (/^assistant\b/u.test(visible)) {
		return { role: "threeXhaust", label: "", content: without(/^assistant\s*/u) };
	}
	if (/^Thought:/u.test(visible)) return { role: "thought", label: "", content: visible };
	if (/^Stats:/u.test(visible)) return { role: "metrics", label: "", content: without(/^Stats:\s*/u) };
	if (/^TPS\b/u.test(visible)) return { role: "metrics", label: "", content: visible };
	if (
		/^(Patch ready|Tool approval|Press y|Computer action ready|✓ Patch approved|✓ Computer action approved|Patch rejected)\b/u.test(
			visible,
		)
	) {
		return { role: "approval", label: warning("review"), content: visible };
	}
	if (/^(?:Error:|Computer Use:|Unknown command:)/u.test(visible)) {
		return { role: "error", label: failure("error"), content: visible };
	}
	if (/^(?:tool|capability|◇ model)\b|^[✓×]/u.test(visible)) {
		return { role: "tool", label: muted("tool"), content: visible };
	}
	if (/^(agent|chat|Intent →)\b/u.test(visible)) {
		return { role: "agent", label: muted("agent"), content: visible };
	}
	if (/^Notice\b/u.test(visible)) {
		return { role: "notice", label: dim("notice"), content: without(/^Notice\s*/u) };
	}
	return { role: "system", label: dim("system"), content: visible };
}

export function formatVisibleTranscriptEntry(value: string): string {
	return formatTranscriptEntry(value).role === "system" ? `Notice ${value}` : value;
}
