import type {
	AssistantMessage,
	Context as PiContext,
} from "@earendil-works/pi-ai";
import { db } from "../db";
import {
	resolveModel,
	resolveTaskModelOrFallback,
	streamModel,
	type ModelSelection,
} from "../chat/catalog";
import { assembleContext } from "./assembler";
import { buildRollingSummaryPrompt, planSummaryChunks } from "./compaction";
import { canonicalPolicyProvider } from "./policy";
import { ContextRepository } from "./repository";
import {
	estimateRecordTokens,
	estimateRecordsTokens,
	type ContextRecord,
} from "./tokens";
import type { ContextGlobalSettings } from "./types";
import type {
	AttachmentSummaryRepresentation,
	ProviderCallTelemetry,
} from "./types";
import { modelCallTelemetry, type ModelCallTelemetry } from "./telemetry";

const MOCK_CONTEXT_WINDOW = 128_000;
const SUMMARY_PROMPT_VERSION = "solar-context-summary-v1";

export interface ContextAssemblyResult {
	messageIds: Set<string>;
	summary: string | null;
	tokens: number;
	policy: Awaited<ReturnType<ContextRepository["resolvePolicy"]>>;
	allowedAttachmentIds: Set<string>;
}

export type ContextSummaryResult = {
	summary: string;
	message: AssistantMessage;
};

export type ContextSummarizer = (
	prompt: string,
	selection: ModelSelection,
) => Promise<ContextSummaryResult | string>;
export type ContextSettingsReader = () => Promise<ContextGlobalSettings>;
export type ContextPromptProvider = (
	override: string | null,
	previous: string,
	records: readonly ContextRecord[],
) => string;

export class ContextCompactionError extends Error {}

function modelFamily(selection: ModelSelection): string | undefined {
	const identity = `${selection.provider} ${selection.modelId}`.toLowerCase();
	if (identity.includes("claude")) return "claude-1m";
	if (identity.includes("gpt-5.6")) return "gpt-5.6";
	return undefined;
}

function policyProvider(selection: ModelSelection): string {
	return canonicalPolicyProvider(modelFamily(selection)) ?? selection.provider;
}

const defaultPromptProvider: ContextPromptProvider = (
	override,
	previous,
	records,
) =>
	`${SUMMARY_PROMPT_VERSION}\n\n${override ?? "Update the rolling context summary. Preserve durable, task-relevant information."}\n\n${buildRollingSummaryPrompt(undefined, records)}${previous ? `\n\nPrevious active summary:\n${previous}` : ""}`;

function deterministicSummary(prompt: string): string {
	return [
		"# Rolling Context Summary",
		"",
		"## Goal",
		"- Conversation context",
		"",
		"## Constraints",
		"- None",
		"",
		"## Decisions",
		"- None",
		"",
		"## Durable Facts",
		"- None",
		"",
		"## Progress",
		`- Compacted ${Math.ceil(prompt.length / 4)} source tokens`,
		"",
		"## Unresolved Questions",
		"- Continue the conversation",
		"",
		"## Critical Excerpts",
		"- None",
		"",
		"## Tool Outcomes",
		"- None",
	].join("\n");
}

function retainedBoundaryId(
	records: readonly ContextRecord[],
	omittedRecordIds: readonly string[],
): string | null {
	if (omittedRecordIds.length === 0) {
		return records.find((record) => record.role === "user")?.id ?? null;
	}
	const omitted = new Set(omittedRecordIds);
	let lastOmittedIndex = -1;
	for (let index = 0; index < records.length; index += 1) {
		if (omitted.has(records[index]!.id)) lastOmittedIndex = index;
	}
	for (const record of records.slice(lastOmittedIndex + 1)) {
		if (record.id === "system-prompt") continue;
		const messageId = record.id.split(":step:")[0];
		if (messageId) return messageId;
	}
	return null;
}

async function defaultSummarizer(
	prompt: string,
	selection: ModelSelection,
): Promise<ContextSummaryResult | string> {
	if (process.env.SOLAR_MOCK_LLM) return deterministicSummary(prompt);
	const resolved = await resolveModel(selection);
	const context: PiContext = {
		messages: [{ role: "user", content: prompt, timestamp: Date.now() }],
	};
	let text = "";
	let message: AssistantMessage | undefined;
	for await (const event of streamModel(
		resolved,
		context,
		new AbortController().signal,
	)) {
		if (event.type === "text_delta") text += event.delta;
		if (event.type === "error")
			throw new Error(event.error.errorMessage ?? "Compaction failed");
		if (event.type === "done") message = event.message;
	}
	if (!text.trim()) throw new Error("Compaction returned an empty summary");
	if (!message)
		throw new Error("Compaction did not return a completed assistant message");
	return { summary: text.trim(), message };
}

/** Coordinates persisted transcript assembly and revision-safe rolling summaries. */
export class ContextRuntime {
	constructor(
		private readonly repository = new ContextRepository(db),
		private readonly summarize: ContextSummarizer = defaultSummarizer,
		private readonly settings: ContextSettingsReader = () =>
			repository.globalSettings(),
		private readonly promptProvider: ContextPromptProvider = defaultPromptProvider,
		private readonly attachmentSummary?: AttachmentSummaryRepresentation,
	) {}

	async assemble(
		conversationId: string,
		selection: ModelSelection,
		systemPrompt?: string | null,
		attachmentSummary = this.attachmentSummary,
	): Promise<ContextAssemblyResult> {
		await this.repository.seedDefaultPolicies();
		let state = await this.repository.ensureState(conversationId);
		const previousModel =
			await this.repository.conversationModel(conversationId);
		if (
			state.summary &&
			previousModel?.provider &&
			previousModel.modelId &&
			(previousModel.provider !== selection.provider ||
				previousModel.modelId !== selection.modelId)
		) {
			await this.repository.invalidateSummary(conversationId);
			state = await this.repository.ensureState(conversationId);
		}
		const contextWindowTokens =
			selection.provider === "mock"
				? MOCK_CONTEXT_WINDOW
				: (await resolveModel(selection)).model.contextWindow;
		const [policy, global, allRecords] = await Promise.all([
			this.repository.resolvePolicy({
				provider: policyProvider(selection),
				modelId: selection.modelId,
				modelFamily: modelFamily(selection),
				contextWindowTokens,
			}),
			this.settings(),
			this.repository.contextRecords(
				conversationId,
				systemPrompt,
				attachmentSummary,
			),
		]);
		const firstUser = allRecords.find((record) => record.role === "user");
		const boundaryIndex = state.retainedMessageBoundaryId
			? allRecords.findIndex(
					(record) => record.id === state.retainedMessageBoundaryId,
				)
			: -1;
		const records =
			state.summary && boundaryIndex >= 0
				? Array.from(
						new Map(
							[firstUser, ...allRecords.slice(boundaryIndex)]
								.filter((record): record is ContextRecord => Boolean(record))
								.map((record) => [record.id, record]),
						).values(),
					)
				: allRecords;
		const summary = state.summary
			? {
					id: "rolling-summary",
					role: "summary" as const,
					content: [{ kind: "text" as const, text: state.summary }],
				}
			: undefined;
		const assembled = assembleContext(records, {
			inputLimit: policy.hardInputTokens,
			summary,
			firstTurnAttachmentTokens: policy.maxPinnedAttachmentTokens,
		});
		const compactionPlan = assembleContext(records, {
			inputLimit: policy.targetTokens,
			summary,
			firstTurnAttachmentTokens: policy.maxPinnedAttachmentTokens,
		});
		const result = {
			messageIds: new Set(
				assembled.records
					.filter((record) => record.role !== "summary")
					.map((record) => record.id),
			),
			summary: state.summary,
			tokens:
				estimateRecordsTokens(records) +
				(summary ? estimateRecordTokens(summary) : 0),
			policy,
			allowedAttachmentIds: new Set(
				assembled.records.flatMap((record) =>
					record.content
						.filter((part) => part.kind === "attachment" && part.id)
						.map((part) => part.id!),
				),
			),
		};

		const attachmentOnlyCompaction =
			compactionPlan.omittedAttachments.length > 0 && !state.summary;
		if (
			global.enabled &&
			policy.enabled &&
			(result.tokens >= policy.softTriggerTokens || attachmentOnlyCompaction)
		) {
			const work = () =>
				this.compact(
					conversationId,
					selection,
					records,
					state,
					policy,
					compactionPlan.compactionRecords,
					compactionPlan.omittedRecordIds,
					result.tokens,
				);
			if (result.tokens >= policy.hardInputTokens || attachmentOnlyCompaction) {
				await work();
				const refreshed = await this.repository.ensureState(conversationId);
				if (refreshed.jobStatus === "failed")
					throw new ContextCompactionError(
						`Context compaction failed: ${refreshed.jobError ?? "unknown error"}`,
					);
				if (refreshed.jobStatus === "idle")
					return this.assembleWithoutCompaction(
						conversationId,
						selection,
						systemPrompt,
						attachmentSummary,
					);
				throw new ContextCompactionError(
					"Context exceeds the hard input limit and no compactable records remain",
				);
			} else void work();
		}
		return result;
	}

	private async assembleWithoutCompaction(
		conversationId: string,
		selection: ModelSelection,
		systemPrompt?: string | null,
		attachmentSummary = this.attachmentSummary,
	) {
		const state = await this.repository.ensureState(conversationId);
		const records = await this.repository.contextRecords(
			conversationId,
			systemPrompt,
			attachmentSummary,
		);
		const policy = await this.repository.resolvePolicy({
			provider: policyProvider(selection),
			modelId: selection.modelId,
			modelFamily: modelFamily(selection),
			contextWindowTokens:
				selection.provider === "mock"
					? MOCK_CONTEXT_WINDOW
					: (await resolveModel(selection)).model.contextWindow,
		});
		const boundary = state.retainedMessageBoundaryId
			? records.findIndex(
					(record) => record.id === state.retainedMessageBoundaryId,
				)
			: -1;
		const firstUser = records.find((record) => record.role === "user");
		const retained =
			state.summary && boundary >= 0
				? Array.from(
						new Map(
							[firstUser, ...records.slice(boundary)]
								.filter(Boolean)
								.map((record) => [record!.id, record!]),
						).values(),
					)
				: records;
		const summary = state.summary
			? {
					id: "rolling-summary",
					role: "summary" as const,
					content: [{ kind: "text" as const, text: state.summary }],
				}
			: undefined;
		const assembled = assembleContext(retained, {
			inputLimit: policy.hardInputTokens,
			summary,
			firstTurnAttachmentTokens: policy.maxPinnedAttachmentTokens,
		});
		return {
			messageIds: new Set(
				assembled.records
					.filter(
						(record) =>
							record.role !== "summary" && record.id !== "system-prompt",
					)
					.map((record) => record.id.split(":step:")[0]!),
			),
			summary: state.summary,
			tokens:
				estimateRecordsTokens(retained) +
				(summary ? estimateRecordTokens(summary) : 0),
			policy,
			allowedAttachmentIds: new Set(
				assembled.records.flatMap((record) =>
					record.content
						.filter((part) => part.kind === "attachment" && part.id)
						.map((part) => part.id!),
				),
			),
		};
	}

	async compactForRetry(
		conversationId: string,
		selection: ModelSelection,
		systemPrompt?: string | null,
		attachmentSummary = this.attachmentSummary,
	): Promise<void> {
		const state = await this.repository.ensureState(conversationId);
		const policy = await this.repository.resolvePolicy({
			provider: policyProvider(selection),
			modelId: selection.modelId,
			modelFamily: modelFamily(selection),
			contextWindowTokens:
				selection.provider === "mock"
					? MOCK_CONTEXT_WINDOW
					: (await resolveModel(selection)).model.contextWindow,
		});
		const records = await this.repository.contextRecords(
			conversationId,
			systemPrompt,
			attachmentSummary,
		);
		const plan = assembleContext(records, {
			inputLimit: policy.targetTokens,
			firstTurnAttachmentTokens: policy.maxPinnedAttachmentTokens,
		});
		if (!plan.compactionRecords.length)
			throw new ContextCompactionError("Context overflow cannot be compacted");
		await this.compact(
			conversationId,
			selection,
			records,
			state,
			policy,
			plan.compactionRecords,
			plan.omittedRecordIds,
			estimateRecordsTokens(records),
		);
		const refreshed = await this.repository.ensureState(conversationId);
		if (refreshed.jobStatus !== "idle" || !refreshed.summary)
			throw new ContextCompactionError(
				`Context compaction failed: ${refreshed.jobError ?? "unknown error"}`,
			);
	}

	private async compact(
		conversationId: string,
		selection: ModelSelection,
		records: ContextRecord[],
		state: Awaited<ReturnType<ContextRepository["ensureState"]>>,
		policy: Awaited<ReturnType<ContextRepository["resolvePolicy"]>>,
		compactionRecords: ContextRecord[],
		omittedRecordIds: string[],
		tokensBefore: number,
	): Promise<void> {
		if (!compactionRecords.length) return;
		const jobId = crypto.randomUUID();
		if (
			!(await this.repository.startJob(conversationId, state.revision, jobId))
		)
			return;
		try {
			const taskSelection =
				selection.provider === "mock"
					? selection
					: await resolveTaskModelOrFallback(selection);
			const taskContextWindow =
				taskSelection.provider === "mock"
					? MOCK_CONTEXT_WINDOW
					: (await resolveModel(taskSelection)).model.contextWindow;
			const chunks = planSummaryChunks(
				compactionRecords,
				taskContextWindow,
				4_096,
			).chunks;
			if (!chunks.length)
				throw new Error(
					"Compaction source exceeds the task model context window",
				);
			let summary = state.summary ?? "";
			for (const chunk of chunks) {
				const prompt = this.promptProvider(
					(await this.settings()).summaryPromptOverride,
					summary,
					chunk,
				);
				const startedAt = Date.now();
				const summaryResult = await this.summarize(prompt, taskSelection);
				summary =
					typeof summaryResult === "string"
						? summaryResult
						: summaryResult.summary;
				let usage: ModelCallTelemetry;
				if (typeof summaryResult === "string") {
					usage = {
						provider: taskSelection.provider,
						api: taskSelection.api,
						modelId: taskSelection.modelId,
						inputTokens: estimateRecordsTokens(chunk),
						outputTokens: estimateRecordTokens({
							id: "summary",
							role: "summary",
							content: [{ kind: "text", text: summary }],
						}),
					};
				} else {
					const { error: _error, ...completedUsage } = modelCallTelemetry(
						taskSelection,
						summaryResult.message,
						Date.now() - startedAt,
					);
					usage = completedUsage;
				}
				const telemetry: ProviderCallTelemetry = {
					id: crypto.randomUUID(),
					conversationId,
					purpose: "compaction",
					...usage,
					latencyMs: Date.now() - startedAt,
					contextPolicySource: policy.source,
					contextPolicyEnabled: policy.enabled,
					contextPolicyState: policy,
					compactionTokensBefore: tokensBefore,
					compactionTokensAfter: estimateRecordTokens({
						id: "summary",
						role: "summary",
						content: [{ kind: "text", text: summary }],
					}),
				};
				await this.repository.recordProviderCall(telemetry);
			}
			if (!summary) throw new Error("Compaction returned an empty summary");
			const boundary = retainedBoundaryId(records, omittedRecordIds);
			await this.repository.activateSummary({
				conversationId,
				expectedRevision: state.revision,
				jobId,
				summary,
				retainedMessageBoundaryId: boundary,
			});
		} catch (error) {
			await this.repository.failJob(
				conversationId,
				state.revision,
				jobId,
				error instanceof Error ? error.message : String(error),
			);
		}
	}
}

export const contextRuntime = new ContextRuntime();
