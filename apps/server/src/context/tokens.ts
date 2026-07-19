export type ContextRole =
	| "system"
	| "developer"
	| "user"
	| "assistant"
	| "tool"
	| "summary";
export type ContentKind =
	| "text"
	| "attachment"
	| "reasoning"
	| "toolCall"
	| "toolResult";

export interface ContextPart {
	id?: string;
	kind: ContentKind;
	text: string;
	tokenCount?: number;
	summary?: string;
}

export interface ContextRecord {
	id: string;
	role: ContextRole;
	content: ContextPart[];
	status?: "complete" | "pending" | "streaming";
	turnId?: string;
	toolTransactionId?: string;
}

export type TokenEstimator = (text: string) => number;

export const estimateTextTokens: TokenEstimator = (text) =>
	estimateAgentTokens({
		role: "user",
		content: text,
		timestamp: 0,
	});

export function estimatePartTokens(
	part: ContextPart,
	estimate: TokenEstimator = estimateTextTokens,
): number {
	return part.tokenCount ?? estimate(part.text);
}

export function estimateRecordTokens(
	record: ContextRecord,
	estimate: TokenEstimator = estimateTextTokens,
): number {
	return record.content.reduce(
		(total, part) => total + estimatePartTokens(part, estimate),
		0,
	);
}

export function estimateRecordsTokens(
	records: readonly ContextRecord[],
	estimate: TokenEstimator = estimateTextTokens,
): number {
	return records.reduce(
		(total, record) => total + estimateRecordTokens(record, estimate),
		0,
	);
}
import { estimateTokens as estimateAgentTokens } from "@earendil-works/pi-agent-core";
