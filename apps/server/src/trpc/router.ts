import { initTRPC, TRPCError } from "@trpc/server";
import { sql } from "kysely";
import { z } from "zod";
import {
	createSolarApiKey,
	createSolarUser,
	setSolarUserPassword,
} from "../auth";
import {
	startSolarImpersonation,
	stopSolarImpersonation,
} from "../impersonation";
import { config } from "../config";
import { db, sqlite } from "../db";
import { deleteAttachmentFilesForUser } from "../chat/attachments";
import {
	getAdminDefault,
	getModelCapabilities,
	documentInputMimeTypes,
	getTaskModel,
	getTitlePrompt,
	getUserDefault,
	getUserDefaultPreset,
	getUserDefaultDisplayMode,
	setUserDefaultDisplayMode,
	importProviderModels,
	listAvailableImageModels,
	listImageCatalogModels,
	listAvailableModels,
	loadProviderConfigs,
	parseAllowlist,
	parseImageAllowlist,
	ALL_PROVIDER_APIS,
	resolveSelection,
	resolveModel,
	setAdminDefault,
	setTaskModel,
	setTitlePrompt,
	setUserDefault,
	setUserDefaultPreset,
} from "../chat/catalog";
import { applyUserRole, countActiveAdmins } from "../userRoles";
import type { TrpcContext } from "./context";
import { getLogLevel, setLogLevel, type SolarLogLevel } from "../logger";
import { testMcpServer } from "../chat/mcp";
import {
	contextGlobalSettingsInputSchema,
	CONTEXT_GLOBAL_SETTINGS_VERSION,
	DEFAULT_CONTEXT_SUMMARY_PROMPT,
	getContextGlobalSettings,
	setContextGlobalSettings,
} from "../context/settings";
import {
	getPasteSettings,
	PASTE_SETTINGS_VERSION,
	pasteSettingsInputSchema,
	setPasteSettings,
} from "../chat/pasteSettings";
import { SourceCategoryResolver } from "../sources/categories";
import { parseSkill } from "../chat/skills";
import { conversationRepository } from "../conversations/repository";
import { piCompact, piDeleteConversation } from "../pi/engine";
import { isPiSessionReady } from "../pi/sessions";
import { buildHistoryBundle } from "../history/export";
import {
	executeHistoryImport,
	HistoryImportValidationError,
	planHistoryImport,
} from "../history/import";
import { HISTORY_BUNDLE_FORMAT, type HistoryBundle } from "../history/bundle";
import { piModelCapabilities, syncPiModelConfig } from "../pi/models";
import {
	loadPiMessages,
	piConversationMatchesQuery,
	piConversationTitle,
	piConversationUsage,
	piLatestCompaction,
} from "../pi/turns";
import {
	ImageNotFoundError,
	ImageWorkspaceBusyError,
	ImageWorkspaceStartedError,
} from "../images/repository";
import { imageGenerationService } from "../images/service";
import { ImageStorageError } from "../images/storage";

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

const conversationRouter = router({
	list: protectedProcedure.query(async ({ ctx }) => {
		const [conversations, tags] = await Promise.all([
			conversationRepository.listConversations(ctx.user.id),
			db
				.selectFrom("tag")
				.select(["id", "name"])
				.where("userId", "=", ctx.user.id)
				.execute(),
		]);
		const tagById = new Map(tags.map((tag) => [tag.id, tag]));
		return conversations.map((conversation) => ({
			id: conversation.id,
			title: isPiSessionReady(conversation.id)
				? (piConversationTitle(conversation.id) ?? conversation.title)
				: conversation.title,
			folderId: conversation.folderId,
			provider: conversation.provider,
			endpointId: conversation.endpointId,
			modelId: conversation.modelId,
			modelApi: conversation.modelApi,
			createdAt: conversation.createdAt,
			updatedAt: conversation.updatedAt,
			tags: conversation.tagIds
				.map((tagId) => tagById.get(tagId))
				.filter((tag): tag is { id: string; name: string } => Boolean(tag)),
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
			// Discard abandoned drafts (metadata rows with no pi session) so
			// they never accumulate.
			const conversations = await conversationRepository.listConversations(
				ctx.user.id,
			);
			for (const conversation of conversations) {
				if (!isPiSessionReady(conversation.id)) {
					await conversationRepository
						.deleteConversation(ctx.user.id, conversation.id)
						.catch(() => {});
				}
			}
			const presetId =
				input.presetId ?? (await getUserDefaultPreset(ctx.user.id));
			// Snapshot the preset (model + system prompt + reasoning params) onto the
			// conversation so later preset edits don't mutate this conversation.
			let snapshot: {
				provider: string | null;
				endpointId: string | null;
				modelId: string | null;
				modelApi: string | null;
				systemPrompt: string | null;
				reasoningEffort: string | null;
				reasoningSummary: boolean;
				verbosity: string | null;
			} = {
				provider: null,
				endpointId: null,
				modelId: null,
				modelApi: null,
				systemPrompt: null,
				reasoningEffort: null,
				reasoningSummary: false,
				verbosity: null,
			};
			if (presetId) {
				const preset = await db
					.selectFrom("preset")
					.selectAll()
					.where("id", "=", presetId)
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
						reasoningSummary: Boolean(preset.reasoningSummary),
						verbosity: preset.verbosity,
					};
				}
			}
			const defaultDisplayMode = await getUserDefaultDisplayMode(ctx.user.id);
			const conversation = await conversationRepository.createConversation(
				ctx.user.id,
				{
					title: input.title ?? "New conversation",
					folderId: input.folderId ?? null,
					displayMode: defaultDisplayMode,
					...snapshot,
				},
			);
			return { id: conversation.id };
		}),

	rename: protectedProcedure
		.input(
			z.object({ id: z.string(), title: z.string().trim().min(1).max(200) }),
		)
		.mutation(async ({ ctx, input }) => {
			try {
				await conversationRepository.renameConversation(
					ctx.user.id,
					input.id,
					input.title,
				);
			} catch {
				throw new TRPCError({ code: "NOT_FOUND" });
			}
		}),

	remove: protectedProcedure
		.input(z.object({ id: z.string() }))
		.mutation(async ({ ctx, input }) => {
			try {
				if (isPiSessionReady(input.id)) {
					await piDeleteConversation(input.id);
				}
				await conversationRepository.deleteConversation(ctx.user.id, input.id);
			} catch {
				throw new TRPCError({ code: "NOT_FOUND" });
			}
		}),

	contextState: protectedProcedure
		.input(z.object({ conversationId: z.string() }))
		.query(async ({ ctx, input }) => {
			try {
				await conversationRepository.getConversation(
					ctx.user.id,
					input.conversationId,
				);
			} catch {
				throw new TRPCError({ code: "NOT_FOUND" });
			}
			// Pi compacts inside its own process; there is no Solar job queue to
			// report from. We expose the latest compaction the session file knows
			// about, always in the idle state.
			const latest = isPiSessionReady(input.conversationId)
				? piLatestCompaction(input.conversationId)
				: null;
			return {
				state: "idle" as const,
				estimatedTokens: latest?.tokensBefore ?? null,
				summarized: latest !== null,
				jobError: null,
				summaryEvent: latest
					? {
							tokensBefore: latest.tokensBefore,
							tokensAfter: latest.usageOutput ?? null,
							revision: latest.revision,
							createdAt: latest.createdAt,
							retainedMessageBoundaryId: null,
						}
					: null,
			};
		}),

	metrics: protectedProcedure
		.input(z.object({ conversationId: z.string() }))
		.query(async ({ ctx, input }) => {
			const conversation = await (async () => {
				try {
					return await conversationRepository.getConversation(
						ctx.user.id,
						input.conversationId,
					);
				} catch {
					throw new TRPCError({ code: "NOT_FOUND" });
				}
			})();
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
			const resolved =
				selection.provider === "mock"
					? undefined
					: await resolveModel(selection);
			const contextWindowTokens = resolved?.model.contextWindow ?? 128_000;
			// Usage comes from the session file's own usage blocks; there is no
			// server-side telemetry table.
			const usage = piConversationUsage(input.conversationId);
			return {
				contextTokens: usage.lastConversationTokens,
				contextWindowTokens,
				compactionAtTokens: Math.round(contextWindowTokens * 0.75),
				costMicros: usage.costMicros,
			};
		}),

	compact: protectedProcedure
		.input(z.object({ conversationId: z.string() }))
		.mutation(async ({ ctx, input }) => {
			try {
				await conversationRepository.getConversation(
					ctx.user.id,
					input.conversationId,
				);
			} catch {
				throw new TRPCError({ code: "NOT_FOUND" });
			}
			// pi compacts in its own process (auto or on demand); the session file
			// is the only recording of it.
			if (!isPiSessionReady(input.conversationId)) {
				throw new TRPCError({
					code: "BAD_REQUEST",
					message: "Conversation has no pi session to compact",
				});
			}
			await piCompact({
				userId: ctx.user.id,
				isAdmin: ctx.user.role === "admin",
				conversationId: input.conversationId,
			});
			return { success: true };
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
			try {
				await conversationRepository.setConversationModel(
					ctx.user.id,
					input.id,
					{
						provider: input.provider,
						endpointId: input.endpointId,
						modelId: input.modelId,
						modelApi: input.api,
					},
				);
			} catch {
				throw new TRPCError({ code: "NOT_FOUND" });
			}
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
			const conversation = await (async () => {
				try {
					return await conversationRepository.getConversation(
						ctx.user.id,
						input.id,
					);
				} catch {
					throw new TRPCError({ code: "NOT_FOUND" });
				}
			})();
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
			const capabilities = await effectiveModelCapabilities(selection);
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
			await conversationRepository.setConversationGenerationSettings(
				ctx.user.id,
				input.id,
				{
					reasoningEffort: input.reasoningEffort,
					verbosity: input.verbosity,
				},
			);
		}),

	move: protectedProcedure
		.input(z.object({ id: z.string(), folderId: z.string().nullable() }))
		.mutation(async ({ ctx, input }) => {
			try {
				await conversationRepository.setConversationFolder(
					ctx.user.id,
					input.id,
					input.folderId,
				);
			} catch {
				throw new TRPCError({ code: "NOT_FOUND" });
			}
		}),

	setTags: protectedProcedure
		.input(z.object({ id: z.string(), tagIds: z.array(z.string()) }))
		.mutation(async ({ ctx, input }) => {
			try {
				await conversationRepository.setConversationTags(
					ctx.user.id,
					input.id,
					input.tagIds,
				);
			} catch {
				throw new TRPCError({ code: "NOT_FOUND" });
			}
		}),

	search: protectedProcedure
		.input(z.object({ query: z.string().trim().min(1) }))
		.query(async ({ ctx, input }) => {
			const conversations = await conversationRepository.listConversations(
				ctx.user.id,
			);
			const needle = input.query.toLocaleLowerCase();
			const matchedIds = new Set<string>();
			// Scan the pi session files directly.
			for (const conversation of conversations) {
				if (
					isPiSessionReady(conversation.id) &&
					piConversationMatchesQuery(conversation.id, input.query)
				) {
					matchedIds.add(conversation.id);
				}
			}
			return conversations
				.filter(
					(conversation) =>
						matchedIds.has(conversation.id) ||
						conversation.title.toLocaleLowerCase().includes(needle),
				)
				.map(({ id, title, updatedAt }) => ({ id, title, updatedAt }));
		}),

	messages: protectedProcedure
		.input(z.object({ conversationId: z.string() }))
		.query(async ({ ctx, input }) => {
			try {
				await conversationRepository.getConversation(
					ctx.user.id,
					input.conversationId,
				);
			} catch {
				throw new TRPCError({ code: "NOT_FOUND" });
			}
			// Transcript is always served from the pi session file.
			return loadPiMessages(ctx.user.id, input.conversationId);
		}),

	getDisplayMode: protectedProcedure
		.input(z.object({ conversationId: z.string() }))
		.query(async ({ ctx, input }) => {
			const defaultDisplayMode = await getUserDefaultDisplayMode(ctx.user.id);
			const rawDisplayMode = await (async () => {
				try {
					return (
						await conversationRepository.getConversation(
							ctx.user.id,
							input.conversationId,
						)
					).displayMode;
				} catch {
					throw new TRPCError({ code: "NOT_FOUND" });
				}
			})();
			const mode =
				rawDisplayMode === "timeline" || rawDisplayMode === "compact"
					? rawDisplayMode
					: defaultDisplayMode;
			return {
				displayMode: mode as "compact" | "timeline",
				defaultDisplayMode,
			};
		}),

	setDisplayMode: protectedProcedure
		.input(
			z.object({
				conversationId: z.string(),
				displayMode: z.enum(["compact", "timeline"]),
			}),
		)
		.mutation(async ({ ctx, input }) => {
			try {
				await conversationRepository.setConversationDisplayMode(
					ctx.user.id,
					input.conversationId,
					input.displayMode,
				);
			} catch {
				throw new TRPCError({ code: "NOT_FOUND" });
			}
		}),

	setUserDefaultDisplayMode: protectedProcedure
		.input(
			z.object({
				displayMode: z.enum(["compact", "timeline"]),
			}),
		)
		.mutation(async ({ ctx, input }) => {
			await setUserDefaultDisplayMode(ctx.user.id, input.displayMode);
		}),
});

const skillRouter = router({
	list: protectedProcedure.query(async ({ ctx }) => {
		const rows = await db
			.selectFrom("skill")
			.select([
				"id",
				"name",
				"description",
				"exposed",
				"createdAt",
				"updatedAt",
			])
			.where("userId", "=", ctx.user.id)
			.orderBy("name", "asc")
			.execute();
		return rows.map((row) => ({ ...row, exposed: Boolean(row.exposed) }));
	}),
	create: protectedProcedure
		.input(z.object({ content: z.string() }))
		.mutation(async ({ ctx, input }) => {
			let parsed: { name: string; description: string };
			try {
				parsed = parseSkill(input.content);
			} catch (error) {
				throw new TRPCError({
					code: "BAD_REQUEST",
					message: error instanceof Error ? error.message : "Invalid SKILL.md",
				});
			}
			const existing = await db
				.selectFrom("skill")
				.select("id")
				.where("userId", "=", ctx.user.id)
				.where("name", "=", parsed.name)
				.executeTakeFirst();
			if (existing)
				throw new TRPCError({
					code: "CONFLICT",
					message: "Skill name already exists",
				});
			const id = crypto.randomUUID();
			const now = new Date().toISOString();
			try {
				await db
					.insertInto("skill")
					.values({
						id,
						userId: ctx.user.id,
						...parsed,
						content: input.content,
						exposed: 0,
						createdAt: now,
						updatedAt: now,
					})
					.execute();
			} catch (error) {
				if (isUniqueConstraint(error))
					throw new TRPCError({
						code: "CONFLICT",
						message: "Skill name already exists",
					});
				throw error;
			}
			return { id };
		}),
	get: protectedProcedure
		.input(z.object({ id: z.string() }))
		.query(async ({ ctx, input }) => {
			const skill = await db
				.selectFrom("skill")
				.selectAll()
				.where("id", "=", input.id)
				.where("userId", "=", ctx.user.id)
				.executeTakeFirst();
			if (!skill) throw new TRPCError({ code: "NOT_FOUND" });
			return { ...skill, exposed: Boolean(skill.exposed) };
		}),
	update: protectedProcedure
		.input(z.object({ id: z.string(), content: z.string() }))
		.mutation(async ({ ctx, input }) => {
			let parsed: { name: string; description: string };
			try {
				parsed = parseSkill(input.content);
			} catch (error) {
				throw new TRPCError({
					code: "BAD_REQUEST",
					message: error instanceof Error ? error.message : "Invalid SKILL.md",
				});
			}
			try {
				const result = await db
					.updateTable("skill")
					.set({
						...parsed,
						content: input.content,
						updatedAt: new Date().toISOString(),
					})
					.where("id", "=", input.id)
					.where("userId", "=", ctx.user.id)
					.executeTakeFirst();
				if (!result.numUpdatedRows) throw new TRPCError({ code: "NOT_FOUND" });
			} catch (error) {
				if (isUniqueConstraint(error))
					throw new TRPCError({
						code: "CONFLICT",
						message: "Skill name already exists",
					});
				throw error;
			}
		}),
	setExposed: protectedProcedure
		.input(z.object({ id: z.string(), exposed: z.boolean() }))
		.mutation(async ({ ctx, input }) => {
			const result = await db
				.updateTable("skill")
				.set({
					exposed: input.exposed ? 1 : 0,
					updatedAt: new Date().toISOString(),
				})
				.where("id", "=", input.id)
				.where("userId", "=", ctx.user.id)
				.executeTakeFirst();
			if (!result.numUpdatedRows) throw new TRPCError({ code: "NOT_FOUND" });
		}),
	remove: protectedProcedure
		.input(z.object({ id: z.string() }))
		.mutation(async ({ ctx, input }) => {
			const result = await db
				.deleteFrom("skill")
				.where("id", "=", input.id)
				.where("userId", "=", ctx.user.id)
				.executeTakeFirst();
			if (!result.numDeletedRows) throw new TRPCError({ code: "NOT_FOUND" });
		}),
});

function isUniqueConstraint(error: unknown): boolean {
	return (
		error instanceof Error &&
		(/UNIQUE constraint failed: skill\.userId, skill\.name/.test(
			error.message,
		) ||
			(error as { code?: unknown }).code === "SQLITE_CONSTRAINT_UNIQUE")
	);
}

const allowlistEntrySchema = z
	.object({
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
		image: z
			.object({
				input: z.boolean().default(true),
				aspectRatios: z
					.array(z.string().trim().min(1).max(32))
					.max(32)
					.default([]),
				resolutions: z
					.array(z.string().trim().min(1).max(32))
					.max(32)
					.default([]),
			})
			.optional(),
		reasoningEffort: z
			.enum(["minimal", "low", "medium", "high", "xhigh", "max"])
			.optional(),
		verbosity: z.enum(["low", "medium", "high"]).optional(),
		contextWindow: z.number().int().min(1).max(10_000_000).optional(),
		contextPolicy: z
			.object({
				enabled: z.boolean(),
				softTriggerTokens: z.number().int().min(1).max(10_000_000),
				targetTokens: z.number().int().min(1).max(10_000_000),
				hardInputTokens: z.number().int().min(1).max(10_000_000),
				maxPinnedAttachmentTokens: z.number().int().min(0).max(10_000_000),
				outputReserveTokens: z.number().int().min(1).max(10_000_000),
			})
			.superRefine((policy, ctx) => {
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
				if (policy.maxPinnedAttachmentTokens > policy.hardInputTokens)
					ctx.addIssue({
						code: "custom",
						path: ["maxPinnedAttachmentTokens"],
						message: "Pinned attachment budget cannot exceed hard input",
					});
			})
			.optional(),
	})
	.superRefine((entry, ctx) => {
		if (!entry.contextPolicy) return;
		const window = entry.contextWindow ?? 10_000_000;
		if (entry.contextPolicy.outputReserveTokens >= window) {
			ctx.addIssue({
				code: "custom",
				path: ["contextPolicy", "outputReserveTokens"],
				message: "Output reserve must be smaller than the context window",
			});
		}
		if (
			entry.contextPolicy.hardInputTokens >
			window - entry.contextPolicy.outputReserveTokens
		) {
			ctx.addIssue({
				code: "custom",
				path: ["contextPolicy", "hardInputTokens"],
				message: "Hard input cannot exceed the usable context window",
			});
		}
	});

const adminRouter = router({
	logLevel: adminProcedure.query(() => ({ level: getLogLevel() })),
	pasteSettings: adminProcedure.query(() => getPasteSettings()),
	setPasteSettings: adminProcedure
		.input(pasteSettingsInputSchema)
		.mutation(({ input }) =>
			setPasteSettings({ version: PASTE_SETTINGS_VERSION, ...input }),
		),

	contextManagementSettings: adminProcedure.query(async () => {
		const global = await getContextGlobalSettings();
		return {
			global: {
				...global,
				summaryPrompt:
					global.summaryPromptOverride ?? DEFAULT_CONTEXT_SUMMARY_PROMPT,
				summaryPromptOverridden: global.summaryPromptOverride !== null,
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
				const chats = await conversationRepository.listConversations(
					input.userId,
				);
				return chats.map((chat) => chat.id);
			}),

		chatRows: adminProcedure
			.input(z.object({ chatId: z.string(), userId: z.string() }))
			.query(async ({ input }) => {
				try {
					return await buildHistoryBundle(input.userId, input.chatId);
				} catch {
					throw new TRPCError({ code: "NOT_FOUND" });
				}
			}),
	}),

	history: router({
		export: adminProcedure
			.input(
				z.object({ userId: z.string(), conversationId: z.string().optional() }),
			)
			.query(async ({ input }) => {
				// Conversations export from the pi session file; metadata-only
				// conversations (no session yet) are skipped.
				const buildOne = (conversationId: string) =>
					buildHistoryBundle(input.userId, conversationId);
				if (input.conversationId) return buildOne(input.conversationId);
				const conversations = await conversationRepository.listConversations(
					input.userId,
				);
				const ready = conversations.filter((conversation) =>
					isPiSessionReady(conversation.id),
				);
				return {
					format: HISTORY_BUNDLE_FORMAT,
					exportedAt: new Date().toISOString(),
					userId: input.userId,
					conversations: await Promise.all(
						ready.map((conversation) => buildOne(conversation.id)),
					),
				};
			}),

		import: adminProcedure
			.input(
				z.object({
					userId: z.string(),
					history: z.unknown(),
					remap: z.boolean().optional(),
				}),
			)
			.mutation(async ({ input }) => {
				try {
					const history = input.history as {
						format?: string;
						conversations?: HistoryBundle[];
					} & HistoryBundle;
					const bundles =
						history.format === HISTORY_BUNDLE_FORMAT
							? (history.conversations ?? [])
							: [history];
					const results = [];
					for (const bundle of bundles) {
						const plan = await planHistoryImport(bundle, input.userId, {
							remap: input.remap,
						});
						const result = await executeHistoryImport(plan);
						results.push(result);
					}
					return bundles.length === 1 ? results[0] : { conversations: results };
				} catch (error) {
					if (error instanceof HistoryImportValidationError)
						throw new TRPCError({
							code: "BAD_REQUEST",
							message: error.message,
						});
					throw error;
				}
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
						capabilities:
							model.api === "openrouter-images"
								? null
								: await effectiveModelCapabilities({
										provider: config.provider,
										endpointId: model.endpointId,
										modelId: model.id,
										api: model.api,
									}),
					})),
				),
				imageModels: config.imageModels,
				imageCatalogModels: listImageCatalogModels(),
				apis: ALL_PROVIDER_APIS,
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
						api: z.enum(ALL_PROVIDER_APIS as unknown as [string, ...string[]]),
					}),
				),
				enabledModels: z.array(allowlistEntrySchema),
				imageModels: z.array(allowlistEntrySchema).optional(),
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
			const legacyImageModels = input.enabledModels.filter(
				(entry) => entry.image || entry.api === "openrouter-images",
			);
			const submittedImageModels = input.imageModels ?? legacyImageModels;
			const submittedChatModels = input.enabledModels.filter(
				(entry) => !entry.image && entry.api !== "openrouter-images",
			);
			const imageCatalogIds = new Set(
				listImageCatalogModels().map((model) => model.id),
			);
			for (const e of [...submittedChatModels, ...submittedImageModels]) {
				const endpoint = input.endpoints.find(
					(candidate) => candidate.id === e.endpointId,
				);
				if (e.api === "openrouter-images") {
					if (!e.image) {
						throw new TRPCError({
							code: "BAD_REQUEST",
							message: "image models require image options",
						});
					}
					if (!e.piModel || !imageCatalogIds.has(e.piModel)) {
						throw new TRPCError({
							code: "BAD_REQUEST",
							message: `map image model "${e.id}" to a pi-ai image catalog model before saving`,
						});
					}
				}
				if (e.image && e.api !== "openrouter-images") {
					throw new TRPCError({
						code: "BAD_REQUEST",
						message: "image options are only valid for OpenRouter image models",
					});
				}
				if (!endpoint || endpoint.api !== e.api) {
					throw new TRPCError({
						code: "BAD_REQUEST",
						message: `model "${e.id}" must use a configured endpoint`,
					});
				}
			}
			const existing = await db
				.selectFrom("provider_config")
				.select(["apiKey", "imageModels"])
				.where("provider", "=", input.provider)
				.executeTakeFirst();
			const imageModels =
				input.imageModels !== undefined || legacyImageModels.length > 0
					? submittedImageModels
					: parseImageAllowlist(existing?.imageModels);
			const values = {
				provider: input.provider,
				apiKey: input.apiKey || existing?.apiKey || null,
				baseUrl: null,
				endpoints: JSON.stringify(input.endpoints),
				enabledModels: JSON.stringify(submittedChatModels),
				imageModels: JSON.stringify(imageModels),
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
						imageModels: values.imageModels,
						updatedAt: values.updatedAt,
					}),
				)
				.execute();
			// pi regenerates models.json/auth.json from provider_config.
			await syncPiModelConfig(config.port);
		}),

	deleteProvider: adminProcedure
		.input(z.object({ provider: z.string().trim().min(1).max(100) }))
		.mutation(async ({ input }) => {
			await db
				.deleteFrom("provider_config")
				.where("provider", "=", input.provider)
				.execute();
			await syncPiModelConfig(config.port);
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
							api: z.enum(
								ALL_PROVIDER_APIS as unknown as [string, ...string[]],
							),
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

	startImpersonation: adminProcedure
		.input(z.object({ userId: z.string() }))
		.mutation(({ ctx, input }) => {
			if (!ctx.session) throw new TRPCError({ code: "UNAUTHORIZED" });
			if (ctx.user.id !== ctx.session.userId)
				throw new TRPCError({
					code: "BAD_REQUEST",
					message: "Already impersonating",
				});
			const target = startSolarImpersonation(
				ctx.session.id,
				ctx.user.id,
				input.userId,
			);
			if (!target) throw new TRPCError({ code: "NOT_FOUND" });
			return { name: target.name, email: target.email };
		}),

	stopImpersonation: protectedProcedure.mutation(({ ctx }) => {
		if (!ctx.session || ctx.user.id === ctx.session.userId) {
			throw new TRPCError({
				code: "BAD_REQUEST",
				message: "Not impersonating",
			});
		}
		stopSolarImpersonation(ctx.session.id);
	}),

	createUser: adminProcedure
		.input(
			z.object({
				name: z.string().trim().min(1).max(100),
				email: z.string().email(),
				password: z.string().min(8).max(128),
			}),
		)
		.mutation(async ({ input }) => {
			try {
				await createSolarUser(input);
			} catch (error) {
				throw new TRPCError({
					code: "BAD_REQUEST",
					message:
						error instanceof Error ? error.message : "Unable to create user",
				});
			}
		}),

	setUserPassword: adminProcedure
		.input(
			z.object({
				userId: z.string(),
				password: z.string().min(8).max(128),
			}),
		)
		.mutation(async ({ input }) => {
			if (!(await setSolarUserPassword(input.userId, input.password))) {
				throw new TRPCError({ code: "NOT_FOUND" });
			}
		}),

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
				!target.isDisabled &&
				countActiveAdmins() <= 1
			) {
				throw new TRPCError({
					code: "BAD_REQUEST",
					message: "At least one active admin is required",
				});
			}
			await applyUserRole(input.userId, input.role);
		}),

	listApiKeys: adminProcedure.query(({ ctx }) =>
		db
			.selectFrom("apikey")
			.select(["id", "name", "start", "createdAt"])
			.where("referenceId", "=", ctx.user.id)
			.orderBy("createdAt", "desc")
			.execute(),
	),

	createApiKey: adminProcedure
		.input(z.object({ name: z.string().trim().min(1).max(32) }))
		.mutation(async ({ ctx, input }) => {
			const key = await createSolarApiKey(input.name, ctx.user.id);
			return { id: key.id, key: key.key };
		}),

	revokeApiKey: adminProcedure
		.input(z.object({ keyId: z.string() }))
		.mutation(async ({ ctx, input }) => {
			const deleted = await db
				.deleteFrom("apikey")
				.where("id", "=", input.keyId)
				.where("referenceId", "=", ctx.user.id)
				.returning("id")
				.executeTakeFirst();
			if (!deleted) throw new TRPCError({ code: "NOT_FOUND" });
		}),

	rotateApiKey: adminProcedure
		.input(z.object({ keyId: z.string() }))
		.mutation(async ({ ctx, input }) => {
			const current = await db
				.selectFrom("apikey")
				.select("name")
				.where("id", "=", input.keyId)
				.where("referenceId", "=", ctx.user.id)
				.executeTakeFirst();
			if (!current) throw new TRPCError({ code: "NOT_FOUND" });
			const key = await createSolarApiKey(
				current.name ?? "API key",
				ctx.user.id,
			);
			await db
				.deleteFrom("apikey")
				.where("id", "=", input.keyId)
				.where("referenceId", "=", ctx.user.id)
				.execute();
			return { id: key.id, key: key.key };
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
			if (
				input.isDisabled &&
				target.role === "admin" &&
				!target.isDisabled &&
				countActiveAdmins() <= 1
			) {
				throw new TRPCError({
					code: "BAD_REQUEST",
					message: "At least one active admin is required",
				});
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
			await imageGenerationService.deleteUserWorkspaces(input.userId);
			sqlite.query("DELETE FROM user WHERE id = ?").run(input.userId);
		}),

	// Usage is derived from pi session files; conversations without a pi
	// session file have no usage to report.
	usage: adminProcedure.query(async () => {
		// Better Auth's user table lives outside the typed app schema.
		const userRows = sqlite
			.query("SELECT id AS userId, name, email FROM user ORDER BY email ASC")
			.all() as Array<{ userId: string; name: string; email: string }>;
		const usersById = new Map(userRows.map((row) => [row.userId, row]));
		const conversations = await db
			.selectFrom("conversation")
			.select(["id", "userId", "provider", "modelId"])
			.execute();
		const buckets = new Map<
			string,
			{
				userId: string;
				name: string;
				email: string;
				model: string;
				messageCount: number;
				inputTokens: number;
				outputTokens: number;
			}
		>();
		for (const row of conversations) {
			if (!isPiSessionReady(row.id)) continue;
			const usage = piConversationUsage(row.id);
			if (!usage.assistantMessageCount) continue;
			const user = usersById.get(row.userId);
			if (!user) continue;
			const model = `${row.provider ?? "unknown"}/${row.modelId ?? "unknown"}`;
			const key = `${row.userId}:${model}`;
			const bucket = buckets.get(key) ?? {
				userId: row.userId,
				name: user.name,
				email: user.email,
				model,
				messageCount: 0,
				inputTokens: 0,
				outputTokens: 0,
			};
			bucket.inputTokens += usage.inputTokens;
			bucket.outputTokens += usage.outputTokens;
			bucket.messageCount += usage.assistantMessageCount;
			buckets.set(key, bucket);
		}
		return [...buckets.values()].sort(
			(a, b) =>
				a.email.localeCompare(b.email) || a.model.localeCompare(b.model),
		);
	}),
});

/** Model capabilities for request time: pi's models.json is
 * authoritative when the model is provisioned; falls back to the
 * derivation only for provisioning-time lookups against not-yet-enabled
 * models (admin catalog browsing). */
async function effectiveModelCapabilities(selection: {
	provider: string;
	endpointId: string;
	modelId: string;
	api: string;
}) {
	const entry = (await loadProviderConfigs())
		.find((config) => config.provider === selection.provider)
		?.enabledModels.find(
			(candidate) =>
				candidate.id === selection.modelId &&
				candidate.endpointId === selection.endpointId &&
				candidate.api === selection.api,
		);
	const piCaps = piModelCapabilities(selection);
	if (!piCaps) return getModelCapabilities(selection);
	return {
		reasoningLevels: piCaps.reasoningLevels,
		supportsVerbosity: piCaps.supportsVerbosity,
		defaultReasoningEffort: entry?.reasoningEffort ?? null,
		defaultVerbosity: entry?.verbosity ?? null,
		contextWindow: piCaps.contextWindow ?? 128_000,
	};
}

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
			const convo = await (async () => {
				try {
					const record = await conversationRepository.getConversation(
						ctx.user.id,
						input.conversationId,
					);
					return {
						provider: record.provider,
						endpointId: record.endpointId,
						modelId: record.modelId,
						modelApi: record.modelApi,
						reasoningEffort: record.reasoningEffort,
						presetReasoningEffort: null as string | null,
						verbosity: record.verbosity,
						presetVerbosity: null as string | null,
					};
				} catch {
					throw new TRPCError({ code: "NOT_FOUND" });
				}
			})();
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
			const capabilities = await effectiveModelCapabilities(selection);
			const documentMimeTypes = await documentInputMimeTypes(selection);
			console.info("[attachments] model capability", {
				conversationId: input.conversationId,
				selection,
				documents: descriptor?.documents ?? false,
				documentMimeTypes,
			});
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
	return preset;
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

	userDefault: protectedProcedure.query(async ({ ctx }) => {
		return getUserDefaultPreset(ctx.user.id);
	}),

	setUserDefault: protectedProcedure
		.input(z.object({ id: z.string().nullable() }))
		.mutation(async ({ ctx, input }) => {
			if (input.id) {
				const preset = await db
					.selectFrom("preset")
					.selectAll()
					.where("id", "=", input.id)
					.executeTakeFirst();
				if (!preset) throw new TRPCError({ code: "NOT_FOUND" });
				if (preset.userId !== ctx.user.id && preset.scope !== "shared") {
					throw new TRPCError({ code: "FORBIDDEN" });
				}
				await assertCanUseModel(
					{
						provider: preset.provider,
						endpointId: preset.endpointId ?? preset.modelApi,
						modelId: preset.modelId,
						api: preset.modelApi,
					},
					ctx.user.role === "admin",
				);
			}
			await setUserDefaultPreset(ctx.user.id, input.id);
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
			const preset = await assertCanEditPreset(ctx.user.id, isAdmin, input.id);
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
			if (input.scope === "personal") {
				await db
					.updateTable("user_setting")
					.set({ defaultPresetId: null, updatedAt: new Date().toISOString() })
					.where("defaultPresetId", "=", input.id)
					.where("userId", "!=", preset.userId)
					.execute();
			}
		}),

	remove: protectedProcedure
		.input(z.object({ id: z.string() }))
		.mutation(async ({ ctx, input }) => {
			const isAdmin = (ctx.user as { role?: string }).role === "admin";
			await assertCanEditPreset(ctx.user.id, isAdmin, input.id);
			await db
				.updateTable("user_setting")
				.set({ defaultPresetId: null, updatedAt: new Date().toISOString() })
				.where("defaultPresetId", "=", input.id)
				.execute();
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
			const [conversation, bindings, servers] = await (async () => {
				try {
					const conv = await conversationRepository.getConversation(
						ctx.user.id,
						input.conversationId,
					);
					const bindingRows =
						await conversationRepository.listConversationMcpServers(
							ctx.user.id,
							input.conversationId,
						);
					const serverRows = await db
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
						.select([
							"mcp_server.id",
							"mcp_server.name",
							"mcp_server.enabled",
							"user_mcp_server_preference.enabled as preferenceEnabled",
						])
						.where("mcp_server.enabled", "=", 1)
						.where((eb) =>
							eb.or([
								eb("mcp_server.userId", "is", null),
								eb("mcp_server.userId", "=", ctx.user.id),
							]),
						)
						.execute();
					return [conv, bindingRows, serverRows] as const;
				} catch {
					throw new TRPCError({ code: "NOT_FOUND" });
				}
			})();
			const bindingByServer = new Map(
				bindings.map((binding) => [binding.serverId, binding.enabled]),
			);
			return {
				autoExecuteTools: Boolean(conversation.autoExecuteTools),
				servers: servers.map((server) => ({
					id: server.id,
					name: server.name,
					enabled:
						bindingByServer.get(server.id) ??
						Boolean(server.preferenceEnabled ?? 1),
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
			const server = await getMcpServer(input.serverId);
			if (server.userId !== null && server.userId !== ctx.user.id)
				throw new TRPCError({ code: "FORBIDDEN" });
			try {
				await conversationRepository.setConversationMcpServer(
					ctx.user.id,
					input.conversationId,
					input.serverId,
					input.enabled,
				);
			} catch {
				throw new TRPCError({ code: "NOT_FOUND" });
			}
		}),

	setAutoExecute: protectedProcedure
		.input(z.object({ conversationId: z.string(), enabled: z.boolean() }))
		.mutation(async ({ ctx, input }) => {
			try {
				await conversationRepository.setConversationAutoExecuteTools(
					ctx.user.id,
					input.conversationId,
					input.enabled,
				);
			} catch {
				throw new TRPCError({ code: "NOT_FOUND" });
			}
		}),
});

const folderRouter = router({
	list: protectedProcedure.query(async ({ ctx }) => {
		return conversationRepository.listFolders(ctx.user.id);
	}),

	create: protectedProcedure
		.input(z.object({ name: z.string().trim().min(1).max(100) }))
		.mutation(async ({ ctx, input }) => {
			const folder = await conversationRepository.createFolder(ctx.user.id, {
				name: input.name,
			});
			return { id: folder.id };
		}),

	rename: protectedProcedure
		.input(
			z.object({ id: z.string(), name: z.string().trim().min(1).max(100) }),
		)
		.mutation(async ({ ctx, input }) => {
			try {
				await conversationRepository.renameFolder(
					ctx.user.id,
					input.id,
					input.name,
				);
			} catch {
				throw new TRPCError({ code: "NOT_FOUND" });
			}
		}),

	remove: protectedProcedure
		.input(z.object({ id: z.string() }))
		.mutation(async ({ ctx, input }) => {
			try {
				await conversationRepository.deleteFolder(ctx.user.id, input.id);
			} catch {
				throw new TRPCError({ code: "NOT_FOUND" });
			}
		}),
});

const tagRouter = router({
	list: protectedProcedure.query(async ({ ctx }) => {
		return conversationRepository.listTags(ctx.user.id);
	}),

	create: protectedProcedure
		.input(z.object({ name: z.string().trim().min(1).max(50) }))
		.mutation(async ({ ctx, input }) => {
			// Reuse an existing tag of the same name (unique per user).
			const existing = await conversationRepository.findTagByName(
				ctx.user.id,
				input.name,
			);
			if (existing) return { id: existing.id };
			const tag = await conversationRepository.createTag(ctx.user.id, {
				name: input.name,
			});
			return { id: tag.id };
		}),

	remove: protectedProcedure
		.input(z.object({ id: z.string() }))
		.mutation(async ({ ctx, input }) => {
			try {
				await conversationRepository.deleteTag(ctx.user.id, input.id);
			} catch {
				throw new TRPCError({ code: "NOT_FOUND" });
			}
		}),
});

function imageProcedureError(error: unknown): never {
	if (error instanceof ImageNotFoundError)
		throw new TRPCError({ code: "NOT_FOUND", message: error.message });
	if (
		error instanceof ImageWorkspaceBusyError ||
		error instanceof ImageWorkspaceStartedError ||
		error instanceof ImageStorageError
	)
		throw new TRPCError({ code: "BAD_REQUEST", message: error.message });
	throw error;
}

function imageAssetUrl(workspaceId: string, assetId: string, download = false) {
	return `/api/images/${encodeURIComponent(workspaceId)}/assets/${encodeURIComponent(assetId)}${download ? "/download" : ""}`;
}

function mapImageWorkspace(
	data: Awaited<ReturnType<typeof imageGenerationService.getWorkspace>>,
) {
	const promptByAsset = new Map(
		data.attempts
			.filter((attempt) => attempt.resultAssetId)
			.map((attempt) => [attempt.resultAssetId as string, attempt.prompt]),
	);
	const assets = data.assets.map((asset) => ({
		id: asset.id,
		url: imageAssetUrl(data.workspace.id, asset.id),
		downloadUrl: imageAssetUrl(data.workspace.id, asset.id, true),
		mimeType: asset.mimeType,
		filename: asset.filename,
		byteSize: asset.byteSize,
		width: asset.width,
		height: asset.height,
		prompt: promptByAsset.get(asset.id) ?? null,
		sourceVariantId: asset.sourceAssetId,
		createdAt: asset.createdAt,
	}));
	const assetById = new Map(assets.map((asset) => [asset.id, asset]));
	const attempts = data.attempts.map((attempt) => ({
		id: attempt.id,
		status: attempt.status,
		prompt: attempt.prompt,
		error: attempt.errorMessage,
		errorMessage: attempt.errorMessage,
		createdAt: attempt.createdAt,
		finishedAt: attempt.finishedAt,
		costMicros: attempt.costMicros,
		resultAssetId: attempt.resultAssetId,
		asset: attempt.resultAssetId
			? (assetById.get(attempt.resultAssetId) ?? null)
			: null,
	}));
	const activeAttempt = attempts.find((attempt) =>
		["queued", "running"].includes(attempt.status),
	);
	return {
		id: data.workspace.id,
		title: data.workspace.title,
		createdAt: data.workspace.createdAt,
		updatedAt: data.workspace.updatedAt,
		modelId: data.workspace.modelId,
		aspectRatio: data.workspace.aspectRatio,
		resolution: data.workspace.resolution,
		assets,
		variants: assets,
		attempts,
		activeAttempt: activeAttempt ?? null,
		currentAssetId: data.currentAssetId,
	};
}

const imageRouter = router({
	list: protectedProcedure.query(async ({ ctx }) => {
		const workspaces = await imageGenerationService.listWorkspaces(ctx.user.id);
		return Promise.all(
			workspaces.map(async (workspace) => {
				const data = await imageGenerationService.getWorkspace(
					ctx.user.id,
					workspace.id,
				);
				const latest = data.assets.at(-1);
				const active = data.activeAttempt;
				return {
					id: workspace.id,
					title: workspace.title,
					createdAt: workspace.createdAt,
					updatedAt: workspace.updatedAt,
					thumbnailUrl: latest ? imageAssetUrl(workspace.id, latest.id) : null,
					status: active?.status ?? data.attempts[0]?.status ?? null,
				};
			}),
		);
	}),

	get: protectedProcedure
		.input(z.object({ workspaceId: z.string().uuid() }))
		.query(async ({ ctx, input }) => {
			try {
				return mapImageWorkspace(
					await imageGenerationService.getWorkspace(
						ctx.user.id,
						input.workspaceId,
					),
				);
			} catch (error) {
				return imageProcedureError(error);
			}
		}),

	models: protectedProcedure.query(async ({ ctx }) =>
		listAvailableImageModels(ctx.user.role === "admin"),
	),

	create: protectedProcedure
		.input(z.object({ title: z.string().trim().max(200).optional() }))
		.mutation(async ({ ctx, input }) =>
			imageGenerationService.createWorkspace(ctx.user.id, input.title),
		),

	generate: protectedProcedure
		.input(
			z.object({
				workspaceId: z.string().uuid(),
				sourceAssetId: z.string().uuid().nullable().optional(),
				prompt: z.string().trim().min(1).max(20_000),
				modelId: z.string().trim().min(1).max(300),
				provider: z.string().trim().max(100).optional(),
				endpointId: z.string().trim().max(100).optional(),
				api: z.string().trim().max(100).optional(),
				aspectRatio: z.string().trim().min(1).max(32),
				resolution: z.string().trim().min(1).max(32),
				requestKey: z.string().uuid().optional(),
			}),
		)
		.mutation(async ({ ctx, input }) => {
			const models = await listAvailableImageModels(ctx.user.role === "admin");
			const model = models.find(
				(candidate) =>
					candidate.modelId === input.modelId &&
					(!input.provider || candidate.provider === input.provider) &&
					(!input.endpointId || candidate.endpointId === input.endpointId) &&
					(!input.api || candidate.api === input.api),
			);
			if (!model)
				throw new TRPCError({
					code: "BAD_REQUEST",
					message: "Image model unavailable",
				});
			if (
				model.aspectRatios.length > 0 &&
				!model.aspectRatios.includes(input.aspectRatio)
			)
				throw new TRPCError({
					code: "BAD_REQUEST",
					message: "Aspect ratio unavailable",
				});
			if (
				model.resolutions.length > 0 &&
				!model.resolutions.includes(input.resolution)
			)
				throw new TRPCError({
					code: "BAD_REQUEST",
					message: "Resolution unavailable",
				});
			try {
				const attempt = await imageGenerationService.startGeneration({
					userId: ctx.user.id,
					workspaceId: input.workspaceId,
					sourceAssetId: input.sourceAssetId ?? null,
					prompt: input.prompt,
					modelId: model.modelId,
					provider: model.provider,
					endpointId: model.endpointId,
					api: model.api,
					aspectRatio: input.aspectRatio,
					resolution: input.resolution,
					requestKey: input.requestKey,
				});
				return {
					id: attempt.id,
					status: attempt.status,
					prompt: attempt.prompt,
					error: attempt.errorMessage,
					createdAt: attempt.createdAt,
				};
			} catch (error) {
				return imageProcedureError(error);
			}
		}),

	retry: protectedProcedure
		.input(z.object({ attemptId: z.string().uuid() }))
		.mutation(async ({ ctx, input }) => {
			try {
				const attempt = await imageGenerationService.retry(
					ctx.user.id,
					input.attemptId,
				);
				return {
					id: attempt.id,
					status: attempt.status,
					prompt: attempt.prompt,
					error: attempt.errorMessage,
					createdAt: attempt.createdAt,
				};
			} catch (error) {
				return imageProcedureError(error);
			}
		}),

	remove: protectedProcedure
		.input(z.object({ workspaceId: z.string().uuid() }))
		.mutation(async ({ ctx, input }) => {
			try {
				await imageGenerationService.deleteWorkspace(
					ctx.user.id,
					input.workspaceId,
				);
			} catch (error) {
				return imageProcedureError(error);
			}
		}),
});

export const appRouter = router({
	pasteSettings: protectedProcedure.query(() => getPasteSettings()),
	sourceCategories: protectedProcedure
		.input(z.object({ urls: z.array(z.string().url()).max(20) }))
		.query(({ input }) => new SourceCategoryResolver(db).resolve(input.urls)),
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

	me: publicProcedure.query(({ ctx }) => ({
		user: ctx.user,
		impersonation: ctx.impersonation,
	})),

	/** Which optional auth providers and deployment modes are configured. */
	authProviders: publicProcedure.query(() => ({
		google: Boolean(
			!config.airgapMode && config.googleClientId && config.googleClientSecret,
		),
		// Only the button label. The issuer and client id stay server-side; this
		// query is unauthenticated. OIDC is not disabled by airgap mode because a
		// self-hosted IdP is the operator's own service, not a third party.
		oidc: config.oidc ? { displayName: config.oidc.displayName } : null,
		airgap: config.airgapMode,
	})),

	conversation: conversationRouter,
	folder: folderRouter,
	tag: tagRouter,
	model: modelRouter,
	preset: presetRouter,
	mcp: mcpRouter,
	skill: skillRouter,
	image: imageRouter,
	admin: adminRouter,
});

/** Exported for the web app's type-only tRPC client. */
export type AppRouter = typeof appRouter;
