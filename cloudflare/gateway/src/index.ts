/**
 * FromDonna Telegram gateway Worker.
 *
 * Owns Telegram webhook + D1 routing + E2B lifecycle + Bot API proxy.
 * Never puts the real bot token into sandboxes. Official Hermes TelegramAdapter
 * in each sandbox uses base_url → this Worker's /telegram-bot-api/* proxy.
 */

import { handleBotApiProxy, mintBotProxyToken } from "./bot_api_proxy";
import { normalizeTelegramUpdate, type TelegramUpdate } from "./telegram";

export interface Env {
  FROMDONNA_ROUTING: D1Database;
  TELEGRAM_BOT_TOKEN: string;
  TELEGRAM_WEBHOOK_SECRET: string;
  E2B_API_KEY: string;
  WORKER_TO_HARNESS_SECRET: string;
  LLM_CAPABILITY_SECRET: string;
  E2B_TEMPLATE: string;
  HARNESS_PORT: string;
  E2B_SANDBOX_DOMAIN?: string;
  /** Public URL of this Worker (no trailing slash). Used as Bot API base for sandboxes. */
  WORKER_PUBLIC_URL?: string;
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
/** Idle auto-pause keeps the VM disk; this is max lifetime / each connect extension.
 * E2B rejects timeout > 1 hour (HTTP 400). Every message extends by this amount. */
const SANDBOX_TTL_SECONDS = 3600;
const DEFAULT_WORKER_URL = "https://fromdonna-telegram-gateway.code-df4.workers.dev";

function internalUserId(gateway: string, gatewayUserId: string): string {
  return `${gateway}:${gatewayUserId}`;
}

function required(env: Env, key: keyof Env): string {
  const value = env[key];
  if (typeof value !== "string" || !value) throw new Error(`Worker secret/config ${key} is missing.`);
  return value;
}

function workerPublicUrl(env: Env): string {
  return (env.WORKER_PUBLIC_URL || DEFAULT_WORKER_URL).replace(/\/$/, "");
}

function sandboxDomain(env: Env, rowDomain: string | null | undefined): string {
  return rowDomain || env.E2B_SANDBOX_DOMAIN || DEFAULT_SANDBOX_DOMAIN;
}

function harnessBaseUrl(env: Env, sandboxId: string, domain: string | null | undefined): string {
  const port = required(env, "HARNESS_PORT");
  return `https://${port}-${sandboxId}.${sandboxDomain(env, domain)}`;
}

function encodeBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

async function mintLlmCapability(env: Env, userId: string): Promise<string> {
  const payload = new TextEncoder().encode(
    JSON.stringify({ sub: userId, exp: Math.floor(Date.now() / 1000) + 15 * 60 }),
  );
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(required(env, "LLM_CAPABILITY_SECRET")),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
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
      envVars: {
        WORKER_TO_HARNESS_SECRET: required(env, "WORKER_TO_HARNESS_SECRET"),
        FROMDONNA_RUNTIME: "e2b",
        FROMDONNA_WORKER_URL: workerPublicUrl(env),
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

/** Resume + extend TTL. Returns false when the sandbox no longer exists (expired/killed). */
async function ensureSandboxRunning(env: Env, sandboxId: string): Promise<boolean> {
  const response = await fetch(`https://api.e2b.app/sandboxes/${sandboxId}/connect`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "X-API-KEY": required(env, "E2B_API_KEY"),
    },
    body: JSON.stringify({ timeout: SANDBOX_TTL_SECONDS }),
  });
  if (response.status === 404) return false;
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(`E2B connect failed with HTTP ${response.status}${detail ? `: ${detail.slice(0, 200)}` : ""}`);
  }
  return true;
}

async function killSandboxBestEffort(env: Env, sandboxId: string): Promise<void> {
  try {
    await fetch(`https://api.e2b.app/sandboxes/${sandboxId}`, {
      method: "DELETE",
      headers: { "X-API-KEY": required(env, "E2B_API_KEY") },
    });
  } catch {
    // ignore — missing/already dead is fine
  }
}

async function waitForHarness(env: Env, sandboxId: string, domain: string | null | undefined, attempts = 90): Promise<void> {
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

async function bootstrapHarness(
  env: Env,
  row: Pick<UserAgentRow, "user_id" | "gateway_user_id" | "gateway_conversation_id" | "runtime_id" | "runtime_domain">,
): Promise<void> {
  const proxyToken = await mintBotProxyToken(
    required(env, "WORKER_TO_HARNESS_SECRET"),
    row.user_id,
    row.gateway_conversation_id,
  );
  const base = workerPublicUrl(env);
  const url = `${harnessBaseUrl(env, row.runtime_id, row.runtime_domain)}/bootstrap`;
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      secret: required(env, "WORKER_TO_HARNESS_SECRET"),
      telegramProxy: {
        token: proxyToken,
        baseUrl: `${base}/telegram-bot-api/bot`,
        baseFileUrl: `${base}/telegram-bot-api/file/bot`,
        userId: row.user_id,
        chatId: row.gateway_conversation_id,
        gatewayUserId: row.gateway_user_id,
      },
    }),
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(`Harness bootstrap failed with HTTP ${response.status}${detail ? `: ${detail.slice(0, 200)}` : ""}`);
  }
}

async function lookup(env: Env, gateway: string, gatewayUserId: string): Promise<UserAgentRow | null> {
  return env.FROMDONNA_ROUTING.prepare(
    `SELECT user_id, gateway, gateway_user_id, gateway_conversation_id,
            runtime_provider, runtime_id, runtime_domain, status
     FROM user_agents WHERE gateway = ?1 AND gateway_user_id = ?2`,
  )
    .bind(gateway, gatewayUserId)
    .first<UserAgentRow>();
}

async function lookupByUserId(env: Env, userId: string): Promise<UserAgentRow | null> {
  return env.FROMDONNA_ROUTING.prepare(
    `SELECT user_id, gateway, gateway_user_id, gateway_conversation_id,
            runtime_provider, runtime_id, runtime_domain, status
     FROM user_agents WHERE user_id = ?1`,
  )
    .bind(userId)
    .first<UserAgentRow>();
}

async function claimProvisioning(
  env: Env,
  gateway: string,
  gatewayUserId: string,
  gatewayConversationId: string,
): Promise<boolean> {
  const placeholder = `provisioning:${crypto.randomUUID()}`;
  const result = await env.FROMDONNA_ROUTING.prepare(
    `INSERT INTO user_agents
      (user_id, gateway, gateway_user_id, gateway_conversation_id, runtime_provider, runtime_id, status, provisioning_started_at)
     VALUES (?1, ?2, ?3, ?4, 'e2b', ?5, 'provisioning', CURRENT_TIMESTAMP)
     ON CONFLICT(gateway, gateway_user_id) DO NOTHING`,
  )
    .bind(internalUserId(gateway, gatewayUserId), gateway, gatewayUserId, gatewayConversationId, placeholder)
    .run();
  return result.meta.changes === 1;
}

async function claimFailedRecovery(
  env: Env,
  gateway: string,
  gatewayUserId: string,
  gatewayConversationId: string,
): Promise<boolean> {
  const placeholder = `provisioning:${crypto.randomUUID()}`;
  const result = await env.FROMDONNA_ROUTING.prepare(
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
  await env.FROMDONNA_ROUTING.prepare(
    `UPDATE user_agents SET status = 'failed', updated_at = CURRENT_TIMESTAMP
     WHERE gateway = ?1 AND gateway_user_id = ?2`,
  )
    .bind(gateway, gatewayUserId)
    .run();
}

/** Steal a provisioning row stuck longer than ~90s (crashed waitUntil / failed bootstrap). */
async function claimStuckProvisioning(
  env: Env,
  gateway: string,
  gatewayUserId: string,
  gatewayConversationId: string,
): Promise<boolean> {
  const placeholder = `provisioning:${crypto.randomUUID()}`;
  const result = await env.FROMDONNA_ROUTING.prepare(
    `UPDATE user_agents
     SET gateway_conversation_id = ?3,
         runtime_id = ?4,
         runtime_domain = NULL,
         status = 'provisioning',
         provisioning_started_at = CURRENT_TIMESTAMP,
         updated_at = CURRENT_TIMESTAMP
     WHERE gateway = ?1 AND gateway_user_id = ?2 AND status = 'provisioning'
       AND (
         provisioning_started_at IS NULL
         OR provisioning_started_at < datetime('now', '-90 seconds')
       )`,
  )
    .bind(gateway, gatewayUserId, gatewayConversationId, placeholder)
    .run();
  return result.meta.changes === 1;
}

async function provision(env: Env, gateway: string, gatewayUserId: string): Promise<UserAgentRow> {
  const userId = internalUserId(gateway, gatewayUserId);
  const sandbox = await createSandbox(env, userId);
  const domain = sandbox.domain || DEFAULT_SANDBOX_DOMAIN;
  try {
    await waitForHarness(env, sandbox.sandboxID, domain);

    // Stash runtime while still provisioning — only flip ready after bootstrap
    // succeeds so a broken Telegram gateway never looks "ready" in D1.
    await env.FROMDONNA_ROUTING.prepare(
      `UPDATE user_agents
       SET runtime_id = ?3, runtime_domain = ?4, updated_at = CURRENT_TIMESTAMP
       WHERE gateway = ?1 AND gateway_user_id = ?2 AND status = 'provisioning'`,
    )
      .bind(gateway, gatewayUserId, sandbox.sandboxID, domain)
      .run();

    const pending = await lookup(env, gateway, gatewayUserId);
    if (!pending || pending.status !== "provisioning") {
      throw new Error("Runtime was created but the user-agent row was not in provisioning state.");
    }
    await bootstrapHarness(env, pending);

    await env.FROMDONNA_ROUTING.prepare(
      `UPDATE user_agents
       SET status = 'ready', updated_at = CURRENT_TIMESTAMP
       WHERE gateway = ?1 AND gateway_user_id = ?2 AND status = 'provisioning'`,
    )
      .bind(gateway, gatewayUserId)
      .run();

    const row = await lookup(env, gateway, gatewayUserId);
    if (!row || row.status !== "ready") throw new Error("Runtime was bootstrapped but the user-agent row was not finalized.");
    return row;
  } catch (error) {
    await killSandboxBestEffort(env, sandbox.sandboxID);
    throw error;
  }
}

/**
 * Ready row points at a dead/expired sandbox (or irreparable harness).
 * Spin a fresh VM for the same user and remap D1 — then deliver the original turn.
 */
async function replaceRuntime(env: Env, row: UserAgentRow): Promise<UserAgentRow> {
  const oldId = row.runtime_id;
  const sandbox = await createSandbox(env, row.user_id);
  const domain = sandbox.domain || DEFAULT_SANDBOX_DOMAIN;
  try {
    await waitForHarness(env, sandbox.sandboxID, domain);

    // Keep status non-ready until Telegram gateway bootstrap succeeds.
    await env.FROMDONNA_ROUTING.prepare(
      `UPDATE user_agents
       SET runtime_id = ?3, runtime_domain = ?4, status = 'provisioning',
           provisioning_started_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
       WHERE gateway = ?1 AND gateway_user_id = ?2`,
    )
      .bind(row.gateway, row.gateway_user_id, sandbox.sandboxID, domain)
      .run();

    const pending: UserAgentRow = {
      ...row,
      runtime_id: sandbox.sandboxID,
      runtime_domain: domain,
      status: "provisioning",
    };
    await bootstrapHarness(env, pending);

    await env.FROMDONNA_ROUTING.prepare(
      `UPDATE user_agents
       SET status = 'ready', updated_at = CURRENT_TIMESTAMP
       WHERE gateway = ?1 AND gateway_user_id = ?2`,
    )
      .bind(row.gateway, row.gateway_user_id)
      .run();

    if (oldId && oldId !== sandbox.sandboxID && !oldId.startsWith("provisioning:")) {
      await killSandboxBestEffort(env, oldId);
    }

    const next = await lookup(env, row.gateway, row.gateway_user_id);
    if (!next || next.status !== "ready") throw new Error("Runtime replace failed to finalize D1 row.");
    return next;
  } catch (error) {
    await killSandboxBestEffort(env, sandbox.sandboxID);
    // Leave a failed row (not half-provisioned) so the next message reclaims cleanly.
    await markFailed(env, row.gateway, row.gateway_user_id).catch(() => {});
    throw error;
  }
}

async function postTelegramUpdate(env: Env, row: UserAgentRow, update: TelegramUpdate): Promise<Response> {
  const url = `${harnessBaseUrl(env, row.runtime_id, row.runtime_domain)}/telegram/update`;
  const capability = await mintLlmCapability(env, row.user_id);
  return fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${required(env, "WORKER_TO_HARNESS_SECRET")}`,
      "x-llm-capability": capability,
    },
    body: JSON.stringify({ update }),
  });
}

/** Push a raw Telegram update into the sandbox official Hermes Telegram gateway. */
async function injectTelegramUpdate(env: Env, row: UserAgentRow, update: TelegramUpdate): Promise<void> {
  if (row.runtime_provider !== "e2b") throw new Error(`Unsupported runtime provider: ${row.runtime_provider}`);

  let current = row;
  let lastError = "inject failed";

  // Attempt 0: resume existing box. Attempt 1: replace runtime if gone/broken.
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const alive = await ensureSandboxRunning(env, current.runtime_id);
      if (!alive) {
        lastError = "E2B sandbox missing";
        current = await replaceRuntime(env, current);
        // fall through to inject on the new box
      } else {
        // Pause→resume: wait for harness, then re-bootstrap proxy + start gateway.
        await waitForHarness(env, current.runtime_id, current.runtime_domain, 90);
        await bootstrapHarness(env, current);
      }

      let response = await postTelegramUpdate(env, current, update);
      if (!response.ok) {
        const detail = await response.text().catch(() => "");
        lastError = `Sandbox telegram inject failed with HTTP ${response.status}${detail ? `: ${detail.slice(0, 300)}` : ""}`;
        // One soft retry on same box after re-bootstrap (stale gateway thread / lock).
        await bootstrapHarness(env, current);
        response = await postTelegramUpdate(env, current, update);
        if (!response.ok) {
          const detail2 = await response.text().catch(() => "");
          lastError = `Sandbox telegram inject failed with HTTP ${response.status}${detail2 ? `: ${detail2.slice(0, 300)}` : ""}`;
          if (attempt === 0) {
            current = await replaceRuntime(env, current);
            continue;
          }
          throw new Error(lastError);
        }
      }
      return;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      if (
        attempt === 0 &&
        /missing|harness health|bootstrap failed|telegram inject|connect failed|telegram gateway|gateway start/i.test(
          lastError,
        )
      ) {
        try {
          current = await replaceRuntime(env, current);
          continue;
        } catch (replaceError) {
          lastError = replaceError instanceof Error ? replaceError.message : String(replaceError);
          await markFailed(env, current.gateway, current.gateway_user_id).catch(() => {});
        }
      }
      throw new Error(lastError);
    }
  }
  throw new Error(lastError);
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

  // Stuck provisioning (e.g. Worker waitUntil died mid-bootstrap): reclaim after 90s.
  if (row?.status === "provisioning") {
    const claimed = await claimStuckProvisioning(env, gateway, gatewayUserId, gatewayConversationId);
    if (claimed) {
      try {
        return await provision(env, gateway, gatewayUserId);
      } catch (error) {
        await markFailed(env, gateway, gatewayUserId);
        throw error;
      }
    }
    return "provisioning";
  }

  // Keep conversation id fresh (user may message from same account in same DM).
  if (row && row.gateway_conversation_id !== gatewayConversationId && row.status === "ready") {
    await env.FROMDONNA_ROUTING.prepare(
      `UPDATE user_agents SET gateway_conversation_id = ?3, updated_at = CURRENT_TIMESTAMP
       WHERE gateway = ?1 AND gateway_user_id = ?2`,
    )
      .bind(gateway, gatewayUserId, gatewayConversationId)
      .run();
    row = { ...row, gateway_conversation_id: gatewayConversationId };
  }

  if (!row) return "provisioning";
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

    // Official path: sandbox Hermes Telegram gateway sends via Bot API proxy.
    // Worker does not render agent text itself.
    await injectTelegramUpdate(env, resolved, update);
  } catch (error) {
    console.error(error instanceof Error ? error.message : "processTelegramUpdate failed");
    try {
      const detail = error instanceof Error ? error.message : "processTelegramUpdate failed";
      console.error("processTelegramUpdate", detail);
      await telegram(env, "sendMessage", {
        chat_id: gatewayConversationId,
        text: "Something went wrong on my side. Please try again in a moment.",
      });
    } catch {
      // ignore
    }
  }
}

async function rebindTelegramWebhook(env: Env): Promise<Response> {
  const base = workerPublicUrl(env);
  const url = `${base}/telegram/webhook`;
  // Official Hermes UX needs callbacks (buttons), edits, and media messages.
  const allowed_updates = [
    "message",
    "edited_message",
    "callback_query",
    "inline_query",
    "chosen_inline_result",
    "my_chat_member",
    "chat_member",
    "chat_join_request",
    "message_reaction",
    "message_reaction_count",
  ];
  const result = await telegram(env, "setWebhook", {
    url,
    secret_token: required(env, "TELEGRAM_WEBHOOK_SECRET"),
    allowed_updates,
    drop_pending_updates: false,
  });
  return json({ ok: true, webhook: url, allowed_updates, result });
}

async function handleTelegram(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  if (request.headers.get("X-Telegram-Bot-Api-Secret-Token") !== required(env, "TELEGRAM_WEBHOOK_SECRET")) {
    return new Response("Unauthorized", { status: 401 });
  }

  const update = await request.json<TelegramUpdate>();
  ctx.waitUntil(processTelegramUpdate(env, update));
  return json({ ok: true });
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    try {
      if (request.method === "GET" && url.pathname === "/health") {
        return json({ ok: true, service: "fromdonna-telegram-gateway", mode: "official-telegram-proxy" });
      }

      // Ops: rebind Telegram webhook with full allowed_updates (auth via harness secret).
      if (request.method === "POST" && url.pathname === "/admin/rebind-webhook") {
        const auth = request.headers.get("authorization") || "";
        const expected = `Bearer ${required(env, "WORKER_TO_HARNESS_SECRET")}`;
        if (auth !== expected) return new Response("Unauthorized", { status: 401 });
        return await rebindTelegramWebhook(env);
      }

      // Official Hermes TelegramAdapter Bot API reverse proxy (token never leaves Worker).
      const proxied = await handleBotApiProxy({
        request,
        url,
        realBotToken: required(env, "TELEGRAM_BOT_TOKEN"),
        proxySecret: required(env, "WORKER_TO_HARNESS_SECRET"),
      });
      if (proxied) return proxied;

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
