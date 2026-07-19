import type {
	ContextJobStatus,
	ContextPolicyScope,
	ProviderCallPurpose,
} from "../db/schema";

export type ContextPolicy = {
	enabled: boolean;
	softTriggerTokens: number;
	targetTokens: number;
	hardInputTokens: number;
	maxPinnedAttachmentTokens: number;
	outputReserveTokens: number;
};

export type ContextPolicySource = ContextPolicyScope | "derived";

export type ResolvedContextPolicy = ContextPolicy & {
	source: ContextPolicySource;
};

export type ContextPolicySelector =
	| {
			scope: Exclude<ContextPolicyScope, "provider">;
			provider: string;
			modelFamily?: string;
			modelId?: string;
	  }
	| {
			scope: "provider";
			provider: string;
	  };

export type ContextState = {
	conversationId: string;
	revision: number;
	summary: string | null;
	summaryRevision: number | null;
	retainedMessageBoundaryId: string | null;
	jobStatus: ContextJobStatus;
	jobId: string | null;
	jobAttempt: number;
	jobError: string | null;
	jobUpdatedAt: string | null;
};

export type ContextGlobalSettings = {
	enabled: boolean;
	summaryPromptOverride: string | null;
};

export type ProviderCallTelemetry = {
	id: string;
	conversationId?: string;
	messageId?: string;
	provider: string;
	api: string;
	modelId: string;
	purpose: ProviderCallPurpose;
	inputTokens?: number;
	outputTokens?: number;
	cacheReadTokens?: number;
	cacheWriteTokens?: number;
	estimatedCostMicros?: number;
	latencyMs?: number;
	contextPolicySource?: ContextPolicySource;
	contextPolicyEnabled?: boolean;
	contextPolicyState?: ContextPolicy;
	overflowed?: boolean;
	retryAttempt?: number;
	compactionTokensBefore?: number;
	compactionTokensAfter?: number;
};

export type AttachmentSummaryRepresentation = (attachment: {
	id: string;
	filename: string;
	mimeType: string;
	kind: string;
	byteSize: number;
}) => Promise<string>;
