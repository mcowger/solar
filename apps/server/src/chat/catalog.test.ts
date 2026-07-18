import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { AllowlistEntry } from "./allowlist";

interface ProviderConfig {
  provider: string;
  apiKey: string | null;
  baseUrl: string | null;
  endpoints?: { id: string; label: string; baseUrl: string; api: string }[];
  enabledModels: AllowlistEntry[];
}

const state = {
  providerConfigs: [] as ProviderConfig[],
  userSettings: new Map<string, Record<string, string | null>>(),
  appMeta: new Map<string, string>(),
};

const db = {
  selectFrom(table: string) {
    return {
      select() {
        return {
          execute: async () => table === "provider_config" ? state.providerConfigs.map((config) => ({
            ...config,
            endpoints: JSON.stringify(config.endpoints ?? []),
            enabledModels: JSON.stringify(config.enabledModels),
          })) : [],
          where(column: string, _operator: string, value: string) {
            return {
              executeTakeFirst: async () => {
                if (table === "provider_config" && column === "provider") {
                  return state.providerConfigs.find((config) => config.provider === value);
                }
                if (table === "user_setting" && column === "userId") {
                  return state.userSettings.get(value);
                }
                if (table === "app_meta" && column === "key") {
                  const metaValue = state.appMeta.get(value);
                  return metaValue === undefined ? undefined : { value: metaValue };
                }
              },
            };
          },
        };
      },
    };
  },
};

mock.module("../db", () => ({ db }));

const catalog = await import("./catalog");

const publicModel = {
  provider: "openai",
  endpointId: "openai-responses",
  modelId: "public-model",
  api: "openai-responses",
};
const privateModel = {
  provider: "anthropic",
  endpointId: "anthropic-messages",
  modelId: "private-model",
  api: "anthropic-messages",
};

beforeEach(() => {
  state.providerConfigs = [];
  state.userSettings.clear();
  state.appMeta.clear();
});

function configureModels(...configs: ProviderConfig[]) {
  state.providerConfigs = configs;
}

describe("catalog model policy", () => {
  test("shows private models only to admins and conservatively describes unknown models", async () => {
    configureModels(
      {
        provider: "openai",
        apiKey: null,
        baseUrl: null,
        enabledModels: [
          { id: publicModel.modelId, endpointId: publicModel.endpointId, api: publicModel.api, visibility: "public" },
          { id: "private-openai", endpointId: "openai-completions", api: "openai-completions", visibility: "private" },
        ],
      },
    );

    expect(await catalog.listAvailableModels()).toEqual([
      { ...publicModel, name: publicModel.modelId, reasoning: false, vision: false },
    ]);
    expect(await catalog.listAvailableModels(true)).toEqual([
      { ...publicModel, name: publicModel.modelId, reasoning: false, vision: false },
      {
        provider: "openai",
        endpointId: "openai-completions",
        modelId: "private-openai",
        api: "openai-completions",
        name: "private-openai",
        reasoning: false,
        vision: false,
      },
    ]);
  });

  test("uses the first still-available selection in conversation, user, admin order", async () => {
    configureModels(
      {
        provider: "openai",
        apiKey: null,
        baseUrl: null,
        enabledModels: [{ id: publicModel.modelId, endpointId: publicModel.endpointId, api: publicModel.api, visibility: "public" }],
      },
      {
        provider: "anthropic",
        apiKey: null,
        baseUrl: null,
        enabledModels: [{ id: privateModel.modelId, endpointId: privateModel.endpointId, api: privateModel.api, visibility: "private" }],
      },
    );
    state.userSettings.set("user-1", {
      defaultProvider: publicModel.provider,
      defaultModelId: publicModel.modelId,
      defaultApi: publicModel.api,
    });
    state.appMeta.set("default_model", JSON.stringify(privateModel));

    expect(await catalog.resolveSelection(privateModel, "user-1")).toEqual(publicModel);
    expect(await catalog.resolveSelection(publicModel, "user-1")).toEqual(publicModel);
    expect(await catalog.resolveSelection({}, undefined, true)).toEqual(privateModel);
  });

  test("rejects incomplete or removed defaults before falling back to the first visible model", async () => {
    configureModels({
      provider: "openai",
      apiKey: null,
      baseUrl: null,
      enabledModels: [{ id: publicModel.modelId, endpointId: publicModel.endpointId, api: publicModel.api, visibility: "public" }],
    });
    state.userSettings.set("user-1", {
      defaultProvider: "removed-provider",
      defaultModelId: "removed-model",
      defaultApi: "removed-api",
    });
    state.appMeta.set("default_model", "not json");

    expect(await catalog.resolveSelection({ provider: publicModel.provider }, "user-1")).toEqual(publicModel);
    await expect(catalog.resolveSelection({})).resolves.toEqual(publicModel);

    state.providerConfigs = [];
    await expect(catalog.resolveSelection({})).rejects.toThrow("No models are configured");
  });

  test("uses only public task models and falls back when the configured task model is unavailable", async () => {
    configureModels({
      provider: "openai",
      apiKey: null,
      baseUrl: null,
      enabledModels: [{ id: publicModel.modelId, endpointId: publicModel.endpointId, api: publicModel.api, visibility: "public" }],
    });

    state.appMeta.set("task_model", JSON.stringify(publicModel));
    await expect(catalog.resolveTaskModel()).resolves.toEqual(publicModel);
    await expect(catalog.resolveTaskModelOrFallback(privateModel)).resolves.toEqual(publicModel);

    state.appMeta.set("task_model", JSON.stringify(privateModel));
    await expect(catalog.resolveTaskModel()).rejects.toThrow("No task model is configured");
    await expect(catalog.resolveTaskModelOrFallback(privateModel)).resolves.toEqual(privateModel);
  });

  test("resolves unknown configured models without provider calls and rejects mock pi resolution", async () => {
    configureModels({
      provider: "openrouter",
      apiKey: "configured-key",
      baseUrl: "https://gateway.example/v1",
      endpoints: [{
        id: "openai-completions",
        label: "Chat Completions",
        baseUrl: "https://gateway.example/v1",
        api: "openai-completions",
      }],
      enabledModels: [],
    });

    const resolved = await catalog.resolveModel({
      provider: "openrouter",
      endpointId: "openai-completions",
      modelId: "gateway-model",
      api: "openai-completions",
    });
    expect(resolved).toMatchObject({
      apiKey: "configured-key",
      model: {
        id: "gateway-model",
        name: "gateway-model",
        api: "openai-completions",
        provider: "solar:openrouter:openai-completions",
        baseUrl: "https://gateway.example/v1",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128_000,
        maxTokens: 4096,
      },
    });
    await expect(catalog.resolveModel({ provider: "mock", endpointId: "mock", modelId: "mock-reasoning", api: "mock" }))
      .rejects.toThrow("mock provider is not a pi-ai model");
  });

  test("normalizes Plexus hints and omits non-text-generation models during discovery", async () => {
    configureModels({
      provider: "plexus",
      apiKey: "test-key",
      baseUrl: null,
      endpoints: [{
        id: "responses",
        label: "Responses",
        baseUrl: "https://plexus.example/v1",
        api: "openai-responses",
      }],
      enabledModels: [],
    });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mock(async () => new Response(JSON.stringify({
      data: [
        {
          id: "gpt-test",
          name: "GPT Test",
          preferred_api: ["responses"],
          pi_provider: "openai",
          pi_model: "gpt-test",
          pi_options: { supportsToolSearch: true },
          architecture: { input_modalities: ["text", "image"], output_modalities: ["text"] },
          supported_parameters: ["reasoning"],
        },
        {
          id: "embedding-test",
          architecture: { input_modalities: ["text"], output_modalities: ["embeddings"] },
        },
      ],
    }))) as unknown as typeof fetch;
    try {
      expect(await catalog.discoverProviderModels("plexus", "responses")).toEqual([{
        id: "gpt-test",
        name: "GPT Test",
        preferredApi: "openai-responses",
        piProvider: "openai",
        piModel: "gpt-test",
        piOptions: { supportsToolSearch: true },
        reasoning: true,
        vision: true,
      }]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
