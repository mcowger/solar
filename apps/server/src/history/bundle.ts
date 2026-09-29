import type { Message } from "@earendil-works/pi-ai";
import type { AttachmentRecord } from "../conversations/types";

export const HISTORY_BUNDLE_VERSION = 3 as const;
export const HISTORY_BUNDLE_FORMAT = "solar-chat-history-bundle" as const;

export type HistoryMessageRole = "user" | "assistant" | "toolResult";

export interface HistoryConversationMeta {
	id: string;
	userId: string;
	title: string;
	folderId: string | null;
	provider: string | null;
	endpointId: string | null;
	modelId: string | null;
	modelApi: string | null;
	systemPrompt: string | null;
	reasoningEffort: string | null;
	reasoningSummary: number;
	verbosity: string | null;
	autoExecuteTools: number;
	displayMode: string | null;
	createdAt: string;
	updatedAt: string;
}

export interface HistoryTurn {
	id: string;
	conversationId: string;
	ordinal: number;
	role: "user" | "assistant";
	origin: string;
	status: string;
	createdAt: string;
}

export interface HistoryMessage {
	id: string;
	conversationId: string;
	turnId: string | null;
	ordinal: number;
	role: HistoryMessageRole;
	message: Message;
	origin: string;
	status: string;
	createdAt: string;
}

export interface HistoryBinding {
	messageId: string;
	attachmentId: string;
	ordinal: number;
}

export interface HistoryFolder {
	id: string;
	name: string;
	createdAt: string;
}

export interface HistoryTag {
	id: string;
	name: string;
	createdAt: string;
}

/**
 * Pi-native history bundle. Transcript comes from the pi session file;
 * metadata from the live conversation tables. There is deliberately no
 * generation/compaction/voice payload: session files already carry compaction
 * entries, and per-call telemetry is not persisted.
 */
export interface HistoryBundle {
	version: typeof HISTORY_BUNDLE_VERSION;
	sourceUserId: string;
	conversation: HistoryConversationMeta;
	turns: HistoryTurn[];
	messages: HistoryMessage[];
	attachments: AttachmentRecord[];
	bindings: HistoryBinding[];
	folder: HistoryFolder | null;
	tags: HistoryTag[];
}
