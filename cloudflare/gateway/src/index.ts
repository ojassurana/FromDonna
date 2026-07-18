/**
 * FromDonna gateway Worker (channel-agnostic).
 *
 * Owns chat webhooks + D1 routing + E2B lifecycle + channel API proxies
 * (Telegram first; WhatsApp/etc. later). Never puts real channel tokens into
 * sandboxes. Per-channel adapters in each sandbox call this Worker as the
 * privileged door (e.g. Hermes TelegramAdapter → /telegram-bot-api/*).
 */

import { handleAdminTurns } from "./admin_turns";
import { handleBotApiProxy, mintBotProxyToken } from "./bot_api_proxy";
import {
  getCheckpointBytes,
  handleCheckpointStatus,
  handleCheckpointUpload,
  putCheckpoint,
} from "./checkpoint";
import { ensureUserComposio, mintComposioMcpAccess } from "./composio";
import { normalizeTelegramUpdate, type TelegramUpdate } from "./telegram";
import {
  addTurnEvent,
  inboundPreviewFromUpdate,
  newTurnId,
  startTurn,
} from "./turn_trace";

export interface Env {
  FROMDONNA_ROUTING: D1Database;
  /** Optional until R2 bucket is provisioned; checkpoint endpoints return 503 without it. */
  USER_STATE?: R2Bucket;
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
  /** Optional; defaults to WORKER_TO_HARNESS_SECRET for composio-proxy HMAC */
  COMPOSIO_SESSION_SECRET?: string;
  /** Optional; defaults to https://fromdonna-composio-proxy.code-df4.workers.dev */
  COMPOSIO_PROXY_URL?: string;
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
const DEFAULT_WORKER_URL = "https://fromdonna-gateway.code-df4.workers.dev";

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

type HarnessHealth = {
  ok?: boolean;
  auth_ready?: boolean;
  telegram_proxy_ready?: boolean;
  gateway_running?: boolean;
  composio_mcp_ready?: boolean;
};

async function fetchHarnessHealth(
  env: Env,
  sandboxId: string,
  domain: string | null | undefined,
): Promise<HarnessHealth | null> {
  try {
    const response = await fetch(`${harnessBaseUrl(env, sandboxId, domain)}/health`, {
      method: "GET",
    });
    if (!response.ok) return null;
    return (await response.json()) as HarnessHealth;
  } catch {
    return null;
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

const CHECKPOINT_TAR_PATH = "/home/user/.hermes/fromdonna-checkpoint-latest.tar.gz";
const CHECKPOINT_READY_PATH = "/home/user/.hermes/fromdonna-checkpoint-ready.json";
/** envd default port for filesystem API */
const ENVD_PORT = "49983";

async function storeCheckpointBytes(
  env: Env,
  row: Pick<UserAgentRow, "user_id" | "runtime_id">,
  bytes: ArrayBuffer,
  source: string,
): Promise<boolean> {
  if (!bytes.byteLength) return false;
  const manifest = await putCheckpoint(env, row.user_id, bytes, {
    runtimeId: row.runtime_id,
    source,
  });
  console.log(
    `checkpoint stored for ${row.user_id} (${manifest.bytes} bytes, source=${manifest.source})`,
  );
  return true;
}

/** Harness GET /internal/checkpoint/export (preferred when auth_ready). */
async function pullCheckpointViaHarness(
  env: Env,
  row: Pick<UserAgentRow, "user_id" | "runtime_id" | "runtime_domain">,
): Promise<boolean> {
  const url = `${harnessBaseUrl(env, row.runtime_id, row.runtime_domain)}/internal/checkpoint/export`;
  const response = await fetch(url, {
    method: "GET",
    headers: { authorization: `Bearer ${required(env, "WORKER_TO_HARNESS_SECRET")}` },
  });
  if (response.status === 204 || response.status === 404) return false;
  if (!response.ok) {
    console.error(`checkpoint export failed for ${row.user_id}: HTTP ${response.status}`);
    return false;
  }
  const bytes = await response.arrayBuffer();
  const source = response.headers.get("x-fromdonna-checkpoint-source") || "harness-export";
  return storeCheckpointBytes(env, row, bytes, source);
}

/**
 * Fallback: read staged tar via E2B envd filesystem API.
 * Works even if harness export is down; uses connect token.
 */
async function pullCheckpointViaEnvd(
  env: Env,
  row: Pick<UserAgentRow, "user_id" | "runtime_id" | "runtime_domain">,
): Promise<boolean> {
  // Ensure sandbox is up and get envd access token
  const connectRes = await fetch(`https://api.e2b.app/sandboxes/${row.runtime_id}/connect`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "X-API-KEY": required(env, "E2B_API_KEY"),
    },
    body: JSON.stringify({ timeout: SANDBOX_TTL_SECONDS }),
  });
  if (connectRes.status === 404) return false;
  if (!connectRes.ok) {
    console.error(`envd connect for checkpoint failed: HTTP ${connectRes.status}`);
    return false;
  }
  const connected = await connectRes.json<{ envdAccessToken?: string; domain?: string | null }>();
  const token = connected.envdAccessToken;
  if (!token) {
    console.error("envd connect returned no access token");
    return false;
  }
  const domain = sandboxDomain(env, connected.domain || row.runtime_domain);
  // Probe ready marker (optional — if missing, still try tar)
  const readyUrl = new URL(`https://${ENVD_PORT}-${row.runtime_id}.${domain}/files`);
  readyUrl.searchParams.set("path", CHECKPOINT_READY_PATH);
  readyUrl.searchParams.set("username", "user");
  const readyRes = await fetch(readyUrl.toString(), {
    headers: { "X-Access-Token": token },
  });
  if (!readyRes.ok && readyRes.status !== 404) {
    // continue; tar may still exist
  }

  const tarUrl = new URL(`https://${ENVD_PORT}-${row.runtime_id}.${domain}/files`);
  tarUrl.searchParams.set("path", CHECKPOINT_TAR_PATH);
  tarUrl.searchParams.set("username", "user");
  const tarRes = await fetch(tarUrl.toString(), {
    headers: { "X-Access-Token": token },
  });
  if (tarRes.status === 404) return false;
  if (!tarRes.ok) {
    console.error(`envd tar read failed for ${row.user_id}: HTTP ${tarRes.status}`);
    return false;
  }
  const bytes = await tarRes.arrayBuffer();
  if (!bytes.byteLength) return false;

  // Best-effort clear ready marker so we don't re-upload forever
  try {
    const delReady = new URL(`https://${ENVD_PORT}-${row.runtime_id}.${domain}/files`);
    delReady.searchParams.set("path", CHECKPOINT_READY_PATH);
    delReady.searchParams.set("username", "user");
    await fetch(delReady.toString(), {
      method: "DELETE",
      headers: { "X-Access-Token": token },
    });
  } catch {
    // ignore
  }

  return storeCheckpointBytes(env, row, bytes, "envd-pull");
}

/**
 * Pull a staged checkpoint from the runtime and store it in R2.
 * Tries harness export first, then E2B envd file read.
 * Prefer this over sandbox→Worker upload (often blocked by Cloudflare 1010).
 */
async function pullCheckpointOnce(
  env: Env,
  row: Pick<UserAgentRow, "user_id" | "runtime_id" | "runtime_domain">,
): Promise<boolean> {
  if (!env.USER_STATE) return false;
  if (!row.runtime_id || row.runtime_id.startsWith("provisioning:")) return false;
  try {
    if (await pullCheckpointViaHarness(env, row)) return true;
  } catch (error) {
    console.error(
      `harness checkpoint pull error for ${row.user_id}:`,
      error instanceof Error ? error.message : error,
    );
  }
  try {
    if (await pullCheckpointViaEnvd(env, row)) return true;
  } catch (error) {
    console.error(
      `envd checkpoint pull error for ${row.user_id}:`,
      error instanceof Error ? error.message : error,
    );
  }
  return false;
}

/**
 * After a turn is scheduled, harvest a staged checkpoint when ready.
 * Long-running; must be scheduled via its own ctx.waitUntil so create/inject
 * does not consume the whole background budget before pack finishes.
 */
async function harvestCheckpointAfterTurn(
  env: Env,
  row: Pick<UserAgentRow, "user_id" | "runtime_id" | "runtime_domain">,
  attempts = 60,
  delayMs = 10_000,
): Promise<void> {
  // Initial delay: agent turn rarely finishes in the first few seconds.
  await new Promise((r) => setTimeout(r, 15_000));
  for (let i = 0; i < attempts; i++) {
    const ok = await pullCheckpointOnce(env, row);
    if (ok) return;
    await new Promise((r) => setTimeout(r, delayMs));
  }
  console.log(`checkpoint harvest timed out for ${row.user_id} after ${attempts} attempts`);
}

/**
 * Push latest R2 checkpoint into a sandbox (agent-home + workspace).
 * No-op when R2 is unbound or the user has never been checkpointed.
 * Soft-fails: must not block a working empty runtime.
 */
async function restoreCheckpointToRuntime(
  env: Env,
  row: Pick<UserAgentRow, "user_id" | "runtime_id" | "runtime_domain">,
): Promise<void> {
  if (!env.USER_STATE) return;
  try {
    const checkpoint = await getCheckpointBytes(env, row.user_id);
    if (!checkpoint || checkpoint.bytes.byteLength === 0) return;

    const url = `${harnessBaseUrl(env, row.runtime_id, row.runtime_domain)}/internal/restore`;
    const response = await fetch(url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${required(env, "WORKER_TO_HARNESS_SECRET")}`,
        "content-type": "application/gzip",
      },
      body: checkpoint.bytes,
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      console.error(
        `checkpoint restore failed for ${row.user_id}: HTTP ${response.status}${detail ? ` ${detail.slice(0, 200)}` : ""}`,
      );
      return;
    }
    console.log(
      `checkpoint restored for ${row.user_id} (${checkpoint.bytes.byteLength} bytes, savedAt=${checkpoint.manifest?.savedAt ?? "unknown"})`,
    );
  } catch (error) {
    console.error(
      `checkpoint restore error for ${row.user_id}:`,
      error instanceof Error ? error.message : error,
    );
  }
}

/**
 * Mint Composio MCP access and bootstrap the harness.
 *
 * Default (requireComposio=false): always bring up Telegram. Composio is best-effort —
 * mint failures must NOT kill first provision (jul 2026: secret desync → failed D1 +
 * "Something went wrong" for every new user after wipe).
 *
 * Pass requireComposio:true only for ops probes that explicitly need MCP ready.
 */
async function bootstrapHarness(
  env: Env,
  row: Pick<UserAgentRow, "user_id" | "gateway_user_id" | "gateway_conversation_id" | "runtime_id" | "runtime_domain">,
  opts?: { requireComposio?: boolean },
): Promise<void> {
  // Soft-default: telegram-ready wins over Composio-hard-fail (prod jul 2026).
  const requireComposio = opts?.requireComposio === true;
  const proxyToken = await mintBotProxyToken(
    required(env, "WORKER_TO_HARNESS_SECRET"),
    row.user_id,
    row.gateway_conversation_id,
  );
  const base = workerPublicUrl(env);

  try {
    await ensureUserComposio(env, row.user_id);
  } catch (error) {
    console.error(
      `composio ensure failed for ${row.user_id}:`,
      error instanceof Error ? error.message : error,
    );
  }

  // Fast path for per-message inject: already wired — still refresh telegram proxy,
  // but skip expensive mint+require if Composio is already live.
  if (!requireComposio) {
    const prior = await fetchHarnessHealth(env, row.runtime_id, row.runtime_domain);
    if (prior?.composio_mcp_ready === true && prior?.telegram_proxy_ready === true) {
      // Still re-mint Composio when possible (token refresh) but never fail the turn.
      const soft = await mintComposioMcpAccess(env, row.user_id, row.runtime_id);
      const url = `${harnessBaseUrl(env, row.runtime_id, row.runtime_domain)}/bootstrap`;
      const response = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          secret: required(env, "WORKER_TO_HARNESS_SECRET"),
          workerUrl: base,
          userId: row.user_id,
          telegramProxy: {
            token: proxyToken,
            baseUrl: `${base}/telegram-bot-api/bot`,
            baseFileUrl: `${base}/telegram-bot-api/file/bot`,
            userId: row.user_id,
            chatId: row.gateway_conversation_id,
            gatewayUserId: row.gateway_user_id,
          },
          ...(soft
            ? {
                composioMcp: {
                  url: soft.mcp_url,
                  token: soft.mcp_token,
                  toolkits: soft.toolkits,
                },
              }
            : {}),
        }),
      });
      if (!response.ok) {
        const detail = await response.text().catch(() => "");
        throw new Error(
          `Harness bootstrap failed with HTTP ${response.status}${detail ? `: ${detail.slice(0, 200)}` : ""}`,
        );
      }
      return;
    }
  }

  const mintAttempts: Array<{ forceNewComposioSession?: boolean }> = requireComposio
    ? [{}, { forceNewComposioSession: true }, { forceNewComposioSession: true }]
    : [{}, { forceNewComposioSession: true }];

  let lastError = "composio mint failed";
  for (let attempt = 0; attempt < mintAttempts.length; attempt++) {
    const mintOpts = mintAttempts[attempt];
    let composioMcp = await mintComposioMcpAccess(
      env,
      row.user_id,
      row.runtime_id,
      mintOpts,
    );
    if (!composioMcp) {
      lastError =
        `composio mint returned null (attempt ${attempt + 1}/${mintAttempts.length}); ` +
        `check COMPOSIO_SESSION_SECRET match on gateway+composio-proxy and COMPOSIO_API_KEY on proxy`;
      console.error(lastError);
      // Without Composio: still try telegram-only bootstrap when not required.
      if (!requireComposio) {
        break;
      }
      continue;
    }
    console.log(
      `composio MCP minted for ${row.user_id} toolkits=${(composioMcp.toolkits || []).join(",")} ` +
        `reused=${!!composioMcp.reused_composio_session} attempt=${attempt + 1}`,
    );

    const url = `${harnessBaseUrl(env, row.runtime_id, row.runtime_domain)}/bootstrap`;
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        secret: required(env, "WORKER_TO_HARNESS_SECRET"),
        workerUrl: base,
        userId: row.user_id,
        telegramProxy: {
          token: proxyToken,
          baseUrl: `${base}/telegram-bot-api/bot`,
          baseFileUrl: `${base}/telegram-bot-api/file/bot`,
          userId: row.user_id,
          chatId: row.gateway_conversation_id,
          gatewayUserId: row.gateway_user_id,
        },
        composioMcp: {
          url: composioMcp.mcp_url,
          token: composioMcp.mcp_token,
          toolkits: composioMcp.toolkits,
        },
      }),
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      lastError = `Harness bootstrap failed with HTTP ${response.status}${detail ? `: ${detail.slice(0, 200)}` : ""}`;
      console.error(lastError);
      // Inject path: telegram-only retry if composio apply rejected.
      if (!requireComposio && detail.includes("composio")) {
        break;
      }
      continue;
    }

    let bodyComposio = false;
    try {
      const body = (await response.json()) as { composio_mcp?: boolean };
      bodyComposio = body?.composio_mcp === true;
    } catch {
      // non-JSON — fall through to health check
    }

    // Source of truth: harness health (env token + config block live).
    const health = await fetchHarnessHealth(env, row.runtime_id, row.runtime_domain);
    if (health?.composio_mcp_ready === true) {
      if (!bodyComposio) {
        console.log(
          `composio: health ready for ${row.user_id} (bootstrap body omitted composio_mcp flag)`,
        );
      }
      return;
    }

    lastError =
      `composio_mcp_ready still false after bootstrap attempt ${attempt + 1} ` +
      `for ${row.user_id} (body_composio=${bodyComposio}, health=${JSON.stringify(health)})`;
    console.error(lastError);
  }

  // Telegram-only bootstrap (inject path when Composio is unavailable).
  if (!requireComposio) {
    const url = `${harnessBaseUrl(env, row.runtime_id, row.runtime_domain)}/bootstrap`;
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        secret: required(env, "WORKER_TO_HARNESS_SECRET"),
        workerUrl: base,
        userId: row.user_id,
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
      throw new Error(
        `Harness bootstrap failed with HTTP ${response.status}${detail ? `: ${detail.slice(0, 200)}` : ""}`,
      );
    }
    console.error(
      `composio MCP NOT injected for ${row.user_id} (requireComposio=false) — ${lastError}`,
    );
    return;
  }

  throw new Error(
    `Composio MCP not ready for ${row.user_id} after retries: ${lastError}`,
  );
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
    // succeeds so a broken in-sandbox Telegram runtime never looks "ready" in D1.
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
    // Hydrate agent-home BEFORE bootstrap when possible… but restore requires
    // harness auth (bootstrap sets the secret). So: bootstrap first, restore,
    // then re-bootstrap so composio MCP + reply_to policy win over any
    // checkpoint-overwritten config.yaml.
    // Composio is best-effort — never hard-fail provision on mint desync.
    await bootstrapHarness(env, pending, { requireComposio: false });
    await restoreCheckpointToRuntime(env, pending);
    // Second bootstrap is idempotent (same secret): re-applies composio token
    // and restarts/reloads gateway tooling after restore may have overwritten
    // ~/.hermes/config.yaml.
    await bootstrapHarness(env, pending, { requireComposio: false });

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

    // Keep status non-ready until in-sandbox Telegram runtime bootstrap succeeds.
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
    // Best-effort: pull any staged checkpoint from the old live box before kill.
    if (oldId && !oldId.startsWith("provisioning:")) {
      await pullCheckpointOnce(env, { ...row, runtime_id: oldId }).catch(() => {});
    }

    await bootstrapHarness(env, pending, { requireComposio: false });
    // Critical: replaceRuntime kills the old box — restore then re-bootstrap so
    // composio MCP / telegram proxy win over checkpoint-overwritten config.
    await restoreCheckpointToRuntime(env, pending);
    await bootstrapHarness(env, pending, { requireComposio: false });

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

/**
 * Push a raw Telegram update into the sandbox Hermes Telegram runtime.
 * Returns the live runtime row after a successful inject (for checkpoint pull).
 */
async function injectTelegramUpdate(
  env: Env,
  row: UserAgentRow,
  update: TelegramUpdate,
  turnId?: string,
): Promise<UserAgentRow> {
  if (row.runtime_provider !== "e2b") throw new Error(`Unsupported runtime provider: ${row.runtime_provider}`);

  let current = row;
  let lastError = "inject failed";
  if (turnId) {
    await addTurnEvent(env.FROMDONNA_ROUTING, turnId, "inject.start", {
      status: "injecting",
      runtimeId: current.runtime_id,
      detail: { attempt: 0 },
    });
  }

  // Attempt 0: resume existing box. Attempt 1: replace runtime if gone/broken.
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const alive = await ensureSandboxRunning(env, current.runtime_id);
      if (!alive) {
        lastError = "E2B sandbox missing";
        if (turnId) {
          await addTurnEvent(env.FROMDONNA_ROUTING, turnId, "sandbox.missing", {
            ok: false,
            detail: { runtime_id: current.runtime_id },
          });
        }
        current = await replaceRuntime(env, current);
        if (turnId) {
          await addTurnEvent(env.FROMDONNA_ROUTING, turnId, "sandbox.replaced", {
            runtimeId: current.runtime_id,
            detail: { runtime_id: current.runtime_id },
          });
        }
        // fall through to inject on the new box
      } else {
        // Pause→resume: wait for harness, then re-bootstrap proxy + start gateway.
        // requireComposio:false — per-message path must not 500 the whole turn if
        // Composio mint is slow/down; chat still works. Provision still hard-requires it.
        const t0 = Date.now();
        await waitForHarness(env, current.runtime_id, current.runtime_domain, 90);
        if (turnId) {
          await addTurnEvent(env.FROMDONNA_ROUTING, turnId, "harness.ready", {
            durationMs: Date.now() - t0,
            runtimeId: current.runtime_id,
          });
        }
        const t1 = Date.now();
        await bootstrapHarness(env, current, { requireComposio: false });
        if (turnId) {
          await addTurnEvent(env.FROMDONNA_ROUTING, turnId, "bootstrap.ok", {
            durationMs: Date.now() - t1,
            detail: { requireComposio: false },
          });
        }
        // Capture prior turn's staged checkpoint before this turn overwrites state.
        await pullCheckpointOnce(env, current);
        if (turnId) {
          await addTurnEvent(env.FROMDONNA_ROUTING, turnId, "checkpoint.pull", {
            detail: { note: "pre-inject best-effort" },
          });
        }
      }

      let response = await postTelegramUpdate(env, current, update);
      if (!response.ok) {
        const detail = await response.text().catch(() => "");
        lastError = `Sandbox telegram inject failed with HTTP ${response.status}${detail ? `: ${detail.slice(0, 300)}` : ""}`;
        if (turnId) {
          await addTurnEvent(env.FROMDONNA_ROUTING, turnId, "inject.post_failed", {
            ok: false,
            detail: { status: response.status, detail: detail.slice(0, 200), retry: true },
          });
        }
        // One soft retry on same box after re-bootstrap (stale gateway thread / lock).
        await bootstrapHarness(env, current, { requireComposio: false });
        response = await postTelegramUpdate(env, current, update);
        if (!response.ok) {
          const detail2 = await response.text().catch(() => "");
          lastError = `Sandbox telegram inject failed with HTTP ${response.status}${detail2 ? `: ${detail2.slice(0, 300)}` : ""}`;
          if (attempt === 0) {
            current = await replaceRuntime(env, current);
            if (turnId) {
              await addTurnEvent(env.FROMDONNA_ROUTING, turnId, "sandbox.replaced", {
                runtimeId: current.runtime_id,
                detail: { reason: "inject_retry_exhausted" },
              });
            }
            continue;
          }
          throw new Error(lastError);
        }
      }
      if (turnId) {
        await addTurnEvent(env.FROMDONNA_ROUTING, turnId, "inject.ok", {
          status: "injected",
          runtimeId: current.runtime_id,
          detail: { attempt },
        });
      }
      return current;
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
          if (turnId) {
            await addTurnEvent(env.FROMDONNA_ROUTING, turnId, "sandbox.replaced", {
              runtimeId: current.runtime_id,
              detail: { reason: "recoverable_error", error: lastError.slice(0, 200) },
            });
          }
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

async function processTelegramUpdate(
  env: Env,
  update: TelegramUpdate,
  ctx: ExecutionContext,
): Promise<void> {
  const event = normalizeTelegramUpdate(update);
  if (!event) return;

  const gateway = "telegram";
  const gatewayUserId = event.actorId;
  const gatewayConversationId = event.conversationId;
  const userId = internalUserId(gateway, gatewayUserId);
  const turnId = newTurnId();
  const inbound = inboundPreviewFromUpdate(update);

  await startTurn(env.FROMDONNA_ROUTING, {
    turnId,
    userId,
    gateway,
    gatewayUserId,
    gatewayConversationId,
    telegramUpdateId:
      typeof update.update_id === "number"
        ? update.update_id
        : typeof update.update_id === "string" && update.update_id
          ? Number(update.update_id) || null
          : null,
    inboundKind: inbound.kind,
    inboundPreview: inbound.preview,
  });

  try {
    await addTurnEvent(env.FROMDONNA_ROUTING, turnId, "route.start", { status: "routing" });
    const tRoute = Date.now();
    const resolved = await resolveReadyRow(env, gateway, gatewayUserId, gatewayConversationId);
    if (resolved === "provisioning") {
      await addTurnEvent(env.FROMDONNA_ROUTING, turnId, "route.provisioning", {
        status: "provisioning",
        durationMs: Date.now() - tRoute,
        detail: { note: "another request is provisioning or reclaim in progress" },
      });
      await telegram(env, "sendMessage", {
        chat_id: gatewayConversationId,
        text: "Setting up your private assistant — one moment, then send that again.",
      });
      await addTurnEvent(env.FROMDONNA_ROUTING, turnId, "gateway.user_notice", {
        status: "complete",
        detail: { text: "setting_up" },
      });
      return;
    }

    await addTurnEvent(env.FROMDONNA_ROUTING, turnId, "route.ready", {
      durationMs: Date.now() - tRoute,
      runtimeId: resolved.runtime_id,
      detail: { status: resolved.status, runtime_id: resolved.runtime_id },
    });

    // Official path: sandbox Hermes Telegram runtime sends via Bot API proxy.
    // Worker does not render agent text itself.
    const live = await injectTelegramUpdate(env, resolved, update, turnId);
    // Separate waitUntil so create/inject time does not starve checkpoint harvest.
    // Goal: proactive R2 backup after agent use (best-effort after this turn;
    // also pulled at the start of the next message / before replace).
    ctx.waitUntil(
      (async () => {
        await harvestCheckpointAfterTurn(env, live);
        await addTurnEvent(env.FROMDONNA_ROUTING, turnId, "checkpoint.harvest", {
          detail: { runtime_id: live.runtime_id },
        });
      })(),
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : "processTelegramUpdate failed");
    try {
      const detail = error instanceof Error ? error.message : "processTelegramUpdate failed";
      console.error("processTelegramUpdate", detail);
      await addTurnEvent(env.FROMDONNA_ROUTING, turnId, "turn.error", {
        ok: false,
        status: "error",
        error: detail,
        detail: { message: detail.slice(0, 500) },
      });
      await telegram(env, "sendMessage", {
        chat_id: gatewayConversationId,
        text: "Something went wrong on my side. Please try again in a moment.",
      });
      await addTurnEvent(env.FROMDONNA_ROUTING, turnId, "gateway.user_notice", {
        detail: { text: "something_went_wrong" },
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
  ctx.waitUntil(processTelegramUpdate(env, update, ctx));
  return json({ ok: true });
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    try {
      if (request.method === "GET" && url.pathname === "/health") {
        return json({ ok: true, service: "fromdonna-gateway", mode: "channel-agnostic" });
      }

      // Ops: message-flow dashboard + JSON API (auth via harness secret / ?token=).
      const adminTurns = await handleAdminTurns(request, env, url);
      if (adminTurns) return adminTurns;

      // Ops: rebind Telegram webhook with full allowed_updates (auth via harness secret).
      if (request.method === "POST" && url.pathname === "/admin/rebind-webhook") {
        const auth = request.headers.get("authorization") || "";
        const expected = `Bearer ${required(env, "WORKER_TO_HARNESS_SECRET")}`;
        if (auth !== expected) return new Response("Unauthorized", { status: 401 });
        return await rebindTelegramWebhook(env);
      }

      // Runtime checkpoint (channel-agnostic): harness uploads after agent turn completes.
      if (request.method === "POST" && url.pathname === "/internal/checkpoint") {
        return await handleCheckpointUpload(request, env);
      }
      if (request.method === "GET" && url.pathname === "/internal/checkpoint/status") {
        return await handleCheckpointStatus(request, env);
      }

      // Official Hermes TelegramAdapter Bot API reverse proxy (token never leaves Worker).
      const proxied = await handleBotApiProxy({
        request,
        url,
        realBotToken: required(env, "TELEGRAM_BOT_TOKEN"),
        proxySecret: required(env, "WORKER_TO_HARNESS_SECRET"),
        routingDb: env.FROMDONNA_ROUTING,
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
