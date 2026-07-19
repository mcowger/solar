import type { ContextPolicy as PersistedContextPolicy } from "./types";

export type ContextPolicy = PersistedContextPolicy;

export interface ModelContextCapabilities {
	modelId?: string;
	provider?: string;
	contextWindow: number;
	maxOutputTokens?: number;
}

export const GPT_CONTEXT_POLICY: ContextPolicy = {
	enabled: true,
	softTriggerTokens: 272_000,
	targetTokens: 180_000,
	hardInputTokens: 600_000,
	maxPinnedAttachmentTokens: 64_000,
	outputReserveTokens: 32_000,
};

export const CLAUDE_CONTEXT_POLICY: ContextPolicy = {
	enabled: true,
	softTriggerTokens: 500_000,
	targetTokens: 300_000,
	hardInputTokens: 900_000,
	maxPinnedAttachmentTokens: 64_000,
	outputReserveTokens: 32_000,
};

export function contextPolicyFor(
	model: Pick<ModelContextCapabilities, "modelId" | "provider">,
): ContextPolicy | undefined {
	const identity =
		`${model.provider ?? ""} ${model.modelId ?? ""}`.toLowerCase();
	if (identity.includes("claude") || identity.includes("anthropic"))
		return CLAUDE_CONTEXT_POLICY;
	if (identity.includes("gpt") || identity.includes("openai"))
		return GPT_CONTEXT_POLICY;
	return undefined;
}

export function effectiveContextPolicy(
	model: ModelContextCapabilities,
	configured = contextPolicyFor(model),
): ContextPolicy {
	if (!Number.isFinite(model.contextWindow) || model.contextWindow <= 0) {
		throw new RangeError("contextWindow must be a positive finite number");
	}
	const outputReserveTokens = Math.min(
		configured?.outputReserveTokens ?? 32_000,
		model.maxOutputTokens ?? 32_000,
		Math.max(0, model.contextWindow - 1),
	);
	const availableInputTokens = model.contextWindow - outputReserveTokens;
	const hardInputTokens = Math.min(
		configured?.hardInputTokens ?? availableInputTokens,
		availableInputTokens,
	);
	return {
		enabled: configured?.enabled ?? true,
		softTriggerTokens:
			configured?.softTriggerTokens ?? Math.floor(model.contextWindow * 0.7),
		targetTokens: Math.min(
			configured?.targetTokens ?? Math.floor(model.contextWindow * 0.45),
			hardInputTokens,
		),
		hardInputTokens,
		maxPinnedAttachmentTokens: Math.min(
			configured?.maxPinnedAttachmentTokens ?? 64_000,
			hardInputTokens,
		),
		outputReserveTokens,
	};
}
