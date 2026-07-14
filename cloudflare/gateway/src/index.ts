/**
 * FromDonna Telegram gateway Worker.
 *
 * Owns Telegram I/O + D1 routing + E2B lifecycle. Never puts Telegram/Codex
 * credentials into sandboxes. Hermes talks to the existing LLM proxy Worker
 * with a short-lived capability token only.
 */

import {
  normalizeTelegramUpdate,
  renderTelegramActions,
  type HarnessReply,
  type NormalizedTelegramEvent,
  type TelegramUpdate,
} from "./telegram";

export interface Env {
  FROMDONNA_ROUTING: D1Database;
  TELEGRAM_BOT_TOKEN: string;
  TELEGRAM_WEBHOOK_SECRET: string;
  E2B_API_KEY: string;
  WORKER_TO_HARNESS_SECRET: string;
  /** HMAC key shared only with the LLM proxy for short-lived turn capability tokens. */
  LLM_CAPABILITY_SECRET: string;
  E2B_TEMPLATE: string;
  HARNESS_PORT: string;
  /** Optional override; defaults to e2b.dev when E2B omits domain. */
  E2B_SANDBOX_DOMAIN?: string;
}

type UserAgentRow = {
  user_id: string;
  gateway: string;
  gateway_user_id: string;
  gateway_conversation_id: string;
  runtime_provider: "e2b";
  runtime_id: string;
  runtime_domain: string | null;
  status: "provisioning" | "ready" | "failed";
};

type E2bSandbox = { sandboxID: string; domain?: string | null };

const json = (body: unknown, status = 200) => Response.json(body, { status });
const DEFAULT_SANDBOX_DOMAIN = "e2b.dev";
const SANDBOX_TTL_SECONDS = 3600;

function internalUserId(gateway: string, gatewayUserId: string): string {
  return `${gateway}:${gatewayUserId}`;
}

function required(env: Env, key: keyof Env): string {
  const value = env[key];
  if (typeof value !== "string" || !value) throw new Error(`Worker secret/config ${key} is missing.`);
  return value;
}

function sandboxDomain(env: Env, rowDomain: string | null | undefined): string {
  return rowDomain || env.E2B_SANDBOX_DOMAIN || DEFAULT_SANDBOX_DOMAIN;
}

function harnessBaseUrl(env: Env, sandboxId: string, domain: string | null | undefined): string {
  const port = required(env, "HARNESS_PORT");
  return `https://${port}-${sandboxId}.${sandboxDomain(env, domain)}`;
}

/** URL-safe HMAC capability for one Hermes → proxy turn; never a provider credential. */
function encodeBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

async function mintLlmCapability(env: Env, userId: string): Promise<string> {
  const payload = new TextEncoder().encode(JSON.stringify({ sub: userId, exp: Math.floor(Date.now() / 1000) + 15 * 60 }));
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(required(env, "LLM_CAPABILITY_SECRET")), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = new Uint8Array(await crypto.subtle.sign("HMAC", key, payload));
  return `${encodeBase64Url(payload)}.${encodeBase64Url(signature)}`;
}

async function telegram(env: Env, method: string, body: Record<string, unknown>): Promise<void> {
  const response = await fetch(`https://api.telegram.org/bot${required(env, "TELEGRAM_BOT_TOKEN")}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(`Telegram ${method} failed with HTTP ${response.status}${detail ? `: ${detail.slice(0, 200)}` : ""}`);
  }
}

async function createSandbox(env: Env, userId: string): Promise<E2bSandbox> {
  const response = await fetch("https://api.e2b.app/sandboxes", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "X-API-KEY": required(env, "E2B_API_KEY"),
    },
    body: JSON.stringify({
      templateID: required(env, "E2B_TEMPLATE"),
      autoPause: true,
      autoResume: { enabled: true },
      timeout: SANDBOX_TTL_SECONDS,
      secure: true,
      allow_internet_access: true,
      // Present for any post-create processes; warm harness still needs /bootstrap.
      envVars: {
        WORKER_TO_HARNESS_SECRET: required(env, "WORKER_TO_HARNESS_SECRET"),
        FROMDONNA_RUNTIME: "e2b",
      },
      metadata: { fromdonna_user_id: userId },
    }),
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(`E2B sandbox create failed with HTTP ${response.status}${detail ? `: ${detail.slice(0, 200)}` : ""}`);
  }
  const payload = await response.json<E2bSandbox>();
  if (!payload.sandboxID) throw new Error("E2B did not return a sandbox ID.");
  return payload;
}

/** Resume paused sandbox and extend TTL. */
async function ensureSandboxRunning(env: Env, sandboxId: string): Promise<void> {
  const response = await fetch(`https://api.e2b.app/sandboxes/${sandboxId}/connect`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "X-API-KEY": required(env, "E2B_API_KEY"),
    },
    body: JSON.stringify({ timeout: SANDBOX_TTL_SECONDS }),
  });
  if (!response.ok && response.status !== 404) {
    const detail = await response.text().catch(() => "");
    throw new Error(`E2B connect failed with HTTP ${response.status}${detail ? `: ${detail.slice(0, 200)}` : ""}`);
  }
  if (response.status === 404) throw new Error("E2B sandbox missing; needs re-provision.");
}

async function waitForHarness(env: Env, sandboxId: string, domain: string | null | undefined, attempts = 20): Promise<void> {
  const url = `${harnessBaseUrl(env, sandboxId, domain)}/health`;
  let lastError = "harness not ready";
  for (let i = 0; i < attempts; i++) {
    try {
      const response = await fetch(url, { method: "GET" });
      if (response.ok) return;
      lastError = `HTTP ${response.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : "fetch failed";
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`Sandbox harness health check failed: ${lastError}`);
}

/** Inject Worker→harness secret into the warm process (create envVars do not reach snapshotted uvicorn). */
async function bootstrapHarness(env: Env, sandboxId: string, domain: string | null | undefined): Promise<void> {
  const url = `${harnessBaseUrl(env, sandboxId, domain)}/bootstrap`;
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ secret: required(env, "WORKER_TO_HARNESS_SECRET") }),
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(`Harness bootstrap failed with HTTP ${response.status}${detail ? `: ${detail.slice(0, 200)}` : ""}`);
  }
}

async function lookup(env: Env, gateway: string, gatewayUserId: string): Promise<UserAgentRow | null> {
  return env.FROMDONNA_ROUTING
    .prepare(
      `SELECT user_id, gateway, gateway_user_id, gateway_conversation_id,
              runtime_provider, runtime_id, runtime_domain, status
       FROM user_agents WHERE gateway = ?1 AND gateway_user_id = ?2`,
    )
    .bind(gateway, gatewayUserId)
    .first<UserAgentRow>();
}

/** Claim first-message provisioning atomically. Only the inserted user-agent row may create a runtime. */
async function claimProvisioning(
  env: Env,
  gateway: string,
  gatewayUserId: string,
  gatewayConversationId: string,
): Promise<boolean> {
  const placeholder = `provisioning:${crypto.randomUUID()}`;
  const result = await env.FROMDONNA_ROUTING
    .prepare(
      `INSERT INTO user_agents
        (user_id, gateway, gateway_user_id, gateway_conversation_id, runtime_provider, runtime_id, status, provisioning_started_at)
       VALUES (?1, ?2, ?3, ?4, 'e2b', ?5, 'provisioning', CURRENT_TIMESTAMP)
       ON CONFLICT(gateway, gateway_user_id) DO NOTHING`,
    )
    .bind(internalUserId(gateway, gatewayUserId), gateway, gatewayUserId, gatewayConversationId, placeholder)
    .run();
  return result.meta.changes === 1;
}

/** Recover from a previous failed provision so the user is not permanently stuck. */
async function claimFailedRecovery(
  env: Env,
  gateway: string,
  gatewayUserId: string,
  gatewayConversationId: string,
): Promise<boolean> {
  const placeholder = `provisioning:${crypto.randomUUID()}`;
  const result = await env.FROMDONNA_ROUTING
    .prepare(
      `UPDATE user_agents
       SET gateway_conversation_id = ?3,
           runtime_id = ?4,
           runtime_domain = NULL,
           status = 'provisioning',
           provisioning_started_at = CURRENT_TIMESTAMP,
           updated_at = CURRENT_TIMESTAMP
       WHERE gateway = ?1 AND gateway_user_id = ?2 AND status = 'failed'`,
    )
    .bind(gateway, gatewayUserId, gatewayConversationId, placeholder)
    .run();
  return result.meta.changes === 1;
}

async function markFailed(env: Env, gateway: string, gatewayUserId: string): Promise<void> {
  await env.FROMDONNA_ROUTING
    .prepare(
      `UPDATE user_agents SET status = 'failed', updated_at = CURRENT_TIMESTAMP
       WHERE gateway = ?1 AND gateway_user_id = ?2`,
    )
    .bind(gateway, gatewayUserId)
    .run();
}

async function provision(env: Env, gateway: string, gatewayUserId: string): Promise<UserAgentRow> {
  const userId = internalUserId(gateway, gatewayUserId);
  const sandbox = await createSandbox(env, userId);
  const domain = sandbox.domain || DEFAULT_SANDBOX_DOMAIN;
  await waitForHarness(env, sandbox.sandboxID, domain);
  await bootstrapHarness(env, sandbox.sandboxID, domain);

  await env.FROMDONNA_ROUTING
    .prepare(
      `UPDATE user_agents
       SET runtime_id = ?3, runtime_domain = ?4, status = 'ready', updated_at = CURRENT_TIMESTAMP
       WHERE gateway = ?1 AND gateway_user_id = ?2 AND status = 'provisioning'`,
    )
    .bind(gateway, gatewayUserId, sandbox.sandboxID, domain)
    .run();

  const row = await lookup(env, gateway, gatewayUserId);
  if (!row || row.status !== "ready") throw new Error("Runtime was created but the user-agent row was not finalized.");
  return row;
}

async function sendTurn(env: Env, row: UserAgentRow, event: NormalizedTelegramEvent): Promise<HarnessReply> {
  if (row.runtime_provider !== "e2b") throw new Error(`Unsupported runtime provider: ${row.runtime_provider}`);
  await ensureSandboxRunning(env, row.runtime_id);
  // Best-effort re-bootstrap: no-ops if already configured with the same secret.
  try {
    await bootstrapHarness(env, row.runtime_id, row.runtime_domain);
  } catch {
    // Harness may reject if already bootstrapped with a different secret after template rebuilds.
  }

  const url = `${harnessBaseUrl(env, row.runtime_id, row.runtime_domain)}/turn`;
  const capability = await mintLlmCapability(env, row.user_id);
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${required(env, "WORKER_TO_HARNESS_SECRET")}`,
      "x-llm-capability": capability,
    },
    body: JSON.stringify({
      userId: row.user_id,
      event,
      gateway: row.gateway,
      gatewayChatId: row.gateway_conversation_id,
      gatewayMessageId: event.type === "message" ? event.message.id : (event.callback.messageId ?? ""),
      text: event.type === "message" ? (event.message.text ?? "") : (event.callback.data ?? ""),
    }),
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(`Sandbox harness failed with HTTP ${response.status}${detail ? `: ${detail.slice(0, 200)}` : ""}`);
  }
  return response.json<HarnessReply>();
}

async function resolveReadyRow(
  env: Env,
  gateway: string,
  gatewayUserId: string,
  gatewayConversationId: string,
): Promise<UserAgentRow | "provisioning"> {
  let row = await lookup(env, gateway, gatewayUserId);

  if (!row) {
    const claimed = await claimProvisioning(env, gateway, gatewayUserId, gatewayConversationId);
    if (claimed) {
      try {
        return await provision(env, gateway, gatewayUserId);
      } catch (error) {
        await markFailed(env, gateway, gatewayUserId);
        throw error;
      }
    }
    row = await lookup(env, gateway, gatewayUserId);
  }

  if (row?.status === "failed") {
    const claimed = await claimFailedRecovery(env, gateway, gatewayUserId, gatewayConversationId);
    if (claimed) {
      try {
        return await provision(env, gateway, gatewayUserId);
      } catch (error) {
        await markFailed(env, gateway, gatewayUserId);
        throw error;
      }
    }
    row = await lookup(env, gateway, gatewayUserId);
  }

  if (!row || row.status === "provisioning") return "provisioning";
  if (row.status !== "ready") throw new Error(`Unexpected agent runtime status: ${row.status}`);
  return row;
}

async function processTelegramUpdate(env: Env, update: TelegramUpdate): Promise<void> {
  const event = normalizeTelegramUpdate(update);
  if (!event) return;

  const gateway = "telegram";
  const gatewayUserId = event.actorId;
  const gatewayConversationId = event.conversationId;

  try {
    const resolved = await resolveReadyRow(env, gateway, gatewayUserId, gatewayConversationId);
    if (resolved === "provisioning") {
      await telegram(env, "sendMessage", {
        chat_id: gatewayConversationId,
        text: "Setting up your private assistant — one moment, then send that again.",
      });
      return;
    }

    const reply = await sendTurn(env, resolved, event);
    const calls = renderTelegramActions(reply, gatewayConversationId, event.type === "callback" ? event.callback.id : undefined);
    if (calls.length > 0) {
      for (const call of calls) await telegram(env, call.method, call.body);
    } else if (!Array.isArray(reply.actions)) {
      // Preserve the old `{ text: "" }` harness response behavior. An explicit
      // empty action list is intentionally silent (useful for callback turns).
      await telegram(env, "sendMessage", {
        chat_id: gatewayConversationId,
        text: "I got that, but had nothing to say back. Try again?",
      });
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : "processTelegramUpdate failed");
    try {
      await telegram(env, "sendMessage", {
        chat_id: gatewayConversationId,
        text: "Something went wrong on my side. Please try again in a moment.",
      });
    } catch {
      // ignore secondary telegram failures
    }
  }
}

async function handleTelegram(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  if (request.headers.get("X-Telegram-Bot-Api-Secret-Token") !== required(env, "TELEGRAM_WEBHOOK_SECRET")) {
    return new Response("Unauthorized", { status: 401 });
  }

  const update = await request.json<TelegramUpdate>();
  // ACK Telegram quickly; do provision + Hermes turn in the background.
  ctx.waitUntil(processTelegramUpdate(env, update));
  return json({ ok: true });
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    try {
      if (request.method === "GET" && url.pathname === "/health") {
        return json({ ok: true, service: "fromdonna-telegram-gateway" });
      }
      if (request.method === "POST" && url.pathname === "/telegram/webhook") {
        return await handleTelegram(request, env, ctx);
      }
      return new Response("Not found", { status: 404 });
    } catch (error) {
      console.error(error instanceof Error ? error.message : "Unhandled gateway error");
      return json({ ok: false, error: "gateway_request_failed" }, 500);
    }
  },
} satisfies ExportedHandler<Env>;
