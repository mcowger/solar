import {
  createModels,
  createProvider,
  envApiKeyAuth,
  type Api,
  type Model,
} from "@earendil-works/pi-ai";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { openrouterProvider } from "@earendil-works/pi-ai/providers/openrouter";
import { getBuiltinModels } from "@earendil-works/pi-ai/providers/all";
import { openAIResponsesApi } from "@earendil-works/pi-ai/api/openai-responses.lazy";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { db } from "../db";

/** Whether the mock (zero-cost) provider is active — see chat/models.ts. */
export const MOCK = Boolean(process.env.SOLAR_MOCK_LLM);

/** A concrete per-conversation model choice. */
export interface ModelSelection {
  provider: string;
  modelId: string;
  api: string;
}

/** A model offered to users, derived from the allowlist / catalog. */
export interface ModelDescriptor extends ModelSelection {
  name: string;
  reasoning: boolean;
  vision: boolean;
}

/** One allowlist entry stored in `provider_config.enabledModels`. */
export type ModelVisibility = "public" | "private";

export interface AllowlistEntry {
  id: string;
  api: string;
  visibility: ModelVisibility;
}

/**
 * pi-ai provider registry for the M3 slice: OpenAI (both the responses and
 * completions transports behind one provider id), Anthropic, and OpenRouter.
 * API keys and base URLs come from the DB per request; the env-based auth here
 * is only a fallback when a provider row omits a key.
 */
const piModels = createModels();
piModels.setProvider(
  createProvider<"openai-responses" | "openai-completions">({
    id: "openai",
    name: "OpenAI",
    baseUrl: "https://api.openai.com/v1",
    auth: { apiKey: envApiKeyAuth("OpenAI API key", ["OPENAI_API_KEY"]) },
    models: getBuiltinModels("openai"),
    api: {
      "openai-responses": openAIResponsesApi(),
      "openai-completions": openAICompletionsApi(),
    },
  }),
);
piModels.setProvider(anthropicProvider());
piModels.setProvider(openrouterProvider());

const PROVIDER_BASE_URLS: Record<string, string> = {
  openai: "https://api.openai.com/v1",
  anthropic: "https://api.anthropic.com",
  openrouter: "https://openrouter.ai/api/v1",
};

/** Providers the M3 slice knows how to talk to (excludes the mock provider). */
export const SUPPORTED_PROVIDERS = Object.keys(PROVIDER_BASE_URLS);

/** The stream APIs each provider's allowlist entries may use. */
export const PROVIDER_APIS: Record<string, string[]> = {
  openai: ["openai-responses", "openai-completions"],
  anthropic: ["anthropic-messages"],
  openrouter: ["openai-completions"],
};

/** Mock models surfaced when SOLAR_MOCK_LLM is set (zero API cost). */
const MOCK_MODELS: ModelDescriptor[] = [
  {
    provider: "mock",
    modelId: "mock-reasoning",
    api: "mock",
    name: "Mock (reasoning)",
    reasoning: true,
    vision: false,
  },
  {
    provider: "mock",
    modelId: "mock-vision",
    api: "mock",
    name: "Mock (vision)",
    reasoning: false,
    vision: true,
  },
];

interface ProviderConfigRow {
  provider: string;
  apiKey: string | null;
  baseUrl: string | null;
  enabledModels: AllowlistEntry[];
}

async function loadProviderConfigs(): Promise<ProviderConfigRow[]> {
  const rows = await db
    .selectFrom("provider_config")
    .select(["provider", "apiKey", "baseUrl", "enabledModels"])
    .execute();
  return rows.map((r) => ({
    provider: r.provider,
    apiKey: r.apiKey,
    baseUrl: r.baseUrl,
    enabledModels: parseAllowlist(r.enabledModels),
  }));
}

export function parseAllowlist(json: string): AllowlistEntry[] {
  try {
    const parsed = JSON.parse(json);
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((entry) => {
      if (!entry || typeof entry.id !== "string" || typeof entry.api !== "string") {
        return [];
      }
      return [{
        id: entry.id,
        api: entry.api,
        visibility: entry.visibility === "private" ? "private" : "public",
      }];
    });
  } catch {
    return [];
  }
}

/** Catalog metadata for a known model, if pi-ai ships one. */
function catalogModel(provider: string, modelId: string): Model<Api> | undefined {
  return piModels.getModel(provider, modelId);
}

function describe(
  provider: string,
  entry: AllowlistEntry,
): ModelDescriptor {
  const known = catalogModel(provider, entry.id);
  return {
    provider,
    modelId: entry.id,
    api: entry.api,
    name: known?.name ?? entry.id,
    reasoning: known?.reasoning ?? false,
    vision: known?.input.includes("image") ?? false,
  };
}

/**
 * Models a user may pick: public models, plus private models for admins, and
 * the mock models when SOLAR_MOCK_LLM is set.
 */
export async function listAvailableModels(isAdmin = false): Promise<ModelDescriptor[]> {
  const configs = await loadProviderConfigs();
  const available: ModelDescriptor[] = [];
  for (const cfg of configs) {
    for (const entry of cfg.enabledModels) {
      if (entry.visibility === "private" && !isAdmin) continue;
      available.push(describe(cfg.provider, entry));
    }
  }
  if (MOCK) available.push(...MOCK_MODELS);
  return available;
}

const ADMIN_DEFAULT_KEY = "default_model";

function toSelection(sel: Partial<ModelSelection>): ModelSelection | null {
  return sel.provider && sel.modelId && sel.api
    ? { provider: sel.provider, modelId: sel.modelId, api: sel.api }
    : null;
}

function findAvailable(
  available: ModelDescriptor[],
  sel: ModelSelection | null,
): ModelSelection | null {
  if (!sel) return null;
  const match = available.find(
    (m) => m.provider === sel.provider && m.modelId === sel.modelId && m.api === sel.api,
  );
  return match ? { provider: match.provider, modelId: match.modelId, api: match.api } : null;
}

/** The user's personal default model, if set. */
export async function getUserDefault(
  userId: string,
): Promise<ModelSelection | null> {
  const row = await db
    .selectFrom("user_setting")
    .select(["defaultProvider", "defaultModelId", "defaultApi"])
    .where("userId", "=", userId)
    .executeTakeFirst();
  return row
    ? toSelection({
        provider: row.defaultProvider ?? undefined,
        modelId: row.defaultModelId ?? undefined,
        api: row.defaultApi ?? undefined,
      })
    : null;
}

/** Persist the user's personal default model. */
export async function setUserDefault(
  userId: string,
  sel: ModelSelection,
): Promise<void> {
  await db
    .insertInto("user_setting")
    .values({
      userId,
      defaultProvider: sel.provider,
      defaultModelId: sel.modelId,
      defaultApi: sel.api,
      updatedAt: new Date().toISOString(),
    })
    .onConflict((oc) =>
      oc.column("userId").doUpdateSet({
        defaultProvider: sel.provider,
        defaultModelId: sel.modelId,
        defaultApi: sel.api,
        updatedAt: new Date().toISOString(),
      }),
    )
    .execute();
}

/** The admin-wide default model, if set. */
export async function getAdminDefault(): Promise<ModelSelection | null> {
  const row = await db
    .selectFrom("app_meta")
    .select("value")
    .where("key", "=", ADMIN_DEFAULT_KEY)
    .executeTakeFirst();
  if (!row) return null;
  try {
    return toSelection(JSON.parse(row.value));
  } catch {
    return null;
  }
}

/** Persist the admin-wide default model. */
export async function setAdminDefault(sel: ModelSelection): Promise<void> {
  const value = JSON.stringify(sel);
  await db
    .insertInto("app_meta")
    .values({ key: ADMIN_DEFAULT_KEY, value })
    .onConflict((oc) => oc.column("key").doUpdateSet({ value }))
    .execute();
}

/**
 * Resolve the model to use for a conversation. Preference order: the stored
 * conversation selection → the user's personal default → the admin default →
 * the first available model. Only selections still present in the allowlist are
 * honored.
 */
export async function resolveSelection(
  stored: Partial<ModelSelection>,
  userId?: string,
  isAdmin = false,
): Promise<ModelSelection> {
  const available = await listAvailableModels(isAdmin);
  if (available.length === 0) {
    throw new Error("No models are configured. Add a provider in admin settings.");
  }

  const fromStored = findAvailable(available, toSelection(stored));
  if (fromStored) return fromStored;

  if (userId) {
    const fromUser = findAvailable(available, await getUserDefault(userId));
    if (fromUser) return fromUser;
  }

  const fromAdmin = findAvailable(available, await getAdminDefault());
  if (fromAdmin) return fromAdmin;

  const first = available[0]!;
  return { provider: first.provider, modelId: first.modelId, api: first.api };
}

/** Resolved model plus the credential needed to stream it. */
export interface ResolvedModel {
  model: Model<Api>;
  apiKey?: string;
}

const THINKING_LEVELS = ["minimal", "low", "medium", "high", "xhigh", "max"] as const;

export async function getModelCapabilities(selection: ModelSelection) {
  if (selection.provider === "mock") {
    return {
      reasoningLevels: [...THINKING_LEVELS],
      supportsVerbosity: false,
    };
  }
  const { model } = await resolveModel(selection);
  const reasoningLevels = model.reasoning
    ? THINKING_LEVELS.filter((level) => {
        const mapped = model.thinkingLevelMap?.[level];
        if (mapped === null) return false;
        return level !== "xhigh" && level !== "max" || mapped !== undefined;
      })
    : [];
  return {
    reasoningLevels,
    supportsVerbosity: selection.api === "openai-responses",
  };
}

/**
 * Build the pi-ai `Model` for a selection, applying the DB-configured base URL
 * and returning the API key to pass per-call. Throws for the mock provider,
 * which is streamed by the local echo generator, not pi-ai.
 */
export async function resolveModel(
  selection: ModelSelection,
): Promise<ResolvedModel> {
  if (selection.provider === "mock") {
    throw new Error("mock provider is not a pi-ai model");
  }
  const cfg = await db
    .selectFrom("provider_config")
    .select(["apiKey", "baseUrl"])
    .where("provider", "=", selection.provider)
    .executeTakeFirst();

  const baseUrl =
    cfg?.baseUrl ?? PROVIDER_BASE_URLS[selection.provider];
  if (!baseUrl) {
    throw new Error(`Unknown provider "${selection.provider}"`);
  }

  const known = catalogModel(selection.provider, selection.modelId);
  const model: Model<Api> =
    known && known.api === selection.api
      ? { ...known, baseUrl }
      : synthesizeModel(selection, baseUrl);

  return { model, apiKey: cfg?.apiKey ?? undefined };
}

/**
 * Construct a minimal `Model` for an allowlisted id pi-ai doesn't ship in its
 * catalog (custom-baseURL / gateway models). Capabilities default conservatively;
 * pi-ai auto-detects compat behavior from the base URL.
 */
function synthesizeModel(selection: ModelSelection, baseUrl: string): Model<Api> {
  return {
    id: selection.modelId,
    name: selection.modelId,
    api: selection.api as Api,
    provider: selection.provider,
    baseUrl,
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 4096,
  };
}

/** Reasoning/verbosity params applied to a turn (from a conversation snapshot). */
export interface GenerationParams {
  systemPrompt?: string;
  /** pi ThinkingLevel; enables reasoning via streamSimple when set. */
  reasoningEffort?: string;
  /** Request a provider reasoning summary (openai-responses / anthropic). */
  reasoningSummary?: boolean;
  /** openai-responses only. */
  verbosity?: string;
}

/** Stream via pi-ai for a resolved (non-mock) model, applying reasoning params. */
export function streamModel(
  resolved: ResolvedModel,
  context: Parameters<typeof piModels.stream>[1],
  signal: AbortSignal,
  params: GenerationParams = {},
) {
  const apiKeyOpt = resolved.apiKey ? { apiKey: resolved.apiKey } : {};
  const api = resolved.model.api;

  // onPayload injects provider-native knobs the typed options don't expose:
  // a reasoning summary (openai-responses / anthropic) and text verbosity
  // (openai-responses only).
  const wantSummary = params.reasoningSummary;
  const wantVerbosity = params.verbosity && api === "openai-responses";
  const onPayload =
    wantSummary || wantVerbosity
      ? (payload: unknown) => {
          const p = payload as Record<string, unknown>;
          if (api === "openai-responses") {
            if (wantSummary) {
              p.reasoning = { ...(p.reasoning as object), summary: "auto" };
            }
            if (wantVerbosity) {
              p.text = { ...(p.text as object), verbosity: params.verbosity };
            }
          } else if (api === "anthropic-messages" && wantSummary) {
            // Anthropic streams thinking natively when reasoning is enabled;
            // nothing extra needed on the payload.
          }
          return p;
        }
      : undefined;

  // Reasoning effort uses streamSimple (maps ThinkingLevel per model).
  if (params.reasoningEffort) {
    return piModels.streamSimple(resolved.model, context, {
      signal,
      reasoning: params.reasoningEffort as never,
      ...(onPayload ? { onPayload } : {}),
      ...apiKeyOpt,
    });
  }

  return piModels.stream(resolved.model, context, {
    signal,
    ...(onPayload ? { onPayload } : {}),
    ...apiKeyOpt,
  });
}
