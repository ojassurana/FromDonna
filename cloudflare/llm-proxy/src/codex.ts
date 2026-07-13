export type Env = {
  CODEX_RELAY_URL: string;
  RELAY_SHARED_SECRET: string;
};

/**
 * The Worker never owns Codex OAuth state. The trusted relay resolves Hermes's
 * active runtime credential for every request, keeping one token authority.
 */
export async function codexResponse(env: Env, body: Record<string, unknown>): Promise<Response> {
  return fetch(env.CODEX_RELAY_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Relay-Token": env.RELAY_SHARED_SECRET,
      "ngrok-skip-browser-warning": "true",
    },
    body: JSON.stringify(body),
  });
}
