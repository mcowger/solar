import { builtinModels } from "@earendil-works/pi-ai/providers/all";

/**
 * pi-ai model registry. M1 ships a single hard-coded provider/model (OpenAI
 * gpt-4o-mini); API keys are read from the environment by pi-ai. Multi-provider
 * selection and DB-stored keys arrive in M3/M4.
 */
export const models = builtinModels();

export const DEFAULT_PROVIDER = "openai";
export const DEFAULT_MODEL_ID = "gpt-4o-mini";
export const DEFAULT_MODEL = `${DEFAULT_PROVIDER}/${DEFAULT_MODEL_ID}`;

export function getDefaultModel() {
  const model = models.getModel(DEFAULT_PROVIDER, DEFAULT_MODEL_ID);
  if (!model) {
    throw new Error(
      `Default model ${DEFAULT_MODEL} is unavailable (check pi-ai catalog / API key).`,
    );
  }
  return model;
}
