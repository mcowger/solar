/** One allowlist entry stored in `provider_config.enabledModels`. */
export type ModelVisibility = "public" | "private";

export interface ModelContextPolicy {
	enabled: boolean;
	softTriggerTokens: number;
	targetTokens: number;
	hardInputTokens: number;
	maxPinnedAttachmentTokens: number;
	outputReserveTokens: number;
}

export interface AllowlistEntry {
	id: string;
	endpointId: string;
	api: string;
	visibility: ModelVisibility;
	name?: string;
	piProvider?: string;
	piModel?: string;
	piOptions?: Record<string, unknown>;
	reasoning?: boolean;
	vision?: boolean;
	documents?: boolean;
	reasoningEffort?: "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
	verbosity?: "low" | "medium" | "high";
	contextWindow?: number;
	maxTokens?: number;
	contextPolicy?: ModelContextPolicy;
}

function parseContextPolicy(value: unknown): ModelContextPolicy | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return;
	const policy = value as Record<string, unknown>;
	if (
		typeof policy.enabled !== "boolean" ||
		![
			"softTriggerTokens",
			"targetTokens",
			"hardInputTokens",
			"maxPinnedAttachmentTokens",
			"outputReserveTokens",
		].every(
			(field) =>
				typeof policy[field] === "number" && Number.isInteger(policy[field]),
		)
	)
		return;
	return policy as unknown as ModelContextPolicy;
}

export function parseAllowlist(json: string): AllowlistEntry[] {
	try {
		const parsed = JSON.parse(json);
		if (!Array.isArray(parsed)) return [];
		return parsed.flatMap((entry) => {
			if (
				!entry ||
				typeof entry.id !== "string" ||
				typeof entry.api !== "string"
			) {
				return [];
			}
			const contextPolicy = parseContextPolicy(entry.contextPolicy);
			return [
				{
					id: entry.id,
					endpointId:
						typeof entry.endpointId === "string" ? entry.endpointId : entry.api,
					api: entry.api,
					visibility: entry.visibility === "private" ? "private" : "public",
					...(typeof entry.name === "string" ? { name: entry.name } : {}),
					...(typeof entry.piProvider === "string"
						? { piProvider: entry.piProvider }
						: {}),
					...(typeof entry.piModel === "string"
						? { piModel: entry.piModel }
						: {}),
					...(entry.piOptions &&
					typeof entry.piOptions === "object" &&
					!Array.isArray(entry.piOptions)
						? { piOptions: entry.piOptions as Record<string, unknown> }
						: {}),
					...(typeof entry.reasoning === "boolean"
						? { reasoning: entry.reasoning }
						: {}),
					...(typeof entry.vision === "boolean"
						? { vision: entry.vision }
						: {}),
					...(typeof entry.documents === "boolean"
						? { documents: entry.documents }
						: {}),
					...(["minimal", "low", "medium", "high", "xhigh", "max"].includes(
						entry.reasoningEffort,
					)
						? {
								reasoningEffort:
									entry.reasoningEffort as AllowlistEntry["reasoningEffort"],
							}
						: {}),
					...(["low", "medium", "high"].includes(entry.verbosity)
						? { verbosity: entry.verbosity as AllowlistEntry["verbosity"] }
						: {}),
					...(typeof entry.contextWindow === "number" &&
					Number.isInteger(entry.contextWindow) &&
					entry.contextWindow > 0
						? { contextWindow: entry.contextWindow }
						: {}),
					...(typeof entry.maxTokens === "number" &&
					Number.isInteger(entry.maxTokens) &&
					entry.maxTokens > 0
						? { maxTokens: entry.maxTokens }
						: {}),
					...(contextPolicy ? { contextPolicy } : {}),
				},
			];
		});
	} catch {
		return [];
	}
}
