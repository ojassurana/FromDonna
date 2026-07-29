export type Env = {
  /** Full HTTPS URL for Codex Responses on the private host relay. */
  CODEX_RELAY_URL: string;
  /**
   * Full HTTPS URL for OpenAI-compatible chat completions on the same host
   * relay (xAI/Grok OAuth). Defaults are derived from CODEX_RELAY_URL when
   * unset by rewriting `/v1/responses` → `/v1/chat/completions`.
   */
  GROK_RELAY_URL?: string;
  RELAY_SHARED_SECRET: string;
  /** HMAC key shared with the gateway Worker, never exposed to sandboxes. */
  LLM_CAPABILITY_SECRET: string;

  // --- Endpoint pool (see pool.ts) ----------------------------------------

  /**
   * JSON array of interchangeable upstream endpoints. Config, not a secret: it
   * holds only URLs and the *names* of the secrets that authenticate them, so
   * the routing topology stays reviewable in git and changeable without a code
   * deploy. Unset = the legacy relay-then-single-key behaviour below.
   */
  LLM_POOL?: string;
  /**
   * KV namespace for per-endpoint cooldowns. Optional: without it the pool
   * still retries within a request, it just cannot remember a bad endpoint
   * between requests. Falls back to CODEX_TOKENS when unbound.
   */
  POOL_STATE?: KVNamespace;
  /** Existing namespace, reused for cooldowns when POOL_STATE is unbound. */
  CODEX_TOKENS?: KVNamespace;

  // --- Direct-provider credentials ----------------------------------------
  // All optional. With no key configured that provider contributes no endpoint
  // and relay failures propagate unchanged, exactly as before the pool existed.

  /** OpenAI API key used when the Codex OAuth relay is out of quota or down. */
  OPENAI_API_KEY?: string;
  /** xAI API key used when the Grok OAuth relay is out of quota or down. */
  XAI_API_KEY?: string;
  /** Override the direct OpenAI Responses endpoint (defaults to the public API). */
  OPENAI_RESPONSES_URL?: string;
  /** Override the direct xAI Chat Completions endpoint (defaults to the public API). */
  XAI_CHAT_COMPLETIONS_URL?: string;
  /**
   * Model id to send on the direct-API fallback. The relay accepts internal
   * aliases (e.g. `gpt-5.6-terra`) that the public API does not, so the
   * fallback needs its own id. Unset = send the requested model as-is.
   */
  OPENAI_FALLBACK_MODEL?: string;
  /** Same for xAI, if a catalog id is relay-only. Unset = send as-is. */
  XAI_FALLBACK_MODEL?: string;
};

export function grokRelayUrl(env: Env): string {
  if (env.GROK_RELAY_URL) return env.GROK_RELAY_URL;
  // Same tunnel as Codex; only the path differs.
  return env.CODEX_RELAY_URL.replace(/\/v1\/responses\/?$/, "/v1/chat/completions");
}
