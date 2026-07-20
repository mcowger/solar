/**
 * Application table types for Kysely.
 *
 * These describe the *app-owned* tables only. Better Auth owns and migrates its
 * own tables (`user`, `session`, `account`, `verification`) via its adapter; we
 * do not model those here in M0. When we need to join against them (M1+), the
 * generated types from `kysely-codegen` (`types.generated.ts`) provide the full
 * picture across both migration owners.
 */
import type { Generated } from "kysely";
import type { Apikey } from "./types.generated";

export interface AppMetaTable {
	key: string;
	value: string;
	updatedAt: Generated<string>;
}

export interface ConversationTable {
	id: string;
	/** FK -> Better Auth `user.id` (same solar.db). */
	userId: string;
	title: string;
	/** FK -> `folder.id`; null = unfiled. */
	folderId: string | null;
	/** Per-conversation model selection (M3); null = resolve default at send time. */
	provider: string | null;
	endpointId: string | null;
	modelId: string | null;
	modelApi: string | null;
	/** Generation params snapshotted from the preset chosen at conversation start. */
	systemPrompt: string | null;
	presetReasoningEffort: string | null;
	reasoningEffort: string | null;
	reasoningSummary: Generated<number>;
	verbosity: string | null;
	presetVerbosity: string | null;
	autoExecuteTools: Generated<number>;
	createdAt: Generated<string>;
	updatedAt: Generated<string>;
}

export interface McpServerTable {
	id: string;
	/** Null for an admin-managed global server. */
	userId: string | null;
	name: string;
	url: string;
	/** JSON object of static HTTP request headers. */
	headers: Generated<string>;
	enabled: Generated<number>;
	createdAt: string;
	updatedAt: string;
}

export interface UserMcpServerPreferenceTable {
	userId: string;
	serverId: string;
	enabled: Generated<number>;
}

export interface ConversationMcpServerTable {
	conversationId: string;
	serverId: string;
	enabled: Generated<number>;
}

export type PresetScope = "personal" | "shared";

/** Reusable assistant config (M3): model + system prompt + reasoning params. */
export interface PresetTable {
	id: string;
	userId: string;
	name: string;
	scope: Generated<string>;
	provider: string;
	endpointId: string | null;
	modelId: string;
	modelApi: string;
	systemPrompt: string | null;
	reasoningEffort: string | null;
	reasoningSummary: Generated<number>;
	verbosity: string | null;
	createdAt: Generated<string>;
}

/** Admin-owned, global provider credentials + model allowlist (M3). */
export interface ProviderConfigTable {
	/** Provider id, e.g. "openai" | "anthropic" | "openrouter". */
	provider: string;
	apiKey: string | null;
	baseUrl: string | null;
	/** JSON array of configured API endpoints. */
	endpoints: Generated<string>;
	/** JSON array of `{ id, api, visibility }` allowlist entries. */
	enabledModels: Generated<string>;
	updatedAt: Generated<string>;
}

export interface FolderTable {
	id: string;
	userId: string;
	name: string;
	createdAt: Generated<string>;
}

export interface TagTable {
	id: string;
	userId: string;
	name: string;
	createdAt: Generated<string>;
}

export interface ConversationTagTable {
	conversationId: string;
	tagId: string;
}

export type MessageRole = "user" | "assistant";
export type MessageStatus = "complete" | "generating" | "error";

export interface MessageTable {
	id: string;
	conversationId: string;
	role: MessageRole;
	/** Plain text, for search and quick reconstruction. */
	text: string;
	/** pi-native message parts as JSON (full fidelity on reload). */
	parts: string | null;
	status: MessageStatus;
	model: string | null;
	inputTokens: number | null;
	outputTokens: number | null;
	createdAt: Generated<string>;
}

export type AttachmentKind = "image" | "text" | "document";

/**
 * Uploaded file (M3): stored on disk via Mirage, never locally parsed. Rows are
 * created on upload (`messageId` null) and linked to the message they're sent
 * with; unlinked rows are orphaned uploads pending removal or send.
 */
export interface AttachmentTable {
	id: string;
	userId: string;
	messageId: string | null;
	filename: string;
	mimeType: string;
	kind: AttachmentKind;
	byteSize: number;
	width: number | null;
	height: number | null;
	pageCount: number | null;
	extractedTextChars: number | null;
	storageKey: string;
	createdAt: Generated<string>;
}

/** Per-user preferences (M3): currently the personal default model. */
export interface UserSettingTable {
	userId: string;
	defaultProvider: string | null;
	defaultEndpointId: string | null;
	defaultModelId: string | null;
	defaultApi: string | null;
	updatedAt: Generated<string>;
}

export type ContextJobStatus = "idle" | "queued" | "running" | "failed";

/** Mutable working-memory artifact for one canonical conversation. */
export interface ConversationContextStateTable {
	conversationId: string;
	/** Incremented when the transcript changes; background work must match it. */
	revision: Generated<number>;
	summary: string | null;
	summaryRevision: number | null;
	/** First raw message retained after the active rolling summary. */
	retainedMessageBoundaryId: string | null;
	jobStatus: Generated<ContextJobStatus>;
	jobId: string | null;
	jobAttempt: Generated<number>;
	jobError: string | null;
	jobUpdatedAt: string | null;
	createdAt: Generated<string>;
	updatedAt: Generated<string>;
}

/** Opaque pi-native intermediate steps for a visible assistant message. */
export interface GenerationStepTable {
	messageId: string;
	sequence: number;
	data: string;
	createdAt: Generated<string>;
}

export type ProviderCallPurpose = "chat" | "tool_loop" | "title" | "compaction";

/** Per-provider-call accounting. Deliberately contains no prompt or response content. */
export interface ProviderCallTelemetryTable {
	id: string;
	conversationId: string | null;
	messageId: string | null;
	provider: string;
	api: string;
	modelId: string;
	purpose: ProviderCallPurpose;
	inputTokens: number | null;
	outputTokens: number | null;
	cacheReadTokens: number | null;
	cacheWriteTokens: number | null;
	estimatedCostMicros: number | null;
	latencyMs: number | null;
	contextPolicySource: string | null;
	contextPolicyEnabled: number | null;
	/** JSON snapshot of numeric context-policy settings; never prompt content. */
	contextPolicyState: string | null;
	overflowed: Generated<number>;
	retryAttempt: Generated<number>;
	compactionTokensBefore: number | null;
	compactionTokensAfter: number | null;
	createdAt: Generated<string>;
}

/** Cached domain categories from Cloudflare Radar. A null category is a cached miss. */
export interface SourceCategoryTable {
	domain: string;
	category: string | null;
	source: string;
	updatedAt: Generated<string>;
}

export interface Database {
	apikey: Apikey;
	app_meta: AppMetaTable;
	user_setting: UserSettingTable;
	conversation: ConversationTable;
	message: MessageTable;
	folder: FolderTable;
	tag: TagTable;
	conversation_tag: ConversationTagTable;
	provider_config: ProviderConfigTable;
	preset: PresetTable;
	attachment: AttachmentTable;
	mcp_server: McpServerTable;
	user_mcp_server_preference: UserMcpServerPreferenceTable;
	conversation_mcp_server: ConversationMcpServerTable;
	conversation_context_state: ConversationContextStateTable;
	generation_step: GenerationStepTable;
	provider_call_telemetry: ProviderCallTelemetryTable;
	source_category: SourceCategoryTable;
}
