export type Env = {
  /** Real Exa API key — Worker secret only; never sent to sandboxes. */
  EXA_API_KEY: string;
  /**
   * Placeholder the sandbox sends as x-api-key (MVP stub auth).
   * TODO: replace with short-lived HMAC capability verified against gateway.
   */
  API_STUB_TOKEN?: string;
};

export const EXA_UPSTREAM = "https://api.exa.ai";

/** Default stub token until real capability tokens ship. */
export function stubToken(env: Env): string {
  const t = (env.API_STUB_TOKEN || "STUB").trim();
  return t || "STUB";
}
