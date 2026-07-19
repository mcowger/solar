import {
  createProvider,
  envApiKeyAuth,
  type Api,
  type Model,
  type Provider,
} from "@earendil-works/pi-ai";
import { anthropicMessagesApi } from "@earendil-works/pi-ai/api/anthropic-messages.lazy";
import { googleGenerativeAIApi } from "@earendil-works/pi-ai/api/google-generative-ai.lazy";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { openAIResponsesApi } from "@earendil-works/pi-ai/api/openai-responses.lazy";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { db } from "../db";
import { parseAllowlist, type AllowlistEntry, type ModelVisibility } from "./allowlist";
import type { NativeDocumentInput } from "./attachments";
import {
  FALLBACK_DOCUMENT_INPUT,
  nativeAttachmentAdapter,
  type DocumentInputCapabilities,
} from "./nativeAttachmentAdapters";

export { parseAllowlist, type AllowlistEntry, type ModelVisibility } from "./allowlist";

export const MOCK = Boolean(process.env.SOLAR_MOCK_LLM);

const API_STREAMS = {
  "openai-responses": openAIResponsesApi(),
  "openai-completions": openAICompletionsApi(),
  "anthropic-messages": anthropicMessagesApi(),
  "google-generative-ai": googleGenerativeAIApi(),
};

export const PROVIDER_APIS = Object.keys(API_STREAMS);

const UPSTREAM_API_MAP: Record<string, string> = {
  responses: "openai-responses",
  "chat_completions": "openai-completions",
  messages: "anthropic-messages",
  gemini: "google-generative-ai",
  "openai-responses": "openai-responses",
  "openai-completions": "openai-completions",
  "anthropic-messages": "anthropic-messages",
  "google-generative-ai": "google-generative-ai",
};

const piModels = builtinModels();

export interface ProviderEndpoint {
  id: string;
  label: string;
  baseUrl: string;
  api: string;
}

export interface ModelSelection {
  provider: string;
  endpointId: string;
  modelId: string;
  api: string;
}

export interface ModelDescriptor extends ModelSelection {
  name: string;
  reasoning: boolean;
  vision: boolean;
  documents: boolean;
}

export interface ProviderConfigRow {
  provider: string;
  apiKey: string | null;
  baseUrl: string | null;
  endpoints: ProviderEndpoint[];
  enabledModels: AllowlistEntry[];
}

export interface DiscoveredModel {
  id: string;
  name: string;
  preferredApi: string | null;
  piProvider?: string;
  piModel?: string;
  piOptions?: Record<string, unknown>;
  reasoning: boolean;
  vision: boolean;
}

const MOCK_MODELS: ModelDescriptor[] = [
  { provider: "mock", endpointId: "mock", modelId: "mock-reasoning", api: "mock", name: "Mock (reasoning)", reasoning: true, vision: false, documents: false },
  { provider: "mock", endpointId: "mock", modelId: "mock-vision", api: "mock", name: "Mock (vision)", reasoning: false, vision: true, documents: false },
];

function parseEndpoints(json: string | null | undefined, baseUrl: string | null, entries: AllowlistEntry[]) {
  try {
    const parsed = JSON.parse(json ?? "[]");
    if (Array.isArray(parsed)) {
      const endpoints = parsed.flatMap((endpoint) =>
        endpoint &&
        typeof endpoint.id === "string" &&
        typeof endpoint.label === "string" &&
        typeof endpoint.baseUrl === "string" &&
        typeof endpoint.api === "string" &&
        PROVIDER_APIS.includes(endpoint.api)
          ? [{ id: endpoint.id, label: endpoint.label, baseUrl: endpoint.baseUrl, api: endpoint.api }]
          : [],
      );
      if (endpoints.length) return endpoints;
    }
  } catch {
    // Legacy configurations are converted below.
  }
  return [...new Set(entries.map((entry) => entry.api))].map((api) => ({
    id: api,
    label: api,
    baseUrl: baseUrl ?? "",
    api,
  }));
}

export async function loadProviderConfigs(): Promise<ProviderConfigRow[]> {
  const rows = await db
    .selectFrom("provider_config")
    .select(["provider", "apiKey", "baseUrl", "endpoints", "enabledModels"])
    .execute();
  return rows.map((row) => {
    const enabledModels = parseAllowlist(row.enabledModels);
    return {
      provider: row.provider,
      apiKey: row.apiKey,
      baseUrl: row.baseUrl,
      endpoints: parseEndpoints(row.endpoints, row.baseUrl, enabledModels),
      enabledModels,
    };
  });
}

function catalogModel(provider: string, entry: AllowlistEntry): Model<Api> | undefined {
  const modelId = entry.piModel ?? entry.id;
  return piModels.getModel(entry.piProvider ?? provider, modelId) ??
    piModels.getModels().find((model) => model.id === modelId && model.api === entry.api);
}

function describe(provider: string, entry: AllowlistEntry): ModelDescriptor {
  const known = catalogModel(provider, entry);
  return {
    provider,
    endpointId: entry.endpointId,
    modelId: entry.id,
    api: entry.api,
    name: entry.name ?? known?.name ?? entry.id,
    reasoning: entry.reasoning ?? known?.reasoning ?? false,
    vision: entry.vision ?? known?.input.includes("image") ?? false,
    documents: entry.documents ?? false,
  };
}

export async function listAvailableModels(isAdmin = false): Promise<ModelDescriptor[]> {
  const configs = await loadProviderConfigs();
  const available = configs.flatMap((config) =>
    config.enabledModels
      .filter((entry) => entry.visibility === "public" || isAdmin)
      .filter((entry) => config.endpoints.some((endpoint) => endpoint.id === entry.endpointId && endpoint.api === entry.api))
      .map((entry) => describe(config.provider, entry)),
  );
  if (MOCK) available.push(...MOCK_MODELS);
  return available;
}

const ADMIN_DEFAULT_KEY = "default_model";
const TASK_MODEL_KEY = "task_model";
const TITLE_PROMPT_KEY = "title_prompt";
export const THINKING_LEVELS = ["minimal", "low", "medium", "high", "xhigh", "max"] as const;
export const VERBOSITY_LEVELS = ["low", "medium", "high"] as const;

export const DEFAULT_TITLE_PROMPT = `### Task: Generate a concise, 3-5 word title with an emoji summarizing the first user message.
### Guidelines:
- The title should clearly represent the main theme or subject of the conversation.
- Use emojis that enhance understanding of the topic, but avoid quotation marks or special formatting.
- Write the title in the chat's primary language; default to English if multilingual.
- Prioritize accuracy over excessive creativity; keep it clear and simple.
- Your entire response must consist solely of the JSON object, without any introductory or concluding text.
- The output must be a single, raw JSON object, without any markdown code fences or other encapsulating text.
- Ensure no conversational text, affirmations, or explanations precede or follow the raw JSON output, as this will cause direct parsing failure.
### Output: JSON format: { "title": "your concise title here" }
### First User Message: <first_user_message>
{{first_message}}
</first_user_message>`;

type PartialSelection = Partial<ModelSelection>;

function toSelection(selection: PartialSelection): PartialSelection | null {
  return selection.provider && selection.modelId && selection.api ? selection : null;
}

function sameSelection(model: ModelDescriptor, selection: PartialSelection) {
  return model.provider === selection.provider &&
    model.modelId === selection.modelId &&
    model.api === selection.api &&
    (!selection.endpointId || model.endpointId === selection.endpointId);
}

function findAvailable(available: ModelDescriptor[], selection: PartialSelection | null): ModelSelection | null {
  if (!selection) return null;
  const match = available.find((model) => sameSelection(model, selection));
  return match ? { provider: match.provider, endpointId: match.endpointId, modelId: match.modelId, api: match.api } : null;
}

export async function getUserDefault(userId: string): Promise<ModelSelection | null> {
  const row = await db
    .selectFrom("user_setting")
    .select(["defaultProvider", "defaultEndpointId", "defaultModelId", "defaultApi"])
    .where("userId", "=", userId)
    .executeTakeFirst();
  return row ? toSelection({
    provider: row.defaultProvider ?? undefined,
    endpointId: row.defaultEndpointId ?? undefined,
    modelId: row.defaultModelId ?? undefined,
    api: row.defaultApi ?? undefined,
  }) as ModelSelection | null : null;
}

export async function setUserDefault(userId: string, selection: ModelSelection): Promise<void> {
  const values = {
    userId,
    defaultProvider: selection.provider,
    defaultEndpointId: selection.endpointId,
    defaultModelId: selection.modelId,
    defaultApi: selection.api,
    updatedAt: new Date().toISOString(),
  };
  await db.insertInto("user_setting").values(values).onConflict((oc) => oc.column("userId").doUpdateSet(values)).execute();
}

export async function getAdminDefault(): Promise<ModelSelection | null> {
  return getAppMetaSelection(ADMIN_DEFAULT_KEY);
}

export async function setAdminDefault(selection: ModelSelection): Promise<void> {
  await setAppMetaSelection(ADMIN_DEFAULT_KEY, selection);
}

export async function getTaskModel(): Promise<ModelSelection | null> {
  return getAppMetaSelection(TASK_MODEL_KEY);
}

export async function setTaskModel(selection: ModelSelection): Promise<void> {
  await setAppMetaSelection(TASK_MODEL_KEY, selection);
}

export async function getTitlePrompt(): Promise<string> {
  const row = await db.selectFrom("app_meta").select("value").where("key", "=", TITLE_PROMPT_KEY).executeTakeFirst();
  return row?.value ?? DEFAULT_TITLE_PROMPT;
}

export async function setTitlePrompt(prompt: string): Promise<void> {
  await db.insertInto("app_meta").values({ key: TITLE_PROMPT_KEY, value: prompt }).onConflict((oc) => oc.column("key").doUpdateSet({ value: prompt })).execute();
}

export async function resolveTaskModel(): Promise<ModelSelection> {
  const taskModel = findAvailable(await listAvailableModels(), await getTaskModel());
  if (!taskModel) throw new Error("No task model is configured. Select one in admin settings.");
  return taskModel;
}

export async function resolveTaskModelOrFallback(fallback: ModelSelection): Promise<ModelSelection> {
  return findAvailable(await listAvailableModels(), await getTaskModel()) ?? fallback;
}

async function getAppMetaSelection(key: string): Promise<ModelSelection | null> {
  const row = await db.selectFrom("app_meta").select("value").where("key", "=", key).executeTakeFirst();
  if (!row) return null;
  try {
    return toSelection(JSON.parse(row.value)) as ModelSelection | null;
  } catch {
    return null;
  }
}

async function setAppMetaSelection(key: string, selection: ModelSelection): Promise<void> {
  const value = JSON.stringify(selection);
  await db.insertInto("app_meta").values({ key, value }).onConflict((oc) => oc.column("key").doUpdateSet({ value })).execute();
}

export async function resolveSelection(stored: PartialSelection, userId?: string, isAdmin = false): Promise<ModelSelection> {
  const available = await listAvailableModels(isAdmin);
  if (!available.length) throw new Error("No models are configured. Add a provider in admin settings.");
  const fromStored = findAvailable(available, toSelection(stored));
  if (fromStored) return fromStored;
  if (userId) {
    const fromUser = findAvailable(available, await getUserDefault(userId));
    if (fromUser) return fromUser;
  }
  const fromAdmin = findAvailable(available, await getAdminDefault());
  if (fromAdmin) return fromAdmin;
  const first = available[0]!;
  return { provider: first.provider, endpointId: first.endpointId, modelId: first.modelId, api: first.api };
}

export interface ResolvedModel {
  model: Model<Api>;
  runtimeProvider: Provider<Api>;
  apiKey?: string;
}

export async function getModelCapabilities(selection: ModelSelection) {
  if (selection.provider === "mock") return { reasoningLevels: [...THINKING_LEVELS], supportsVerbosity: false, defaultReasoningEffort: null, defaultVerbosity: null };
  const { model } = await resolveModel(selection);
  const config = (await loadProviderConfigs()).find((candidate) => candidate.provider === selection.provider);
  const entry = config?.enabledModels.find((candidate) => candidate.id === selection.modelId && candidate.endpointId === selection.endpointId && candidate.api === selection.api);
  const reasoningLevels = model.reasoning
    ? THINKING_LEVELS.filter((level) => model.thinkingLevelMap?.[level] !== null && (level !== "xhigh" && level !== "max" || model.thinkingLevelMap?.[level] !== undefined))
    : [];
  return {
    reasoningLevels,
    supportsVerbosity: selection.api === "openai-responses",
    defaultReasoningEffort: entry?.reasoningEffort ?? null,
    defaultVerbosity: entry?.verbosity ?? null,
  };
}

const NO_DOCUMENT_INPUT: DocumentInputCapabilities = {
  nativeMimeTypes: [],
  extractedTextMimeTypes: [],
};

export async function documentInputCapabilities(
  selection: ModelSelection,
): Promise<DocumentInputCapabilities> {
  const adapter = nativeAttachmentAdapter(selection);
  const config = (await loadProviderConfigs()).find((candidate) => candidate.provider === selection.provider);
  const enabled = Boolean(
    config?.enabledModels.find(
      (candidate) =>
        candidate.id === selection.modelId &&
        candidate.endpointId === selection.endpointId &&
        candidate.api === selection.api,
    )?.documents,
  );
  if (!enabled) return NO_DOCUMENT_INPUT;
  return adapter
    ? {
        nativeMimeTypes: adapter.nativeMimeTypes,
        extractedTextMimeTypes: adapter.extractedTextMimeTypes,
      }
    : FALLBACK_DOCUMENT_INPUT;
}

export async function documentInputMimeTypes(selection: ModelSelection): Promise<readonly string[]> {
  const capabilities = await documentInputCapabilities(selection);
  return [...capabilities.nativeMimeTypes, ...capabilities.extractedTextMimeTypes];
}

function runtimeProviderId(selection: ModelSelection) {
  return `solar:${selection.provider}:${selection.endpointId}`;
}

export async function resolveModel(selection: ModelSelection): Promise<ResolvedModel> {
  if (selection.provider === "mock") throw new Error("mock provider is not a pi-ai model");
  const config = (await loadProviderConfigs()).find((candidate) => candidate.provider === selection.provider);
  const endpoint = config?.endpoints.find((candidate) => candidate.id === selection.endpointId && candidate.api === selection.api);
  if (!config || !endpoint) throw new Error(`Unknown endpoint "${selection.provider}/${selection.endpointId}"`);
  const entry = config.enabledModels.find((candidate) => candidate.id === selection.modelId && candidate.endpointId === selection.endpointId && candidate.api === selection.api);
  const known = entry ? catalogModel(selection.provider, entry) : undefined;
  const provider = runtimeProviderId(selection);
  const model: Model<Api> = known
    ? { ...known, id: selection.modelId, provider, api: selection.api as Api, baseUrl: endpoint.baseUrl, ...(entry?.piOptions ?? {}) } as Model<Api>
    : synthesizeModel(selection, endpoint.baseUrl, provider, entry);
  const runtimeProvider = createProvider({
    id: provider,
    baseUrl: endpoint.baseUrl,
    auth: { apiKey: envApiKeyAuth("Solar provider API key", []) },
    models: [model],
    api: API_STREAMS,
  });
  return { model, runtimeProvider, apiKey: config.apiKey ?? undefined };
}

function synthesizeModel(selection: ModelSelection, baseUrl: string, provider: string, entry?: AllowlistEntry): Model<Api> {
  return {
    id: selection.modelId,
    name: entry?.name ?? selection.modelId,
    api: selection.api as Api,
    provider,
    baseUrl,
    reasoning: entry?.reasoning ?? false,
    input: entry?.vision ? ["text", "image"] : ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 4096,
    ...(entry?.piOptions ?? {}),
  } as Model<Api>;
}

export interface GenerationParams {
  systemPrompt?: string;
  reasoningEffort?: string;
  reasoningSummary?: boolean;
  verbosity?: string;
  documents?: NativeDocumentInput[];
}

export function streamModel(resolved: ResolvedModel, context: Parameters<Provider<Api>["stream"]>[1], signal: AbortSignal, params: GenerationParams = {}) {
  const apiKey = resolved.apiKey ? { apiKey: resolved.apiKey } : {};
  const api = resolved.model.api;
  const wantSummary = params.reasoningSummary;
  const wantVerbosity = params.verbosity && api === "openai-responses";
  const onPayload = wantSummary || wantVerbosity || params.documents?.length
    ? (payload: unknown) => {
        const next = payload as Record<string, unknown>;
        if (api === "openai-responses") {
          if (wantSummary) next.reasoning = { ...(next.reasoning as object), summary: "auto" };
          if (wantVerbosity) next.text = { ...(next.text as object), verbosity: params.verbosity };
        }
        return params.documents?.length
          ? nativeAttachmentAdapter({ api })?.injectDocuments(next, params.documents) ?? next
          : next;
      }
    : undefined;
  if (params.reasoningEffort) {
    return resolved.runtimeProvider.streamSimple(resolved.model, context, { signal, reasoning: params.reasoningEffort as never, ...(onPayload ? { onPayload } : {}), ...apiKey });
  }
  return resolved.runtimeProvider.stream(resolved.model, context, { signal, ...(onPayload ? { onPayload } : {}), ...apiKey });
}

function modelsUrl(baseUrl: string) {
  const url = new URL(baseUrl);
  url.pathname = `${url.pathname.replace(/\/+$/, "")}${url.pathname.replace(/\/+$/, "").endsWith("/v1") ? "" : "/v1"}/models`;
  return url;
}

function upstreamApi(value: unknown) {
  return typeof value === "string" ? UPSTREAM_API_MAP[value] ?? null : null;
}

function isTextGeneration(model: Record<string, unknown>) {
  const architecture = model.architecture;
  if (!architecture || typeof architecture !== "object" || Array.isArray(architecture)) return true;
  const input = (architecture as { input_modalities?: unknown }).input_modalities;
  const output = (architecture as { output_modalities?: unknown }).output_modalities;
  const modalities = (value: unknown) => Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
  const inputModalities = modalities(input);
  const outputModalities = modalities(output);
  return (!inputModalities.length || inputModalities.includes("text")) && (!outputModalities.length || outputModalities.includes("text"));
}

export async function discoverProviderModels(provider: string, endpointId: string): Promise<DiscoveredModel[]> {
  const config = (await loadProviderConfigs()).find((candidate) => candidate.provider === provider);
  const endpoint = config?.endpoints.find((candidate) => candidate.id === endpointId);
  if (!config || !endpoint || !endpoint.baseUrl) throw new Error("Provider endpoint is not configured");
  const response = await fetch(modelsUrl(endpoint.baseUrl), {
    headers: config.apiKey ? { authorization: `Bearer ${config.apiKey}` } : {},
  });
  if (!response.ok) throw new Error(`Model query failed (${response.status} ${response.statusText})`);
  const payload = await response.json() as { data?: unknown };
  if (!Array.isArray(payload.data)) throw new Error("Model query returned an invalid response");
  return payload.data.flatMap((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return [];
    const model = item as Record<string, unknown>;
    if (typeof model.id !== "string" || !isTextGeneration(model)) return [];
    const preferred = Array.isArray(model.preferred_api) ? model.preferred_api.map(upstreamApi).find((api): api is string => api !== null) ?? null : null;
    const architecture = model.architecture as { input_modalities?: unknown } | undefined;
    const input = Array.isArray(architecture?.input_modalities) ? architecture.input_modalities : [];
    const supported = Array.isArray(model.supported_parameters) ? model.supported_parameters : [];
    return [{
      id: model.id,
      name: typeof model.name === "string" ? model.name : model.id,
      preferredApi: preferred,
      ...(typeof model.pi_provider === "string" ? { piProvider: model.pi_provider } : {}),
      ...(typeof model.pi_model === "string" ? { piModel: model.pi_model } : {}),
      ...(model.pi_options && typeof model.pi_options === "object" && !Array.isArray(model.pi_options) ? { piOptions: model.pi_options as Record<string, unknown> } : {}),
      reasoning: supported.includes("reasoning"),
      vision: input.includes("image"),
    }];
  });
}

export async function importProviderModels(provider: string, endpointId: string, imports: { id: string; api: string; visibility: ModelVisibility }[]) {
  const config = (await loadProviderConfigs()).find((candidate) => candidate.provider === provider);
  if (!config) throw new Error("Provider not found");
  const discovered = await discoverProviderModels(provider, endpointId);
  const imported = imports.map((selection) => {
    const model = discovered.find((candidate) => candidate.id === selection.id);
    const endpoint = config.endpoints.find((candidate) => candidate.api === selection.api);
    if (!model || !endpoint) throw new Error(`Model "${selection.id}" cannot use ${selection.api}`);
    return {
      id: model.id,
      endpointId: endpoint.id,
      api: selection.api,
      visibility: selection.visibility,
      name: model.name,
      ...(model.piProvider ? { piProvider: model.piProvider } : {}),
      ...(model.piModel ? { piModel: model.piModel } : {}),
      ...(model.piOptions ? { piOptions: model.piOptions } : {}),
      reasoning: model.reasoning,
      vision: model.vision,
    } satisfies AllowlistEntry;
  });
  const enabledModels = [...config.enabledModels.filter((entry) => !imported.some((item) => item.id === entry.id)), ...imported];
  await db.updateTable("provider_config").set({ enabledModels: JSON.stringify(enabledModels), updatedAt: new Date().toISOString() }).where("provider", "=", provider).execute();
}
