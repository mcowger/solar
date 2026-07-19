import { initTRPC, TRPCError } from "@trpc/server";
import { z } from "zod";
import { db, sqlite } from "../db";
import {
	deleteAttachmentFilesForMessages,
	deleteAttachmentFilesForUser,
} from "../chat/attachments";
import { generationManager } from "../chat/generationManager";
import {
	getAdminDefault,
	getModelCapabilities,
	documentInputMimeTypes,
	getTaskModel,
	getTitlePrompt,
	getUserDefault,
	importProviderModels,
	listAvailableModels,
	loadProviderConfigs,
	parseAllowlist,
	PROVIDER_APIS,
	resolveSelection,
	setAdminDefault,
	setTaskModel,
	setTitlePrompt,
	setUserDefault,
} from "../chat/catalog";
import type { TrpcContext } from "./context";
import { getLogLevel, setLogLevel, type SolarLogLevel } from "../logger";
import { testMcpServer } from "../chat/mcp";
import { ContextRepository } from "../context/repository";
import {
	contextGlobalSettingsInputSchema,
	CONTEXT_GLOBAL_SETTINGS_VERSION,
	DEFAULT_CONTEXT_SUMMARY_PROMPT,
	getContextGlobalSettings,
	setContextGlobalSettings,
} from "../context/settings";

const t = initTRPC.context<TrpcContext>().create();

export const router = t.router;
export const publicProcedure = t.procedure;

/** Gate: requires an authenticated Better Auth session. */
export const protectedProcedure = t.procedure.use(({ ctx, next }) => {
	if (!ctx.user) throw new TRPCError({ code: "UNAUTHORIZED" });
	return next({ ctx: { ...ctx, user: ctx.user } });
});

/** Gate: requires an authenticated user with the admin role. */
export const adminProcedure = protectedProcedure.use(({ ctx, next }) => {
	if ((ctx.user as { role?: string }).role !== "admin") {
		throw new TRPCError({ code: "FORBIDDEN" });
	}
	return next({ ctx });
});

/** Asserts the conversation exists and belongs to the user; else NOT_FOUND. */
async function assertOwnsConversation(userId: string, conversationId: string) {
	const convo = await db
		.selectFrom("conversation")
		.select("id")
		.where("id", "=", conversationId)
		.where("userId", "=", userId)
		.executeTakeFirst();
	if (!convo) throw new TRPCError({ code: "NOT_FOUND" });
}

/** Pulls the persisted "thinking" text out of a full pi AssistantMessage JSON. */
function extractReasoning(parts: string | null): string | null {
	if (!parts) return null;
	try {
		const parsed = JSON.parse(parts) as {
			content?: { type: string; thinking?: string }[];
		};
		const thinking = parsed.content?.find((c) => c.type === "thinking");
		return thinking?.thinking ?? null;
	} catch {
		return null;
	}
}

function extractToolCalls(parts: string | null) {
	if (!parts) return [];
	try {
		const parsed = JSON.parse(parts) as { solarToolCalls?: unknown };
		return Array.isArray(parsed.solarToolCalls) ? parsed.solarToolCalls : [];
	} catch {
		return [];
	}
}

const conversationRouter = router({
	list: protectedProcedure.query(async ({ ctx }) => {
		const conversations = await db
			.selectFrom("conversation")
			.select([
				"id",
				"title",
				"folderId",
				"provider",
				"endpointId",
				"modelId",
				"modelApi",
				"createdAt",
				"updatedAt",
			])
			.where("userId", "=", ctx.user.id)
			.orderBy("updatedAt", "desc")
			.execute();

		const tagRows = await db
			.selectFrom("conversation_tag")
			.innerJoin("tag", "tag.id", "conversation_tag.tagId")
			.select([
				"conversation_tag.conversationId",
				"tag.id as tagId",
				"tag.name",
			])
			.where("tag.userId", "=", ctx.user.id)
			.execute();

		const tagsByConversation = new Map<
			string,
			{ id: string; name: string }[]
		>();
		for (const r of tagRows) {
			const list = tagsByConversation.get(r.conversationId) ?? [];
			list.push({ id: r.tagId, name: r.name });
			tagsByConversation.set(r.conversationId, list);
		}

		return conversations.map((c) => ({
			...c,
			tags: tagsByConversation.get(c.id) ?? [],
		}));
	}),

	create: protectedProcedure
		.input(
			z.object({
				title: z.string().trim().min(1).max(200).optional(),
				folderId: z.string().nullish(),
				/** A preset chosen at conversation start; its config is snapshotted. */
				presetId: z.string().nullish(),
			}),
		)
		.mutation(async ({ ctx, input }) => {
			const id = crypto.randomUUID();
			// Snapshot the preset (model + system prompt + reasoning params) onto the
			// conversation so later preset edits don't mutate this conversation.
			let snapshot: {
				provider: string | null;
				endpointId: string | null;
				modelId: string | null;
				modelApi: string | null;
				systemPrompt: string | null;
				reasoningEffort: string | null;
				reasoningSummary: number;
				verbosity: string | null;
			} = {
				provider: null,
				endpointId: null,
				modelId: null,
				modelApi: null,
				systemPrompt: null,
				reasoningEffort: null,
				reasoningSummary: 0,
				verbosity: null,
			};
			if (input.presetId) {
				const preset = await db
					.selectFrom("preset")
					.selectAll()
					.where("id", "=", input.presetId)
					.executeTakeFirst();
				// Presets are usable by the owner (any scope) or anyone (shared).
				if (
					preset &&
					(preset.scope === "shared" || preset.userId === ctx.user.id)
				) {
					await assertCanUseModel(
						{
							provider: preset.provider,
							endpointId: preset.endpointId ?? preset.modelApi,
							modelId: preset.modelId,
							api: preset.modelApi,
						},
						ctx.user.role === "admin",
					);
					snapshot = {
						provider: preset.provider,
						endpointId: preset.endpointId ?? preset.modelApi,
						modelId: preset.modelId,
						modelApi: preset.modelApi,
						systemPrompt: preset.systemPrompt,
						reasoningEffort: preset.reasoningEffort,
						reasoningSummary: preset.reasoningSummary,
						verbosity: preset.verbosity,
					};
				}
			}
			await db
				.insertInto("conversation")
				.values({
					id,
					userId: ctx.user.id,
					title: input.title ?? "New conversation",
					folderId: input.folderId ?? null,
					...snapshot,
				})
				.execute();
			return { id };
		}),

	rename: protectedProcedure
		.input(
			z.object({ id: z.string(), title: z.string().trim().min(1).max(200) }),
		)
		.mutation(async ({ ctx, input }) => {
			await assertOwnsConversation(ctx.user.id, input.id);
			await db
				.updateTable("conversation")
				.set({ title: input.title })
				.where("id", "=", input.id)
				.execute();
		}),

	remove: protectedProcedure
		.input(z.object({ id: z.string() }))
		.mutation(async ({ ctx, input }) => {
			await assertOwnsConversation(ctx.user.id, input.id);
			const messages = await db
				.selectFrom("message")
				.select("id")
				.where("conversationId", "=", input.id)
				.execute();
			await deleteAttachmentFilesForMessages(messages.map((m) => m.id));
			await db.deleteFrom("conversation").where("id", "=", input.id).execute();
		}),

	contextState: protectedProcedure
		.input(z.object({ conversationId: z.string() }))
		.query(async ({ ctx, input }) => {
			await assertOwnsConversation(ctx.user.id, input.conversationId);
			const state = await new ContextRepository(db).getState(
				input.conversationId,
			);
			const latestEstimate = await db
				.selectFrom("provider_call_telemetry")
				.select("compactionTokensBefore")
				.where("conversationId", "=", input.conversationId)
				.where("compactionTokensBefore", "is not", null)
				.orderBy("createdAt", "desc")
				.executeTakeFirst();
			return {
				state:
					state?.jobStatus === "failed"
						? "failed"
						: state?.jobStatus === "running" || state?.jobStatus === "queued"
							? "running"
							: "idle",
				estimatedTokens: latestEstimate?.compactionTokensBefore ?? null,
				summarized: Boolean(state?.summary),
				jobError: state?.jobError ?? null,
			};
		}),

	setModel: protectedProcedure
		.input(
			z.object({
				id: z.string(),
				provider: z.string(),
				endpointId: z.string(),
				modelId: z.string(),
				api: z.string(),
			}),
		)
		.mutation(async ({ ctx, input }) => {
			await assertOwnsConversation(ctx.user.id, input.id);
			// Only allow selecting a model the user actually has access to.
			const available = await listAvailableModels(ctx.user.role === "admin");
			const ok = available.some(
				(m) =>
					m.provider === input.provider &&
					m.endpointId === input.endpointId &&
					m.modelId === input.modelId &&
					m.api === input.api,
			);
			if (!ok)
				throw new TRPCError({
					code: "BAD_REQUEST",
					message: "model unavailable",
				});
			await db
				.updateTable("conversation")
				.set({
					provider: input.provider,
					endpointId: input.endpointId,
					modelId: input.modelId,
					modelApi: input.api,
				})
				.where("id", "=", input.id)
				.execute();
		}),

	setGenerationSettings: protectedProcedure
		.input(
			z.object({
				id: z.string(),
				reasoningEffort: z
					.enum(["minimal", "low", "medium", "high", "xhigh", "max"])
					.nullable()
					.optional(),
				verbosity: z.enum(["low", "medium", "high"]).nullable().optional(),
			}),
		)
		.mutation(async ({ ctx, input }) => {
			await assertOwnsConversation(ctx.user.id, input.id);
			const conversation = await db
				.selectFrom("conversation")
				.select([
					"provider",
					"endpointId",
					"modelId",
					"modelApi",
					"presetReasoningEffort",
					"presetVerbosity",
				])
				.where("id", "=", input.id)
				.executeTakeFirstOrThrow();
			const selection = await resolveSelection(
				{
					provider: conversation.provider ?? undefined,
					endpointId: conversation.endpointId ?? undefined,
					modelId: conversation.modelId ?? undefined,
					api: conversation.modelApi ?? undefined,
				},
				ctx.user.id,
				ctx.user.role === "admin",
			);
			const capabilities = await getModelCapabilities(selection);
			if (
				input.reasoningEffort !== undefined &&
				input.reasoningEffort !== null &&
				!capabilities.reasoningLevels.includes(input.reasoningEffort)
			) {
				throw new TRPCError({
					code: "BAD_REQUEST",
					message: "reasoning effort unavailable",
				});
			}
			if (
				input.verbosity !== undefined &&
				input.verbosity !== null &&
				!capabilities.supportsVerbosity
			) {
				throw new TRPCError({
					code: "BAD_REQUEST",
					message: "verbosity unavailable",
				});
			}
			await db
				.updateTable("conversation")
				.set({
					...(input.reasoningEffort !== undefined
						? { reasoningEffort: input.reasoningEffort }
						: {}),
					...(input.verbosity !== undefined
						? { verbosity: input.verbosity }
						: {}),
				})
				.where("id", "=", input.id)
				.execute();
		}),

	move: protectedProcedure
		.input(z.object({ id: z.string(), folderId: z.string().nullable() }))
		.mutation(async ({ ctx, input }) => {
			await assertOwnsConversation(ctx.user.id, input.id);
			await db
				.updateTable("conversation")
				.set({ folderId: input.folderId })
				.where("id", "=", input.id)
				.execute();
		}),

	setTags: protectedProcedure
		.input(z.object({ id: z.string(), tagIds: z.array(z.string()) }))
		.mutation(async ({ ctx, input }) => {
			await assertOwnsConversation(ctx.user.id, input.id);
			// Only accept tags the user actually owns.
			const owned = input.tagIds.length
				? await db
						.selectFrom("tag")
						.select("id")
						.where("userId", "=", ctx.user.id)
						.where("id", "in", input.tagIds)
						.execute()
				: [];
			await db
				.deleteFrom("conversation_tag")
				.where("conversationId", "=", input.id)
				.execute();
			if (owned.length) {
				await db
					.insertInto("conversation_tag")
					.values(owned.map((t) => ({ conversationId: input.id, tagId: t.id })))
					.execute();
			}
		}),

	search: protectedProcedure
		.input(z.object({ query: z.string().trim().min(1) }))
		.query(async ({ ctx, input }) => {
			const like = `%${input.query.replace(/[%_]/g, "\\$&")}%`;
			const rows = await db
				.selectFrom("conversation")
				.leftJoin("message", "message.conversationId", "conversation.id")
				.select([
					"conversation.id",
					"conversation.title",
					"conversation.updatedAt",
				])
				.where("conversation.userId", "=", ctx.user.id)
				.where((eb) =>
					eb.or([
						eb("conversation.title", "like", like),
						eb("message.text", "like", like),
					]),
				)
				.groupBy("conversation.id")
				.orderBy("conversation.updatedAt", "desc")
				.execute();
			return rows;
		}),

	messages: protectedProcedure
		.input(z.object({ conversationId: z.string() }))
		.query(async ({ ctx, input }) => {
			await assertOwnsConversation(ctx.user.id, input.conversationId);

			const messages = await db
				.selectFrom("message")
				.select(["id", "role", "text", "status", "parts", "createdAt"])
				.where("conversationId", "=", input.conversationId)
				.orderBy("createdAt", "asc")
				.execute();

			const attachments = messages.length
				? await db
						.selectFrom("attachment")
						.select(["id", "messageId", "filename", "mimeType", "kind"])
						.where(
							"messageId",
							"in",
							messages.map((m) => m.id),
						)
						.execute()
				: [];
			const attachmentsByMessage = new Map<string, typeof attachments>();
			for (const a of attachments) {
				if (!a.messageId) continue;
				const list = attachmentsByMessage.get(a.messageId) ?? [];
				list.push(a);
				attachmentsByMessage.set(a.messageId, list);
			}

			return messages.map((m) => {
				const reasoning = extractReasoning(m.parts);
				const toolCalls = extractToolCalls(m.parts);
				return {
					id: m.id,
					role: m.role,
					text: m.text,
					status: m.status,
					createdAt: m.createdAt,
					reasoning,
					toolCalls,
					attachments: (attachmentsByMessage.get(m.id) ?? []).map((a) => ({
						id: a.id,
						filename: a.filename,
						mimeType: a.mimeType,
						kind: a.kind,
					})),
					isActive:
						m.status === "generating" && generationManager.isActive(m.id),
				};
			});
		}),
});

const allowlistEntrySchema = z.object({
	id: z.string().trim().min(1),
	endpointId: z.string().trim().min(1),
	api: z.string().trim().min(1),
	visibility: z.enum(["public", "private"]).default("public"),
	name: z.string().trim().optional(),
	piProvider: z.string().trim().optional(),
	piModel: z.string().trim().optional(),
	piOptions: z.record(z.string(), z.unknown()).optional(),
	reasoning: z.boolean().optional(),
	vision: z.boolean().optional(),
	documents: z.boolean().optional(),
	reasoningEffort: z
		.enum(["minimal", "low", "medium", "high", "xhigh", "max"])
		.optional(),
	verbosity: z.enum(["low", "medium", "high"]).optional(),
});

const folderHistorySchema = z.object({
	id: z.string(),
	userId: z.string(),
	name: z.string(),
	createdAt: z.string(),
});

const tagHistorySchema = folderHistorySchema;

const conversationHistorySchema = z.object({
	id: z.string(),
	userId: z.string(),
	title: z.string(),
	folderId: z.string().nullable(),
	provider: z.string().nullable(),
	endpointId: z.string().nullable().optional().default(null),
	modelId: z.string().nullable(),
	modelApi: z.string().nullable(),
	systemPrompt: z.string().nullable(),
	presetReasoningEffort: z.string().nullable(),
	reasoningEffort: z.string().nullable(),
	reasoningSummary: z.number(),
	verbosity: z.string().nullable(),
	presetVerbosity: z.string().nullable(),
	autoExecuteTools: z.number(),
	createdAt: z.string(),
	updatedAt: z.string(),
});

const messageHistorySchema = z.object({
	id: z.string(),
	conversationId: z.string(),
	role: z.enum(["user", "assistant"]),
	text: z.string(),
	parts: z.string().nullable(),
	status: z.enum(["complete", "generating", "error"]),
	model: z.string().nullable(),
	inputTokens: z.number().nullable(),
	outputTokens: z.number().nullable(),
	createdAt: z.string(),
});

const attachmentHistorySchema = z.object({
	id: z.string(),
	userId: z.string(),
	messageId: z.string(),
	filename: z.string(),
	mimeType: z.string(),
	kind: z.enum(["image", "text"]),
	byteSize: z.number(),
	storageKey: z.string(),
	createdAt: z.string(),
});

const historySchema = z.object({
	format: z.literal("solar-chat-history"),
	version: z.literal(1),
	exportedAt: z.string(),
	userId: z.string(),
	folders: z.array(folderHistorySchema),
	tags: z.array(tagHistorySchema),
	conversations: z.array(conversationHistorySchema),
	messages: z.array(messageHistorySchema),
	attachments: z.array(attachmentHistorySchema),
	conversationTags: z.array(
		z.object({ conversationId: z.string(), tagId: z.string() }),
	),
});

export const contextPolicySchema = z
	.object({
		scope: z.enum(["exact_model", "model_family", "provider"]),
		provider: z.string().trim().min(1).max(100),
		modelFamily: z.string().trim().min(1).max(200).nullable(),
		modelId: z.string().trim().min(1).max(200).nullable(),
		enabled: z.boolean(),
		softTriggerTokens: z.number().int().min(1).max(2_000_000),
		targetTokens: z.number().int().min(1).max(2_000_000),
		hardInputTokens: z.number().int().min(1).max(2_000_000),
		maxPinnedAttachmentTokens: z.number().int().min(0).max(2_000_000),
		outputReserveTokens: z.number().int().min(1).max(2_000_000),
	})
	.superRefine((policy, ctx) => {
		if (policy.scope === "exact_model" && !policy.modelId) {
			ctx.addIssue({
				code: "custom",
				path: ["modelId"],
				message: "Exact policies require a model ID",
			});
		}
		if (policy.scope === "model_family" && !policy.modelFamily) {
			ctx.addIssue({
				code: "custom",
				path: ["modelFamily"],
				message: "Family policies require a model family",
			});
		}
		if (policy.scope === "provider" && (policy.modelFamily || policy.modelId)) {
			ctx.addIssue({
				code: "custom",
				path: ["scope"],
				message: "Provider policies cannot select a model",
			});
		}
		if (
			policy.targetTokens > policy.softTriggerTokens ||
			policy.softTriggerTokens > policy.hardInputTokens
		) {
			ctx.addIssue({
				code: "custom",
				path: ["softTriggerTokens"],
				message: "Target, trigger, and hard input must be ordered",
			});
		}
		if (policy.maxPinnedAttachmentTokens > policy.hardInputTokens) {
			ctx.addIssue({
				code: "custom",
				path: ["maxPinnedAttachmentTokens"],
				message: "Pinned attachment budget cannot exceed hard input",
			});
		}
	});

function hasDuplicateIds(rows: { id: string }[]) {
	return new Set(rows.map((row) => row.id)).size !== rows.length;
}

const adminRouter = router({
	logLevel: adminProcedure.query(() => ({ level: getLogLevel() })),

	contextManagementSettings: adminProcedure.query(async () => {
		const repository = new ContextRepository(db);
		await repository.seedDefaultPolicies();
		const [global, policies] = await Promise.all([
			getContextGlobalSettings(),
			db
				.selectFrom("context_policy")
				.selectAll()
				.orderBy("provider", "asc")
				.orderBy("scope", "asc")
				.execute(),
		]);
		return {
			global: {
				...global,
				summaryPrompt:
					global.summaryPromptOverride ?? DEFAULT_CONTEXT_SUMMARY_PROMPT,
				summaryPromptOverridden: global.summaryPromptOverride !== null,
			},
			policies: policies.map((policy) => ({
				...policy,
				enabled: Boolean(policy.enabled),
			})),
			fallback: {
				softTrigger: "70% of the model context window",
				target: "45% of the model context window",
				hardInput: "Context window minus the output reserve",
				maxPinnedAttachmentTokens: 64_000,
				outputReserveTokens: 32_000,
			},
		};
	}),

	setContextManagementGlobal: adminProcedure
		.input(contextGlobalSettingsInputSchema)
		.mutation(async ({ input }) => {
			await setContextGlobalSettings({
				version: CONTEXT_GLOBAL_SETTINGS_VERSION,
				...input,
			});
		}),

	setContextPolicy: adminProcedure
		.input(contextPolicySchema)
		.mutation(async ({ input }) => {
			const repository = new ContextRepository(db);
			const policy = {
				enabled: input.enabled,
				softTriggerTokens: input.softTriggerTokens,
				targetTokens: input.targetTokens,
				hardInputTokens: input.hardInputTokens,
				maxPinnedAttachmentTokens: input.maxPinnedAttachmentTokens,
				outputReserveTokens: input.outputReserveTokens,
			};
			if (input.scope === "exact_model") {
				await repository.savePolicy({
					...policy,
					scope: input.scope,
					provider: input.provider,
					modelId: input.modelId!,
				});
			} else if (input.scope === "model_family") {
				await repository.savePolicy({
					...policy,
					scope: input.scope,
					provider: input.provider,
					modelFamily: input.modelFamily!,
				});
			} else {
				await repository.savePolicy({
					...policy,
					scope: input.scope,
					provider: input.provider,
				});
			}
		}),

	resetContextSummaryPrompt: adminProcedure.mutation(async () => {
		const settings = await getContextGlobalSettings();
		await setContextGlobalSettings({
			...settings,
			summaryPromptOverride: null,
		});
	}),

	debug: router({
		chatIds: adminProcedure
			.input(z.object({ userId: z.string() }))
			.query(async ({ input }) => {
				const chats = await db
					.selectFrom("conversation")
					.select("id")
					.where("userId", "=", input.userId)
					.orderBy("updatedAt", "desc")
					.execute();
				return chats.map((chat) => chat.id);
			}),

		chatRows: adminProcedure
			.input(z.object({ chatId: z.string() }))
			.query(async ({ input }) => {
				const conversation = await db
					.selectFrom("conversation")
					.selectAll()
					.where("id", "=", input.chatId)
					.executeTakeFirst();
				if (!conversation) throw new TRPCError({ code: "NOT_FOUND" });

				const messages = await db
					.selectFrom("message")
					.selectAll()
					.where("conversationId", "=", input.chatId)
					.orderBy("createdAt", "asc")
					.execute();
				const messageIds = messages.map((message) => message.id);
				const [attachments, conversationTags, conversationMcpServers] =
					await Promise.all([
						messageIds.length
							? db
									.selectFrom("attachment")
									.selectAll()
									.where("messageId", "in", messageIds)
									.execute()
							: [],
						db
							.selectFrom("conversation_tag")
							.selectAll()
							.where("conversationId", "=", input.chatId)
							.execute(),
						db
							.selectFrom("conversation_mcp_server")
							.selectAll()
							.where("conversationId", "=", input.chatId)
							.execute(),
					]);

				return {
					conversation,
					messages,
					attachments,
					conversationTags,
					conversationMcpServers,
				};
			}),
	}),

	history: router({
		export: adminProcedure
			.input(z.object({ userId: z.string() }))
			.query(async ({ input }) => {
				const [folders, tags, conversations] = await Promise.all([
					db
						.selectFrom("folder")
						.selectAll()
						.where("userId", "=", input.userId)
						.execute(),
					db
						.selectFrom("tag")
						.selectAll()
						.where("userId", "=", input.userId)
						.execute(),
					db
						.selectFrom("conversation")
						.selectAll()
						.where("userId", "=", input.userId)
						.orderBy("createdAt", "asc")
						.execute(),
				]);
				const conversationIds = conversations.map(
					(conversation) => conversation.id,
				);
				const messages = conversationIds.length
					? await db
							.selectFrom("message")
							.selectAll()
							.where("conversationId", "in", conversationIds)
							.orderBy("createdAt", "asc")
							.execute()
					: [];
				const messageIds = messages.map((message) => message.id);
				const [attachments, conversationTags] = await Promise.all([
					messageIds.length
						? db
								.selectFrom("attachment")
								.selectAll()
								.where("messageId", "in", messageIds)
								.execute()
						: [],
					conversationIds.length
						? db
								.selectFrom("conversation_tag")
								.selectAll()
								.where("conversationId", "in", conversationIds)
								.execute()
						: [],
				]);

				return {
					format: "solar-chat-history" as const,
					version: 1 as const,
					exportedAt: new Date().toISOString(),
					userId: input.userId,
					folders,
					tags,
					conversations,
					messages,
					attachments: attachments.filter(
						(
							attachment,
						): attachment is typeof attachment & { messageId: string } =>
							attachment.messageId !== null,
					),
					conversationTags,
				};
			}),

		import: adminProcedure
			.input(z.object({ userId: z.string(), history: historySchema }))
			.mutation(async ({ input }) => {
				const { history, userId } = input;
				if (
					hasDuplicateIds(history.folders) ||
					hasDuplicateIds(history.tags) ||
					hasDuplicateIds(history.conversations) ||
					hasDuplicateIds(history.messages) ||
					hasDuplicateIds(history.attachments)
				) {
					throw new TRPCError({
						code: "BAD_REQUEST",
						message: "History contains duplicate IDs",
					});
				}

				const folderIds = new Set(history.folders.map((folder) => folder.id));
				const tagIds = new Set(history.tags.map((tag) => tag.id));
				const conversationIds = new Set(
					history.conversations.map((conversation) => conversation.id),
				);
				const messageIds = new Set(
					history.messages.map((message) => message.id),
				);
				if (
					history.conversations.some(
						(conversation) =>
							conversation.folderId !== null &&
							!folderIds.has(conversation.folderId),
					) ||
					history.messages.some(
						(message) => !conversationIds.has(message.conversationId),
					) ||
					history.attachments.some(
						(attachment) => !messageIds.has(attachment.messageId),
					) ||
					history.conversationTags.some(
						({ conversationId, tagId }) =>
							!conversationIds.has(conversationId) || !tagIds.has(tagId),
					)
				) {
					throw new TRPCError({
						code: "BAD_REQUEST",
						message: "History contains invalid references",
					});
				}

				await db.transaction().execute(async (trx) => {
					const user = sqlite
						.query("SELECT id FROM user WHERE id = ?")
						.get(userId);
					if (!user) throw new TRPCError({ code: "NOT_FOUND" });

					const [
						existingFolders,
						existingTags,
						existingConversations,
						existingMessages,
						existingAttachments,
					] = await Promise.all([
						history.folders.length
							? trx
									.selectFrom("folder")
									.select("id")
									.where(
										"id",
										"in",
										history.folders.map((folder) => folder.id),
									)
									.execute()
							: [],
						history.tags.length
							? trx
									.selectFrom("tag")
									.select("id")
									.where(
										"id",
										"in",
										history.tags.map((tag) => tag.id),
									)
									.execute()
							: [],
						history.conversations.length
							? trx
									.selectFrom("conversation")
									.select("id")
									.where(
										"id",
										"in",
										history.conversations.map(
											(conversation) => conversation.id,
										),
									)
									.execute()
							: [],
						history.messages.length
							? trx
									.selectFrom("message")
									.select("id")
									.where(
										"id",
										"in",
										history.messages.map((message) => message.id),
									)
									.execute()
							: [],
						history.attachments.length
							? trx
									.selectFrom("attachment")
									.select("id")
									.where(
										"id",
										"in",
										history.attachments.map((attachment) => attachment.id),
									)
									.execute()
							: [],
					]);
					if (
						existingFolders.length ||
						existingTags.length ||
						existingConversations.length ||
						existingMessages.length ||
						existingAttachments.length
					) {
						throw new TRPCError({
							code: "CONFLICT",
							message: "History conflicts with existing IDs",
						});
					}

					const existingTagNames = history.tags.length
						? await trx
								.selectFrom("tag")
								.select("name")
								.where("userId", "=", userId)
								.where(
									"name",
									"in",
									history.tags.map((tag) => tag.name),
								)
								.execute()
						: [];
					if (existingTagNames.length) {
						throw new TRPCError({
							code: "CONFLICT",
							message: "History conflicts with existing tag names",
						});
					}

					if (history.folders.length) {
						await trx
							.insertInto("folder")
							.values(history.folders.map((folder) => ({ ...folder, userId })))
							.execute();
					}
					if (history.tags.length) {
						await trx
							.insertInto("tag")
							.values(history.tags.map((tag) => ({ ...tag, userId })))
							.execute();
					}
					if (history.conversations.length) {
						await trx
							.insertInto("conversation")
							.values(
								history.conversations.map((conversation) => ({
									...conversation,
									userId,
								})),
							)
							.execute();
					}
					if (history.messages.length) {
						await trx.insertInto("message").values(history.messages).execute();
					}
					if (history.attachments.length) {
						await trx
							.insertInto("attachment")
							.values(
								history.attachments.map((attachment) => ({
									...attachment,
									userId,
								})),
							)
							.execute();
					}
					if (history.conversationTags.length) {
						await trx
							.insertInto("conversation_tag")
							.values(history.conversationTags)
							.execute();
					}
				});

				return {
					folders: history.folders.length,
					tags: history.tags.length,
					conversations: history.conversations.length,
					messages: history.messages.length,
					attachments: history.attachments.length,
				};
			}),
	}),

	setLogLevel: adminProcedure
		.input(
			z.object({ level: z.enum(["trace", "debug", "info", "warn", "error"]) }),
		)
		.mutation(({ input }) => {
			setLogLevel(input.level as SolarLogLevel);
		}),

	listProviders: adminProcedure.query(async () => {
		const configs = await loadProviderConfigs();
		return Promise.all(
			configs.map(async (config) => ({
				provider: config.provider,
				hasApiKey: Boolean(config.apiKey),
				endpoints: config.endpoints,
				enabledModels: await Promise.all(
					config.enabledModels.map(async (model) => ({
						...model,
						capabilities: await getModelCapabilities({
							provider: config.provider,
							endpointId: model.endpointId,
							modelId: model.id,
							api: model.api,
						}),
					})),
				),
				apis: PROVIDER_APIS,
			})),
		);
	}),

	setProvider: adminProcedure
		.input(
			z.object({
				provider: z.string().trim().min(1).max(100),
				apiKey: z.string().trim().nullish(),
				endpoints: z.array(
					z.object({
						id: z.string().trim().min(1).max(100),
						label: z.string().trim().min(1).max(100),
						baseUrl: z.string().url().max(2000),
						api: z.enum(PROVIDER_APIS as [string, ...string[]]),
					}),
				),
				enabledModels: z.array(allowlistEntrySchema),
			}),
		)
		.mutation(async ({ input }) => {
			const endpointIds = new Set(
				input.endpoints.map((endpoint) => endpoint.id),
			);
			if (endpointIds.size !== input.endpoints.length) {
				throw new TRPCError({
					code: "BAD_REQUEST",
					message: "endpoint IDs must be unique",
				});
			}
			const endpointApis = new Set(
				input.endpoints.map((endpoint) => endpoint.api),
			);
			if (endpointApis.size !== input.endpoints.length) {
				throw new TRPCError({
					code: "BAD_REQUEST",
					message: "each endpoint must use a different API",
				});
			}
			for (const e of input.enabledModels) {
				const endpoint = input.endpoints.find(
					(candidate) => candidate.id === e.endpointId,
				);
				if (!endpoint || endpoint.api !== e.api) {
					throw new TRPCError({
						code: "BAD_REQUEST",
						message: `model "${e.id}" must use a configured endpoint`,
					});
				}
			}
			const existing = await db
				.selectFrom("provider_config")
				.select("apiKey")
				.where("provider", "=", input.provider)
				.executeTakeFirst();
			const values = {
				provider: input.provider,
				apiKey: input.apiKey || existing?.apiKey || null,
				baseUrl: null,
				endpoints: JSON.stringify(input.endpoints),
				enabledModels: JSON.stringify(input.enabledModels),
				updatedAt: new Date().toISOString(),
			};
			await db
				.insertInto("provider_config")
				.values(values)
				.onConflict((oc) =>
					oc.column("provider").doUpdateSet({
						apiKey: values.apiKey,
						baseUrl: values.baseUrl,
						endpoints: values.endpoints,
						enabledModels: values.enabledModels,
						updatedAt: values.updatedAt,
					}),
				)
				.execute();
		}),

	deleteProvider: adminProcedure
		.input(z.object({ provider: z.string().trim().min(1).max(100) }))
		.mutation(async ({ input }) => {
			await db
				.deleteFrom("provider_config")
				.where("provider", "=", input.provider)
				.execute();
		}),

	queryProviderModels: adminProcedure
		.input(z.object({ provider: z.string(), endpointId: z.string() }))
		.mutation(async ({ input }) => {
			try {
				const { discoverProviderModels } = await import("../chat/catalog");
				return await discoverProviderModels(input.provider, input.endpointId);
			} catch (error) {
				throw new TRPCError({
					code: "BAD_REQUEST",
					message:
						error instanceof Error ? error.message : "Model query failed",
				});
			}
		}),

	importProviderModels: adminProcedure
		.input(
			z.object({
				provider: z.string(),
				endpointId: z.string(),
				models: z
					.array(
						z.object({
							id: z.string(),
							api: z.enum(PROVIDER_APIS as [string, ...string[]]),
							visibility: z.enum(["public", "private"]),
						}),
					)
					.min(1),
			}),
		)
		.mutation(async ({ input }) => {
			try {
				await importProviderModels(
					input.provider,
					input.endpointId,
					input.models,
				);
			} catch (error) {
				throw new TRPCError({
					code: "BAD_REQUEST",
					message:
						error instanceof Error ? error.message : "Model import failed",
				});
			}
		}),

	listUsers: adminProcedure.query(
		() =>
			sqlite
				.query(
					"SELECT id, name, email, role, isDisabled, createdAt FROM user ORDER BY createdAt ASC",
				)
				.all() as {
				id: string;
				name: string;
				email: string;
				role: string;
				isDisabled: number;
				createdAt: string;
			}[],
	),

	setUserRole: adminProcedure
		.input(z.object({ userId: z.string(), role: z.enum(["admin", "user"]) }))
		.mutation(async ({ ctx, input }) => {
			if (input.userId === ctx.user.id) {
				throw new TRPCError({
					code: "BAD_REQUEST",
					message: "You cannot change your own role",
				});
			}
			const target = sqlite
				.query("SELECT role, isDisabled FROM user WHERE id = ?")
				.get(input.userId) as { role: string; isDisabled: number } | null;
			if (!target) throw new TRPCError({ code: "NOT_FOUND" });
			if (
				target.role === "admin" &&
				input.role === "user" &&
				!target.isDisabled
			) {
				const admins = sqlite
					.query(
						"SELECT COUNT(*) AS count FROM user WHERE role = 'admin' AND isDisabled = 0",
					)
					.get() as { count: number };
				if (admins.count <= 1) {
					throw new TRPCError({
						code: "BAD_REQUEST",
						message: "At least one active admin is required",
					});
				}
			}
			sqlite
				.query("UPDATE user SET role = ? WHERE id = ?")
				.run(input.role, input.userId);
		}),

	setUserDisabled: adminProcedure
		.input(z.object({ userId: z.string(), isDisabled: z.boolean() }))
		.mutation(async ({ ctx, input }) => {
			if (input.userId === ctx.user.id) {
				throw new TRPCError({
					code: "BAD_REQUEST",
					message: "You cannot disable your own account",
				});
			}
			const target = sqlite
				.query("SELECT role, isDisabled FROM user WHERE id = ?")
				.get(input.userId) as { role: string; isDisabled: number } | null;
			if (!target) throw new TRPCError({ code: "NOT_FOUND" });
			if (input.isDisabled && target.role === "admin" && !target.isDisabled) {
				const admins = sqlite
					.query(
						"SELECT COUNT(*) AS count FROM user WHERE role = 'admin' AND isDisabled = 0",
					)
					.get() as { count: number };
				if (admins.count <= 1) {
					throw new TRPCError({
						code: "BAD_REQUEST",
						message: "At least one active admin is required",
					});
				}
			}
			sqlite
				.query("UPDATE user SET isDisabled = ? WHERE id = ?")
				.run(input.isDisabled ? 1 : 0, input.userId);
			if (input.isDisabled)
				sqlite.query("DELETE FROM session WHERE userId = ?").run(input.userId);
		}),

	deleteUser: adminProcedure
		.input(z.object({ userId: z.string() }))
		.mutation(async ({ ctx, input }) => {
			if (input.userId === ctx.user.id) {
				throw new TRPCError({
					code: "BAD_REQUEST",
					message: "You cannot delete your own account",
				});
			}
			const target = sqlite
				.query("SELECT role, isDisabled FROM user WHERE id = ?")
				.get(input.userId) as { role: string; isDisabled: number } | null;
			if (!target) throw new TRPCError({ code: "NOT_FOUND" });
			if (target.role === "admin" && !target.isDisabled) {
				const admins = sqlite
					.query(
						"SELECT COUNT(*) AS count FROM user WHERE role = 'admin' AND isDisabled = 0",
					)
					.get() as { count: number };
				if (admins.count <= 1) {
					throw new TRPCError({
						code: "BAD_REQUEST",
						message: "At least one active admin is required",
					});
				}
			}
			await deleteAttachmentFilesForUser(input.userId);
			sqlite.query("DELETE FROM user WHERE id = ?").run(input.userId);
		}),

	usage: adminProcedure.query(
		() =>
			sqlite
				.query(`
      SELECT u.id AS userId, u.name, u.email, COALESCE(m.model, 'unknown') AS model,
        COUNT(*) AS messageCount, COALESCE(SUM(m.inputTokens), 0) AS inputTokens,
        COALESCE(SUM(m.outputTokens), 0) AS outputTokens
      FROM message m
      JOIN conversation c ON c.id = m.conversationId
      JOIN user u ON u.id = c.userId
      WHERE m.role = 'assistant'
      GROUP BY u.id, u.name, u.email, m.model
      ORDER BY u.email ASC, model ASC
    `)
				.all() as {
				userId: string;
				name: string;
				email: string;
				model: string;
				messageCount: number;
				inputTokens: number;
				outputTokens: number;
			}[],
	),
});

const modelSelectionSchema = z.object({
	provider: z.string(),
	endpointId: z.string(),
	modelId: z.string(),
	api: z.string(),
});

async function assertCanUseModel(
	selection: z.infer<typeof modelSelectionSchema>,
	isAdmin: boolean,
) {
	const available = await listAvailableModels(isAdmin);
	const selected = available.some(
		(model) =>
			model.provider === selection.provider &&
			model.endpointId === selection.endpointId &&
			model.modelId === selection.modelId &&
			model.api === selection.api,
	);
	if (!selected)
		throw new TRPCError({ code: "BAD_REQUEST", message: "model unavailable" });
}

const modelRouter = router({
	/** Models the current user may select (allowlist + mock). */
	available: protectedProcedure.query(async ({ ctx }) => {
		return listAvailableModels(ctx.user.role === "admin");
	}),

	/** The effective model for a conversation (stored selection or resolved
	 * default), with its catalog capabilities (reasoning/vision). */
	forConversation: protectedProcedure
		.input(z.object({ conversationId: z.string() }))
		.query(async ({ ctx, input }) => {
			await assertOwnsConversation(ctx.user.id, input.conversationId);
			const convo = await db
				.selectFrom("conversation")
				.select([
					"provider",
					"endpointId",
					"modelId",
					"modelApi",
					"reasoningEffort",
					"presetReasoningEffort",
					"verbosity",
					"presetVerbosity",
				])
				.where("id", "=", input.conversationId)
				.executeTakeFirst();
			const selection = await resolveSelection(
				{
					provider: convo?.provider ?? undefined,
					endpointId: convo?.endpointId ?? undefined,
					modelId: convo?.modelId ?? undefined,
					api: convo?.modelApi ?? undefined,
				},
				ctx.user.id,
				ctx.user.role === "admin",
			);
			const available = await listAvailableModels(ctx.user.role === "admin");
			const descriptor = available.find(
				(m) =>
					m.provider === selection.provider &&
					m.endpointId === selection.endpointId &&
					m.modelId === selection.modelId &&
					m.api === selection.api,
			);
			const capabilities = await getModelCapabilities(selection);
			const documentMimeTypes = await documentInputMimeTypes(selection);
			const effectiveReasoningEffort =
				convo?.reasoningEffort ??
				convo?.presetReasoningEffort ??
				capabilities.defaultReasoningEffort;
			const effectiveVerbosity =
				convo?.verbosity ??
				convo?.presetVerbosity ??
				capabilities.defaultVerbosity;
			return {
				...(descriptor ?? {
					...selection,
					name: selection.modelId,
					reasoning: false,
					vision: false,
					documents: false,
				}),
				...capabilities,
				documentMimeTypes,
				reasoningEffort: convo?.reasoningEffort ?? null,
				presetReasoningEffort: convo?.presetReasoningEffort ?? null,
				verbosity: convo?.verbosity ?? null,
				presetVerbosity: convo?.presetVerbosity ?? null,
				effectiveReasoningEffort,
				effectiveVerbosity,
			};
		}),

	/** The current user's personal default model, if any. */
	userDefault: protectedProcedure.query(async ({ ctx }) => {
		return getUserDefault(ctx.user.id);
	}),

	setUserDefault: protectedProcedure
		.input(modelSelectionSchema)
		.mutation(async ({ ctx, input }) => {
			await assertCanUseModel(input, ctx.user.role === "admin");
			await setUserDefault(ctx.user.id, input);
		}),

	adminDefault: adminProcedure.query(async () => {
		return getAdminDefault();
	}),

	setAdminDefault: adminProcedure
		.input(modelSelectionSchema)
		.mutation(async ({ input }) => {
			const publicModels = await listAvailableModels();
			const selected = publicModels.some(
				(model) =>
					model.provider === input.provider &&
					model.endpointId === input.endpointId &&
					model.modelId === input.modelId &&
					model.api === input.api,
			);
			if (!selected)
				throw new TRPCError({
					code: "BAD_REQUEST",
					message: "admin default must be public",
				});
			await setAdminDefault(input);
		}),

	taskModel: adminProcedure.query(() => getTaskModel()),

	titlePrompt: adminProcedure.query(() => getTitlePrompt()),

	setTitlePrompt: adminProcedure
		.input(z.object({ prompt: z.string().trim().min(1).max(20_000) }))
		.mutation(async ({ input }) => {
			await setTitlePrompt(input.prompt);
		}),

	setTaskModel: adminProcedure
		.input(modelSelectionSchema)
		.mutation(async ({ input }) => {
			const available = await listAvailableModels();
			const isAvailable = available.some(
				(model) =>
					model.provider === input.provider &&
					model.endpointId === input.endpointId &&
					model.modelId === input.modelId &&
					model.api === input.api,
			);
			if (!isAvailable) {
				throw new TRPCError({
					code: "BAD_REQUEST",
					message: "model unavailable",
				});
			}
			await setTaskModel(input);
		}),
});

const presetInputSchema = z.object({
	name: z.string().trim().min(1).max(100),
	scope: z.enum(["personal", "shared"]),
	provider: z.string(),
	endpointId: z.string(),
	modelId: z.string(),
	api: z.string(),
	systemPrompt: z.string().trim().max(20000).nullish(),
	reasoningEffort: z.string().nullish(),
	reasoningSummary: z.boolean().optional(),
	verbosity: z.string().nullish(),
});

/** Load a preset and assert the user may edit/delete it (owner or admin). */
async function assertCanEditPreset(
	userId: string,
	isAdmin: boolean,
	presetId: string,
) {
	const preset = await db
		.selectFrom("preset")
		.select(["id", "userId"])
		.where("id", "=", presetId)
		.executeTakeFirst();
	if (!preset) throw new TRPCError({ code: "NOT_FOUND" });
	if (preset.userId !== userId && !isAdmin) {
		throw new TRPCError({ code: "FORBIDDEN" });
	}
}

const presetRouter = router({
	/** Presets the user may use: their own (any scope) plus all shared presets. */
	list: protectedProcedure.query(async ({ ctx }) => {
		const rows = await db
			.selectFrom("preset")
			.selectAll()
			.where((eb) =>
				eb.or([eb("userId", "=", ctx.user.id), eb("scope", "=", "shared")]),
			)
			.orderBy("name", "asc")
			.execute();
		const available = await listAvailableModels(ctx.user.role === "admin");
		return rows
			.filter((preset) =>
				available.some(
					(model) =>
						model.provider === preset.provider &&
						model.endpointId === (preset.endpointId ?? preset.modelApi) &&
						model.modelId === preset.modelId &&
						model.api === preset.modelApi,
				),
			)
			.map((r) => ({
				...r,
				reasoningSummary: Boolean(r.reasoningSummary),
				owned: r.userId === ctx.user.id,
			}));
	}),

	create: protectedProcedure
		.input(presetInputSchema)
		.mutation(async ({ ctx, input }) => {
			const isAdmin = ctx.user.role === "admin";
			await assertCanUseModel(input, isAdmin);
			if (input.scope === "shared") await assertCanUseModel(input, false);
			const id = crypto.randomUUID();
			await db
				.insertInto("preset")
				.values({
					id,
					userId: ctx.user.id,
					name: input.name,
					scope: input.scope,
					provider: input.provider,
					endpointId: input.endpointId,
					modelId: input.modelId,
					modelApi: input.api,
					systemPrompt: input.systemPrompt ?? null,
					reasoningEffort: input.reasoningEffort ?? null,
					reasoningSummary: input.reasoningSummary ? 1 : 0,
					verbosity: input.verbosity ?? null,
				})
				.execute();
			return { id };
		}),

	update: protectedProcedure
		.input(presetInputSchema.extend({ id: z.string() }))
		.mutation(async ({ ctx, input }) => {
			const isAdmin = (ctx.user as { role?: string }).role === "admin";
			await assertCanEditPreset(ctx.user.id, isAdmin, input.id);
			await assertCanUseModel(input, isAdmin);
			if (input.scope === "shared") await assertCanUseModel(input, false);
			await db
				.updateTable("preset")
				.set({
					name: input.name,
					scope: input.scope,
					provider: input.provider,
					endpointId: input.endpointId,
					modelId: input.modelId,
					modelApi: input.api,
					systemPrompt: input.systemPrompt ?? null,
					reasoningEffort: input.reasoningEffort ?? null,
					reasoningSummary: input.reasoningSummary ? 1 : 0,
					verbosity: input.verbosity ?? null,
				})
				.where("id", "=", input.id)
				.execute();
		}),

	remove: protectedProcedure
		.input(z.object({ id: z.string() }))
		.mutation(async ({ ctx, input }) => {
			const isAdmin = (ctx.user as { role?: string }).role === "admin";
			await assertCanEditPreset(ctx.user.id, isAdmin, input.id);
			await db.deleteFrom("preset").where("id", "=", input.id).execute();
		}),
});

const mcpHeadersSchema = z
	.record(z.string().trim().min(1), z.string())
	.default({});
const mcpInputSchema = z.object({
	name: z.string().trim().min(1).max(100),
	url: z.string().url().max(2000),
	headers: mcpHeadersSchema,
	enabled: z.boolean().default(true),
	global: z.boolean().default(false),
});

async function getMcpServer(id: string) {
	const server = await db
		.selectFrom("mcp_server")
		.selectAll()
		.where("id", "=", id)
		.executeTakeFirst();
	if (!server)
		throw new TRPCError({ code: "NOT_FOUND", message: "MCP server not found" });
	return server;
}

function canManageMcp(
	userId: string,
	isAdmin: boolean,
	ownerId: string | null,
) {
	if (!isAdmin && ownerId !== userId)
		throw new TRPCError({ code: "FORBIDDEN" });
}

const mcpRouter = router({
	list: protectedProcedure.query(async ({ ctx }) => {
		const isAdmin = (ctx.user as { role?: string }).role === "admin";
		const rows = await db
			.selectFrom("mcp_server")
			.leftJoin("user_mcp_server_preference", (join) =>
				join
					.onRef("user_mcp_server_preference.serverId", "=", "mcp_server.id")
					.on("user_mcp_server_preference.userId", "=", ctx.user.id),
			)
			.select([
				"mcp_server.id",
				"mcp_server.userId",
				"mcp_server.name",
				"mcp_server.url",
				"mcp_server.enabled",
				"mcp_server.createdAt",
				"mcp_server.updatedAt",
				"user_mcp_server_preference.enabled as preferenceEnabled",
			])
			.where((eb) =>
				isAdmin
					? eb("mcp_server.id", "is not", null)
					: eb.or([
							eb("mcp_server.userId", "is", null),
							eb("mcp_server.userId", "=", ctx.user.id),
						]),
			)
			.orderBy("mcp_server.name", "asc")
			.execute();
		return rows.map((row) => ({
			...row,
			enabled: Boolean(row.enabled),
			defaultEnabled: Boolean(row.preferenceEnabled ?? 1),
			global: row.userId === null,
			owned: row.userId === ctx.user.id,
		}));
	}),

	create: protectedProcedure
		.input(mcpInputSchema)
		.mutation(async ({ ctx, input }) => {
			const isAdmin = (ctx.user as { role?: string }).role === "admin";
			if (input.global && !isAdmin) throw new TRPCError({ code: "FORBIDDEN" });
			const id = crypto.randomUUID();
			const now = new Date().toISOString();
			await db
				.insertInto("mcp_server")
				.values({
					id,
					userId: input.global ? null : ctx.user.id,
					name: input.name,
					url: input.url,
					headers: JSON.stringify(input.headers),
					enabled: input.enabled ? 1 : 0,
					createdAt: now,
					updatedAt: now,
				})
				.execute();
			return { id };
		}),

	update: protectedProcedure
		.input(mcpInputSchema.extend({ id: z.string() }))
		.mutation(async ({ ctx, input }) => {
			const isAdmin = (ctx.user as { role?: string }).role === "admin";
			const server = await getMcpServer(input.id);
			canManageMcp(ctx.user.id, isAdmin, server.userId);
			if (input.global && !isAdmin) throw new TRPCError({ code: "FORBIDDEN" });
			await db
				.updateTable("mcp_server")
				.set({
					userId: input.global ? null : (server.userId ?? ctx.user.id),
					name: input.name,
					url: input.url,
					headers: JSON.stringify(input.headers),
					enabled: input.enabled ? 1 : 0,
					updatedAt: new Date().toISOString(),
				})
				.where("id", "=", input.id)
				.execute();
		}),

	remove: protectedProcedure
		.input(z.object({ id: z.string() }))
		.mutation(async ({ ctx, input }) => {
			const server = await getMcpServer(input.id);
			canManageMcp(
				ctx.user.id,
				(ctx.user as { role?: string }).role === "admin",
				server.userId,
			);
			await db.deleteFrom("mcp_server").where("id", "=", input.id).execute();
		}),

	test: protectedProcedure
		.input(
			z.object({
				id: z.string().optional(),
				url: z.string().url().max(2000).optional(),
				headers: mcpHeadersSchema,
			}),
		)
		.mutation(async ({ ctx, input }) => {
			let url = input.url;
			let headers = input.headers;
			if (input.id) {
				const server = await getMcpServer(input.id);
				canManageMcp(
					ctx.user.id,
					(ctx.user as { role?: string }).role === "admin",
					server.userId,
				);
				url = url ?? server.url;
				headers = Object.keys(headers).length
					? headers
					: JSON.parse(server.headers);
			}
			if (!url)
				throw new TRPCError({
					code: "BAD_REQUEST",
					message: "URL is required",
				});
			try {
				return await testMcpServer(url, headers);
			} catch (error) {
				throw new TRPCError({
					code: "BAD_REQUEST",
					message:
						error instanceof Error ? error.message : "MCP connection failed",
				});
			}
		}),

	setDefault: protectedProcedure
		.input(z.object({ serverId: z.string(), enabled: z.boolean() }))
		.mutation(async ({ ctx, input }) => {
			const server = await getMcpServer(input.serverId);
			if (
				server.userId !== null &&
				server.userId !== ctx.user.id &&
				(ctx.user as { role?: string }).role !== "admin"
			)
				throw new TRPCError({ code: "FORBIDDEN" });
			await db
				.insertInto("user_mcp_server_preference")
				.values({
					userId: ctx.user.id,
					serverId: input.serverId,
					enabled: input.enabled ? 1 : 0,
				})
				.onConflict((oc) =>
					oc
						.columns(["userId", "serverId"])
						.doUpdateSet({ enabled: input.enabled ? 1 : 0 }),
				)
				.execute();
		}),

	forConversation: protectedProcedure
		.input(z.object({ conversationId: z.string() }))
		.query(async ({ ctx, input }) => {
			await assertOwnsConversation(ctx.user.id, input.conversationId);
			const [conversation, servers] = await Promise.all([
				db
					.selectFrom("conversation")
					.select("autoExecuteTools")
					.where("id", "=", input.conversationId)
					.executeTakeFirstOrThrow(),
				db
					.selectFrom("mcp_server")
					.leftJoin("user_mcp_server_preference", (join) =>
						join
							.onRef(
								"user_mcp_server_preference.serverId",
								"=",
								"mcp_server.id",
							)
							.on("user_mcp_server_preference.userId", "=", ctx.user.id),
					)
					.leftJoin("conversation_mcp_server", (join) =>
						join
							.onRef("conversation_mcp_server.serverId", "=", "mcp_server.id")
							.on(
								"conversation_mcp_server.conversationId",
								"=",
								input.conversationId,
							),
					)
					.select([
						"mcp_server.id",
						"mcp_server.name",
						"mcp_server.enabled",
						"user_mcp_server_preference.enabled as preferenceEnabled",
						"conversation_mcp_server.enabled as conversationEnabled",
					])
					.where("mcp_server.enabled", "=", 1)
					.where((eb) =>
						eb.or([
							eb("mcp_server.userId", "is", null),
							eb("mcp_server.userId", "=", ctx.user.id),
						]),
					)
					.execute(),
			]);
			return {
				autoExecuteTools: Boolean(conversation.autoExecuteTools),
				servers: servers.map((server) => ({
					id: server.id,
					name: server.name,
					enabled: Boolean(
						server.conversationEnabled ?? server.preferenceEnabled ?? 1,
					),
				})),
			};
		}),

	setConversation: protectedProcedure
		.input(
			z.object({
				conversationId: z.string(),
				serverId: z.string(),
				enabled: z.boolean(),
			}),
		)
		.mutation(async ({ ctx, input }) => {
			await assertOwnsConversation(ctx.user.id, input.conversationId);
			const server = await getMcpServer(input.serverId);
			if (server.userId !== null && server.userId !== ctx.user.id)
				throw new TRPCError({ code: "FORBIDDEN" });
			await db
				.insertInto("conversation_mcp_server")
				.values({
					conversationId: input.conversationId,
					serverId: input.serverId,
					enabled: input.enabled ? 1 : 0,
				})
				.onConflict((oc) =>
					oc
						.columns(["conversationId", "serverId"])
						.doUpdateSet({ enabled: input.enabled ? 1 : 0 }),
				)
				.execute();
		}),

	setAutoExecute: protectedProcedure
		.input(z.object({ conversationId: z.string(), enabled: z.boolean() }))
		.mutation(async ({ ctx, input }) => {
			await assertOwnsConversation(ctx.user.id, input.conversationId);
			await db
				.updateTable("conversation")
				.set({ autoExecuteTools: input.enabled ? 1 : 0 })
				.where("id", "=", input.conversationId)
				.execute();
		}),
});

const folderRouter = router({
	list: protectedProcedure.query(async ({ ctx }) => {
		return db
			.selectFrom("folder")
			.select(["id", "name", "createdAt"])
			.where("userId", "=", ctx.user.id)
			.orderBy("name", "asc")
			.execute();
	}),

	create: protectedProcedure
		.input(z.object({ name: z.string().trim().min(1).max(100) }))
		.mutation(async ({ ctx, input }) => {
			const id = crypto.randomUUID();
			await db
				.insertInto("folder")
				.values({ id, userId: ctx.user.id, name: input.name })
				.execute();
			return { id };
		}),

	rename: protectedProcedure
		.input(
			z.object({ id: z.string(), name: z.string().trim().min(1).max(100) }),
		)
		.mutation(async ({ ctx, input }) => {
			await db
				.updateTable("folder")
				.set({ name: input.name })
				.where("id", "=", input.id)
				.where("userId", "=", ctx.user.id)
				.execute();
		}),

	remove: protectedProcedure
		.input(z.object({ id: z.string() }))
		.mutation(async ({ ctx, input }) => {
			await db
				.deleteFrom("folder")
				.where("id", "=", input.id)
				.where("userId", "=", ctx.user.id)
				.execute();
		}),
});

const tagRouter = router({
	list: protectedProcedure.query(async ({ ctx }) => {
		return db
			.selectFrom("tag")
			.select(["id", "name", "createdAt"])
			.where("userId", "=", ctx.user.id)
			.orderBy("name", "asc")
			.execute();
	}),

	create: protectedProcedure
		.input(z.object({ name: z.string().trim().min(1).max(50) }))
		.mutation(async ({ ctx, input }) => {
			// Reuse an existing tag of the same name (unique per user).
			const existing = await db
				.selectFrom("tag")
				.select("id")
				.where("userId", "=", ctx.user.id)
				.where("name", "=", input.name)
				.executeTakeFirst();
			if (existing) return { id: existing.id };
			const id = crypto.randomUUID();
			await db
				.insertInto("tag")
				.values({ id, userId: ctx.user.id, name: input.name })
				.execute();
			return { id };
		}),

	remove: protectedProcedure
		.input(z.object({ id: z.string() }))
		.mutation(async ({ ctx, input }) => {
			await db
				.deleteFrom("tag")
				.where("id", "=", input.id)
				.where("userId", "=", ctx.user.id)
				.execute();
		}),
});

export const appRouter = router({
	health: publicProcedure.query(async () => {
		const row = await db
			.selectFrom("app_meta")
			.select("value")
			.where("key", "=", "schema_version")
			.executeTakeFirst();
		return {
			ok: true,
			service: "solar-server",
			schemaVersion: row?.value ?? null,
		};
	}),

	me: publicProcedure.query(({ ctx }) => ({ user: ctx.user })),

	conversation: conversationRouter,
	folder: folderRouter,
	tag: tagRouter,
	model: modelRouter,
	preset: presetRouter,
	mcp: mcpRouter,
	admin: adminRouter,
});

/** Exported for the web app's type-only tRPC client. */
export type AppRouter = typeof appRouter;
