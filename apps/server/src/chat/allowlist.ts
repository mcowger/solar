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

export interface ImageModelOptions {
	input: boolean;
	aspectRatios: string[];
	resolutions: string[];
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
	/** Image generation is deliberately separate from chat capabilities. */
	image?: ImageModelOptions;
	reasoningEffort?: "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
	/** Tiers the provider advertises for this model (Plexus `/v1/models`
	 * `service_tiers`). Absent/empty means the model has no tier support and
	 * no tier control is shown. */
	serviceTiers?: string[];
	/** Admin-chosen default tier. Only honored when listed in serviceTiers. */
	serviceTier?: string;
	contextWindow?: number;
	maxTokens?: number;
	contextPolicy?: ModelContextPolicy;
}

function parseServiceTiers(value: unknown): string[] | undefined {
	if (!Array.isArray(value)) return undefined;
	const tiers = [
		...new Set(
			value.flatMap((tier) =>
				typeof tier === "string" &&
				tier.trim().length > 0 &&
				tier.trim().length <= 32
					? [tier.trim()]
					: [],
			),
		),
	].slice(0, 16);
	return tiers.length ? tiers : undefined;
}

function parseImageOptions(value: unknown): ImageModelOptions | undefined {
	if (value === true) {
		return { input: true, aspectRatios: [], resolutions: [] };
	}
	if (!value || typeof value !== "object" || Array.isArray(value)) return;
	const options = value as Record<string, unknown>;
	const aspectRatios = Array.isArray(options.aspectRatios)
		? options.aspectRatios.filter(
				(value): value is string =>
					typeof value === "string" && value.length <= 32,
			)
		: [];
	const resolutions = Array.isArray(options.resolutions)
		? options.resolutions.filter(
				(value): value is string =>
					typeof value === "string" && value.length <= 32,
			)
		: [];
	return {
		input: options.input !== false,
		aspectRatios: [...new Set(aspectRatios)],
		resolutions: [...new Set(resolutions)],
	};
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

export function parseAllowlist(
	json: string | null | undefined,
): AllowlistEntry[] {
	try {
		if (!json) return [];
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
			const parsedServiceTiers = parseServiceTiers(entry.serviceTiers);
			const parsedServiceTier =
				typeof entry.serviceTier === "string" &&
				entry.serviceTier.trim().length > 0 &&
				entry.serviceTier.trim().length <= 32
					? entry.serviceTier.trim()
					: undefined;
			const image = parseImageOptions(
				entry.image ??
					entry.imageCapabilities ??
					(entry.api === "openrouter-images" ? { input: true } : undefined),
			);
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
					...(image ? { image } : {}),
					...(["minimal", "low", "medium", "high", "xhigh", "max"].includes(
						entry.reasoningEffort,
					)
						? {
								reasoningEffort:
									entry.reasoningEffort as AllowlistEntry["reasoningEffort"],
							}
						: {}),
					...(parsedServiceTiers ? { serviceTiers: parsedServiceTiers } : {}),
					...(parsedServiceTier &&
					(!parsedServiceTiers ||
						parsedServiceTiers.includes(parsedServiceTier))
						? { serviceTier: parsedServiceTier }
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

/** Parses the image-only catalog stored separately from chat models. */
export function parseImageAllowlist(
	json: string | null | undefined,
): AllowlistEntry[] {
	return parseAllowlist(json).filter(
		(entry) => entry.api === "openrouter-images" || entry.image !== undefined,
	);
}
