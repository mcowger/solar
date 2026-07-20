import type {
	AssistantMessage,
	Context as PiContext,
	Message as PiMessage,
} from "@earendil-works/pi-ai";
import {
	convertToLlm,
	createCompactionSummaryMessage,
} from "@earendil-works/pi-agent-core";
import { Hono } from "hono";
import { getSolarSession } from "../auth";
import { db, sqlite } from "../db";
import { logger } from "../logger";
import {
	deleteAttachmentFilesForMessages,
	attachmentMetadata,
	linkAttachments,
	loadAttachmentContentParts,
	loadAttachmentSummary,
} from "./attachments";
import {
	getTitlePrompt,
	getModelCapabilities,
	documentInputCapabilities,
	resolveSelection,
	resolveTaskModelOrFallback,
	documentInputMimeTypes,
	type GenerationParams,
} from "./catalog";
import { generationManager } from "./generationManager";
import type { DocumentInputCapabilities } from "./nativeAttachmentAdapters";
import { toolProvider } from "./tools";
import { contextRuntime } from "../context/runtime";
import { ContextRepository } from "../context/repository";
import {
	renderBuiltinPromptInterpolations,
	type UserLocation,
} from "./builtins";
import { reverseGeocode } from "./location";

export const chatRoutes = new Hono();

interface AuthenticatedUser {
	id: string;
	isAdmin: boolean;
}

async function requireUser(req: Request): Promise<AuthenticatedUser | null> {
	const principal = await getSolarSession(req.headers);
	if (!principal) return null;
	return { id: principal.user.id, isAdmin: principal.user.role === "admin" };
}

async function ownsConversation(userId: string, conversationId: string) {
	const row = await db
		.selectFrom("conversation")
		.select("id")
		.where("id", "=", conversationId)
		.where("userId", "=", userId)
		.executeTakeFirst();
	return Boolean(row);
}

/** Reconstruct pi context from persisted messages (DB-canonical, per turn). */
async function buildContext(
	conversationId: string,
	systemPrompt?: string | null,
	documentInput: DocumentInputCapabilities = {
		nativeMimeTypes: [],
		extractedTextMimeTypes: [],
	},
	messageIds?: ReadonlySet<string>,
	summary?: string | null,
	allowedAttachmentIds?: ReadonlySet<string>,
): Promise<{
	context: PiContext;
	documents: import("./attachments").NativeDocumentInput[];
}> {
	const rows = await db
		.selectFrom("message")
		.select(["id", "role", "text", "parts"])
		.where("conversationId", "=", conversationId)
		.where("status", "=", "complete")
		.orderBy("createdAt", "asc")
		.execute();

	const messages: PiMessage[] = [];
	const documents: import("./attachments").NativeDocumentInput[] = [];
	for (const r of rows) {
		if (messageIds && !messageIds.has(r.id)) continue;
		if (r.role === "user") {
			const attachmentContent = await loadAttachmentContentParts(
				r.id,
				documentInput,
				allowedAttachmentIds,
			);
			documents.push(...attachmentContent.documents);
			const content =
				attachmentContent.parts.length === 0
					? r.text
					: [
							...(r.text ? [{ type: "text" as const, text: r.text }] : []),
							...attachmentContent.parts,
						];
			messages.push({ role: "user", content, timestamp: Date.now() });
		} else if (r.role === "assistant") {
			const steps = await db
				.selectFrom("generation_step")
				.select("data")
				.where("messageId", "=", r.id)
				.orderBy("sequence", "asc")
				.execute();
			for (const step of steps) {
				const parsed = JSON.parse(step.data) as { role?: unknown };
				if (typeof parsed.role === "string") messages.push(parsed as PiMessage);
			}
			// Intermediate tool/reasoning messages precede the final persisted reply.
			if (r.parts) {
				const message = JSON.parse(r.parts) as AssistantMessage;
				// Completed thinking is private scratch work; tool calls remain in their persisted steps.
				messages.push({
					...message,
					content: message.content.filter((part) => part.type !== "thinking"),
				});
			} else
				messages.push({
					role: "assistant",
					content: [{ type: "text", text: r.text }],
					timestamp: Date.now(),
					api: "unknown",
					provider: "unknown",
					model: "unknown",
					usage: {},
					stopReason: "stop",
				} as AssistantMessage);
		}
	}
	if (summary) {
		const summaryMessage = convertToLlm([
			createCompactionSummaryMessage(summary, 0, new Date().toISOString()),
		])[0]!;
		const firstUserIndex = messages.findIndex(
			(message) => message.role === "user",
		);
		messages.splice(
			firstUserIndex < 0 ? 0 : firstUserIndex + 1,
			0,
			summaryMessage,
		);
	}
	return {
		context: systemPrompt ? { systemPrompt, messages } : { messages },
		documents,
	};
}

const sseHeaders = {
	"content-type": "text/event-stream",
	"cache-control": "no-cache",
	connection: "keep-alive",
};

function parseUserLocation(value: unknown): UserLocation | undefined {
	if (!value || typeof value !== "object") return undefined;
	const location = value as Record<string, unknown>;
	const timeZone =
		typeof location.timeZone === "string" ? location.timeZone : undefined;
	const latitude =
		typeof location.latitude === "number" &&
		Number.isFinite(location.latitude) &&
		location.latitude >= -90 &&
		location.latitude <= 90
			? location.latitude
			: undefined;
	const longitude =
		typeof location.longitude === "number" &&
		Number.isFinite(location.longitude) &&
		location.longitude >= -180 &&
		location.longitude <= 180
			? location.longitude
			: undefined;
	const accuracy =
		typeof location.accuracy === "number" &&
		Number.isFinite(location.accuracy) &&
		location.accuracy >= 0
			? location.accuracy
			: undefined;
	const timestamp =
		typeof location.timestamp === "number" &&
		Number.isFinite(location.timestamp)
			? location.timestamp
			: undefined;
	return timeZone || latitude !== undefined || longitude !== undefined
		? { timeZone, latitude, longitude, accuracy, timestamp }
		: undefined;
}

/** Deletes messages matching the predicate, freeing their attachments' on-disk
 * files first (SQLite's ON DELETE CASCADE only removes the DB rows). */
async function deleteMessages(
	conversationId: string,
	createdAt: string,
	op: ">" | ">=",
): Promise<void> {
	const toDelete = await db
		.selectFrom("message")
		.select("id")
		.where("conversationId", "=", conversationId)
		.where("createdAt", op, createdAt)
		.execute();
	await deleteAttachmentFilesForMessages(toDelete.map((m) => m.id));
	await db
		.deleteFrom("message")
		.where("conversationId", "=", conversationId)
		.where("createdAt", op, createdAt)
		.execute();
}

/** Look up a message with its owning user id (for authorization). */
async function getOwnedMessage(userId: string, messageId: string) {
	const row = await db
		.selectFrom("message")
		.innerJoin("conversation", "conversation.id", "message.conversationId")
		.select([
			"message.id",
			"message.conversationId",
			"message.role",
			"message.createdAt",
			"conversation.userId",
		])
		.where("message.id", "=", messageId)
		.executeTakeFirst();
	return row && row.userId === userId ? row : null;
}

/**
 * Insert a fresh assistant placeholder, kick off a decoupled generation from
 * the current DB-canonical context, and return its SSE stream. Callers mutate
 * the message history first (send/edit/regenerate) so `buildContext` sees the
 * intended state.
 */
async function streamNewAssistantTurn(
	conversationId: string,
	userId: string,
	isAdmin: boolean,
	userLocation?: UserLocation,
	titleGeneration?: { firstMessage: string },
): Promise<string> {
	// Resolve the model for this turn, then persist it so the conversation
	// remembers the effective selection (defaults are resolved lazily).
	const convo = await db
		.selectFrom("conversation")
		.select([
			"provider",
			"endpointId",
			"modelId",
			"modelApi",
			"systemPrompt",
			"reasoningEffort",
			"presetReasoningEffort",
			"reasoningSummary",
			"verbosity",
			"presetVerbosity",
			"autoExecuteTools",
		])
		.where("id", "=", conversationId)
		.executeTakeFirst();
	const selection = await resolveSelection(
		{
			provider: convo?.provider ?? undefined,
			endpointId: convo?.endpointId ?? undefined,
			modelId: convo?.modelId ?? undefined,
			api: convo?.modelApi ?? undefined,
		},
		userId,
		isAdmin,
	);
	const [documentInput, capabilities] = await Promise.all([
		documentInputCapabilities(selection),
		getModelCapabilities(selection),
	]);
	const systemPrompt = renderBuiltinPromptInterpolations(
		convo?.systemPrompt,
		userLocation,
	);
	const assembled = await contextRuntime.assemble(
		conversationId,
		selection,
		systemPrompt,
		loadAttachmentSummary,
	);
	const { context, documents } = await buildContext(
		conversationId,
		systemPrompt,
		documentInput,
		assembled.messageIds,
		assembled.summary,
		assembled.allowedAttachmentIds,
	);
	const resolvedTools = convo?.autoExecuteTools
		? await toolProvider.resolve({ userId, conversationId, userLocation })
		: [];
	context.tools = resolvedTools.map(({ tool }) => tool);
	const prompt = [...context.messages]
		.reverse()
		.find((message) => message.role === "user");
	if (prompt && typeof prompt.content === "string") {
		logger.withMetadata({ conversationId, userId }).trace(prompt.content);
	}
	const params: GenerationParams = {
		systemPrompt: systemPrompt ?? undefined,
		reasoningEffort:
			convo?.reasoningEffort ??
			convo?.presetReasoningEffort ??
			capabilities.defaultReasoningEffort ??
			undefined,
		reasoningSummary: Boolean(convo?.reasoningSummary),
		verbosity:
			convo?.verbosity ??
			convo?.presetVerbosity ??
			capabilities.defaultVerbosity ??
			undefined,
		documents,
	};
	const titleTask = titleGeneration
		? {
				firstMessage: titleGeneration.firstMessage,
				prompt: await getTitlePrompt(),
				selection: await resolveTaskModelOrFallback(selection),
			}
		: undefined;
	await db
		.updateTable("conversation")
		.set({
			provider: selection.provider,
			endpointId: selection.endpointId,
			modelId: selection.modelId,
			modelApi: selection.api,
		})
		.where("id", "=", conversationId)
		.execute();

	const assistantMessageId = crypto.randomUUID();
	await db
		.insertInto("message")
		.values({
			id: assistantMessageId,
			conversationId,
			role: "assistant",
			text: "",
			status: "generating",
			createdAt: new Date().toISOString(),
		})
		.execute();

	generationManager.start({
		conversationId,
		messageId: assistantMessageId,
		context,
		selection,
		params,
		tools: resolvedTools,
		titleGeneration: titleTask,
		retryContext: async () => {
			await contextRuntime.compactForRetry(
				conversationId,
				selection,
				convo?.systemPrompt,
				loadAttachmentSummary,
			);
			const retryAssembly = await contextRuntime.assemble(
				conversationId,
				selection,
				convo?.systemPrompt,
				loadAttachmentSummary,
			);
			const rebuilt = await buildContext(
				conversationId,
				convo?.systemPrompt,
				documentInput,
				retryAssembly.messageIds,
				retryAssembly.summary,
				retryAssembly.allowedAttachmentIds,
			);
			rebuilt.context.tools = resolvedTools.map(({ tool }) => tool);
			return {
				context: rebuilt.context,
				params: { ...params, documents: rebuilt.documents },
			};
		},
	});

	return assistantMessageId;
}

// Send a message: persist user turn, start a decoupled generation, stream it.
chatRoutes.post("/", async (c) => {
	const user = await requireUser(c.req.raw);
	if (!user) return c.json({ error: "unauthorized" }, 401);

	const { conversationId, text, attachmentIds, userLocation } =
		(await c.req.json()) as {
			conversationId: string;
			text: string;
			attachmentIds?: string[];
			userLocation?: unknown;
		};
	const parsedUserLocation = parseUserLocation(userLocation);
	const hasAttachments = Boolean(attachmentIds?.length);
	if (!conversationId || (!text?.trim() && !hasAttachments)) {
		return c.json(
			{ error: "conversationId and text or an attachment are required" },
			400,
		);
	}
	if (!(await ownsConversation(user.id, conversationId))) {
		return c.json({ error: "conversation not found" }, 404);
	}
	if (attachmentIds?.length) {
		const attachments = await attachmentMetadata(attachmentIds, user.id);
		const documentMimeTypes = attachments
			.filter((attachment) => attachment.kind === "document")
			.map((attachment) => attachment.mimeType);
		if (documentMimeTypes.length) {
			const convo = await db
				.selectFrom("conversation")
				.select(["provider", "endpointId", "modelId", "modelApi"])
				.where("id", "=", conversationId)
				.executeTakeFirst();
			const selection = await resolveSelection(
				{
					provider: convo?.provider ?? undefined,
					endpointId: convo?.endpointId ?? undefined,
					modelId: convo?.modelId ?? undefined,
					api: convo?.modelApi ?? undefined,
				},
				user.id,
				user.isAdmin,
			);
			const supportedMimeTypes = await documentInputMimeTypes(selection);
			if (
				documentMimeTypes.some(
					(mimeType) => !supportedMimeTypes.includes(mimeType),
				)
			) {
				return c.json(
					{
						error:
							"The selected model does not support one or more document types",
					},
					400,
				);
			}
		}
	}

	// Explicit ms-resolution timestamps guarantee stable ordering (SQLite's
	// CURRENT_TIMESTAMP is only second-resolution). User precedes assistant.
	const userMessageId = crypto.randomUUID();
	await db
		.insertInto("message")
		.values({
			id: userMessageId,
			conversationId,
			role: "user",
			text: text ?? "",
			status: "complete",
			createdAt: new Date().toISOString(),
		})
		.execute();
	if (attachmentIds?.length) {
		await linkAttachments(attachmentIds, user.id, userMessageId);
	}

	const firstUserMessage = await db
		.selectFrom("message")
		.select("id")
		.where("conversationId", "=", conversationId)
		.where("role", "=", "user")
		.limit(2)
		.execute();
	const assistantMessageId = await streamNewAssistantTurn(
		conversationId,
		user.id,
		user.isAdmin,
		await reverseGeocode(parsedUserLocation),
		firstUserMessage.length === 1 ? { firstMessage: text ?? "" } : undefined,
	);
	return c.json({ messageId: assistantMessageId }, 202);
});

// Edit a user message: rewrite its text, discard everything after it, and
// regenerate the assistant reply from the amended history.
chatRoutes.post("/edit", async (c) => {
	const user = await requireUser(c.req.raw);
	if (!user) return c.json({ error: "unauthorized" }, 401);

	const { messageId, text, userLocation } = (await c.req.json()) as {
		messageId: string;
		text: string;
		userLocation?: unknown;
	};
	if (!messageId || !text?.trim()) {
		return c.json({ error: "messageId and text are required" }, 400);
	}

	const msg = await getOwnedMessage(user.id, messageId);
	if (!msg) return c.json({ error: "message not found" }, 404);
	if (msg.role !== "user") {
		return c.json({ error: "only user messages can be edited" }, 400);
	}

	await deleteMessages(msg.conversationId, msg.createdAt, ">");
	await db
		.updateTable("message")
		.set({ text })
		.where("id", "=", messageId)
		.execute();
	const contextRepository = new ContextRepository(db);
	await contextRepository.ensureState(msg.conversationId);
	await contextRepository.invalidateSummary(msg.conversationId);

	const assistantMessageId = await streamNewAssistantTurn(
		msg.conversationId,
		user.id,
		user.isAdmin,
		await reverseGeocode(parseUserLocation(userLocation)),
	);
	return c.json({ messageId: assistantMessageId }, 202);
});

// Regenerate a reply. `messageId` may be the assistant message to replace
// (discard it and anything after) or its parent user message (assistant-ui's
// onReload passes the parent — discard everything after it). Either way, a
// fresh reply is generated from the resulting history.
chatRoutes.post("/regenerate", async (c) => {
	const user = await requireUser(c.req.raw);
	if (!user) return c.json({ error: "unauthorized" }, 401);

	const { messageId, userLocation } = (await c.req.json()) as {
		messageId: string;
		userLocation?: unknown;
	};
	if (!messageId) return c.json({ error: "messageId required" }, 400);

	const msg = await getOwnedMessage(user.id, messageId);
	if (!msg) return c.json({ error: "message not found" }, 404);

	await deleteMessages(
		msg.conversationId,
		msg.createdAt,
		msg.role === "assistant" ? ">=" : ">",
	);
	const contextRepository = new ContextRepository(db);
	await contextRepository.ensureState(msg.conversationId);
	await contextRepository.invalidateSummary(msg.conversationId);

	const assistantMessageId = await streamNewAssistantTurn(
		msg.conversationId,
		user.id,
		user.isAdmin,
		await reverseGeocode(parseUserLocation(userLocation)),
	);
	return c.json({ messageId: assistantMessageId }, 202);
});

// Resume streaming an in-progress (or just-finished) generation after reconnect.
chatRoutes.get("/stream", async (c) => {
	const user = await requireUser(c.req.raw);
	if (!user) return c.json({ error: "unauthorized" }, 401);

	const messageId = c.req.query("messageId");
	if (!messageId) return c.json({ error: "messageId required" }, 400);
	if (!(await getOwnedMessage(user.id, messageId)))
		return c.json({ error: "message not found" }, 404);

	const lastEventId = Number(
		c.req.header("last-event-id") ?? c.req.query("lastEventId") ?? 0,
	);

	return new Response(generationManager.subscribe(messageId, lastEventId), {
		headers: sseHeaders,
	});
});

// Explicit user Stop — the only signal that cancels a generation.
chatRoutes.post("/stop", async (c) => {
	const user = await requireUser(c.req.raw);
	if (!user) return c.json({ error: "unauthorized" }, 401);

	const { messageId } = (await c.req.json()) as { messageId: string };
	if (!messageId) return c.json({ error: "messageId required" }, 400);
	if (!(await getOwnedMessage(user.id, messageId)))
		return c.json({ error: "message not found" }, 404);
	const stopped = generationManager.stop(messageId);
	return c.json({ stopped });
});

// Finalize an orphaned assistant placeholder after a process restart or failed
// generation teardown. Active generations still use the normal Stop path so
// their buffered output is persisted by the generation manager.
chatRoutes.post("/force-stop", async (c) => {
	const user = await requireUser(c.req.raw);
	if (!user) return c.json({ error: "unauthorized" }, 401);

	const { messageId } = (await c.req.json()) as { messageId: string };
	if (!messageId) return c.json({ error: "messageId required" }, 400);
	const message = await getOwnedMessage(user.id, messageId);
	if (!message) return c.json({ error: "message not found" }, 404);
	if (message.role !== "assistant") {
		return c.json(
			{ error: "only assistant messages can be force-stopped" },
			400,
		);
	}
	if (generationManager.stop(messageId)) return c.json({ stopped: true });

	const result = await db
		.updateTable("message")
		.set({ status: "complete" })
		.where("id", "=", messageId)
		.where("status", "=", "generating")
		.executeTakeFirst();
	if (result.numUpdatedRows > 0) {
		await db
			.updateTable("conversation")
			.set({ updatedAt: new Date().toISOString() })
			.where("id", "=", message.conversationId)
			.execute();
	}
	return c.json({ stopped: result.numUpdatedRows > 0 });
});
