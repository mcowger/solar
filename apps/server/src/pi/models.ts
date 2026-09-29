/**
 * Model catalog integration (plan: "Model catalog integration").
 *
 * Solar's `provider_config` table remains the admin source of truth for which
 * models a deployment offers; pi's `${SOLAR_PI_AGENT_DIR}/models.json` +
 * `auth.json` are regenerated from it so pi child processes (and Solar's
 * in-process availability checks) read the same set. Solar never hand-edits
 * those files: they are derived artifacts owned by this module.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ModelRegistry, ModelRuntime } from "@earendil-works/pi-coding-agent";
import {
	loadProviderConfigs,
	MOCK,
	normalizeBaseUrlForApi,
	type ProviderConfigRow,
} from "../chat/catalog";
import { logger } from "../logger";
import { ensurePiDirs, piConfig } from "./config";

/**
 * Structural shape of a models.json provider entry (matching pi's
 * PiProviderConfig, which isn't re-exported from the package root).
 */
interface PiProviderConfig {
	name?: string;
	baseUrl?: string;
	api?: string;
	apiKey?: string;
	authHeader?: boolean;
	models?: Array<{
		id: string;
		name: string;
		api?: string;
		baseUrl?: string;
		reasoning: boolean;
		thinkingLevelMap?: Record<string, string | null>;
		input: ("text" | "image")[];
		cost: unknown;
		contextWindow: number;
		maxTokens: number;
		samplingParams?: Record<string, unknown>;
		headers?: Record<string, string>;
		[extra: string]: unknown;
	}>;
}

/** pi provider id Solar uses for a configured endpoint. */
export function piProviderId(selection: {
	provider: string;
	endpointId: string;
}): string {
	return `solar:${selection.provider}:${selection.endpointId}`;
}

export const MOCK_PI_PROVIDER = "solar:mock:mock";

interface PiModelEntry {
	id: string;
	name: string;
	api: string;
	reasoning: boolean;
	thinkingLevelMap?: Record<string, string | null>;
	input: ("text" | "image")[];
	cost: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		tiers?: unknown[];
	};
	contextWindow: number;
	maxTokens: number;
	[extra: string]: unknown;
}

const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

/**
 * pi's own builtin catalog (whatever version pi-coding-agent bundles) looked
 * up per allowlist entry, so thinkingLevelMap / cost / input honesty comes
 * from the model pi actually knows. Never consults the network or Solar's
 * own models.json — it's a pure in-process lookup at sync time.
 */
async function builtinPiModels() {
	const runtime = await ModelRuntime.create({
		authPath: join(piConfig.agentDir, "auth.json"),
		modelsPath: null,
		allowModelNetwork: false,
	});
	return new ModelRegistry(runtime).getAll();
}

function findKnownModel(
	entry: ProviderConfigRow["enabledModels"][number],
	config: ProviderConfigRow,
	builtins: ReturnType<ModelRegistry["getAll"]>,
) {
	const modelId = entry.piModel ?? entry.id;
	const providerId = entry.piProvider ?? config.provider;
	return (
		builtins.find((m) => m.provider === providerId && m.id === modelId) ??
		builtins.find((m) => m.id === modelId && m.api === entry.api)
	);
}

function endpointModelEntry(
	config: ProviderConfigRow,
	entry: ProviderConfigRow["enabledModels"][number],
	builtins: ReturnType<ModelRegistry["getAll"]>,
): PiModelEntry {
	const known = findKnownModel(entry, config, builtins);
	const reasoning = entry.reasoning ?? known?.reasoning ?? false;
	const windowTokens = entry.contextWindow ?? known?.contextWindow ?? 128_000;
	return {
		id: entry.id,
		name: entry.name ?? known?.name ?? entry.id,
		api: entry.api,
		reasoning,
		// The crucial one: without the level map pi can't translate our
		// reasoningEffort choices into provider request parameters.
		...(known?.thinkingLevelMap
			? {
					thinkingLevelMap: { ...known.thinkingLevelMap } as Record<
						string,
						string | null
					>,
				}
			: {}),
		input: entry.vision
			? ["text", "image"]
			: (known?.input.filter((i) => i === "text" || i === "image") ?? ["text"]),
		cost: known?.cost ? { ...known.cost } : { ...ZERO_COST },
		contextWindow: windowTokens,
		maxTokens:
			entry.maxTokens ?? known?.maxTokens ?? Math.min(windowTokens, 32_768),
		...(known?.samplingParams
			? { samplingParams: { ...known.samplingParams } }
			: {}),
		// piOptions carry pi-level overrides (compat shims, params) admins set.
		...(entry.piOptions ?? {}),
	};
}

/** Serialize the whole provider_config table as pi's models.json body. */
export async function buildPiModelsJson(
	port: number,
): Promise<Record<string, PiProviderConfig>> {
	const configs = await loadProviderConfigs();
	const builtins = await builtinPiModels();
	const providers: Record<string, PiProviderConfig> = {};
	for (const config of configs) {
		for (const endpoint of config.endpoints) {
			const models = config.enabledModels
				.filter((entry) => !entry.image && entry.api !== "openrouter-images")
				.filter((entry) => entry.endpointId === endpoint.id)
				.map((entry) => endpointModelEntry(config, entry, builtins));
			if (models.length === 0) continue;
			const providerId = piProviderId({
				provider: config.provider,
				endpointId: endpoint.id,
			});
			providers[providerId] = {
				name: endpoint.label,
				baseUrl: normalizeBaseUrlForApi(endpoint.api, endpoint.baseUrl),
				api: endpoint.api as PiProviderConfig["api"],
				models: models as NonNullable<PiProviderConfig["models"]>,
			};
		}
	}
	if (MOCK) {
		providers[MOCK_PI_PROVIDER] = {
			name: "Solar mock LLM",
			baseUrl: `http://127.0.0.1:${port}/internal/mock-llm/v1`,
			api: "openai-completions" as PiProviderConfig["api"],
			models: [
				{
					id: "mock-reasoning",
					name: "Mock (reasoning)",
					api: "openai-completions",
					reasoning: true,
					// The mock advertises a plain 1:1 effort map so UI dev++E2E can
					// exercise the reasoning levels dropdown without a real provider.
					thinkingLevelMap: THINKING_LEVELS.reduce<
						Record<string, string | null>
					>((acc, level) => ({ ...acc, [level]: level }), {}),
					input: ["text"],
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					contextWindow: 128_000,
					maxTokens: 8_192,
				},
				{
					id: "mock-vision",
					name: "Mock (vision)",
					api: "openai-completions",
					reasoning: false,
					input: ["text", "image"],
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					contextWindow: 128_000,
					maxTokens: 8_192,
				},
			] as NonNullable<PiProviderConfig["models"]>,
		};
	}
	return providers;
}

export async function buildPiAuthJson(): Promise<Record<string, unknown>> {
	const configs = await loadProviderConfigs();
	const auth: Record<string, unknown> = {};
	for (const config of configs) {
		if (!config.apiKey) continue;
		for (const endpoint of config.endpoints) {
			auth[
				piProviderId({ provider: config.provider, endpointId: endpoint.id })
			] = {
				type: "api_key",
				key: config.apiKey,
			};
		}
	}
	if (MOCK) auth[MOCK_PI_PROVIDER] = { type: "api_key", key: "mock" };
	return auth;
}

/**
 * Rewrite ${SOLAR_PI_AGENT_DIR}/models.json + auth.json from provider_config.
 * Auth values live only in auth.json; models.json references "stored" keys so
 * credentials never land in the model config file.
 */
export async function syncPiModelConfig(port: number): Promise<void> {
	ensurePiDirs();
	const models = { providers: await buildPiModelsJson(port) };
	const auth = await buildPiAuthJson();
	writeFileSync(
		join(piConfig.agentDir, "models.json"),
		JSON.stringify(models, null, 2),
	);
	writeFileSync(
		join(piConfig.agentDir, "auth.json"),
		JSON.stringify(auth, null, 2),
		{
			mode: 0o600,
		},
	);
	logger
		.withMetadata({
			providers: Object.keys(auth).length,
			agentDir: piConfig.agentDir,
		})
		.info("pi model config synced");
}

/** Minimal structural shape of a pi Model (avoids coupling to pi-ai versions). */
interface PiModel {
	provider: string;
	id: string;
	name: string;
	reasoning: boolean;
	contextWindow: number;
}

let availableCache: { at: number; models: PiModel[] } | null = null;
const AVAILABLE_CACHE_MS = 30_000;

/**
 * In-process availability listing — the same files a spawned pi would read,
 * no child process involved (plan: Model catalog integration — Read path).
 */
export async function listPiAvailableModels(): Promise<
	{
		provider: string;
		id: string;
		name: string;
		reasoning: boolean;
		contextWindow: number;
	}[]
> {
	if (!existsSync(join(piConfig.agentDir, "models.json"))) return [];
	if (availableCache && Date.now() - availableCache.at < AVAILABLE_CACHE_MS) {
		return describeAvailable(availableCache.models);
	}
	const runtime = await ModelRuntime.create({
		authPath: join(piConfig.agentDir, "auth.json"),
		modelsPath: join(piConfig.agentDir, "models.json"),
		allowModelNetwork: false,
	});
	const available = [...new ModelRegistry(runtime).getAvailable()] as PiModel[];
	availableCache = { at: Date.now(), models: available };
	return describeAvailable(available);
}

function describeAvailable(models: PiModel[]) {
	return models.map((model) => ({
		provider: model.provider,
		id: model.id,
		name: model.name,
		reasoning: model.reasoning,
		contextWindow: model.contextWindow,
	}));
}

// ---------------------------------------------------------------------------
// Model capability reads — from pi's models.json (0.99 grounded data), not
// Solar's pinned pi-ai catalog snapshot.

const THINKING_LEVELS = [
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
] as const;

interface PiModelJsonEntry {
	id?: string;
	reasoning?: boolean;
	thinkingLevelMap?: Record<string, string | null>;
	contextWindow?: number;
	maxTokens?: number;
}

function readPiModelEntry(selection: {
	provider: string;
	endpointId: string;
	modelId: string;
}): PiModelJsonEntry | null {
	const path = join(piConfig.agentDir, "models.json");
	if (!existsSync(path)) return null;
	try {
		const parsed = JSON.parse(readFileSync(path, "utf-8")) as {
			providers?: Record<string, { models?: PiModelJsonEntry[] }>;
		};
		const provider = parsed.providers?.[piProviderId(selection)];
		return (
			provider?.models?.find((entry) => entry.id === selection.modelId) ?? null
		);
	} catch {
		return null;
	}
}

/**
 * Model capability data pi itself will honor: reasoning levels filtered
 * through the model's thinkingLevelMap (the place pi translates them into
 * provider request parameters). Read from models.json — the registry data
 * Solar already generated with pi's current builtin catalog.
 */
export function piModelCapabilities(selection: {
	provider: string;
	endpointId: string;
	modelId: string;
	api: string;
}) {
	const entry = readPiModelEntry(selection);
	if (!entry) return null;
	const map = entry.thinkingLevelMap ?? {};
	const reasoning = entry.reasoning
		? THINKING_LEVELS.filter(
				(level) =>
					map[level] !== null &&
					((level !== "xhigh" && level !== "max") || map[level] !== undefined),
			)
		: [];
	return {
		reasoningLevels: reasoning,
		supportsVerbosity: selection.api === "openai-responses",
		contextWindow: entry.contextWindow,
		maxTokens: entry.maxTokens,
	};
}

export { THINKING_LEVELS };
