/** One allowlist entry stored in `provider_config.enabledModels`. */
export type ModelVisibility = "public" | "private";

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
				},
			];
		});
	} catch {
		return [];
	}
}
