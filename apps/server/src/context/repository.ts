import { sql, type Kysely } from "kysely";
import type { ModelSelection } from "../chat/catalog";
import { contextualUserText } from "../chat/skills";
import type { Database } from "../db/schema";
import { estimateImageTokens } from "./imageTokens";
import { estimateClaudePdfTokens } from "./pdfTokens";
import type {
	ContextGlobalSettings,
	ContextPolicy,
	ContextState,
	ProviderCallTelemetry,
	ResolvedContextPolicy,
	AttachmentSummaryRepresentation,
} from "./types";
import {
	CLAUDE_CONTEXT_POLICY,
	GPT_CONTEXT_POLICY,
	type ContextPolicy as ConfiguredContextPolicy,
} from "./policy";
import type { ContextRecord } from "./tokens";

const OUTPUT_RESERVE_TOKENS = 32_000;
const MAX_PINNED_ATTACHMENT_TOKENS = 64_000;
const CONTEXT_GLOBAL_SETTINGS_KEY = "context_management_global_v1";

function contentText(value: unknown): string {
	return typeof value === "string" ? value : JSON.stringify(value);
}

function partsFromMessage(parts: string | null, fallback: string) {
	if (!parts) return [{ kind: "text" as const, text: fallback }];
	try {
		const parsed = JSON.parse(parts) as {
			content?: Array<{
				type?: string;
				text?: string;
				thinking?: string;
				name?: string;
				arguments?: unknown;
			}>;
		};
		if (!Array.isArray(parsed.content))
			return [{ kind: "text" as const, text: contentText(parsed) }];
		const content = parsed.content.map((part) => {
			if (part.type === "thinking")
				return { kind: "reasoning" as const, text: part.thinking ?? "" };
			if (part.type === "toolCall")
				return {
					kind: "toolCall" as const,
					text: `${part.name ?? "tool"}(${contentText(part.arguments)})`,
				};
			return { kind: "text" as const, text: part.text ?? contentText(part) };
		});
		return content.length
			? content
			: [{ kind: "text" as const, text: fallback }];
	} catch {
		return [{ kind: "text" as const, text: fallback }];
	}
}

function state(
	row: Awaited<ReturnType<ContextRepository["getState"]>>,
): ContextState | null {
	if (!row) return null;
	return { ...row, jobStatus: row.jobStatus };
}

/** Persistence boundary for policy inheritance, rolling summaries, and call accounting. */
export class ContextRepository {
	constructor(private readonly db: Kysely<Database>) {}

	async resolvePolicy(input: {
		provider: string;
		modelId: string;
		modelFamily?: string;
		contextWindowTokens: number;
		override?: ConfiguredContextPolicy;
	}): Promise<ResolvedContextPolicy> {
		if (input.override)
			return this.boundedPolicy(
				input.override,
				"exact_model",
				input.contextWindowTokens,
			);
		const builtIn =
			input.modelFamily === "gpt-5.6"
				? GPT_CONTEXT_POLICY
				: input.modelFamily === "claude-1m"
					? CLAUDE_CONTEXT_POLICY
					: undefined;
		if (builtIn)
			return this.boundedPolicy(
				builtIn,
				"model_family",
				input.contextWindowTokens,
			);
		return this.derivedPolicy(input.contextWindowTokens);
	}

	async ensureState(conversationId: string): Promise<ContextState> {
		const now = new Date().toISOString();
		await this.db
			.insertInto("conversation_context_state")
			.values({
				conversationId,
				revision: 0,
				summary: null,
				summaryRevision: null,
				retainedMessageBoundaryId: null,
				jobStatus: "idle",
				jobId: null,
				jobAttempt: 0,
				jobError: null,
				jobUpdatedAt: null,
				createdAt: now,
				updatedAt: now,
			})
			.onConflict((oc) => oc.column("conversationId").doNothing())
			.execute();
		return state(await this.getState(conversationId))!;
	}

	conversationModel(conversationId: string) {
		return this.db
			.selectFrom("conversation")
			.select(["provider", "modelId"])
			.where("id", "=", conversationId)
			.executeTakeFirst();
	}

	async globalSettings(): Promise<ContextGlobalSettings> {
		const row = await this.db
			.selectFrom("app_meta")
			.select("value")
			.where("key", "=", CONTEXT_GLOBAL_SETTINGS_KEY)
			.executeTakeFirst();
		if (!row?.value) return { enabled: true, summaryPromptOverride: null };
		try {
			const value = JSON.parse(row.value) as Partial<ContextGlobalSettings>;
			return {
				enabled: typeof value.enabled === "boolean" ? value.enabled : true,
				summaryPromptOverride:
					typeof value.summaryPromptOverride === "string" &&
					value.summaryPromptOverride.trim()
						? value.summaryPromptOverride
						: null,
			};
		} catch {
			return { enabled: true, summaryPromptOverride: null };
		}
	}

	async contextRecords(
		conversationId: string,
		selection: ModelSelection,
		systemPrompt?: string | null,
		attachmentSummary?: AttachmentSummaryRepresentation,
	): Promise<ContextRecord[]> {
		const rows = await this.db
			.selectFrom("message")
			.select(["id", "role", "text", "parts", "status"])
			.where("conversationId", "=", conversationId)
			.where("status", "=", "complete")
			.orderBy("createdAt", "asc")
			.execute();
		const records: ContextRecord[] = systemPrompt
			? [
					{
						id: "system-prompt",
						role: "system",
						content: [{ kind: "text", text: systemPrompt }],
						status: "complete",
					},
				]
			: [];
		for (const row of rows) {
			if (row.role === "user") {
				const attachments = await this.db
					.selectFrom("attachment")
					.select([
						"id",
						"filename",
						"mimeType",
						"kind",
						"byteSize",
						"width",
						"height",
						"pageCount",
						"extractedTextChars",
					])
					.where("messageId", "=", row.id)
					.execute();
				records.push({
					id: row.id,
					role: "user",
					status: "complete",
					content: [
						...(contextualUserText(row.text, row.parts)
							? [
									{
										kind: "text" as const,
										text: contextualUserText(row.text, row.parts),
									},
								]
							: []),
						...(await Promise.all(
							attachments.map(async (attachment) => ({
								id: attachment.id,
								kind: "attachment" as const,
								text: attachment.filename,
								tokenCount:
									attachment.kind === "image"
										? estimateImageTokens(attachment, selection)
										: attachment.mimeType === "application/pdf" &&
												selection.api === "anthropic-messages"
											? estimateClaudePdfTokens(attachment, selection.modelId)
											: Math.ceil(attachment.byteSize / 4),
								summary: await (attachmentSummary?.(attachment) ??
									Promise.resolve(
										`[Omitted attachment: ${attachment.filename}; type: ${attachment.mimeType}; kind: ${attachment.kind}; bytes: ${attachment.byteSize}]`,
									)),
							})),
						)),
					],
				});
				continue;
			}
			const steps = await this.generationSteps(row.id);
			for (const step of steps) {
				records.push({
					id: `${row.id}:step:${step.sequence}`,
					role: "tool",
					status: "complete",
					toolTransactionId: row.id,
					content: [
						{ kind: "toolResult", text: contentText(JSON.parse(step.data)) },
					],
				});
			}
			records.push({
				id: row.id,
				role: "assistant",
				status: "complete",
				toolTransactionId: steps.length ? row.id : undefined,
				content: partsFromMessage(row.parts, row.text),
			});
		}
		return records;
	}

	async getState(conversationId: string) {
		return this.db
			.selectFrom("conversation_context_state")
			.selectAll()
			.where("conversationId", "=", conversationId)
			.executeTakeFirst();
	}

	/** Invalidates any active artifact while atomically advancing the transcript revision. */
	async invalidateSummary(conversationId: string): Promise<boolean> {
		const result = await this.db
			.updateTable("conversation_context_state")
			.set({
				revision: sql`revision + 1`,
				summary: null,
				summaryRevision: null,
				retainedMessageBoundaryId: null,
				jobStatus: "idle",
				jobId: null,
				jobError: null,
				jobUpdatedAt: new Date().toISOString(),
				updatedAt: new Date().toISOString(),
			})
			.where("conversationId", "=", conversationId)
			.executeTakeFirst();
		return Number(result.numUpdatedRows) === 1;
	}

	/** Claims a revision for compaction. A changed transcript rejects the stale job. */
	async startJob(
		conversationId: string,
		expectedRevision: number,
		jobId: string,
	): Promise<boolean> {
		const now = new Date().toISOString();
		const result = await this.db
			.updateTable("conversation_context_state")
			.set({
				jobStatus: "running",
				jobId,
				jobAttempt: sql`jobAttempt + 1`,
				jobError: null,
				jobUpdatedAt: now,
				updatedAt: now,
			})
			.where("conversationId", "=", conversationId)
			.where("revision", "=", expectedRevision)
			.where("jobStatus", "!=", "running")
			.executeTakeFirst();
		return Number(result.numUpdatedRows) === 1;
	}

	/** Records a failed attempt without disturbing the last successfully activated summary. */
	async failJob(
		conversationId: string,
		expectedRevision: number,
		jobId: string,
		error: string,
	): Promise<boolean> {
		const now = new Date().toISOString();
		const result = await this.db
			.updateTable("conversation_context_state")
			.set({
				jobStatus: "failed",
				jobError: error,
				jobUpdatedAt: now,
				updatedAt: now,
			})
			.where("conversationId", "=", conversationId)
			.where("revision", "=", expectedRevision)
			.where("jobId", "=", jobId)
			.executeTakeFirst();
		return Number(result.numUpdatedRows) === 1;
	}

	/** Activates a completed summary only when its source transcript is still current. */
	async activateSummary(input: {
		conversationId: string;
		expectedRevision: number;
		jobId: string;
		summary: string;
		retainedMessageBoundaryId: string | null;
	}): Promise<boolean> {
		const now = new Date().toISOString();
		const result = await this.db
			.updateTable("conversation_context_state")
			.set({
				summary: input.summary,
				summaryRevision: input.expectedRevision,
				retainedMessageBoundaryId: input.retainedMessageBoundaryId,
				jobStatus: "idle",
				jobId: null,
				jobError: null,
				jobUpdatedAt: now,
				updatedAt: now,
			})
			.where("conversationId", "=", input.conversationId)
			.where("revision", "=", input.expectedRevision)
			.where("jobId", "=", input.jobId)
			.executeTakeFirst();
		return Number(result.numUpdatedRows) === 1;
	}

	async recordGenerationSteps(
		messageId: string,
		steps: unknown[],
	): Promise<void> {
		if (steps.length === 0) return;
		await this.db
			.insertInto("generation_step")
			.values(
				steps.map((step, sequence) => ({
					messageId,
					sequence,
					data: JSON.stringify(step),
					createdAt: new Date().toISOString(),
				})),
			)
			.execute();
	}

	generationSteps(messageId: string) {
		return this.db
			.selectFrom("generation_step")
			.selectAll()
			.where("messageId", "=", messageId)
			.orderBy("sequence", "asc")
			.execute();
	}

	async recordProviderCall(call: ProviderCallTelemetry): Promise<void> {
		await this.db
			.insertInto("provider_call_telemetry")
			.values({
				...call,
				conversationId: call.conversationId ?? null,
				messageId: call.messageId ?? null,
				inputTokens: call.inputTokens ?? null,
				outputTokens: call.outputTokens ?? null,
				cacheReadTokens: call.cacheReadTokens ?? null,
				cacheWriteTokens: call.cacheWriteTokens ?? null,
				estimatedCostMicros: call.estimatedCostMicros ?? null,
				latencyMs: call.latencyMs ?? null,
				contextPolicySource: call.contextPolicySource ?? null,
				contextPolicyEnabled:
					call.contextPolicyEnabled === undefined
						? null
						: call.contextPolicyEnabled
							? 1
							: 0,
				contextPolicyState: call.contextPolicyState
					? JSON.stringify(call.contextPolicyState)
					: null,
				overflowed: call.overflowed ? 1 : 0,
				retryAttempt: call.retryAttempt ?? 0,
				compactionTokensBefore: call.compactionTokensBefore ?? null,
				compactionTokensAfter: call.compactionTokensAfter ?? null,
				createdAt: new Date().toISOString(),
			})
			.execute();
	}

	async latestProviderContextTokens(
		conversationId: string,
	): Promise<number | null> {
		const row = await this.db
			.selectFrom("provider_call_telemetry")
			.select(["inputTokens", "cacheReadTokens"])
			.where("conversationId", "=", conversationId)
			.where("purpose", "in", ["chat", "tool_loop"])
			.orderBy("createdAt", "desc")
			.executeTakeFirst();
		if (!row || row.inputTokens === null) return null;
		return row.inputTokens + (row.cacheReadTokens ?? 0);
	}

	private boundedPolicy(
		policy: ContextPolicy,
		source: ResolvedContextPolicy["source"],
		window: number,
	): ResolvedContextPolicy {
		const hardInputTokens = Math.max(
			0,
			Math.min(policy.hardInputTokens, window - policy.outputReserveTokens),
		);
		const targetTokens = Math.min(policy.targetTokens, hardInputTokens);
		return {
			...policy,
			hardInputTokens,
			softTriggerTokens: Math.max(
				targetTokens,
				Math.min(policy.softTriggerTokens, hardInputTokens),
			),
			targetTokens,
			source,
		};
	}

	private derivedPolicy(window: number): ResolvedContextPolicy {
		const hardInputTokens = Math.max(0, window - OUTPUT_RESERVE_TOKENS);
		return {
			enabled: true,
			softTriggerTokens: Math.floor(window * 0.7),
			targetTokens: Math.min(Math.floor(window * 0.45), hardInputTokens),
			hardInputTokens,
			maxPinnedAttachmentTokens: Math.min(
				MAX_PINNED_ATTACHMENT_TOKENS,
				hardInputTokens,
			),
			outputReserveTokens: OUTPUT_RESERVE_TOKENS,
			source: "derived",
		};
	}
}
