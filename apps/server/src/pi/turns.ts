/**
 * pi read path (plan: Architecture overview — pi-read.ts; Search & export;
 * Usage & cost accounting). All reads are direct library calls against the
 * JSONL session file — no spawned process, no SQL mirror of conversation
 * content.
 */
import {
	SessionManager,
	type SessionMessageEntry,
} from "@earendil-works/pi-coding-agent";
import { describeToolNames } from "../chat/mcp";
import { chatV2Repository } from "../chat-v2/db/repository";
import { logger } from "../logger";
import { piSessionDir } from "./config";
import { piGenerations } from "./generation";
import { piSessionFile } from "./migration";

// ---------------------------------------------------------------------------
// Session access

function openManager(conversationId: string): SessionManager | null {
	const file = piSessionFile(conversationId);
	if (!file) return null;
	try {
		return SessionManager.open(file, piSessionDir(conversationId));
	} catch (error) {
		logger
			.withError(error)
			.withMetadata({ conversationId })
			.warn("failed to open pi session file");
		return null;
	}
}

function messageTextOf(
	content: string | Array<{ type: string; text?: string }>,
): string {
	if (typeof content === "string") return content;
	return content
		.filter((part) => part.type === "text")
		.map((part) => part.text ?? "")
		.join("\n");
}

/** AgentMessage is a union; only real conversation messages carry content. */
function contentOf(
	message: unknown,
): string | Array<{ type: string; text?: string }> | null {
	if (
		message &&
		typeof message === "object" &&
		"content" in message &&
		typeof (message as { content?: unknown }).content !== "undefined"
	) {
		return (
			message as { content: string | Array<{ type: string; text?: string }> }
		).content;
	}
	return null;
}

function entryText(entry: SessionMessageEntry): string {
	const content = contentOf(entry.message);
	return content === null ? "" : messageTextOf(content);
}

type ContentBlock = {
	type: string;
	text?: string;
	thinking?: string;
};

function entryBlocks(entry: SessionMessageEntry): ContentBlock[] {
	const content = contentOf(entry.message);
	if (typeof content === "string") return [{ type: "text", text: content }];
	return (content ?? []) as ContentBlock[];
}

function stripSolarMarkers(text: string): string {
	return text
		.replace(/<solar-attachments\s+ids="[^"]*"\s*\/>/g, "")
		.replace(/<explicit-skill\b[^>]*>[\s\S]*?<\/explicit-skill>/g, "")
		.trim();
}

function markerAttachmentIds(text: string): string[] {
	const ids: string[] = [];
	for (const match of text.matchAll(
		/<solar-attachments\s+ids="([^"]*)"\s*\/>/g,
	)) {
		for (const id of (match[1] ?? "").split(",").filter(Boolean)) ids.push(id);
	}
	return ids;
}

// ---------------------------------------------------------------------------
// Transcript projection (conversation.messages tRPC shape)

export interface PiVisibleTurn {
	id: string;
	role: "user" | "assistant";
	entries: SessionMessageEntry[];
	/** Compaction marker immediately preceding this turn, if any. */
	summaryEvent?: {
		tokensBefore: number;
		tokensAfter: number | null;
		revision: number;
		createdAt: string;
		position: "before";
	};
}

function piVisibleTurns(conversationId: string): PiVisibleTurn[] {
	const manager = openManager(conversationId);
	if (!manager) return [];
	// Walk the full current path (all entry types) so compaction markers keep
	// their position; only message entries become turns.
	const path = manager.getBranch();
	const turns: PiVisibleTurn[] = [];

	for (const entry of path) {
		if (entry.type !== "message") continue;
		const role: string = entry.message.role;
		if (role === "user") {
			turns.push({ id: entry.id, role: "user", entries: [entry] });
		} else {
			const current = turns.at(-1);
			if (current && current.role === "assistant") {
				current.entries.push(entry);
				continue;
			}
			turns.push({ id: entry.id, role: "assistant", entries: [entry] });
		}
	}

	// Compaction marker: the visible boundary is where the summarized region
	// ends — i.e. the turn containing the latest compaction's firstKeptEntryId
	// (pi's context starts there; everything before is hidden from the model,
	// exactly what the badge communicates). Fallback: first turn after the
	// compaction entry, in case firstKeptEntryId is a non-message entry.
	const compactions = path.filter(
		(entry) => entry.type === "compaction",
	) as Array<{
		id: string;
		tokensBefore?: number;
		timestamp: string;
		firstKeptEntryId?: string;
		usage?: { output?: number };
	}>;
	const latest = compactions.at(-1);
	if (latest && turns.length > 0) {
		const summaryEvent: PiVisibleTurn["summaryEvent"] = {
			tokensBefore: latest.tokensBefore ?? 0,
			tokensAfter: latest.usage?.output ?? null,
			revision: compactions.length,
			createdAt: latest.timestamp,
			position: "before",
		};
		let target =
			(latest.firstKeptEntryId
				? turns.find((turn) =>
						turn.entries.some((entry) => entry.id === latest.firstKeptEntryId),
					)
				: undefined) ?? null;
		if (!target) {
			const compactionIndex = path.findIndex((entry) => entry.id === latest.id);
			const entryIndex = new Map(path.map((entry, i) => [entry.id, i]));
			target =
				turns.find(
					(turn) =>
						(entryIndex.get(turn.entries[0]!.id) ?? -1) > compactionIndex,
				) ?? null;
		}
		(target ?? turns.at(-1)!).summaryEvent = summaryEvent;
	}
	return turns;
}

/** Attach Solar's stored solar-metrics payload to the assistant turn's parts JSON. */
function withMetrics(
	entry: SessionMessageEntry,
	metrics: PiTurnMetricsRecord | undefined,
): unknown {
	const base = entry.message as unknown as Record<string, unknown>;
	if (!metrics) return base;
	return {
		...base,
		solarMetrics: {
			ttftMs: metrics.ttftMs,
			tps: metrics.tps,
			e2e: metrics.e2e,
		},
	};
}

/** Entries on the current path, grouped into user/assistant visible turns. */
export // ---------------------------------------------------------------------------
// Turn metrics: read the custom entries the engine writes under
// customType solar-turn-metrics (one per completed assistant turn).

interface PiTurnMetricsRecord {
	assistantEntryId: string | null;
	ttftMs: number | null;
	tps: number | null;
	e2e: number | null;
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
}

function piTurnMetricsByAssistant(
	conversationId: string,
): Map<string, PiTurnMetricsRecord> {
	return customDataByAssistant<PiTurnMetricsRecord>(
		conversationId,
		"solar-turn-metrics",
	);
}

// Turn errors: customType solar-turn-error, written by the engine when its
// stall watchdog ended a turn that pi saved as "Request was aborted".

interface PiTurnErrorRecord {
	assistantEntryId: string | null;
	errorMessage: string;
}

function piTurnErrorsByAssistant(
	conversationId: string,
): Map<string, PiTurnErrorRecord> {
	return customDataByAssistant<PiTurnErrorRecord>(
		conversationId,
		"solar-turn-error",
	);
}

function customDataByAssistant<T extends { assistantEntryId: string | null }>(
	conversationId: string,
	customType: string,
): Map<string, T> {
	const manager = openManager(conversationId);
	const byAssistant = new Map<string, T>();
	if (!manager) return byAssistant;
	for (const entry of manager.getBranch()) {
		if (
			entry.type === "custom" &&
			(entry as { customType?: string }).customType === customType
		) {
			const data = (entry as { data?: T }).data;
			if (data?.assistantEntryId) {
				byAssistant.set(data.assistantEntryId, data);
			}
		}
	}
	return byAssistant;
}

interface PiToolCall {
	id: string;
	name: string;
	args: string;
	status: "complete" | "error";
	output?: string;
	serverName?: string;
	remoteName?: string;
}

/**
 * conversation.messages equivalents for pi sessions — matches the exact shape
 * chat/v2Live.ts's loadMessages returns so assistant-ui rendering is engine-
 * agnostic.
 */
export async function loadPiMessages(userId: string, conversationId: string) {
	const turns = piVisibleTurns(conversationId);
	const isLive = piGenerations.isConversationGenerating(conversationId);
	const turnMetrics = piTurnMetricsByAssistant(conversationId);
	const turnErrors = piTurnErrorsByAssistant(conversationId);

	const toolCallsByTurn = turns.map(extractPiToolCalls);
	const toolNames = [
		...new Set(toolCallsByTurn.flat().map((call) => call.name)),
	];
	const displayNames = await describeToolNames(toolNames);

	const rows = [];
	for (const [index, turn] of turns.entries()) {
		const last = turn.entries.at(-1)!;
		const entryTexts = turn.entries
			.filter((entry) => entry.message.role !== "toolResult")
			.map((entry) => {
				const text = stripSolarMarkers(entryText(entry));
				if (text) return text;
				// Persisted assistant errors render as the error they failed with —
				// otherwise a failed turn reads as an empty ghost reply on reload.
				// Solar's own reason (a stall) wins over pi's generic abort text.
				const errorMessage =
					turnErrors.get(entry.id)?.errorMessage ??
					(entry.message as unknown as { errorMessage?: string }).errorMessage;
				return errorMessage ? `**Error:** ${errorMessage}` : "";
			})
			.filter(Boolean);
		const reasoning = turn.entries
			.flatMap((entry) =>
				entryBlocks(entry)
					.filter((part) => part.type === "thinking")
					.map((part) => part.thinking ?? ""),
			)
			.filter(Boolean);
		const attachments =
			turn.role === "user"
				? await attachmentsForEntry(userId, entryText(turn.entries[0]!))
				: [];
		rows.push({
			id: turn.id,
			role: turn.role,
			text: entryTexts.join("\n"),
			parts: JSON.stringify(withMetrics(last, turnMetrics.get(last.id))),
			status: "complete",
			createdAt: turn.entries[0]!.timestamp,
			reasoning: reasoning.join("\n"),
			toolCalls: toolCallsByTurn[index]!.map((call) => ({
				...call,
				...displayNames.get(call.name),
			})),
			skillInvocation: null,
			summaryEvent: turn.summaryEvent ?? null,
			attachments,
			// Only a generation currently pumping into this conversation makes
			// the trailing assistant turn live; the SSE id differs (see API).
			isActive:
				isLive && index === turns.length - 1 && turn.role === "assistant",
		});
	}
	return rows;
}

function extractPiToolCalls(turn: PiVisibleTurn): PiToolCall[] {
	const calls: PiToolCall[] = [];
	const resultByCallId = new Map<string, { text: string; isError: boolean }>();
	for (const entry of turn.entries) {
		if (entry.message.role === "toolResult") {
			const message = entry.message as {
				toolCallId?: string;
				toolName?: string;
				content?: Array<{ type: string; text?: string }>;
				isError?: boolean;
			};
			if (message.toolCallId) {
				resultByCallId.set(message.toolCallId, {
					text: (message.content ?? [])
						.filter((part) => part.type === "text")
						.map((part) => part.text ?? "")
						.join("\n"),
					isError: Boolean(message.isError),
				});
			}
		}
	}
	for (const entry of turn.entries) {
		if (entry.message.role !== "assistant") continue;
		const content = contentOf(entry.message);
		if (typeof content === "string" || content === null) continue;
		for (const part of content as Array<{
			type: string;
			id?: string;
			name?: string;
			arguments?: Record<string, unknown>;
		}>) {
			if (part.type !== "toolCall" || !part.id || !part.name) continue;
			const result = resultByCallId.get(part.id);
			calls.push({
				id: part.id,
				name: part.name,
				args: JSON.stringify(part.arguments ?? {}),
				status: result?.isError ? "error" : "complete",
				output: result?.text,
			});
		}
	}
	return calls;
}

async function attachmentsForEntry(userId: string, rawText: string) {
	const ids = markerAttachmentIds(rawText);
	if (ids.length === 0) return [];
	const rows = [];
	for (const id of ids) {
		const attachment = await chatV2Repository
			.getAttachment(userId, id)
			.catch(() => null);
		if (attachment) {
			rows.push({
				id: attachment.id,
				filename: attachment.filename,
				mimeType: attachment.mimeType,
				kind: attachment.kind as "image" | "text" | "document",
				byteSize: attachment.byteSize,
			});
		}
	}
	return rows;
}

// ---------------------------------------------------------------------------
// List metadata: title/preview live in the session file for pi conversations

export function piConversationTitle(conversationId: string): string | null {
	const manager = openManager(conversationId);
	if (!manager) return null;
	return manager.getSessionName() ?? null;
}

export function piConversationPreview(conversationId: string): string | null {
	const turns = piVisibleTurns(conversationId);
	const first = turns.find((turn) => turn.role === "user");
	if (!first) return null;
	return stripSolarMarkers(entryText(first.entries[0]!)).slice(0, 200) || null;
}

// ---------------------------------------------------------------------------
// Search (plan: Search & export — on-demand scan of owned conversations)

export function piConversationMatchesQuery(
	conversationId: string,
	query: string,
): boolean {
	const manager = openManager(conversationId);
	if (!manager) return false;
	const needle = query.toLocaleLowerCase();
	const name = manager.getSessionName();
	if (name?.toLocaleLowerCase().includes(needle)) return true;
	return manager
		.getBranch()
		.filter((entry): entry is SessionMessageEntry => entry.type === "message")
		.some((entry) => entryText(entry).toLocaleLowerCase().includes(needle));
}

// ---------------------------------------------------------------------------
// Usage rollups (plan: Usage & cost accounting — sums usage blocks on demand)

export interface PiUsageSummary {
	inputTokens: number;
	outputTokens: number;
	costMicros: number;
	lastConversationTokens: number | null;
	assistantMessageCount: number;
}

export function piConversationUsage(conversationId: string): PiUsageSummary {
	const manager = openManager(conversationId);
	const empty: PiUsageSummary = {
		inputTokens: 0,
		outputTokens: 0,
		costMicros: 0,
		lastConversationTokens: null,
		assistantMessageCount: 0,
	};
	if (!manager) return empty;
	const summary: PiUsageSummary = { ...empty };
	let lastAssistantUsage: { input: number; cacheRead: number } | null = null;
	for (const entry of manager.getEntries()) {
		if (entry.type === "message") {
			const message = (entry as SessionMessageEntry).message;
			if (message.role !== "assistant") continue;
			summary.assistantMessageCount += 1;
			const usage = (
				message as unknown as {
					usage?: {
						input?: number;
						output?: number;
						cacheRead?: number;
						cost?: { total?: number };
					};
				}
			).usage;
			if (!usage) continue;
			summary.inputTokens += usage.input ?? 0;
			summary.outputTokens += usage.output ?? 0;
			if (usage.cost?.total)
				summary.costMicros += Math.round(usage.cost.total * 1_000_000);
			lastAssistantUsage = {
				input: usage.input ?? 0,
				cacheRead: usage.cacheRead ?? 0,
			};
		} else if (entry.type === "compaction") {
			const usage = (
				entry as {
					usage?: {
						input?: number;
						output?: number;
						cost?: { total?: number };
					};
				}
			).usage;
			if (!usage) continue;
			summary.inputTokens += usage.input ?? 0;
			summary.outputTokens += usage.output ?? 0;
			if (usage.cost?.total)
				summary.costMicros += Math.round(usage.cost.total * 1_000_000);
		}
	}
	summary.lastConversationTokens = lastAssistantUsage
		? lastAssistantUsage.input + lastAssistantUsage.cacheRead
		: null;
	return summary;
}

/** True when the session file contains a compaction entry (any path). */
export function piConversationSummarized(conversationId: string): boolean {
	const manager = openManager(conversationId);
	if (!manager) return false;
	return manager.getEntries().some((entry) => entry.type === "compaction");
}

/** Latest compaction info for the context-state UI. */
export function piLatestCompaction(conversationId: string): {
	tokensBefore: number;
	createdAt: string;
	usageOutput: number | null;
	/** Number of compaction entries on the current branch — drives UI reloads. */
	revision: number;
} | null {
	const manager = openManager(conversationId);
	if (!manager) return null;
	// Walk the current branch (not the whole tree) so abandoned-path
	// compactions from edits/regenerations do not leak into the summary state.
	const compactions = manager
		.getBranch()
		.filter((entry) => entry.type === "compaction");
	const latest = compactions.at(-1) as
		| { tokensBefore?: number; timestamp: string; usage?: { output?: number } }
		| undefined;
	if (!latest) return null;
	return {
		tokensBefore: latest.tokensBefore ?? 0,
		createdAt: latest.timestamp,
		usageOutput: latest.usage?.output ?? null,
		revision: compactions.length,
	};
}

/** Whether a pi session contains an assistant entry with the given id. */
export function piOwnsAssistantEntry(
	conversationId: string,
	entryId: string,
): boolean {
	const manager = openManager(conversationId);
	if (!manager) return false;
	const entry = manager.getEntry(entryId);
	return (
		entry?.type === "message" &&
		(entry as SessionMessageEntry).message.role === "assistant"
	);
}

export function piOwnsUserEntry(conversationId: string, entryId: string) {
	const manager = openManager(conversationId);
	if (!manager) return false;
	const entry = manager.getEntry(entryId);
	return (
		entry?.type === "message" &&
		(entry as SessionMessageEntry).message.role === "user"
	);
}

/**
 * Locate the (conversation, role) owning a pi entry id across a user's
 * migrated conversations. Chat-v2 resolves message ids through indexed SQL
 * tables; pi sessions are per-conversation files, so this is a scan — bounded
 * by the user's conversation count and only hit on edit/regenerate. Revisit
 * with a narrow index table if profiling shows it hot (plan: caches only
 * after measurement).
 */
export async function piFindEntryOwner(
	userId: string,
	entryId: string,
): Promise<{ conversationId: string; role: "user" | "assistant" } | null> {
	const conversations = await chatV2Repository.listConversations(userId);
	for (const conversation of conversations) {
		if (!piSessionFile(conversation.id)) continue;
		if (piOwnsAssistantEntry(conversation.id, entryId)) {
			return { conversationId: conversation.id, role: "assistant" };
		}
		if (piOwnsUserEntry(conversation.id, entryId)) {
			return { conversationId: conversation.id, role: "user" };
		}
	}
	return null;
}
