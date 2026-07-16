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
};

export function grokRelayUrl(env: Env): string {
  if (env.GROK_RELAY_URL) return env.GROK_RELAY_URL;
  // Same tunnel as Codex; only the path differs.
  return env.CODEX_RELAY_URL.replace(/\/v1\/responses\/?$/, "/v1/chat/completions");
}
