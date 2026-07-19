import { describe, expect, test } from "bun:test";
import { assembleContext } from "./assembler";
import { buildRollingSummaryPrompt } from "./compaction";
import { ContextCompactionError, ContextRuntime } from "./runtime";
import type { ContextRecord } from "./tokens";

const selection = {
	provider: "mock",
	modelId: "mock",
	endpointId: "mock",
	api: "mock",
} as never;

function runtimeFixture(
	records: ContextRecord[],
	options: {
		fail?: boolean;
		running?: boolean;
		observedTokens?: number | null;
		summaryResult?: string | { summary: string; message: any };
	} = {},
) {
	const providerCalls: unknown[] = [];
	const prompts: string[] = [];
	let state: {
		conversationId: string;
		revision: number;
		summary: string | null;
		summaryRevision: number | null;
		retainedMessageBoundaryId: string | null;
		jobStatus: string;
		jobId: string | null;
		jobAttempt: number;
		jobError: string | null;
		jobUpdatedAt: string | null;
	} = {
		conversationId: "conversation",
		revision: 0,
		summary: null as string | null,
		summaryRevision: null,
		retainedMessageBoundaryId: null as string | null,
		jobStatus: options.running ? "running" : "idle",
		jobId: null,
		jobAttempt: 0,
		jobError: null as string | null,
		jobUpdatedAt: null,
	};
	const repository = {
		ensureState: async () => ({ ...state }),
		conversationModel: async () => ({ provider: "mock", modelId: "mock" }),
		globalSettings: async () => ({
			enabled: true,
			summaryPromptOverride: "ADMIN SUMMARY",
		}),
		contextRecords: async () => records,
		latestProviderContextTokens: async () => options.observedTokens ?? null,
		resolvePolicy: async () => ({
			enabled: true,
			softTriggerTokens: 1,
			targetTokens: 1,
			hardInputTokens: 2,
			maxPinnedAttachmentTokens: 1,
			outputReserveTokens: 0,
			source: "derived" as const,
		}),
		startJob: async () => {
			if (state.jobStatus === "running") return false;
			state = { ...state, jobStatus: "running", jobId: "job" };
			return true;
		},
		failJob: async (
			_conversation: string,
			_revision: number,
			_job: string,
			error: string,
		) => {
			state = { ...state, jobStatus: "failed", jobError: error };
			return true;
		},
		activateSummary: async (input: {
			summary: string;
			retainedMessageBoundaryId: string | null;
		}) => {
			state = {
				...state,
				summary: input.summary,
				retainedMessageBoundaryId: input.retainedMessageBoundaryId,
				jobStatus: "idle",
				jobId: null,
			};
			return true;
		},
		recordProviderCall: async (call: unknown) => {
			providerCalls.push(call);
		},
	};
	return {
		runtime: new ContextRuntime(repository as never, async (prompt) => {
			prompts.push(prompt);
			if (options.fail) throw new Error("summary model unavailable");
			return options.summaryResult ?? "summary";
		}),
		state: () => state,
		providerCalls,
		prompts,
	};
}

describe("runtime context planning", () => {
	test("retains the first user message and complete recent turns around a summary boundary", () => {
		const records = [
			{
				id: "u1",
				role: "user" as const,
				content: [{ kind: "text" as const, text: "first" }],
				status: "complete" as const,
			},
			{
				id: "a1",
				role: "assistant" as const,
				content: [{ kind: "text" as const, text: "old reply" }],
				status: "complete" as const,
			},
			{
				id: "u2",
				role: "user" as const,
				content: [{ kind: "text" as const, text: "recent" }],
				status: "complete" as const,
			},
			{
				id: "a2",
				role: "assistant" as const,
				content: [{ kind: "text" as const, text: "recent reply" }],
				status: "complete" as const,
			},
		];
		const assembled = assembleContext(records, {
			inputLimit: 8,
			estimateTokens: (text) => text.split(/\s+/).length,
			summary: {
				id: "summary",
				role: "summary",
				content: [{ kind: "text", text: "old context" }],
			},
		});
		expect(assembled.records.map((record) => record.id)).toEqual([
			"u1",
			"summary",
			"u2",
			"a2",
		]);
		expect(assembled.omittedRecordIds).toEqual(["a1"]);
	});

	test("uses the versioned structured prompt contract", () => {
		expect(
			`solar-context-summary-v1\n${buildRollingSummaryPrompt(undefined, [])}`,
		).toContain("Return only the exact structured summary format");
	});

	test("fails a hard compaction once instead of recursively retrying", async () => {
		const { runtime, state } = runtimeFixture(
			[
				{
					id: "u1",
					role: "user",
					content: [{ kind: "text", text: "old material" }],
				},
				{
					id: "a1",
					role: "assistant",
					content: [{ kind: "text", text: "old response" }],
				},
				{
					id: "u2",
					role: "user",
					content: [{ kind: "text", text: "current material" }],
				},
			],
			{ fail: true },
		);
		await expect(runtime.assemble("conversation", selection)).rejects.toThrow(
			ContextCompactionError,
		);
		expect(state().jobStatus).toBe("failed");
		expect(state().jobError).toContain("summary model unavailable");
	});

	test("does not replace a running soft compaction job", async () => {
		const { runtime, state } = runtimeFixture(
			[
				{
					id: "u1",
					role: "user",
					content: [{ kind: "text", text: "old material" }],
				},
				{
					id: "a1",
					role: "assistant",
					content: [{ kind: "text", text: "old response" }],
				},
				{
					id: "u2",
					role: "user",
					content: [{ kind: "text", text: "current material" }],
				},
			],
			{ running: true },
		);
		await expect(runtime.assemble("conversation", selection)).rejects.toThrow(
			"no compactable records remain",
		);
		expect(state().jobStatus).toBe("running");
	});

	test("accounts for system instructions, attachments, native assistant parts, and steps", async () => {
		const { runtime } = runtimeFixture([
			{
				id: "system-prompt",
				role: "system",
				content: [{ kind: "text", text: "system rules" }],
			},
			{
				id: "u1",
				role: "user",
				content: [
					{ kind: "text", text: "first" },
					{ kind: "attachment", text: "file", tokenCount: 20 },
				],
			},
			{
				id: "a1:step:0",
				role: "tool",
				toolTransactionId: "a1",
				content: [{ kind: "toolResult", text: "tool transaction" }],
			},
			{
				id: "a1",
				role: "assistant",
				toolTransactionId: "a1",
				content: [
					{ kind: "text", text: "native assistant content and reasoning" },
				],
			},
			{ id: "u2", role: "user", content: [{ kind: "text", text: "current" }] },
		]);
		const result = await runtime.assemble(
			"conversation",
			selection,
			"system rules",
		);
		expect(result.tokens).toBeGreaterThan(20);
	});

	test("records task-model compaction telemetry with before and after tokens", async () => {
		const { runtime, providerCalls } = runtimeFixture([
			{
				id: "u1",
				role: "user",
				content: [{ kind: "text", text: "old material" }],
			},
			{
				id: "a1",
				role: "assistant",
				content: [{ kind: "text", text: "old response" }],
			},
			{
				id: "u2",
				role: "user",
				content: [{ kind: "text", text: "current material" }],
			},
		]);
		await runtime.assemble("conversation", selection);
		expect(providerCalls).toEqual([
			expect.objectContaining({
				purpose: "compaction",
				modelId: "mock",
				latencyMs: expect.any(Number),
				compactionTokensBefore: expect.any(Number),
				compactionTokensAfter: expect.any(Number),
			}),
		]);
	});

	test("compacts when cached provider context exceeds the hard limit", async () => {
		const { runtime, providerCalls, state } = runtimeFixture(
			[
				{
					id: "u1",
					role: "user",
					content: [{ kind: "text", text: "old material" }],
				},
				{
					id: "a1",
					role: "assistant",
					content: [{ kind: "text", text: "old response" }],
				},
				{
					id: "u2",
					role: "user",
					content: [{ kind: "text", text: "current material" }],
				},
			],
			{ observedTokens: 250 },
		);

		await runtime.assemble("conversation", selection);

		expect(providerCalls).toHaveLength(1);
		expect(state().summary).toBe("summary");
	});

	test("persists actual completed-message cache and cost telemetry for compaction", async () => {
		const { runtime, providerCalls } = runtimeFixture(
			[
				{
					id: "u1",
					role: "user",
					content: [{ kind: "text", text: "old material" }],
				},
				{
					id: "a1",
					role: "assistant",
					content: [{ kind: "text", text: "old response" }],
				},
				{
					id: "u2",
					role: "user",
					content: [{ kind: "text", text: "current material" }],
				},
			],
			{
				summaryResult: {
					summary: "summary",
					message: {
						api: "responses",
						provider: "mock",
						model: "summary-model",
						responseModel: "summary-response-model",
						content: [{ type: "text", text: "summary" }],
						usage: {
							input: 101,
							output: 37,
							cacheRead: 19,
							cacheWrite: 7,
							cost: {
								input: 0.1,
								output: 0.2,
								cacheRead: 0.03,
								cacheWrite: 0.04,
								total: 0.37,
							},
						},
						stopReason: "stop",
						timestamp: 1,
					},
				},
			},
		);

		await runtime.assemble("conversation", selection);

		expect(providerCalls).toEqual([
			expect.objectContaining({
				api: "responses",
				modelId: "summary-response-model",
				inputTokens: 101,
				outputTokens: 37,
				cacheReadTokens: 19,
				cacheWriteTokens: 7,
				estimatedCostMicros: 370_000,
				compactionTokensBefore: expect.any(Number),
				compactionTokensAfter: expect.any(Number),
				latencyMs: expect.any(Number),
			}),
		]);
	});

	test("stores the first raw tail message after compacted history as the boundary", async () => {
		const { runtime, state } = runtimeFixture([
			{
				id: "system-prompt",
				role: "system",
				content: [{ kind: "text", text: "rules" }],
			},
			{
				id: "u1",
				role: "user",
				content: [{ kind: "text", text: "first request" }],
			},
			{
				id: "a1",
				role: "assistant",
				content: [{ kind: "text", text: "old response" }],
			},
			{
				id: "u2",
				role: "user",
				content: [{ kind: "text", text: "current request" }],
			},
		]);

		await runtime.assemble("conversation", selection, "rules");

		expect(state().retainedMessageBoundaryId).toBe("u2");
	});

	test("compacts an oversized first attachment without dropping typed first-turn text", async () => {
		const { runtime, state, prompts } = runtimeFixture([
			{
				id: "u1",
				role: "user",
				content: [
					{ kind: "text", text: "typed request" },
					{
						id: "file-1",
						kind: "attachment",
						text: "notes.txt",
						tokenCount: 10,
						summary:
							'<attachment name="notes.txt">\nactual UTF-8 attachment text\n</attachment>',
					},
				],
			},
		]);
		const result = await runtime.assemble("conversation", selection);
		expect(prompts.join("\n")).toContain("actual UTF-8 attachment text");
		expect(result.allowedAttachmentIds.has("file-1")).toBe(false);
		expect(result.messageIds).toEqual(new Set(["u1"]));
		expect(state().retainedMessageBoundaryId).toBe("u1");
	});
});
