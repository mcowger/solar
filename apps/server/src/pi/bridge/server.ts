/**
 * Internal HTTP surface backing the generic pi bridge extension
 * (./extension.ts). Loopback-only (enforced where this app is mounted, see
 * index.ts) + per-spawn bearer token (./tokens.ts). All actual tool logic
 * stays in-process here, preserving per-user authorization; the pi child
 * process only proxies.
 */
import { Hono } from "hono";
import { z } from "zod";
import {
	expandAttachmentRows,
	type AttachmentContentRow,
} from "../../chat/attachments";
import {
	documentInputCapabilities,
	resolveSelection,
} from "../../chat/catalog";
import { nativeAttachmentAdapter } from "../../chat/nativeAttachmentAdapters";
import type { ResolvedTool } from "../../chat/mcp";
import { toolProvider } from "../../chat/tools";
import { chatV2Repository } from "../../chat-v2/db/repository";
import { logger } from "../../logger";
import { MOCK } from "../../chat/catalog";
import { serveMockChatCompletion } from "./mockLlm";
import { resolveBridgeToken, type BridgeIdentity } from "./tokens";

export const piBridgeRoutes = new Hono();

function authenticate(
	authorization: string | undefined,
): BridgeIdentity | null {
	if (!authorization?.startsWith("Bearer ")) return null;
	return resolveBridgeToken(authorization.slice("Bearer ".length));
}

/** Serialize a ResolvedTool for the extension's Type.Unsafe reconstruction. */
function serializeTool(resolved: ResolvedTool) {
	return {
		name: resolved.tool.name,
		description: resolved.tool.description,
		// TypeBox schemas are JSON-schema-shaped; symbols don't survive
		// stringification, which is exactly what we want (plain schema).
		parameters: JSON.parse(JSON.stringify(resolved.tool.parameters)),
	};
}

/**
 * Short-window cache of a conversation's resolved tools. The bridge is queried
 * by the pi child at session_start AND by the engine for tool display names;
 * resolution involves MCP handshakes, so we resolve at most once per window.
 */
const TOOL_CACHE_MS = 60_000;
const toolCache = new Map<string, { at: number; tools: ResolvedTool[] }>();

/** Engine-side accessor for the current cached tool set (may be empty). */
export function peekResolvedTools(
	conversationId: string,
): ResolvedTool[] | null {
	const cached = toolCache.get(conversationId);
	return cached && Date.now() - cached.at < TOOL_CACHE_MS ? cached.tools : null;
}

async function resolveConversationTools(identity: BridgeIdentity) {
	const conversation = await chatV2Repository.getConversation(
		identity.userId,
		identity.conversationId,
	);
	const cached = toolCache.get(identity.conversationId);
	const available =
		cached && Date.now() - cached.at < TOOL_CACHE_MS
			? cached.tools
			: await toolProvider
					.resolve({
						userId: identity.userId,
						conversationId: identity.conversationId,
						userLocation: identity.userLocation,
					})
					.then((tools) => {
						toolCache.set(identity.conversationId, { at: Date.now(), tools });
						return tools;
					});
	// Mirrors chat/v2Live.ts: without auto-execute, only read_skill is offered.
	return {
		conversation,
		tools: conversation.autoExecuteTools
			? available
			: available.filter((tool) => tool.tool.name === "read_skill"),
	};
}

piBridgeRoutes.get("/internal/pi-bridge/tools", async (c) => {
	const identity = authenticate(c.req.header("authorization"));
	if (!identity) return c.json({ error: "unauthorized" }, 401);
	const { tools } = await resolveConversationTools(identity);
	return c.json({ tools: tools.map(serializeTool) });
});

const executeBody = z.object({
	toolName: z.string().min(1),
	args: z.record(z.string(), z.unknown()).default({}),
});

piBridgeRoutes.post("/internal/pi-bridge/tools/execute", async (c) => {
	const identity = authenticate(c.req.header("authorization"));
	if (!identity) return c.json({ error: "unauthorized" }, 401);
	let body: z.infer<typeof executeBody>;
	try {
		body = executeBody.parse(await c.req.json());
	} catch {
		return c.json({ error: "invalid request body" }, 400);
	}
	const { tools } = await resolveConversationTools(identity);
	const tool = tools.find((candidate) => candidate.tool.name === body.toolName);
	if (!tool) return c.json({ content: "Tool is unavailable.", isError: true });
	try {
		return c.json(await tool.execute(body.args));
	} catch (error) {
		return c.json({
			content: `Tool failed: ${error instanceof Error ? error.message : String(error)}`,
			isError: true,
		});
	}
});

/**
 * Scope by attachment ownership (attachments are uploaded by the owning user
 * before the message is sent; message bindings are only persisted by the
 * engine AFTER the turn settles, so live expansion can't rely on them).
 */
async function loadAttachmentRows(
	userId: string,
	ids: Iterable<string>,
): Promise<AttachmentContentRow[]> {
	const rows: AttachmentContentRow[] = [];
	for (const id of new Set(ids)) {
		const attachment = await chatV2Repository
			.getAttachment(userId, id)
			.catch(() => null);
		if (!attachment) continue;
		rows.push({
			id: attachment.id,
			storageKey: attachment.storageKey,
			kind: attachment.kind as AttachmentContentRow["kind"],
			mimeType: attachment.mimeType,
			filename: attachment.filename,
		});
	}
	return rows;
}

async function conversationSelection(
	conversation: Awaited<ReturnType<typeof chatV2Repository.getConversation>>,
	userId: string,
) {
	return resolveSelection(
		{
			provider: conversation.provider ?? undefined,
			endpointId: conversation.endpointId ?? undefined,
			modelId: conversation.modelId ?? undefined,
			api: conversation.modelApi ?? undefined,
		},
		userId,
		false,
	);
}

piBridgeRoutes.get("/internal/pi-bridge/attachments", async (c) => {
	const identity = authenticate(c.req.header("authorization"));
	if (!identity) return c.json({ error: "unauthorized" }, 401);
	const ids = (c.req.query("ids") ?? "").split(",").filter(Boolean);
	if (ids.length === 0) return c.json({ partsById: {} });

	const { conversation } = await resolveConversationTools(identity);
	const rows = await loadAttachmentRows(identity.userId, ids);
	if (rows.length === 0) return c.json({ partsById: {} });

	const selection = await conversationSelection(conversation, identity.userId);
	const documentInput = await documentInputCapabilities(selection);
	try {
		const expanded = await expandAttachmentRows(rows, documentInput);
		const partsById: Record<string, unknown> = {};
		for (const [index, row] of rows.entries()) {
			const part = expanded.parts[index];
			if (part) partsById[row.id] = part;
		}
		return c.json({ partsById });
	} catch (error) {
		// Never 500 the extension: a broken batch becomes per-attachment
		// placeholder text so the model still knows what it couldn't read.
		const reason = error instanceof Error ? error.message : String(error);
		logger
			.withError(error)
			.withMetadata({ conversationId: identity.conversationId })
			.warn("attachment expansion batch failed; returning placeholders");
		const partsById: Record<string, unknown> = {};
		for (const row of rows) {
			partsById[row.id] = {
				type: "text",
				text: `<attachment name="${row.filename}">\n[Attachment could not be read: ${reason}]\n</attachment>`,
			};
		}
		return c.json({ partsById });
	}
});

const DOCUMENT_MARKER = /\[\[solar-document:([^\]]+)\]\]/g;

const injectDocumentsBody = z.object({ payload: z.unknown() });

/**
 * Provider-payload half of native document input. The `context` hook expands
 * a native-capable attachment to a `[[solar-document:<id>]]` placeholder text
 * part; the document bytes can't ride in pi message content (pi-ai turns any
 * non-text part into an image block). The extension's `before_provider_request`
 * hook posts the final provider payload here, and the provider adapter swaps
 * each placeholder for a real document block. Stateless: documents are
 * re-resolved from the ids named by the placeholders.
 */
piBridgeRoutes.post("/internal/pi-bridge/inject-documents", async (c) => {
	const identity = authenticate(c.req.header("authorization"));
	if (!identity) return c.json({ error: "unauthorized" }, 401);
	let payload: unknown;
	try {
		({ payload } = injectDocumentsBody.parse(await c.req.json()));
	} catch {
		return c.json({ error: "invalid request body" }, 400);
	}

	const ids = [...JSON.stringify(payload).matchAll(DOCUMENT_MARKER)].map(
		(match) => match[1]!,
	);
	if (ids.length === 0) return c.json({ payload });

	const conversation = await chatV2Repository.getConversation(
		identity.userId,
		identity.conversationId,
	);
	const rows = await loadAttachmentRows(identity.userId, ids);
	if (rows.length === 0) return c.json({ payload });

	const selection = await conversationSelection(conversation, identity.userId);
	const adapter = nativeAttachmentAdapter(selection);
	if (!adapter) return c.json({ payload });
	const { documents } = await expandAttachmentRows(
		rows,
		await documentInputCapabilities(selection),
	);
	if (documents.length === 0) return c.json({ payload });
	return c.json({ payload: adapter.injectDocuments(payload, documents) });
});

// MOCK LLM: an OpenAI-compatible completions endpoint Solar serves to itself so
// a pi child process can generate without touching a real provider.
if (MOCK) {
	piBridgeRoutes.post("/internal/mock-llm/v1/chat/completions", (c) =>
		serveMockChatCompletion(c.req.raw),
	);
}

export function logPiBridgeStartup(): void {
	logger.withMetadata({ mock: MOCK }).debug("pi bridge routes mounted");
}
