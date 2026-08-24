import { createInterface } from "node:readline";
import type { PatchProposal } from "@3xhaust/semantic-contract";
import type { CodingTaskPatchProposal } from "./coding-runtime-contracts.ts";
import type { ProjectDocument } from "./project-snapshot.ts";

export function approvalQuestion(): Promise<boolean> {
	const readline = createInterface({ input: process.stdin, output: process.stdout });
	return new Promise((resolve) => {
		readline.question("Apply this patch? [y/N] ", (answer) => {
			readline.close();
			resolve(["y", "yes"].includes(answer.trim().toLowerCase()));
		});
	});
}

export function createPatchProposal(
	patchId: string,
	targetRevision: string,
	proposal: PatchProposal,
	documents: ReadonlyMap<string, ProjectDocument>,
): CodingTaskPatchProposal {
	const lines: string[] = [];
	for (const edit of proposal.edits) {
		const document = documents.get(edit.documentId);
		if (!document) throw new Error(`Patch references undisclosed document ${edit.documentId}`);
		lines.push(`--- a/${document.relativePath}`, `+++ b/${document.relativePath}`, `@@ exact replacement @@`);
		for (const line of edit.oldText.split("\n")) lines.push(`-${line}`);
		for (const line of edit.newText.split("\n")) lines.push(`+${line}`);
	}
	return {
		patchId,
		targetRevision,
		diff: lines.join("\n"),
		files: proposal.edits.map((edit) => {
			const document = documents.get(edit.documentId);
			if (!document) throw new Error(`Patch references undisclosed document ${edit.documentId}`);
			return document.relativePath;
		}),
	};
}
