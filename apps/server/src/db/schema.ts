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
  modelId: string | null;
  modelApi: string | null;
  createdAt: Generated<string>;
  updatedAt: Generated<string>;
}

/** Admin-owned, global provider credentials + model allowlist (M3). */
export interface ProviderConfigTable {
  /** Provider id, e.g. "openai" | "anthropic" | "openrouter". */
  provider: string;
  apiKey: string | null;
  baseUrl: string | null;
  /** JSON array of `{ id, api }` allowlist entries. */
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

export interface Database {
  app_meta: AppMetaTable;
  conversation: ConversationTable;
  message: MessageTable;
  folder: FolderTable;
  tag: TagTable;
  conversation_tag: ConversationTagTable;
  provider_config: ProviderConfigTable;
}
