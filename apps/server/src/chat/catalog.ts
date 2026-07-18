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
interface AllowlistEntry {
  id: string;
  api: string;
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

function parseAllowlist(json: string): AllowlistEntry[] {
  try {
    const parsed = JSON.parse(json);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (e): e is AllowlistEntry =>
        e && typeof e.id === "string" && typeof e.api === "string",
    );
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
 * Models a user may pick: every allowlisted model across configured providers,
 * plus the mock models when SOLAR_MOCK_LLM is set.
 */
export async function listAvailableModels(): Promise<ModelDescriptor[]> {
  const configs = await loadProviderConfigs();
  const available: ModelDescriptor[] = [];
  for (const cfg of configs) {
    for (const entry of cfg.enabledModels) {
      available.push(describe(cfg.provider, entry));
    }
  }
  if (MOCK) available.push(...MOCK_MODELS);
  return available;
}

/**
 * Resolve the model to use for a conversation. Uses the stored selection when
 * present and still available; otherwise falls back to the first available
 * model (personal/admin defaults arrive in a later step).
 */
export async function resolveSelection(
  stored: Partial<ModelSelection>,
): Promise<ModelSelection> {
  const available = await listAvailableModels();
  if (available.length === 0) {
    throw new Error("No models are configured. Add a provider in admin settings.");
  }
  if (stored.provider && stored.modelId && stored.api) {
    const match = available.find(
      (m) =>
        m.provider === stored.provider &&
        m.modelId === stored.modelId &&
        m.api === stored.api,
    );
    if (match) return { provider: match.provider, modelId: match.modelId, api: match.api };
  }
  const first = available[0]!;
  return { provider: first.provider, modelId: first.modelId, api: first.api };
}

/** Resolved model plus the credential needed to stream it. */
export interface ResolvedModel {
  model: Model<Api>;
  apiKey?: string;
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

/** Stream via pi-ai for a resolved (non-mock) model. */
export function streamModel(
  resolved: ResolvedModel,
  context: Parameters<typeof piModels.stream>[1],
  signal: AbortSignal,
) {
  return piModels.stream(resolved.model, context, {
    signal,
    ...(resolved.apiKey ? { apiKey: resolved.apiKey } : {}),
  });
}
