import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { createTestDatabase } from "../conversations/fixtures";

const USER_ID = "create-user";
const database = await createTestDatabase();
database.seedUser(USER_ID);

mock.module("../db", () => ({ db: database.db, sqlite: database.sqlite }));
mock.module("../auth", () => ({
	createSolarApiKey: async () => ({ id: "key", key: "sk_solar_test" }),
	createSolarUser: async () => {},
	setSolarUserPassword: async () => true,
}));
mock.module("../chat/attachments", () => ({
	deleteAttachmentFilesForMessages: async () => {},
	deleteAttachmentFilesForUser: async () => {},
	deleteAttachmentFilesByStorageKey: async () => {},
	expandAttachmentRows: async () => ({ parts: [], documents: [] }),
}));
mock.module("../logger", () => ({
	logger: {
		withMetadata: () => ({
			trace: () => {},
			info: () => {},
			warn: () => {},
			error: () => {},
		}),
		withError: () => ({
			withMetadata: () => ({ warn: () => {}, error: () => {} }),
		}),
	},
	getLogLevel: () => "info",
	setLogLevel: () => {},
}));
mock.module("../pi/sessions", () => ({
	attachmentMarker: (ids: string[]) =>
		`<solar-attachments ids="${ids.join(",")}"/>`,
	isPiSessionReady: () => false,
	piSessionFile: () => null,
}));

const AVAILABLE_MODEL = {
	provider: "plexus",
	endpointId: "chat",
	modelId: "claude-opus-5.5",
	api: "anthropic-messages",
	name: "Claude Opus 5.5",
	reasoning: true,
	vision: true,
	documents: true,
};

/** The user's stored default preset, as `getUserDefaultPreset` would report. */
let defaultPresetId: string | null = null;

mock.module("../chat/catalog", () => ({
	MOCK: true,
	PROVIDER_APIS: ["anthropic-messages"],
	ALL_PROVIDER_APIS: ["anthropic-messages"],
	parseAllowlist: () => [],
	parseImageAllowlist: () => [],
	listAvailableModels: async () => [AVAILABLE_MODEL],
	listAvailableImageModels: async () => [],
	listImageCatalogModels: () => [],
	fetchEndpointModels: async () => [],
	modelsUrl: (baseUrl: string) => new URL(`${baseUrl}/models`),
	resolveImageModel: async () => {
		throw new Error("resolveImageModel should not be called in this test");
	},
	resolveSelection: async () => ({
		provider: AVAILABLE_MODEL.provider,
		endpointId: AVAILABLE_MODEL.endpointId,
		modelId: AVAILABLE_MODEL.modelId,
		api: AVAILABLE_MODEL.api,
	}),
	mockForcedSelection: (selection: unknown) => selection,
	resolveModel: async () => {
		throw new Error("resolveModel should not be called in this test");
	},
	streamModel: () => {
		throw new Error("streamModel should not be called in this test");
	},
	resolveTaskModelOrFallback: async (selection: unknown) => selection,
	getModelCapabilities: async () => ({
		reasoningLevels: [],
		serviceTiers: [],
		defaultReasoningEffort: null,
		defaultServiceTier: null,
	}),
	documentInputMimeTypes: async () => [],
	documentInputCapabilities: async () => ({
		nativeMimeTypes: [],
		extractedTextMimeTypes: [],
	}),
	getUserDefault: async () => null,
	setUserDefault: async () => {},
	getUserDefaultPreset: async () => defaultPresetId,
	setUserDefaultPreset: async (userId: string, id: string | null) => {
		defaultPresetId = id;
	},
	getUserDefaultDisplayMode: async () => "compact",
	setUserDefaultDisplayMode: async () => {},
	getAdminDefault: async () => null,
	setAdminDefault: async () => {},
	getTaskModel: async () => null,
	setTaskModel: async () => {},
	getTitlePrompt: async () => "",
	setTitlePrompt: async () => {},
	importProviderModels: async () => {},
	loadProviderConfigs: async () => [],
	normalizeBaseUrlForApi: () => "",
}));

const { appRouter } = await import("./router");
const { conversationRepository } = await import("../conversations/repository");

await database.db.schema
	.createTable("preset")
	.addColumn("id", "text", (column) => column.primaryKey())
	.addColumn("userId", "text", (column) => column.notNull())
	.addColumn("name", "text", (column) => column.notNull())
	.addColumn("scope", "text", (column) =>
		column.notNull().defaultTo("personal"),
	)
	.addColumn("provider", "text", (column) => column.notNull())
	.addColumn("endpointId", "text")
	.addColumn("modelId", "text", (column) => column.notNull())
	.addColumn("modelApi", "text", (column) => column.notNull())
	.addColumn("systemPrompt", "text")
	.addColumn("reasoningEffort", "text")
	.addColumn("reasoningSummary", "integer", (column) =>
		column.notNull().defaultTo(0),
	)
	.execute();

function caller() {
	return appRouter.createCaller({
		user: { id: USER_ID, role: "user" },
	} as never);
}

async function seedPreset(id: string, modelId: string, scope = "shared") {
	await database.db
		.insertInto("preset")
		.values({
			id,
			userId: USER_ID,
			name: "Legal",
			scope,
			provider: "plexus",
			endpointId: "chat",
			modelId,
			modelApi: "anthropic-messages",
			systemPrompt: "You are a lawyer.",
			reasoningEffort: "high",
			reasoningSummary: 0,
		})
		.execute();
}

describe("conversation.create preset fallback", () => {
	beforeEach(async () => {
		await database.db.deleteFrom("preset").execute();
		defaultPresetId = null;
	});
	afterEach(async () => {
		await database.reset();
		database.seedUser(USER_ID);
	});

	test("creates the chat without the preset when the default preset's model is gone", async () => {
		await seedPreset("stale-preset", "claude-opus-4-8");
		defaultPresetId = "stale-preset";
		const { id, skippedPreset } = await caller().conversation.create({});
		const conversation = await conversationRepository.getConversation(
			USER_ID,
			id,
		);
		// The preset's snapshot is skipped, so the chat uses the plain default,
		// and the client is told which preset it lost.
		expect(conversation.modelId).toBeNull();
		expect(conversation.systemPrompt).toBeNull();
		expect(skippedPreset).toEqual({ id: "stale-preset", name: "Legal" });
	});

	test("still rejects a preset the user picked explicitly when its model is gone", async () => {
		await seedPreset("stale-preset", "claude-opus-4-8");
		await expect(
			caller().conversation.create({ presetId: "stale-preset" }),
		).rejects.toThrow(/no longer available/);
	});

	test("snapshots the preset when its model is still available", async () => {
		await seedPreset("good-preset", "claude-opus-5.5");
		defaultPresetId = "good-preset";
		const { id, skippedPreset } = await caller().conversation.create({});
		const conversation = await conversationRepository.getConversation(
			USER_ID,
			id,
		);
		expect(conversation.modelId).toBe("claude-opus-5.5");
		expect(conversation.systemPrompt).toBe("You are a lawyer.");
		expect(skippedPreset).toBeNull();
	});
});

describe("preset.list", () => {
	beforeEach(async () => {
		await database.db.deleteFrom("preset").execute();
	});
	afterEach(async () => {
		await database.reset();
		database.seedUser(USER_ID);
	});

	test("lists presets whose model is gone instead of hiding them", async () => {
		await seedPreset("good-preset", "claude-opus-5.5");
		await seedPreset("stale-preset", "claude-opus-4-8");
		const presets = await caller().preset.list();
		const byId = new Map(presets.map((preset) => [preset.id, preset]));
		expect(byId.get("good-preset")?.modelAvailable).toBe(true);
		expect(byId.get("stale-preset")?.modelAvailable).toBe(false);
	});
});
