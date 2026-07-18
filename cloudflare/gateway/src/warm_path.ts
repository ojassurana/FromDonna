/**
 * Pure warm-path decision helpers for Telegram inject latency.
 *
 * Kept free of I/O so unit tests can pin skip/early-typing policy without
 * E2B, D1, or Telegram.
 */

/** Subset of harness GET /health used by inject. */
export type WarmPathHealth = {
  ok?: boolean;
  auth_ready?: boolean;
  telegram_proxy_ready?: boolean;
  gateway_running?: boolean;
  composio_mcp_ready?: boolean;
};

/**
 * True when the sandbox Hermes Telegram gateway is already live and can
 * accept POST /telegram/update without a full /bootstrap.
 *
 * Proxy tokens are deterministic HMAC (no expiry). Composio MCP tokens are
 * long-lived (session TTL days); if health says ready, the live env still
 * has a working Bearer.
 */
export function isWarmHarnessReady(health: WarmPathHealth | null | undefined): boolean {
  if (!health) return false;
  return (
    health.ok === true &&
    health.auth_ready === true &&
    health.telegram_proxy_ready === true &&
    health.gateway_running === true
  );
}

/**
 * Per-message inject may skip /bootstrap when the gateway is already running.
 * When requireComposio is true (provision/replace), never skip — caller must
 * hard-require MCP wiring.
 */
export function shouldSkipBootstrap(
  health: WarmPathHealth | null | undefined,
  opts?: { requireComposio?: boolean },
): boolean {
  if (opts?.requireComposio === true) return false;
  if (!isWarmHarnessReady(health)) return false;
  // Soft inject path: prefer ready Composio, but still skip bootstrap when
  // gateway is live even if MCP flag is false (chat still works).
  return true;
}

/**
 * Pre-inject checkpoint pull is best-effort backup. On the warm path it
 * adds multi-second RTT before the user sees typing. Prefer post-inject
 * harvest / waitUntil instead when the harness is already ready.
 */
export function shouldSkipPreInjectCheckpoint(
  health: WarmPathHealth | null | undefined,
): boolean {
  return isWarmHarnessReady(health);
}

/**
 * Early Worker-edge typing for inbound user messages (not callback presses).
 * Uses real bot token via Worker; never invents reply text.
 */
export function shouldSendEarlyTyping(event: {
  type: string;
} | null | undefined): boolean {
  if (!event) return false;
  return event.type === "message";
}
