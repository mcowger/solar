import { describe, expect, mock, test } from "bun:test";

let ownedConversation = true;
const contextState = {
	conversationId: "conversation",
	revision: 1,
	summary: "private summary",
	summaryRevision: 1,
	retainedMessageBoundaryId: "message",
	jobStatus: "failed",
	jobId: null,
	jobAttempt: 1,
	jobError: "Task model unavailable",
	jobUpdatedAt: null,
	createdAt: "2026-01-01T00:00:00.000Z",
	updatedAt: "2026-01-01T00:00:00.000Z",
};

function query(result: unknown) {
	const builder = {
		select: () => builder,
		selectAll: () => builder,
		where: () => builder,
		orderBy: () => builder,
		executeTakeFirst: async () => result,
	};
	return builder;
}

mock.module("../db", () => ({
	db: {
		selectFrom: (table: string) =>
			query(
				table === "conversation"
					? ownedConversation
						? { id: "conversation" }
						: undefined
					: table === "conversation_context_state"
						? contextState
						: {
								compactionTokensBefore: 1234,
								compactionTokensAfter: 321,
								createdAt: "2026-01-01T00:01:00.000Z",
							},
			),
	},
	sqlite: {},
}));
mock.module("../chat/attachments", () => ({
	deleteAttachmentFilesForMessages: async () => {},
	deleteAttachmentFilesForUser: async () => {},
}));

const { appRouter, contextPolicySchema } = await import("./router");
const { DEFAULT_CONTEXT_GLOBAL_SETTINGS, parseContextGlobalSettings } =
	await import("../context/settings");

describe("context management metadata", () => {
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

	test("requires ordered policy limits and selectors matching their scope", () => {
		const policy = {
			scope: "model_family" as const,
			provider: "openai",
			modelFamily: "gpt-5.6",
			modelId: null,
			enabled: true,
			softTriggerTokens: 272_000,
			targetTokens: 180_000,
			hardInputTokens: 600_000,
			maxPinnedAttachmentTokens: 64_000,
			outputReserveTokens: 32_000,
		};

		expect(contextPolicySchema.safeParse(policy).success).toBe(true);
		expect(
			contextPolicySchema.safeParse({
				...policy,
				scope: "exact_model",
				modelId: null,
			}).success,
		).toBe(false);
		expect(
			contextPolicySchema.safeParse({ ...policy, targetTokens: 300_000 })
				.success,
		).toBe(false);
	});

	test("returns owner-visible context status without summary content", async () => {
		const caller = appRouter.createCaller({ user: { id: "user" } } as never);

		await expect(
			caller.conversation.contextState({ conversationId: "conversation" }),
		).resolves.toEqual({
			state: "failed",
			estimatedTokens: 1234,
			summarized: true,
			jobError: "Task model unavailable",
			summaryEvent: {
				tokensBefore: 1234,
				tokensAfter: 321,
				revision: 1,
				createdAt: "2026-01-01T00:01:00.000Z",
				retainedMessageBoundaryId: "message",
			},
		});
	});

	test("rejects context status for a conversation the user does not own", async () => {
		ownedConversation = false;
		const caller = appRouter.createCaller({ user: { id: "user" } } as never);

		await expect(
			caller.conversation.contextState({ conversationId: "conversation" }),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
		ownedConversation = true;
	});
});
