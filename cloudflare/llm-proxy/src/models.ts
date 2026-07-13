export type Provider = "openai-codex";

/**
 * The public model catalog is deliberately explicit.  Callers must still
 * provide a model on every inference request; this endpoint exists so OpenAI
 * compatible clients can discover the supported IDs instead of guessing.
 */
export const SUPPORTED_MODELS = ["gpt-5.6-terra"] as const;

export function isSupportedModel(model: string): boolean {
  return (SUPPORTED_MODELS as readonly string[]).includes(model);
}

export function providerForModel(model: string): Provider | null {
  // The initial credential route is ChatGPT/Codex OAuth.  Do not accept a
  // prefix wildcard here: advertised and accepted model IDs must be identical.
  return isSupportedModel(model) ? "openai-codex" : null;
}
