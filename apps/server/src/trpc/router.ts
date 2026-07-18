import { initTRPC, TRPCError } from "@trpc/server";
import { z } from "zod";
import { db, sqlite } from "../db";
import { deleteAttachmentFilesForMessages, deleteAttachmentFilesForUser } from "../chat/attachments";
import { generationManager } from "../chat/generationManager";
import {
  getAdminDefault,
  getModelCapabilities,
  getTaskModel,
  getUserDefault,
  listAvailableModels,
  PROVIDER_APIS,
  resolveSelection,
  setAdminDefault,
  setTaskModel,
  setUserDefault,
  SUPPORTED_PROVIDERS,
} from "../chat/catalog";
import type { TrpcContext } from "./context";
import { getLogLevel, setLogLevel, type SolarLogLevel } from "../logger";

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

const conversationRouter = router({
  list: protectedProcedure.query(async ({ ctx }) => {
    const conversations = await db
      .selectFrom("conversation")
      .select([
        "id",
        "title",
        "folderId",
        "provider",
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
      .select(["conversation_tag.conversationId", "tag.id as tagId", "tag.name"])
      .where("tag.userId", "=", ctx.user.id)
      .execute();

    const tagsByConversation = new Map<string, { id: string; name: string }[]>();
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
        modelId: string | null;
        modelApi: string | null;
        systemPrompt: string | null;
        reasoningEffort: string | null;
        reasoningSummary: number;
        verbosity: string | null;
      } = {
        provider: null,
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
          snapshot = {
            provider: preset.provider,
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
    .input(z.object({ id: z.string(), title: z.string().trim().min(1).max(200) }))
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

  setModel: protectedProcedure
    .input(
      z.object({
        id: z.string(),
        provider: z.string(),
        modelId: z.string(),
        api: z.string(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      await assertOwnsConversation(ctx.user.id, input.id);
      // Only allow selecting a model the user actually has access to.
      const available = await listAvailableModels();
      const ok = available.some(
        (m) =>
          m.provider === input.provider &&
          m.modelId === input.modelId &&
          m.api === input.api,
      );
      if (!ok) throw new TRPCError({ code: "BAD_REQUEST", message: "model unavailable" });
      await db
        .updateTable("conversation")
        .set({
          provider: input.provider,
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
        reasoningEffort: z.enum(["minimal", "low", "medium", "high", "xhigh", "max"]).nullable().optional(),
        verbosity: z.enum(["low", "medium", "high"]).nullable().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      await assertOwnsConversation(ctx.user.id, input.id);
      const conversation = await db
        .selectFrom("conversation")
        .select(["provider", "modelId", "modelApi", "presetReasoningEffort", "presetVerbosity"])
        .where("id", "=", input.id)
        .executeTakeFirstOrThrow();
      const selection = await resolveSelection(
        {
          provider: conversation.provider ?? undefined,
          modelId: conversation.modelId ?? undefined,
          api: conversation.modelApi ?? undefined,
        },
        ctx.user.id,
      );
      const capabilities = await getModelCapabilities(selection);
      if (
        input.reasoningEffort !== undefined &&
        input.reasoningEffort !== null &&
        !capabilities.reasoningLevels.includes(input.reasoningEffort)
      ) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "reasoning effort unavailable" });
      }
      if (input.verbosity !== undefined && input.verbosity !== null && !capabilities.supportsVerbosity) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "verbosity unavailable" });
      }
      await db
        .updateTable("conversation")
        .set({
          ...(input.reasoningEffort !== undefined
            ? { reasoningEffort: input.reasoningEffort ?? conversation.presetReasoningEffort }
            : {}),
          ...(input.verbosity !== undefined
            ? { verbosity: input.verbosity ?? conversation.presetVerbosity }
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
        .select(["conversation.id", "conversation.title", "conversation.updatedAt"])
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
        return {
          id: m.id,
          role: m.role,
          text: m.text,
          status: m.status,
          createdAt: m.createdAt,
          reasoning,
          attachments: (attachmentsByMessage.get(m.id) ?? []).map((a) => ({
            id: a.id,
            filename: a.filename,
            mimeType: a.mimeType,
            kind: a.kind,
          })),
          isActive: m.status === "generating" && generationManager.isActive(m.id),
        };
      });
    }),
});

const allowlistEntrySchema = z.object({
  id: z.string().trim().min(1),
  api: z.string().trim().min(1),
});

const adminRouter = router({
  logLevel: adminProcedure.query(() => ({ level: getLogLevel() })),

  setLogLevel: adminProcedure
    .input(z.object({ level: z.enum(["trace", "debug", "info", "warn", "error"]) }))
    .mutation(({ input }) => {
      setLogLevel(input.level as SolarLogLevel);
    }),

  listProviders: adminProcedure.query(async () => {
    const rows = await db
      .selectFrom("provider_config")
      .select(["provider", "apiKey", "baseUrl", "enabledModels"])
      .execute();
    const byProvider = new Map(rows.map((r) => [r.provider, r]));
    return SUPPORTED_PROVIDERS.map((provider) => {
      const row = byProvider.get(provider);
      let enabledModels: { id: string; api: string }[] = [];
      if (row?.enabledModels) {
        try {
          const parsed = JSON.parse(row.enabledModels);
          if (Array.isArray(parsed)) enabledModels = parsed;
        } catch {
          /* ignore malformed */
        }
      }
      return {
        provider,
        hasApiKey: Boolean(row?.apiKey),
        baseUrl: row?.baseUrl ?? "",
        enabledModels,
        apis: PROVIDER_APIS[provider] ?? [],
      };
    });
  }),

  setProvider: adminProcedure
    .input(
      z.object({
        provider: z.enum(SUPPORTED_PROVIDERS as [string, ...string[]]),
        apiKey: z.string().trim().nullish(),
        baseUrl: z.string().trim().nullish(),
        enabledModels: z.array(allowlistEntrySchema),
      }),
    )
    .mutation(async ({ input }) => {
      // Reject allowlist entries whose api is not valid for the provider.
      const validApis = PROVIDER_APIS[input.provider] ?? [];
      for (const e of input.enabledModels) {
        if (!validApis.includes(e.api)) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: `api "${e.api}" is not valid for ${input.provider}`,
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
        baseUrl: input.baseUrl || null,
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
            enabledModels: values.enabledModels,
            updatedAt: values.updatedAt,
          }),
        )
        .execute();
    }),

  listUsers: adminProcedure.query(() =>
    sqlite.query(
      "SELECT id, name, email, role, isDisabled, createdAt FROM user ORDER BY createdAt ASC",
    ).all() as {
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
        throw new TRPCError({ code: "BAD_REQUEST", message: "You cannot change your own role" });
      }
      const target = sqlite.query("SELECT role, isDisabled FROM user WHERE id = ?").get(input.userId) as
        | { role: string; isDisabled: number }
        | null;
      if (!target) throw new TRPCError({ code: "NOT_FOUND" });
      if (target.role === "admin" && input.role === "user" && !target.isDisabled) {
        const admins = sqlite.query("SELECT COUNT(*) AS count FROM user WHERE role = 'admin' AND isDisabled = 0").get() as { count: number };
        if (admins.count <= 1) {
          throw new TRPCError({ code: "BAD_REQUEST", message: "At least one active admin is required" });
        }
      }
      sqlite.query("UPDATE user SET role = ? WHERE id = ?").run(input.role, input.userId);
    }),

  setUserDisabled: adminProcedure
    .input(z.object({ userId: z.string(), isDisabled: z.boolean() }))
    .mutation(async ({ ctx, input }) => {
      if (input.userId === ctx.user.id) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "You cannot disable your own account" });
      }
      const target = sqlite.query("SELECT role, isDisabled FROM user WHERE id = ?").get(input.userId) as
        | { role: string; isDisabled: number }
        | null;
      if (!target) throw new TRPCError({ code: "NOT_FOUND" });
      if (input.isDisabled && target.role === "admin" && !target.isDisabled) {
        const admins = sqlite.query("SELECT COUNT(*) AS count FROM user WHERE role = 'admin' AND isDisabled = 0").get() as { count: number };
        if (admins.count <= 1) {
          throw new TRPCError({ code: "BAD_REQUEST", message: "At least one active admin is required" });
        }
      }
      sqlite.query("UPDATE user SET isDisabled = ? WHERE id = ?").run(input.isDisabled ? 1 : 0, input.userId);
      if (input.isDisabled) sqlite.query("DELETE FROM session WHERE userId = ?").run(input.userId);
    }),

  deleteUser: adminProcedure
    .input(z.object({ userId: z.string() }))
    .mutation(async ({ ctx, input }) => {
      if (input.userId === ctx.user.id) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "You cannot delete your own account" });
      }
      const target = sqlite.query("SELECT role, isDisabled FROM user WHERE id = ?").get(input.userId) as
        | { role: string; isDisabled: number }
        | null;
      if (!target) throw new TRPCError({ code: "NOT_FOUND" });
      if (target.role === "admin" && !target.isDisabled) {
        const admins = sqlite.query("SELECT COUNT(*) AS count FROM user WHERE role = 'admin' AND isDisabled = 0").get() as { count: number };
        if (admins.count <= 1) {
          throw new TRPCError({ code: "BAD_REQUEST", message: "At least one active admin is required" });
        }
      }
      await deleteAttachmentFilesForUser(input.userId);
      sqlite.query("DELETE FROM user WHERE id = ?").run(input.userId);
    }),

  usage: adminProcedure.query(() =>
    sqlite.query(`
      SELECT u.id AS userId, u.name, u.email, COALESCE(m.model, 'unknown') AS model,
        COUNT(*) AS messageCount, COALESCE(SUM(m.inputTokens), 0) AS inputTokens,
        COALESCE(SUM(m.outputTokens), 0) AS outputTokens
      FROM message m
      JOIN conversation c ON c.id = m.conversationId
      JOIN user u ON u.id = c.userId
      WHERE m.role = 'assistant'
      GROUP BY u.id, u.name, u.email, m.model
      ORDER BY u.email ASC, model ASC
    `).all() as {
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
  modelId: z.string(),
  api: z.string(),
});

const modelRouter = router({
  /** Models the current user may select (allowlist + mock). */
  available: protectedProcedure.query(async () => {
    return listAvailableModels();
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
          modelId: convo?.modelId ?? undefined,
          api: convo?.modelApi ?? undefined,
        },
        ctx.user.id,
      );
      const available = await listAvailableModels();
      const descriptor = available.find(
        (m) =>
          m.provider === selection.provider &&
          m.modelId === selection.modelId &&
          m.api === selection.api,
      );
      const capabilities = await getModelCapabilities(selection);
      return {
        ...(descriptor ?? { ...selection, name: selection.modelId, reasoning: false, vision: false }),
        ...capabilities,
        reasoningEffort: convo?.reasoningEffort ?? null,
        presetReasoningEffort: convo?.presetReasoningEffort ?? null,
        verbosity: convo?.verbosity ?? null,
        presetVerbosity: convo?.presetVerbosity ?? null,
      };
    }),

  /** The current user's personal default model, if any. */
  userDefault: protectedProcedure.query(async ({ ctx }) => {
    return getUserDefault(ctx.user.id);
  }),

  setUserDefault: protectedProcedure
    .input(modelSelectionSchema)
    .mutation(async ({ ctx, input }) => {
      await setUserDefault(ctx.user.id, input);
    }),

  adminDefault: adminProcedure.query(async () => {
    return getAdminDefault();
  }),

  setAdminDefault: adminProcedure
    .input(modelSelectionSchema)
    .mutation(async ({ input }) => {
      await setAdminDefault(input);
    }),

  taskModel: adminProcedure.query(() => getTaskModel()),

  setTaskModel: adminProcedure
    .input(modelSelectionSchema)
    .mutation(async ({ input }) => {
      const available = await listAvailableModels();
      const isAvailable = available.some(
        (model) =>
          model.provider === input.provider &&
          model.modelId === input.modelId &&
          model.api === input.api,
      );
      if (!isAvailable) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "model unavailable" });
      }
      await setTaskModel(input);
    }),
});

const presetInputSchema = z.object({
  name: z.string().trim().min(1).max(100),
  scope: z.enum(["personal", "shared"]),
  provider: z.string(),
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
        eb.or([
          eb("userId", "=", ctx.user.id),
          eb("scope", "=", "shared"),
        ]),
      )
      .orderBy("name", "asc")
      .execute();
    return rows.map((r) => ({
      ...r,
      reasoningSummary: Boolean(r.reasoningSummary),
      owned: r.userId === ctx.user.id,
    }));
  }),

  create: protectedProcedure
    .input(presetInputSchema)
    .mutation(async ({ ctx, input }) => {
      const id = crypto.randomUUID();
      await db
        .insertInto("preset")
        .values({
          id,
          userId: ctx.user.id,
          name: input.name,
          scope: input.scope,
          provider: input.provider,
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
      await db
        .updateTable("preset")
        .set({
          name: input.name,
          scope: input.scope,
          provider: input.provider,
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
    .input(z.object({ id: z.string(), name: z.string().trim().min(1).max(100) }))
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
    return { ok: true, service: "solar-server", schemaVersion: row?.value ?? null };
  }),

  me: publicProcedure.query(({ ctx }) => ({ user: ctx.user })),

  conversation: conversationRouter,
  folder: folderRouter,
  tag: tagRouter,
  model: modelRouter,
  preset: presetRouter,
  admin: adminRouter,
});

/** Exported for the web app's type-only tRPC client. */
export type AppRouter = typeof appRouter;
