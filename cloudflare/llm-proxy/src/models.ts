import { codexAdapter, type Env } from "./codex";
import type { ProviderAdapter } from "./openai";

export type Provider = "openai-codex";

/**
 * The public model catalog is deliberately explicit. Callers must still
 * provide a model on every inference request; this endpoint exists so OpenAI
 * compatible clients can discover supported IDs instead of guessing.
 */
export const SUPPORTED_MODELS = ["gpt-5.6-terra"] as const;

const MODEL_ADAPTERS: Record<string, { provider: Provider; adapter: ProviderAdapter<Env> }> = {
  "gpt-5.6-terra": { provider: "openai-codex", adapter: codexAdapter },
};

export function isSupportedModel(model: string): boolean {
  return Object.hasOwn(MODEL_ADAPTERS, model);
}

export function providerForModel(model: string): Provider | null {
  return MODEL_ADAPTERS[model]?.provider ?? null;
}

/** Model routing lives here; the Chat Completions contract itself is provider-neutral. */
export function adapterForModel(model: string): ProviderAdapter<Env> | null {
  return MODEL_ADAPTERS[model]?.adapter ?? null;
}
