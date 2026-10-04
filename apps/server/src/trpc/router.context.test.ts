import { afterEach, describe, expect, mock, test } from "bun:test";
import { createTestDatabase } from "../conversations/fixtures";

const USER_ID = "context-user";
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
			debug: () => {},
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
	isPiSessionReady: (conversationId: string) => conversationId === "pi-backed",
	piSessionFile: () => null,
}));
mock.module("../chat/catalog", () => ({
	MOCK: true,
	PROVIDER_APIS: ["openai-responses"],
	ALL_PROVIDER_APIS: ["openai-responses", "openrouter-images"],
	parseAllowlist: () => [],
	parseImageAllowlist: () => [],
	listAvailableModels: async () => [],
	listAvailableImageModels: async () => [],
	listImageCatalogModels: () => [],
	resolveImageModel: async () => {
		throw new Error("resolveImageModel should not be called in this test");
	},
	resolveSelection: async () => ({
		provider: "mock",
		endpointId: "mock",
		modelId: "mock",
		api: "mock",
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
	getUserDefaultPreset: async () => null,
	setUserDefaultPreset: async () => {},
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
const { DEFAULT_CONTEXT_GLOBAL_SETTINGS, parseContextGlobalSettings } =
	await import("../context/settings");

describe("context management metadata", () => {
	afterEach(async () => {
		await database.reset();
		database.seedUser(USER_ID);
	});

	test("uses built-in settings for absent, malformed, and unsupported metadata", () => {
		expect(parseContextGlobalSettings(null)).toEqual(
			DEFAULT_CONTEXT_GLOBAL_SETTINGS,
		);
		expect(parseContextGlobalSettings("not json")).toEqual(
			DEFAULT_CONTEXT_GLOBAL_SETTINGS,
		);
		expect(parseContextGlobalSettings(JSON.stringify({ version: 2 }))).toEqual(
			DEFAULT_CONTEXT_GLOBAL_SETTINGS,
		);
	});

	test("accepts a complete versioned policy with a prompt override", () => {
		const settings = {
			...DEFAULT_CONTEXT_GLOBAL_SETTINGS,
			enabled: false,
			summaryPromptOverride: "Keep decisions and open questions.",
		};

		expect(parseContextGlobalSettings(JSON.stringify(settings))).toEqual(
			settings,
		);
	});

	test("rejects an empty prompt override", () => {
		const settings = {
			...DEFAULT_CONTEXT_GLOBAL_SETTINGS,
			summaryPromptOverride: "",
		};

		expect(parseContextGlobalSettings(JSON.stringify(settings))).toEqual(
			DEFAULT_CONTEXT_GLOBAL_SETTINGS,
		);
	});

	test("keeps pi-backed conversations when creating a new chat", async () => {
		await conversationRepository.createConversation(USER_ID, {
			id: "pi-backed",
			title: "Persisted chat",
		});
		await conversationRepository.createConversation(USER_ID, {
			id: "empty-draft",
			title: "Empty draft",
		});
		const caller = appRouter.createCaller({ user: { id: USER_ID } } as never);

		await caller.conversation.create({});

		expect((await caller.conversation.list()).map((row) => row.id)).toContain(
			"pi-backed",
		);
		await expect(
			conversationRepository.getConversation(USER_ID, "empty-draft"),
		).rejects.toThrow();
	});

	test("returns idle context status for a conversation with no pi session", async () => {
		const conversation = await conversationRepository.createConversation(
			USER_ID,
			{
				title: "Chat",
			},
		);
		const caller = appRouter.createCaller({ user: { id: USER_ID } } as never);

		await expect(
			caller.conversation.contextState({ conversationId: conversation.id }),
		).resolves.toEqual({
			state: "idle",
			estimatedTokens: null,
			summarized: false,
			jobError: null,
			summaryEvent: null,
		});
	});

	test("rejects context status for a conversation the user does not own", async () => {
		const conversation = await conversationRepository.createConversation(
			USER_ID,
			{
				title: "Chat",
			},
		);
		const caller = appRouter.createCaller({
			user: { id: "someone-else" },
		} as never);

		await expect(
			caller.conversation.contextState({ conversationId: conversation.id }),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
	});

	test("rejects compact for a conversation the user does not own", async () => {
		const conversation = await conversationRepository.createConversation(
			USER_ID,
			{
				title: "Chat",
			},
		);
		const caller = appRouter.createCaller({
			user: { id: "someone-else" },
		} as never);

		await expect(
			caller.conversation.compact({ conversationId: conversation.id }),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
	});
});
