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

/**
 * Live conversation metadata. Transcript history lives in pi session JSONL
 * under ${SOLAR_PI_AGENT_DIR}; this row is identity, ownership, model
 * selection, and UI settings only.
 */
export interface ConversationTable {
	id: string;
	/** FK -> Better Auth `user.id` (same solar.db). */
	userId: string;
	title: string;
	/** FK -> `folder.id`; null = unfiled. */
	folderId: string | null;
	/** Per-conversation model selection; null = resolve default at send time. */
	provider: string | null;
	endpointId: string | null;
	modelId: string | null;
	modelApi: string | null;
	systemPrompt: string | null;
	reasoningEffort: string | null;
	reasoningSummary: Generated<number>;
	verbosity: string | null;
	displayMode: string | null;
	autoExecuteTools: Generated<number>;
	createdAt: Generated<string>;
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

/** Uploaded file metadata; bytes live on disk via Mirage (see chat/attachments). */
export interface AttachmentTable {
	id: string;
	userId: string;
	storageKey: string;
	filename: string;
	mimeType: string;
	kind: string;
	byteSize: number;
	sha256: string;
	width: number | null;
	height: number | null;
	pageCount: number | null;
	createdAt: Generated<string>;
}

/**
 * Attachment ↔ pi session entry linkage. `messageId` is a pi session entry
 * id (plain text, no FK — session files are not SQL rows).
 */
export interface MessageAttachmentTable {
	messageId: string;
	attachmentId: string;
	ordinal: number;
}

export interface ConversationMcpServerTable {
	conversationId: string;
	serverId: string;
	enabled: Generated<number>;
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

/** Uploaded file kind: image, text, or document. */
export type AttachmentKind = "image" | "text" | "document";

/** Admin-owned, global provider credentials + model allowlist (M3). */
export interface ProviderConfigTable {
	/** Provider id, e.g. "openai" | "anthropic" | "openrouter". */
	provider: string;
	apiKey: string | null;
	baseUrl: string | null;
	/** JSON array of configured API endpoints. */
	endpoints: Generated<string>;
	/** JSON array of `{ id, api, visibility }` chat allowlist entries. */
	enabledModels: Generated<string>;
	/** JSON array of admin-approved image model descriptors. */
	imageModels: Generated<string>;
	updatedAt: Generated<string>;
}

/** Per-user preferences (M3): personal default model and preset. */
export interface UserSettingTable {
	userId: string;
	defaultProvider: string | null;
	defaultEndpointId: string | null;
	defaultModelId: string | null;
	defaultApi: string | null;
	defaultPresetId: string | null;
	defaultDisplayMode: string | null;
	updatedAt: Generated<string>;
}

/** Cached domain categories from Cloudflare Radar. A null category is a cached miss. */
export interface SourceCategoryTable {
	domain: string;
	category: string | null;
	source: string;
	updatedAt: Generated<string>;
}

export interface SkillTable {
	id: string;
	userId: string;
	name: string;
	description: string;
	content: string;
	exposed: Generated<number>;
	createdAt: Generated<string>;
	updatedAt: Generated<string>;
}

export interface ImpersonationSessionTable {
	adminSessionId: string;
	targetUserId: string;
	expiresAt: number;
	updatedAt: number;
}

export type ImageAssetKind = "upload" | "generated";
export type ImageAttemptStatus =
	| "queued"
	| "running"
	| "complete"
	| "failed"
	| "interrupted";

export interface ImageWorkspaceTable {
	id: string;
	/** FK -> Better Auth `user.id`; image workspaces are owner-private. */
	userId: string;
	title: string;
	/** Current UI defaults; each attempt snapshots these values. */
	modelId: string | null;
	aspectRatio: string | null;
	resolution: string | null;
	createdAt: Generated<string>;
	updatedAt: Generated<string>;
}

export interface ImageAssetTable {
	id: string;
	/** Denormalized owner for direct file/asset authorization. */
	userId: string;
	workspaceId: string;
	/** Selected source version; null for an initial upload or root prompt. */
	sourceAssetId: string | null;
	kind: ImageAssetKind;
	filename: string;
	mimeType: string;
	byteSize: number;
	sha256: string;
	width: number | null;
	height: number | null;
	/** Generated server-side; never derived from a client path. */
	storageKey: string;
	createdAt: Generated<string>;
}

export interface ImageAttemptTable {
	id: string;
	/** Denormalized owner for direct status authorization. */
	userId: string;
	workspaceId: string;
	sourceAssetId: string | null;
	/** Non-null only when this is an explicit retry of an older attempt. */
	retryOfAttemptId: string | null;
	/** Client-generated key used to reconcile a retried request. */
	requestKey: string;
	prompt: string;
	provider: string;
	endpointId: string;
	api: string;
	modelId: string;
	aspectRatio: string | null;
	resolution: string | null;
	status: ImageAttemptStatus;
	errorMessage: string | null;
	/** JSON-serialized pi-ai `Usage`, when the provider reports it. */
	usageJson: string | null;
	/** pi-ai usage.cost.total converted to integer USD micros. */
	costMicros: number | null;
	resultAssetId: string | null;
	createdAt: Generated<string>;
	startedAt: string | null;
	finishedAt: string | null;
}

export interface Database {
	apikey: Apikey;
	app_meta: AppMetaTable;
	user_setting: UserSettingTable;
	conversation: ConversationTable;
	folder: FolderTable;
	tag: TagTable;
	conversation_tag: ConversationTagTable;
	provider_config: ProviderConfigTable;
	preset: PresetTable;
	attachment: AttachmentTable;
	mcp_server: McpServerTable;
	user_mcp_server_preference: UserMcpServerPreferenceTable;
	conversation_mcp_server: ConversationMcpServerTable;
	message_attachment: MessageAttachmentTable;
	source_category: SourceCategoryTable;
	skill: SkillTable;
	impersonation_session: ImpersonationSessionTable;
	image_workspace: ImageWorkspaceTable;
	image_asset: ImageAssetTable;
	image_attempt: ImageAttemptTable;
}
