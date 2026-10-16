/**
 * Pure merge of a gateway's model list (`GET /v1/models`) into a provider's
 * configured models, used by model sync (./modelSync.ts) and by imports. No
 * I/O, so every rule is unit-tested in isolation.
 *
 * Rules:
 * - New gateway models are added as private (admin-only) models.
 * - Existing models get the facts the gateway reports refreshed (reasoning,
 *   vision, service tiers, and pi routing when the gateway advertises it);
 *   what an admin set (visibility, name, context window/policy, documents,
 *   reasoning effort, max tokens) is never touched. A chosen service tier
 *   survives only while the gateway still offers it.
 * - A model moves to another endpoint only when its API is no longer one the
 *   gateway supports for it.
 * - Models the gateway no longer lists are removed — at once for a manual
 *   sync, on the second miss in a row for the background timer, and never
 *   when the scope was not fetched completely.
 * - An empty reply, or one that would remove every configured model, changes
 *   nothing (a gateway restart or a wrong base URL must not wipe the list).
 */
import type { AllowlistEntry, ImageModelOptions } from "./allowlist";

export interface SyncEndpoint {
	id: string;
	label: string;
	baseUrl: string;
	api: string;
}

/** The fields of a discovered gateway model that sync uses. */
export interface DiscoveredForSync {
	id: string;
	name: string;
	preferredApi: string | null;
	/** Every Solar API the gateway lists for the model, preferred first. */
	supportedApis: string[];
	piProvider?: string;
	piModel?: string;
	piOptions?: Record<string, unknown>;
	reasoning: boolean;
	vision: boolean;
	image?: ImageModelOptions;
	serviceTiers?: string[];
}

export interface ModelSyncSummary {
	added: string[];
	removed: string[];
	updated: { id: string; fields: string[] }[];
	moved: { id: string; from: string; to: string }[];
	/** Image models the gateway offers that have no image-catalog mapping. */
	skipped: string[];
}

export interface MergeInput {
	kind: "chat" | "image";
	current: AllowlistEntry[];
	discovered: DiscoveredForSync[];
	/** Endpoints this discovery covers; models on other endpoints pass through. */
	scopeEndpoints: SyncEndpoint[];
	/** Whether every fetch for this scope succeeded. */
	complete: boolean;
	/** Whether any discovered model carries pi routing (pi_provider). */
	advertisesPiRouting: boolean;
	/** Consecutive misses so far, by model id. */
	misses: Record<string, number>;
	/** Remove a missing model on its first miss (manual sync). */
	immediate: boolean;
	imageCatalogIds?: ReadonlySet<string>;
}

export interface MergeResult {
	next: AllowlistEntry[];
	summary: ModelSyncSummary;
	/** Consecutive misses after this merge, by model id. */
	missing: Record<string, number>;
	changed: boolean;
	error?: string;
}

/** Fields an admin sets; neither sync nor a re-import ever changes them. */
export const ADMIN_SET_FIELDS = [
	"name",
	"contextWindow",
	"maxTokens",
	"contextPolicy",
	"documents",
	"reasoningEffort",
] as const;

/** `next` with every admin-set field `previous` has carried over. */
export function keepAdminFields(
	previous: AllowlistEntry,
	next: AllowlistEntry,
): AllowlistEntry {
	const kept: AllowlistEntry = { ...next };
	for (const field of ADMIN_SET_FIELDS) {
		if (previous[field] !== undefined)
			(kept as unknown as Record<string, unknown>)[field] = previous[field];
	}
	return kept;
}

const REFRESHED_CHAT_FIELDS = [
	"reasoning",
	"vision",
	"serviceTiers",
	"serviceTier",
	"piProvider",
	"piModel",
	"piOptions",
] as const;

function emptySummary(): ModelSyncSummary {
	return { added: [], removed: [], updated: [], moved: [], skipped: [] };
}

function same(a: unknown, b: unknown) {
	return JSON.stringify(a) === JSON.stringify(b);
}

function setOrDelete<K extends keyof AllowlistEntry>(
	entry: AllowlistEntry,
	key: K,
	value: AllowlistEntry[K] | undefined,
) {
	if (value === undefined) delete entry[key];
	else entry[key] = value;
}

/** The scope endpoint a model should use: preferred API, then any supported. */
function chooseEndpoint(
	model: DiscoveredForSync,
	scope: SyncEndpoint[],
): SyncEndpoint | undefined {
	const byApi = (api: string | null) =>
		api ? scope.find((endpoint) => endpoint.api === api) : undefined;
	return (
		byApi(model.preferredApi) ??
		model.supportedApis.map(byApi).find(Boolean) ??
		scope[0]
	);
}

function refreshChat(
	current: AllowlistEntry,
	model: DiscoveredForSync,
	input: MergeInput,
	summary: ModelSyncSummary,
): AllowlistEntry {
	const next: AllowlistEntry = { ...current };
	// An unset capability lets Solar infer it from pi's built-in catalog; a
	// gateway that does not report it must not turn that into an explicit
	// false. Known values follow the gateway.
	for (const field of ["reasoning", "vision"] as const) {
		if (current[field] !== undefined || model[field])
			next[field] = model[field];
	}
	setOrDelete(
		next,
		"serviceTiers",
		model.serviceTiers?.length ? [...model.serviceTiers] : undefined,
	);
	if (next.serviceTier && !next.serviceTiers?.includes(next.serviceTier))
		delete next.serviceTier;
	if (input.advertisesPiRouting) {
		setOrDelete(next, "piProvider", model.piProvider);
		setOrDelete(next, "piModel", model.piModel);
		setOrDelete(next, "piOptions", model.piOptions);
	}
	if (
		model.supportedApis.length > 0 &&
		!model.supportedApis.includes(current.api)
	) {
		const target = model.supportedApis
			.map((api) =>
				input.scopeEndpoints.find((endpoint) => endpoint.api === api),
			)
			.find(Boolean);
		if (target) {
			next.endpointId = target.id;
			next.api = target.api;
			summary.moved.push({ id: current.id, from: current.api, to: target.api });
		}
	}
	const fields = REFRESHED_CHAT_FIELDS.filter(
		(field) => !same(current[field], next[field]),
	);
	if (fields.length)
		summary.updated.push({ id: current.id, fields: [...fields] });
	return next;
}

function refreshImage(
	current: AllowlistEntry,
	model: DiscoveredForSync,
	summary: ModelSyncSummary,
): AllowlistEntry {
	if (!current.image || !model.image) return current;
	if (current.image.input === model.image.input) return current;
	summary.updated.push({ id: current.id, fields: ["image.input"] });
	return { ...current, image: { ...current.image, input: model.image.input } };
}

function addition(
	model: DiscoveredForSync,
	input: MergeInput,
	summary: ModelSyncSummary,
): AllowlistEntry | null {
	if (input.kind === "image") {
		const endpoint = input.scopeEndpoints[0];
		if (!endpoint || !input.imageCatalogIds?.has(model.id)) {
			summary.skipped.push(model.id);
			return null;
		}
		return {
			id: model.id,
			endpointId: endpoint.id,
			api: endpoint.api,
			visibility: "private",
			name: model.name,
			piModel: model.id,
			image: model.image ?? {
				input: true,
				aspectRatios: [],
				resolutions: [],
			},
		};
	}
	const endpoint = chooseEndpoint(model, input.scopeEndpoints);
	if (!endpoint) return null;
	return {
		id: model.id,
		endpointId: endpoint.id,
		api: endpoint.api,
		visibility: "private",
		name: model.name,
		...(model.piProvider ? { piProvider: model.piProvider } : {}),
		...(model.piModel ? { piModel: model.piModel } : {}),
		...(model.piOptions ? { piOptions: model.piOptions } : {}),
		reasoning: model.reasoning,
		vision: model.vision,
		...(model.serviceTiers?.length
			? { serviceTiers: [...model.serviceTiers] }
			: {}),
	};
}

export function mergeDiscoveredModels(input: MergeInput): MergeResult {
	const unchanged = (error: string): MergeResult => ({
		next: input.current,
		summary: emptySummary(),
		missing: { ...input.misses },
		changed: false,
		error,
	});
	if (input.discovered.length === 0)
		return unchanged(
			"The gateway listed no models, so nothing was changed. Check the endpoint's base URL and key.",
		);

	const scopeIds = new Set(input.scopeEndpoints.map((endpoint) => endpoint.id));
	const inScope = (model: AllowlistEntry) => scopeIds.has(model.endpointId);
	const discovered = new Map(
		input.discovered.map((model) => [model.id, model]),
	);
	const summary = emptySummary();
	const missing: Record<string, number> = {};
	const next: AllowlistEntry[] = [];
	let inScopeCount = 0;

	for (const current of input.current) {
		if (!inScope(current)) {
			next.push(current);
			continue;
		}
		inScopeCount++;
		const model = discovered.get(current.id);
		if (model) {
			next.push(
				input.kind === "image"
					? refreshImage(current, model, summary)
					: refreshChat(current, model, input, summary),
			);
			continue;
		}
		const misses = (input.misses[current.id] ?? 0) + 1;
		if (input.complete && (input.immediate || misses >= 2)) {
			summary.removed.push(current.id);
		} else {
			missing[current.id] = misses;
			next.push(current);
		}
	}

	if (inScopeCount > 0 && summary.removed.length === inScopeCount)
		return {
			...unchanged(
				"The gateway's reply would remove every configured model, so nothing was changed. Check the endpoint's base URL.",
			),
			missing: { ...input.misses },
		};

	const known = new Set(input.current.map((model) => model.id));
	const additions = input.discovered
		.filter((model) => !known.has(model.id))
		.sort((a, b) => a.id.localeCompare(b.id))
		.flatMap((model) => {
			const added = addition(model, input, summary);
			if (!added) return [];
			summary.added.push(model.id);
			return [added];
		});
	next.push(...additions);

	const changed =
		summary.added.length > 0 ||
		summary.removed.length > 0 ||
		summary.updated.length > 0 ||
		summary.moved.length > 0;
	return { next, summary, missing, changed };
}
