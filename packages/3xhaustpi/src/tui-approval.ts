import type { AgentToolApprovalRequest } from "./agent-runtime.ts";
import type { CodingTaskPatchProposal } from "./coding-runtime.ts";
import { layoutTuiFrame } from "./tui-layout-frame.ts";
import { projectTranscriptCards } from "./tui-transcript-cards.ts";

export const MAX_TUI_APPROVAL_LINES = 5_000;

export interface TuiApprovalReview {
	readonly reviewable: boolean;
	readonly lines: readonly string[];
}

function boundedReview(lines: readonly string[]): TuiApprovalReview {
	if (lines.length <= MAX_TUI_APPROVAL_LINES) return { reviewable: true, lines };
	return {
		reviewable: false,
		lines: [`Review blocked: ${lines.length} lines exceeds the ${MAX_TUI_APPROVAL_LINES}-line safety limit.`],
	};
}

export function formatPatchApprovalReview(proposal: CodingTaskPatchProposal): TuiApprovalReview {
	return boundedReview(proposal.diff.split("\n"));
}

export function formatToolApprovalReview(request: AgentToolApprovalRequest): TuiApprovalReview {
	const metadata = [
		request.summary,
		request.targetPath ? `path ${request.targetPath}` : undefined,
		request.beforeSha256 && request.afterSha256
			? `${request.beforeSha256.slice(0, 12)} → ${request.afterSha256.slice(0, 12)}`
			: undefined,
	].filter((line) => line !== undefined);
	return boundedReview([...metadata, ...request.preview.split("\n")]);
}

export function formatToolApprovalTranscriptEntry(request: AgentToolApprovalRequest): string {
	const review = formatToolApprovalReview(request);
	return [`Tool approval  ${request.toolName}`, ...review.lines].join("\n");
}

export function formatPatchApprovalTranscriptEntry(proposal: CodingTaskPatchProposal): string {
	const review = formatPatchApprovalReview(proposal);
	return [`Patch ready  ${proposal.files.join(", ")}`, ...review.lines].join("\n");
}

export function approvalFitsTerminal(reviewText: string | undefined, columns: number, rows: number): boolean {
	if (!reviewText || columns < 56 || rows < 12) return false;
	const layout = layoutTuiFrame(columns, rows);
	const renderedRows = projectTranscriptCards([reviewText], columns).reduce((total, card) => total + card.length, 0);
	return renderedRows <= layout.transcriptRows;
}
