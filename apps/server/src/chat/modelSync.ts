/**
 * Model sync: keeps a provider's configured models in step with what its
 * gateway lists at `GET /v1/models`, on demand (the Sync button) and on a
 * background timer for providers with auto-sync on. The merge rules live in
 * ./modelSyncMerge.ts; this module fetches, writes and schedules.
 *
 * Fetching happens outside the provider lock; the merge runs under it
 * against a fresh read of the row, so an admin save that lands meanwhile
 * wins. Every provider write (setProvider, import, delete, sync) goes
 * through withProviderLock.
 */
import { config } from "../config";
import { db } from "../db";
import { logger } from "../logger";
import {
	type DiscoveredModel,
	fetchEndpointModels,
	listImageCatalogModels,
	loadProviderConfigs,
	modelsUrl,
	type ProviderEndpoint,
} from "./catalog";
import { mergeDiscoveredModels, type ModelSyncSummary } from "./modelSyncMerge";

export type ModelSyncTrigger = "manual" | "timer" | "enable";

export interface ModelSyncStatus extends ModelSyncSummary {
	at: string;
	trigger: ModelSyncTrigger;
	ok: boolean;
	errors: string[];
	/** Consecutive timer misses, by chat model id. */
	missing: Record<string, number>;
	/** Consecutive timer misses, by image model id. */
	missingImages: Record<string, number>;
}

export interface ModelSyncOutcome {
	provider: string;
	status: ModelSyncStatus | null;
	/** Why nothing was attempted (airgap mode). */
	skipped?: string;
}

export interface ModelSyncOptions {
	trigger: ModelSyncTrigger;
	fetchImpl?: typeof fetch;
	/** Called after the models changed (regenerates pi's models.json). */
	onModelsChanged?: () => Promise<void>;
	airgapMode?: boolean;
	timeoutMs?: number;
}

const FETCH_TIMEOUT_MS = 15_000;
const LIST_CAP = 50;

const locks = new Map<string, Promise<void>>();
const inflight = new Map<string, Promise<ModelSyncOutcome>>();

/** Runs `fn` with exclusive access to one provider's configuration row. */
export async function withProviderLock<T>(
	provider: string,
	fn: () => Promise<T>,
): Promise<T> {
	const previous = locks.get(provider) ?? Promise.resolve();
	let release!: () => void;
	const mine = new Promise<void>((resolve) => {
		release = resolve;
	});
	const tail = previous.then(() => mine);
	locks.set(provider, tail);
	await previous;
	try {
		return await fn();
	} finally {
		release();
		if (locks.get(provider) === tail) locks.delete(provider);
	}
}

export function isProviderSyncing(provider: string): boolean {
	return inflight.has(provider);
}

export function parseModelSyncStatus(
	json: string | null | undefined,
): ModelSyncStatus | null {
	if (!json) return null;
	try {
		const parsed = JSON.parse(json) as ModelSyncStatus;
		return parsed && typeof parsed === "object" && typeof parsed.at === "string"
			? {
					...parsed,
					missing: parsed.missing ?? {},
					missingImages: parsed.missingImages ?? {},
				}
			: null;
	} catch {
		return null;
	}
}

export async function setProviderAutoSync(
	provider: string,
	enabled: boolean,
): Promise<void> {
	await withProviderLock(provider, async () => {
		await db
			.updateTable("provider_config")
			.set({ autoSyncModels: enabled ? 1 : 0 })
			.where("provider", "=", provider)
			.execute();
	});
}

export async function listAutoSyncProviders(): Promise<string[]> {
	const rows = await db
		.selectFrom("provider_config")
		.select("provider")
		.where("autoSyncModels", "=", 1)
		.orderBy("provider")
		.execute();
	return rows.map((row) => row.provider);
}

/**
 * Sync one provider's models with its gateway. Concurrent calls for the same
 * provider share one run.
 */
export function syncProviderModels(
	provider: string,
	options: ModelSyncOptions,
): Promise<ModelSyncOutcome> {
	if (options.airgapMode ?? config.airgapMode)
		return Promise.resolve({
			provider,
			status: null,
			skipped: "Model sync is off in airgap mode.",
		});
	const running = inflight.get(provider);
	if (running) return running;
	const run = runSync(provider, options).finally(() =>
		inflight.delete(provider),
	);
	inflight.set(provider, run);
	return run;
}

interface EndpointGroup {
	kind: "chat" | "image";
	label: string;
	endpoints: ProviderEndpoint[];
}

/** Endpoints that read the same `/models` URL share one fetch and one merge. */
function groupEndpoints(endpoints: ProviderEndpoint[]): EndpointGroup[] {
	const groups = new Map<string, EndpointGroup>();
	for (const endpoint of endpoints) {
		if (!endpoint.baseUrl) continue;
		let href: string;
		try {
			href = modelsUrl(endpoint.baseUrl, endpoint.api).href;
		} catch {
			continue;
		}
		const kind = endpoint.api === "openrouter-images" ? "image" : "chat";
		const key = `${kind} ${href}`;
		const group = groups.get(key);
		if (group) {
			group.endpoints.push(endpoint);
			group.label = `${group.label}, ${endpoint.label}`;
		} else {
			groups.set(key, { kind, label: endpoint.label, endpoints: [endpoint] });
		}
	}
	return [...groups.values()];
}

async function readRow(provider: string) {
	return db
		.selectFrom("provider_config")
		.select(["endpoints", "modelSyncStatus"])
		.where("provider", "=", provider)
		.executeTakeFirst();
}

async function loadConfig(provider: string) {
	return (await loadProviderConfigs()).find(
		(candidate) => candidate.provider === provider,
	);
}

async function runSync(
	provider: string,
	options: ModelSyncOptions,
): Promise<ModelSyncOutcome> {
	const before = await loadConfig(provider);
	const beforeRow = await readRow(provider);
	if (!before || !beforeRow)
		throw new Error(`Provider "${provider}" not found`);
	const groups = groupEndpoints(before.endpoints);
	const fetched: {
		group: EndpointGroup;
		models?: DiscoveredModel[];
		error?: string;
	}[] = [];
	for (const group of groups) {
		try {
			const models = await fetchEndpointModels(before, group.endpoints[0]!, {
				fetchImpl: options.fetchImpl,
				signal: AbortSignal.timeout(options.timeoutMs ?? FETCH_TIMEOUT_MS),
			});
			fetched.push({ group, models });
		} catch (error) {
			fetched.push({
				group,
				error: `${group.label}: ${error instanceof Error ? error.message : String(error)}`,
			});
		}
	}

	return withProviderLock(provider, async () => {
		const fresh = await loadConfig(provider);
		const freshRow = await readRow(provider);
		if (!fresh || !freshRow)
			throw new Error(`Provider "${provider}" was deleted`);
		const previous = parseModelSyncStatus(freshRow.modelSyncStatus);
		const at = new Date().toISOString();
		const status: ModelSyncStatus = {
			at,
			trigger: options.trigger,
			ok: true,
			added: [],
			removed: [],
			updated: [],
			moved: [],
			skipped: [],
			errors: [],
			missing: {},
			missingImages: {},
		};

		let chatModels = fresh.enabledModels;
		let imageModels = fresh.imageModels;
		let changed = false;
		if (freshRow.endpoints !== beforeRow.endpoints) {
			status.errors.push(
				"The provider's endpoints changed during the sync, so nothing was changed. Sync again.",
			);
		} else {
			const imageCatalogIds = new Set(
				listImageCatalogModels().map((model) => model.id),
			);
			for (const { group, models, error } of fetched) {
				const isImage = group.kind === "image";
				const previousMisses =
					(isImage ? previous?.missingImages : previous?.missing) ?? {};
				const missing = isImage ? status.missingImages : status.missing;
				const scope = new Set(group.endpoints.map((endpoint) => endpoint.id));
				if (error || !models) {
					status.errors.push(error ?? `${group.label}: no reply`);
					// Unknown this time: carry the earlier miss counts forward.
					for (const model of isImage ? imageModels : chatModels) {
						const count = previousMisses[model.id];
						if (scope.has(model.endpointId) && count) missing[model.id] = count;
					}
					continue;
				}
				const result = mergeDiscoveredModels({
					kind: group.kind,
					current: isImage ? imageModels : chatModels,
					discovered: models,
					scopeEndpoints: group.endpoints,
					complete: true,
					advertisesPiRouting: models.some(
						(model) => model.piProvider !== undefined,
					),
					misses: previousMisses,
					immediate: options.trigger !== "timer",
					imageCatalogIds,
				});
				if (result.error) status.errors.push(`${group.label}: ${result.error}`);
				Object.assign(missing, result.missing);
				if (!result.changed) continue;
				changed = true;
				if (isImage) imageModels = result.next;
				else chatModels = result.next;
				status.added.push(...result.summary.added);
				status.removed.push(...result.summary.removed);
				status.updated.push(...result.summary.updated);
				status.moved.push(...result.summary.moved);
				status.skipped.push(...result.summary.skipped);
			}
		}
		status.ok = status.errors.length === 0;
		for (const key of ["added", "removed", "skipped"] as const)
			status[key] = status[key].slice(0, LIST_CAP);
		status.updated = status.updated.slice(0, LIST_CAP);
		status.moved = status.moved.slice(0, LIST_CAP);

		await db
			.updateTable("provider_config")
			.set({
				modelSyncStatus: JSON.stringify(status),
				...(changed
					? {
							enabledModels: JSON.stringify(chatModels),
							imageModels: JSON.stringify(imageModels),
							updatedAt: at,
						}
					: {}),
			})
			.where("provider", "=", provider)
			.execute();
		if (changed) await (options.onModelsChanged ?? regeneratePiModels)();
		logger
			.withMetadata({
				provider,
				trigger: options.trigger,
				ok: status.ok,
				added: status.added.length,
				removed: status.removed.length,
				updated: status.updated.length,
				errors: status.errors,
			})
			.info("provider models synced");
		return { provider, status };
	});
}

async function regeneratePiModels() {
	const { syncPiModelConfig } = await import("../pi/models");
	await syncPiModelConfig(config.port);
}

/** Sync every auto-sync provider in turn; one failure never stops the rest. */
export async function syncAutoSyncProviders(): Promise<void> {
	for (const provider of await listAutoSyncProviders()) {
		try {
			await syncProviderModels(provider, { trigger: "timer" });
		} catch (error) {
			logger
				.withError(error)
				.withMetadata({ provider })
				.warn("provider model sync failed");
		}
	}
}

/**
 * Runs `run` once after `initialDelayMs`, then every `intervalMs`, never two
 * at a time. Timers are unref'd so they never keep the process alive.
 */
export function startModelSyncScheduler(options: {
	intervalMs: number;
	initialDelayMs?: number;
	run?: () => Promise<void>;
}): { stop(): void } {
	const run = options.run ?? syncAutoSyncProviders;
	let running = false;
	let stopped = false;
	const tick = async () => {
		if (running || stopped) return;
		running = true;
		try {
			await run();
		} catch (error) {
			logger.withError(error).warn("model sync run failed");
		} finally {
			running = false;
		}
	};
	const first = setTimeout(() => void tick(), options.initialDelayMs ?? 10_000);
	const every = setInterval(() => void tick(), options.intervalMs);
	first.unref?.();
	every.unref?.();
	return {
		stop() {
			stopped = true;
			clearTimeout(first);
			clearInterval(every);
		},
	};
}
