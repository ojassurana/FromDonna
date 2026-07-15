import { codexAdapter } from "./codex";
import type { Env } from "./env";
import { grokAdapter } from "./grok";
import type { ProviderAdapter } from "./openai";

export type Provider = "openai-codex" | "xai-oauth";

/**
 * Explicit public catalog. Callers must send one of these model IDs; there is
 * no server-side default or provider parameter. Provider is derived here.
 */
export const SUPPORTED_MODELS = [
  "gpt-5.6-terra",
  "grok-4.5",
  "grok-4.3",
  "grok-4.20-0309-reasoning",
  "grok-4.20-0309-non-reasoning",
] as const;

const MODEL_ADAPTERS: Record<string, { provider: Provider; adapter: ProviderAdapter<Env> }> = {
  "gpt-5.6-terra": { provider: "openai-codex", adapter: codexAdapter },
  "grok-4.5": { provider: "xai-oauth", adapter: grokAdapter },
  "grok-4.3": { provider: "xai-oauth", adapter: grokAdapter },
  "grok-4.20-0309-reasoning": { provider: "xai-oauth", adapter: grokAdapter },
  "grok-4.20-0309-non-reasoning": { provider: "xai-oauth", adapter: grokAdapter },
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
