import { describe, expect, test } from "bun:test";
import type { AllowlistEntry } from "./allowlist";
import {
	type DiscoveredForSync,
	mergeDiscoveredModels,
	type MergeInput,
} from "./modelSyncMerge";

const completions = {
	id: "ep-chat",
	label: "Chat",
	baseUrl: "https://gw.example/v1",
	api: "openai-completions",
};
const responses = {
	id: "ep-resp",
	label: "Responses",
	baseUrl: "https://gw.example/v1",
	api: "openai-responses",
};
const images = {
	id: "ep-img",
	label: "Images",
	baseUrl: "https://img.example/v1",
	api: "openrouter-images",
};

function found(
	id: string,
	extra: Partial<DiscoveredForSync> = {},
): DiscoveredForSync {
	return {
		id,
		name: id.toUpperCase(),
		preferredApi: "openai-completions",
		supportedApis: ["openai-completions"],
		reasoning: false,
		vision: false,
		...extra,
	};
}

function entry(
	id: string,
	extra: Partial<AllowlistEntry> = {},
): AllowlistEntry {
	return {
		id,
		endpointId: "ep-chat",
		api: "openai-completions",
		visibility: "public",
		...extra,
	};
}

function merge(overrides: Partial<MergeInput>) {
	return mergeDiscoveredModels({
		kind: "chat",
		current: [],
		discovered: [],
		scopeEndpoints: [completions, responses],
		complete: true,
		advertisesPiRouting: false,
		misses: {},
		immediate: true,
		...overrides,
	});
}

describe("mergeDiscoveredModels: new models", () => {
	test("adds new gateway models as private, sorted, after existing ones", () => {
		const result = merge({
			current: [entry("m-old")],
			discovered: [
				found("m-old"),
				found("z-new"),
				found("a-new", { vision: true }),
			],
		});
		expect(result.next.map((model) => model.id)).toEqual([
			"m-old",
			"a-new",
			"z-new",
		]);
		expect(result.next[1]).toMatchObject({
			visibility: "private",
			name: "A-NEW",
			vision: true,
			reasoning: false,
			endpointId: "ep-chat",
			api: "openai-completions",
		});
		expect(result.summary.added).toEqual(["a-new", "z-new"]);
		expect(result.changed).toBe(true);
	});

	test("a new model uses the gateway's preferred API when an endpoint offers it", () => {
		const result = merge({
			discovered: [
				found("resp-only", {
					preferredApi: "openai-responses",
					supportedApis: ["openai-responses", "openai-completions"],
				}),
			],
		});
		expect(result.next[0]).toMatchObject({
			endpointId: "ep-resp",
			api: "openai-responses",
		});
	});

	test("falls back to a supported API, then to the first scope endpoint", () => {
		const supported = merge({
			scopeEndpoints: [completions, responses],
			discovered: [
				found("x", {
					preferredApi: "anthropic-messages",
					supportedApis: ["anthropic-messages", "openai-responses"],
				}),
			],
		});
		expect(supported.next[0]?.api).toBe("openai-responses");
		const none = merge({
			scopeEndpoints: [completions],
			discovered: [found("y", { preferredApi: null, supportedApis: [] })],
		});
		expect(none.next[0]?.api).toBe("openai-completions");
	});

	test("new models carry service tiers and pi routing from the gateway", () => {
		const result = merge({
			advertisesPiRouting: true,
			discovered: [
				found("t", {
					serviceTiers: ["flex", "priority"],
					piProvider: "openai",
					piModel: "gpt-x",
					piOptions: { a: 1 },
					reasoning: true,
				}),
			],
		});
		expect(result.next[0]).toMatchObject({
			serviceTiers: ["flex", "priority"],
			piProvider: "openai",
			piModel: "gpt-x",
			piOptions: { a: 1 },
			reasoning: true,
		});
	});

	test("an id already configured on another endpoint is not added twice", () => {
		const result = merge({
			scopeEndpoints: [completions],
			current: [
				entry("dup", { endpointId: "elsewhere", api: "openai-responses" }),
			],
			discovered: [found("dup")],
		});
		expect(result.next).toHaveLength(1);
		expect(result.summary.added).toEqual([]);
	});
});

describe("mergeDiscoveredModels: existing models", () => {
	const adminSet: AllowlistEntry = entry("keep", {
		visibility: "private",
		name: "My name",
		contextWindow: 123_000,
		maxTokens: 9_000,
		documents: true,
		reasoningEffort: "high",
		contextPolicy: {
			enabled: true,
			softTriggerTokens: 1,
			targetTokens: 2,
			hardInputTokens: 3,
			maxPinnedAttachmentTokens: 4,
			outputReserveTokens: 5,
		},
		reasoning: false,
		vision: false,
	});

	test("refreshes gateway facts and never touches admin-set fields", () => {
		const result = merge({
			current: [adminSet],
			discovered: [
				found("keep", { name: "Gateway name", reasoning: true, vision: true }),
			],
		});
		const next = result.next[0]!;
		expect(next).toMatchObject({
			visibility: "private",
			name: "My name",
			contextWindow: 123_000,
			maxTokens: 9_000,
			documents: true,
			reasoningEffort: "high",
			reasoning: true,
			vision: true,
		});
		expect(next.contextPolicy).toEqual(adminSet.contextPolicy!);
		expect(result.summary.updated).toEqual([
			{ id: "keep", fields: ["reasoning", "vision"] },
		]);
	});

	test("an unknown capability is never turned into an explicit false", () => {
		const result = merge({
			current: [entry("bare")],
			discovered: [found("bare", { reasoning: false, vision: true })],
		});
		expect(result.next[0]).not.toHaveProperty("reasoning");
		expect(result.next[0]?.vision).toBe(true);
		expect(result.summary.updated).toEqual([
			{ id: "bare", fields: ["vision"] },
		]);
	});

	test("service tiers follow the gateway; a chosen tier survives only while offered", () => {
		const offered = merge({
			current: [entry("t", { serviceTiers: ["flex"], serviceTier: "flex" })],
			discovered: [found("t", { serviceTiers: ["flex", "priority"] })],
		});
		expect(offered.next[0]).toMatchObject({
			serviceTiers: ["flex", "priority"],
			serviceTier: "flex",
		});
		const dropped = merge({
			current: [entry("t", { serviceTiers: ["flex"], serviceTier: "flex" })],
			discovered: [found("t", { serviceTiers: ["priority"] })],
		});
		expect(dropped.next[0]?.serviceTier).toBeUndefined();
		const none = merge({
			current: [entry("t", { serviceTiers: ["flex"], serviceTier: "flex" })],
			discovered: [found("t")],
		});
		expect(none.next[0]?.serviceTiers).toBeUndefined();
		expect(none.next[0]?.serviceTier).toBeUndefined();
	});

	test("pi routing is refreshed only when the gateway advertises it", () => {
		const current = [entry("p", { piProvider: "local", piModel: "local-x" })];
		const silent = merge({
			current,
			advertisesPiRouting: false,
			discovered: [found("p")],
		});
		expect(silent.next[0]).toMatchObject({
			piProvider: "local",
			piModel: "local-x",
		});
		const advertised = merge({
			current,
			advertisesPiRouting: true,
			discovered: [found("p", { piProvider: "anthropic" })],
		});
		expect(advertised.next[0]?.piProvider).toBe("anthropic");
		expect(advertised.next[0]?.piModel).toBeUndefined();
	});

	test("moves a model only when its API is no longer supported", () => {
		const stays = merge({
			current: [entry("m", { endpointId: "ep-resp", api: "openai-responses" })],
			discovered: [
				found("m", {
					preferredApi: "openai-completions",
					supportedApis: ["openai-completions", "openai-responses"],
				}),
			],
		});
		expect(stays.next[0]?.api).toBe("openai-responses");
		expect(stays.summary.moved).toEqual([]);
		const moves = merge({
			current: [entry("m", { endpointId: "ep-resp", api: "openai-responses" })],
			discovered: [
				found("m", {
					preferredApi: "openai-completions",
					supportedApis: ["openai-completions"],
				}),
			],
		});
		expect(moves.next[0]).toMatchObject({
			endpointId: "ep-chat",
			api: "openai-completions",
		});
		expect(moves.summary.moved).toEqual([
			{ id: "m", from: "openai-responses", to: "openai-completions" },
		]);
	});

	test("models on endpoints outside the scope pass through untouched", () => {
		const outside = entry("other", {
			endpointId: "ep-other",
			api: "anthropic-messages",
		});
		const result = merge({
			current: [outside, entry("in")],
			discovered: [found("in")],
		});
		expect(result.next[0]).toEqual(outside);
		expect(result.summary.removed).toEqual([]);
	});
});

describe("mergeDiscoveredModels: missing models", () => {
	const current = [entry("a"), entry("b"), entry("gone")];
	const discovered = [found("a"), found("b")];

	test("the Sync button removes a missing model at once", () => {
		const result = merge({ current, discovered, immediate: true });
		expect(result.next.map((model) => model.id)).toEqual(["a", "b"]);
		expect(result.summary.removed).toEqual(["gone"]);
		expect(result.missing).toEqual({});
	});

	test("the timer removes a model only on its second miss in a row", () => {
		const first = merge({ current, discovered, immediate: false });
		expect(first.next.map((model) => model.id)).toEqual(["a", "b", "gone"]);
		expect(first.missing).toEqual({ gone: 1 });
		expect(first.summary.removed).toEqual([]);
		const second = merge({
			current: first.next,
			discovered,
			immediate: false,
			misses: first.missing,
		});
		expect(second.summary.removed).toEqual(["gone"]);
		expect(second.missing).toEqual({});
	});

	test("a model that comes back resets its miss count", () => {
		const result = merge({
			current,
			discovered: [...discovered, found("gone")],
			immediate: false,
			misses: { gone: 1 },
		});
		expect(result.missing).toEqual({});
		expect(result.next).toHaveLength(3);
	});

	test("nothing is removed when the scope was not fetched completely", () => {
		const result = merge({ current, discovered, complete: false });
		expect(result.next).toHaveLength(3);
		expect(result.summary.removed).toEqual([]);
		expect(result.missing).toEqual({ gone: 1 });
	});
});

describe("mergeDiscoveredModels: guards", () => {
	test("an empty gateway list changes nothing", () => {
		const current = [entry("a")];
		const result = merge({ current, discovered: [] });
		expect(result.next).toEqual(current);
		expect(result.changed).toBe(false);
		expect(result.error).toContain("no models");
	});

	test("a reply that would remove every configured model changes nothing", () => {
		const current = [entry("a"), entry("b")];
		const result = merge({ current, discovered: [found("x")] });
		expect(result.next).toEqual(current);
		expect(result.changed).toBe(false);
		expect(result.error).toContain("every configured model");
		expect(result.missing).toEqual({});
	});

	test("merging the same reply twice changes nothing the second time", () => {
		const discovered = [
			found("a", { serviceTiers: ["flex"], reasoning: true }),
			found("b", { vision: true }),
		];
		const once = merge({ current: [entry("a"), entry("old")], discovered });
		const twice = merge({ current: once.next, discovered });
		expect(twice.changed).toBe(false);
		expect(twice.next).toEqual(once.next);
		expect(twice.summary).toEqual({
			added: [],
			removed: [],
			updated: [],
			moved: [],
			skipped: [],
		});
	});
});

describe("mergeDiscoveredModels: image endpoints", () => {
	const imageEntry: AllowlistEntry = {
		id: "img-a",
		endpointId: "ep-img",
		api: "openrouter-images",
		visibility: "public",
		piModel: "catalog-a",
		image: { input: false, aspectRatios: ["1:1"], resolutions: ["1K"] },
	};

	test("refreshes only image input and keeps the admin's mapping and options", () => {
		const result = merge({
			kind: "image",
			scopeEndpoints: [images],
			current: [imageEntry],
			discovered: [
				found("img-a", {
					image: { input: true, aspectRatios: [], resolutions: [] },
				}),
			],
			imageCatalogIds: new Set(),
		});
		expect(result.next[0]).toEqual({
			...imageEntry,
			image: { input: true, aspectRatios: ["1:1"], resolutions: ["1K"] },
		});
	});

	test("adds only image models that are in the image catalog", () => {
		const result = merge({
			kind: "image",
			scopeEndpoints: [images],
			current: [imageEntry],
			discovered: [
				found("img-a"),
				found("known", {
					image: { input: true, aspectRatios: ["1:1"], resolutions: ["1K"] },
				}),
				found("unknown"),
			],
			imageCatalogIds: new Set(["known"]),
		});
		expect(result.next.map((model) => model.id)).toEqual(["img-a", "known"]);
		expect(result.next[1]).toMatchObject({
			visibility: "private",
			piModel: "known",
			api: "openrouter-images",
			endpointId: "ep-img",
		});
		expect(result.summary.skipped).toEqual(["unknown"]);
	});
});
