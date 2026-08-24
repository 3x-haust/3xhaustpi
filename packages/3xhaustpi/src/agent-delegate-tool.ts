import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const MAX_DELEGATED_OBJECTIVE_CHARACTERS = 4_000;
const delegateSchema = Type.Object({
	objective: Type.String({
		description: "One concrete read-only investigation objective",
		maxLength: MAX_DELEGATED_OBJECTIVE_CHARACTERS,
	}),
});

export interface DelegateAgentRequest {
	readonly workId: string;
	readonly objective: string;
}

export function createDelegateTool(input: {
	readonly delegate: (request: DelegateAgentRequest) => Promise<string>;
}): ToolDefinition {
	const definition: ToolDefinition<typeof delegateSchema> = {
		name: "delegate",
		label: "delegate",
		description: "Delegate one bounded read-only investigation to a child agent and return its result.",
		promptSnippet: "delegate: run one read-only child investigation in parallel",
		promptGuidelines: [
			"Delegate only independent read-only investigation.",
			"Give the child one concrete objective and use its returned evidence.",
		],
		parameters: delegateSchema,
		executionMode: "parallel",
		async execute(toolCallId, params) {
			const objective = params.objective.trim();
			if (!objective) throw new Error("Delegated objective is required");
			const text = await input.delegate({ workId: toolCallId, objective });
			return {
				content: [{ type: "text", text }],
				details: undefined,
			};
		},
	};
	return definition as unknown as ToolDefinition;
}
