/**
 * FromDonna gateway Worker (channel-agnostic).
 *
 * Owns chat webhooks + D1 routing + E2B lifecycle + channel API proxies
 * (Telegram first; WhatsApp/etc. later). Never puts real channel tokens into
 * sandboxes. Per-channel adapters in each sandbox call this Worker as the
 * privileged door (e.g. Hermes TelegramAdapter → /telegram-bot-api/*).
 */

import { handleBotApiProxy, mintBotProxyToken } from "./bot_api_proxy";
import {
  getCheckpointBytes,
  handleCheckpointStatus,
  handleCheckpointUpload,
  putCheckpoint,
} from "./checkpoint";
import { ensureUserComposio, getLastComposioMintError, mintComposioMcpAccess } from "./composio";
import {
  DEFAULT_PRESENCE_CONFIG,
  PRESENCE_PROCESS_FALLBACK,
  appendPresenceSnippets,
  callPresenceTinyLlm,
  claimPresenceProcessSlot,
  isPresenceStatusLine,
  isPresenceTurnFinalized,
  loadPresenceRing,
  loadPresenceTurn,
  markPresenceTurnFinal,
  resetPresenceTurn,
  resolvePresenceAckPreferFast,
  resolvePresenceGate,
  resolvePresenceProcessLine,
  samePresenceText,
  sanitizeStageId,
  stageFromToolName,
  type PresenceSnippet,
} from "./presence";
import { normalizeTelegramUpdate, type TelegramUpdate } from "./telegram";
import {
  harnessHealthPollDelayMs,
  shouldSendEarlyTyping,
  shouldSkipBootstrap,
  shouldSkipPreInjectCheckpoint,
} from "./warm_path";

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
  /**
   * Service binding to fromdonna-composio-proxy (required for Worker→Worker mint).
   * Public workers.dev fetch from this Worker returns CF 1042.
   */
  COMPOSIO_PROXY?: Fetcher;
  /**
   * Service binding to fromdonna-llm-proxy for presence tiny-LLM.
   * Required in production — public workers.dev fetch from a Worker returns CF 1042.
   */
  LLM_PROXY?: Fetcher;
  /**
   * Optional public llm-proxy base (local/tests). Production uses LLM_PROXY binding.
   */
  LLM_PROXY_URL?: string;
  /** Set to "0" / "false" to disable edge presence acks. */
  PRESENCE_ACK_ENABLED?: string;
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
  /** Bumped on every inject; post-turn pause skips if epoch changed. */
  activity_epoch?: number | null;
};

type E2bSandbox = { sandboxID: string; domain?: string | null };

type CheckpointStageState = "ready" | "packing" | "failed" | "idle" | "unknown";

type HarvestResult = {
  ok: boolean;
  /**
   * True only when this turn's pack reached a terminal stage (ready or failed
   * for *this* harvest window). Pause must not run while the agent may still
   * be working (status idle for the whole window).
   */
  safeToPause: boolean;
  reason:
    | "harvested"
    | "pack_failed"
    | "timeout"
    | "timeout_agent_maybe_running"
    | "export_failed"
    | "error";
  detail?: string;
};

const json = (body: unknown, status = 200) => Response.json(body, { status });
const DEFAULT_SANDBOX_DOMAIN = "e2b.dev";
/** Safety-net continuous TTL while a turn is active. E2B rejects > 1 hour.
 * Extended on every connect during inject. Not the cost control for idle —
 * post-turn pause (after terminal pack + quiet) is the primary shutdown path. */
const SANDBOX_TTL_SECONDS = 3600;
/** After terminal pack (ready|failed this turn): wait this long with no newer inject, then pause. */
const POST_TURN_QUIET_MS = 60_000;
/** Harvest: first probe delay (session may still be scheduling). */
const CHECKPOINT_HARVEST_INITIAL_MS = 5_000;
/**
 * Max wait for packing→ready|failed. Must cover harness session wait (900s) + pack.
 * If we stop earlier while still idle, we must NOT pause (agent may still be running).
 */
const CHECKPOINT_HARVEST_MAX_MS = 16 * 60_000;
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
  await telegramJson(env, method, body);
}

/** Telegram Bot API call returning parsed JSON result (ok/result). */
async function telegramJson(
  env: Env,
  method: string,
  body: Record<string, unknown>,
): Promise<unknown> {
  const response = await fetch(`https://api.telegram.org/bot${required(env, "TELEGRAM_BOT_TOKEN")}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const detail = await response.text().catch(() => "");
  if (!response.ok) {
    throw new Error(`Telegram ${method} failed with HTTP ${response.status}${detail ? `: ${detail.slice(0, 200)}` : ""}`);
  }
  let parsed: unknown = null;
  try {
    parsed = detail ? JSON.parse(detail) : null;
  } catch {
    return null;
  }
  // Bot API can return HTTP 200 with { ok: false, description: "..." }.
  if (parsed && typeof parsed === "object" && (parsed as { ok?: unknown }).ok === false) {
    const desc = String((parsed as { description?: unknown }).description || "ok=false");
    throw new Error(`Telegram ${method} rejected: ${desc.slice(0, 200)}`);
  }
  return parsed;
}

function presenceEnabled(env: Env): boolean {
  const flag = (env.PRESENCE_ACK_ENABLED || "1").toLowerCase();
  return flag !== "0" && flag !== "false" && flag !== "off";
}

function llmProxyBaseUrl(env: Env): string {
  return (env.LLM_PROXY_URL || DEFAULT_PRESENCE_CONFIG.llmProxyBaseUrl).replace(/\/$/, "");
}

function presenceLlmCall(env: Env, capability: string) {
  return (body: Parameters<typeof callPresenceTinyLlm>[0]["body"]) =>
    callPresenceTinyLlm({
      fetcher: env.LLM_PROXY,
      llmProxyBaseUrl: llmProxyBaseUrl(env),
      capabilityToken: capability,
      body,
    });
}

/**
 * Edge presence ack: contextual WIP line before Hermes final.
 * Hybrid gate may skip simple turns (hi/echo). Hermes mid-turn stays off.
 */
async function sendPresenceAck(args: {
  env: Env;
  userId: string;
  chatId: string;
  currentUserText: string;
}): Promise<void> {
  const { env, userId, chatId, currentUserText } = args;
  if (!presenceEnabled(env)) return;
  const text = currentUserText.trim();
  if (!text) return;

  let capability: string | null = null;
  try {
    capability = await mintLlmCapability(env, userId);
  } catch (error) {
    console.error(
      "presence capability mint failed:",
      error instanceof Error ? error.message : error,
    );
  }

  const gate = await resolvePresenceGate({
    text,
    model: DEFAULT_PRESENCE_CONFIG.model,
    deadlineMs: 180,
    callTinyLlm: capability ? presenceLlmCall(env, capability) : undefined,
  });

  // Always open turn + record user text so process budget / ring stay coherent.
  await resetPresenceTurn(env.FROMDONNA_ROUTING, userId);
  await appendPresenceSnippets(env.FROMDONNA_ROUTING, userId, [{ role: "user", text }]);

  if (!gate.send) {
    console.log(`presence ack skipped reason=${gate.reason} user=${userId}`);
    return;
  }

  const snippets = await loadPresenceRing(env.FROMDONNA_ROUTING, userId);
  const ack = await resolvePresenceAckPreferFast({
    snippets,
    currentUserText: text,
    seed: userId,
    config: {
      llmProxyBaseUrl: llmProxyBaseUrl(env),
      tinyLlmAck: Boolean(capability),
      ackDeadlineMs: 1200,
    },
    callTinyLlm: capability ? presenceLlmCall(env, capability) : undefined,
  });

  await telegram(env, "sendMessage", {
    chat_id: chatId,
    text: ack.text,
  });

  await appendPresenceSnippets(env.FROMDONNA_ROUTING, userId, [
    { role: "status", text: ack.text },
  ]);
  console.log(`presence ack source=${ack.source} gate=${gate.reason} user=${userId}`);
}

/**
 * Msg 2–3: process WIP from sandbox tool stages.
 * Claim → short contextual LLM → ONE send (no bland-first flash).
 * Never send after Hermes final.
 * Auth: Bearer WORKER_TO_HARNESS_SECRET + body userId/chatId must match D1 route.
 */
async function handlePresenceStage(request: Request, env: Env): Promise<Response> {
  const auth = request.headers.get("authorization") || "";
  const expected = `Bearer ${required(env, "WORKER_TO_HARNESS_SECRET")}`;
  if (auth !== expected) return new Response("Unauthorized", { status: 401 });
  if (!presenceEnabled(env)) {
    console.log("presence process skipped reason=disabled");
    return json({ ok: true, skipped: "disabled" });
  }

  let body: {
    userId?: string;
    chatId?: string;
    toolName?: string;
    stage?: string;
  };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return json({ ok: false, error: "invalid_json" }, 400);
  }

  const userId = (body.userId || "").trim();
  const chatId = (body.chatId || "").trim();
  if (!userId || !chatId) return json({ ok: false, error: "userId_and_chatId_required" }, 400);

  const route = await lookupByUserId(env, userId);
  if (!route || route.status !== "ready") {
    console.log(`presence process skipped reason=user_not_ready user=${userId}`);
    return json({ ok: false, error: "user_not_ready" }, 403);
  }
  if (String(route.gateway_conversation_id) !== String(chatId)) {
    console.log(`presence process skipped reason=chat_mismatch user=${userId}`);
    return json({ ok: false, error: "chat_mismatch" }, 403);
  }

  const toolName = (body.toolName || "").trim();
  const mapped = stageFromToolName(toolName || body.stage || "working");
  const stage = sanitizeStageId(body.stage || mapped.stage);

  const turn = await loadPresenceTurn(env.FROMDONNA_ROUTING, userId);
  const epoch = turn.pre_final_count;
  if (isPresenceTurnFinalized(turn)) {
    console.log(`presence process skipped reason=final_already stage=${stage} user=${userId}`);
    return json({ ok: true, skipped: "final_already", stage });
  }

  // Reserve slot first so budget is real, then write ONE contextual line.
  const claim = await claimPresenceProcessSlot(
    env.FROMDONNA_ROUTING,
    userId,
    stage,
    epoch,
  );
  if (!claim.ok) {
    console.log(
      `presence process skipped reason=${claim.reason} stage=${stage} user=${userId} epoch=${epoch}`,
    );
    return json({ ok: true, skipped: claim.reason, stage });
  }

  const turnAfterClaim = await loadPresenceTurn(env.FROMDONNA_ROUTING, userId);
  if (isPresenceTurnFinalized(turnAfterClaim) || turnAfterClaim.pre_final_count !== epoch) {
    console.log(`presence process skipped reason=final_race stage=${stage} user=${userId}`);
    return json({ ok: true, skipped: "final_race", stage });
  }

  const snippets = await loadPresenceRing(env.FROMDONNA_ROUTING, userId);
  const lastNonStatus = [...snippets].reverse().find((s) => s.role !== "status");
  if (lastNonStatus?.role === "assistant") {
    console.log(`presence process skipped reason=assistant_already stage=${stage} user=${userId}`);
    return json({ ok: true, skipped: "assistant_already", stage });
  }

  const latestUserText = [...snippets].reverse().find((s) => s.role === "user")?.text;
  const lastStatus = [...snippets].reverse().find((s) => s.role === "status");

  let capability: string | null = null;
  try {
    capability = await mintLlmCapability(env, userId);
  } catch {
    // fallback path
  }

  // ONE contextual line from light LLM (short deadline). No bland-first flash.
  const line = await resolvePresenceProcessLine({
    snippets,
    toolName,
    stage,
    seed: userId,
    latestUserText,
    config: {
      llmProxyBaseUrl: llmProxyBaseUrl(env),
      tinyLlmAck: Boolean(capability),
      processDeadlineMs: DEFAULT_PRESENCE_CONFIG.processDeadlineMs,
    },
    callTinyLlm: capability ? presenceLlmCall(env, capability) : undefined,
  });

  if ("skipped" in line) {
    console.log(`presence process skipped reason=${line.reason} stage=${stage} user=${userId}`);
    return json({ ok: true, skipped: line.reason, stage });
  }

  // Only user-visible process when light LLM produced a contextual line.
  // Never ship vague Still working… fallback as a bubble.
  if (line.source !== "tiny_llm") {
    console.log(
      `presence process skipped reason=no_contextual_llm stage=${stage} user=${userId}`,
    );
    return json({ ok: true, skipped: "no_contextual_llm", stage });
  }
  const text = line.text;
  const source = line.source;
  if (lastStatus && samePresenceText(lastStatus.text, text)) {
    console.log(`presence process skipped reason=duplicate_ack stage=${stage} user=${userId}`);
    return json({ ok: true, skipped: "duplicate_ack", stage });
  }

  // Never land after Hermes final.
  const turnBeforeSend = await loadPresenceTurn(env.FROMDONNA_ROUTING, userId);
  if (isPresenceTurnFinalized(turnBeforeSend) || turnBeforeSend.pre_final_count !== epoch) {
    console.log(`presence process skipped reason=final_before_send stage=${stage} user=${userId}`);
    return json({ ok: true, skipped: "final_before_send", stage });
  }
  const ringBeforeSend = await loadPresenceRing(env.FROMDONNA_ROUTING, userId);
  const lastBefore = [...ringBeforeSend].reverse().find((s) => s.role !== "status");
  if (lastBefore?.role === "assistant") {
    console.log(`presence process skipped reason=assistant_before_send stage=${stage} user=${userId}`);
    return json({ ok: true, skipped: "assistant_before_send", stage });
  }

  let messageId: number | null = null;
  try {
    const sent = (await telegramJson(env, "sendMessage", {
      chat_id: chatId,
      text,
    })) as { result?: { message_id?: number } } | null;
    const mid = sent?.result?.message_id;
    messageId = typeof mid === "number" ? mid : null;
  } catch (error) {
    console.error(
      "presence process send failed:",
      error instanceof Error ? error.message : error,
    );
    return json({ ok: false, error: "send_failed", stage }, 502);
  }

  await appendPresenceSnippets(env.FROMDONNA_ROUTING, userId, [
    { role: "status", text },
  ]);
  console.log(
    `presence process source=${source} stage=${stage} tool=${toolName || "-"} user=${userId} mid=${messageId ?? "-"} text=${text.slice(0, 80)}`,
  );
  return json({ ok: true, text, source, stage, messageId });
}

/** Keep Telegram "typing…" alive while inject is in flight (bounded). */
async function typingUntil(
  env: Env,
  chatId: string,
  stop: { done: boolean },
  maxMs = 120_000,
): Promise<void> {
  const started = Date.now();
  while (!stop.done && Date.now() - started < maxMs) {
    try {
      await telegram(env, "sendChatAction", { chat_id: chatId, action: "typing" });
    } catch {
      // ignore
    }
    await new Promise((r) => setTimeout(r, 4000));
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

/** Pause keeps disk + memory; resume via connect on next message. */
async function pauseSandboxBestEffort(env: Env, sandboxId: string): Promise<boolean> {
  try {
    const response = await fetch(`https://api.e2b.app/sandboxes/${sandboxId}/pause`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "X-API-KEY": required(env, "E2B_API_KEY"),
      },
      body: JSON.stringify({ memory: true }),
    });
    // 204 = paused; 409 often already paused; 404 gone
    if (response.status === 204 || response.status === 200 || response.status === 409) {
      return true;
    }
    if (response.status === 404) return false;
    const detail = await response.text().catch(() => "");
    console.error(
      `E2B pause failed for ${sandboxId}: HTTP ${response.status}${detail ? `: ${detail.slice(0, 200)}` : ""}`,
    );
    return false;
  } catch (error) {
    console.error(
      `E2B pause error for ${sandboxId}:`,
      error instanceof Error ? error.message : error,
    );
    return false;
  }
}

/** Bump on inject so a concurrent/later message cancels a scheduled post-turn pause. */
async function bumpActivityEpoch(
  env: Env,
  gateway: string,
  gatewayUserId: string,
): Promise<number> {
  await env.FROMDONNA_ROUTING.prepare(
    `UPDATE user_agents
     SET activity_epoch = COALESCE(activity_epoch, 0) + 1,
         updated_at = CURRENT_TIMESTAMP
     WHERE gateway = ?1 AND gateway_user_id = ?2`,
  )
    .bind(gateway, gatewayUserId)
    .run();
  const row = await env.FROMDONNA_ROUTING.prepare(
    `SELECT activity_epoch FROM user_agents WHERE gateway = ?1 AND gateway_user_id = ?2`,
  )
    .bind(gateway, gatewayUserId)
    .first<{ activity_epoch: number }>();
  return Number(row?.activity_epoch ?? 0);
}

async function readActivityEpoch(
  env: Env,
  gateway: string,
  gatewayUserId: string,
): Promise<number> {
  const row = await env.FROMDONNA_ROUTING.prepare(
    `SELECT activity_epoch FROM user_agents WHERE gateway = ?1 AND gateway_user_id = ?2`,
  )
    .bind(gateway, gatewayUserId)
    .first<{ activity_epoch: number | null }>();
  return Number(row?.activity_epoch ?? 0);
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
    // Adaptive backoff: fast polls right after connect/resume, then slower.
    await new Promise((r) => setTimeout(r, harnessHealthPollDelayMs(i)));
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

/** Poll harness status markers (non-consuming). Falls back to unknown on error. */
async function probeCheckpointStage(
  env: Env,
  row: Pick<UserAgentRow, "runtime_id" | "runtime_domain">,
): Promise<{
  state: CheckpointStageState;
  error?: string;
  readyAt?: number;
  failedAt?: number;
  startedAt?: number;
}> {
  try {
    const url = `${harnessBaseUrl(env, row.runtime_id, row.runtime_domain)}/internal/checkpoint/status`;
    const response = await fetch(url, {
      method: "GET",
      headers: { authorization: `Bearer ${required(env, "WORKER_TO_HARNESS_SECRET")}` },
    });
    if (!response.ok) return { state: "unknown" };
    const body = (await response.json()) as {
      state?: string;
      error?: string;
      readyAt?: number;
      failedAt?: number;
      startedAt?: number;
    };
    const state = body.state;
    if (state === "ready" || state === "packing" || state === "failed" || state === "idle") {
      return {
        state,
        error: typeof body.error === "string" ? body.error : undefined,
        readyAt: typeof body.readyAt === "number" ? body.readyAt : undefined,
        failedAt: typeof body.failedAt === "number" ? body.failedAt : undefined,
        startedAt: typeof body.startedAt === "number" ? body.startedAt : undefined,
      };
    }
    return { state: "unknown" };
  } catch {
    return { state: "unknown" };
  }
}

/**
 * After inject: wait until THIS turn's pack is terminal (packing→ready|failed),
 * then pull to R2 if configured. Never treats leftover tar as a fresh ready.
 * safeToPause is true only after a turn-scoped terminal stage (agent finished packing).
 */
async function harvestCheckpointAfterTurn(
  env: Env,
  row: Pick<UserAgentRow, "user_id" | "runtime_id" | "runtime_domain">,
): Promise<HarvestResult> {
  if (!row.runtime_id || row.runtime_id.startsWith("provisioning:")) {
    return { ok: false, safeToPause: false, reason: "error", detail: "no_runtime" };
  }

  await new Promise((r) => setTimeout(r, CHECKPOINT_HARVEST_INITIAL_MS));

  const harvestStartedMs = Date.now();
  const harvestStartedSec = harvestStartedMs / 1000;
  let sawPacking = false;
  let consecutiveUnknown = 0;

  const isFreshReady = (probe: { readyAt?: number }): boolean => {
    // Accept if we saw packing this window, or readyAt is after harvest started
    // (covers fast packs that finish between polls).
    if (sawPacking) return true;
    if (typeof probe.readyAt === "number" && probe.readyAt >= harvestStartedSec - 2) return true;
    return false;
  };

  const isFreshFailed = (probe: { failedAt?: number }): boolean => {
    if (sawPacking) return true;
    if (typeof probe.failedAt === "number" && probe.failedAt >= harvestStartedSec - 2) return true;
    return false;
  };

  while (Date.now() - harvestStartedMs < CHECKPOINT_HARVEST_MAX_MS) {
    const probe = await probeCheckpointStage(env, row);

    if (probe.state === "packing") {
      sawPacking = true;
      consecutiveUnknown = 0;
      await new Promise((r) => setTimeout(r, 2_000));
      continue;
    }

    if (probe.state === "ready" && isFreshReady(probe)) {
      if (!env.USER_STATE) {
        // Stage complete; no R2 — still safe to pause after quiet.
        return { ok: true, safeToPause: true, reason: "harvested", detail: "no_r2_stage_only" };
      }
      const ok = await pullCheckpointOnce(env, row);
      if (ok) return { ok: true, safeToPause: true, reason: "harvested" };
      await new Promise((r) => setTimeout(r, 2_000));
      const retry = await pullCheckpointOnce(env, row);
      if (retry) return { ok: true, safeToPause: true, reason: "harvested" };
      // Pack finished this turn; export failed — still safe to pause (agent done).
      return {
        ok: false,
        safeToPause: true,
        reason: "export_failed",
        detail: "export_failed_after_ready",
      };
    }

    if (probe.state === "failed" && isFreshFailed(probe)) {
      return {
        ok: false,
        safeToPause: true,
        reason: "pack_failed",
        detail: probe.error?.slice(0, 200),
      };
    }

    // Stale ready/failed from a previous turn — keep waiting for packing of this turn.
    if (probe.state === "ready" || probe.state === "failed") {
      consecutiveUnknown = 0;
      const elapsed = Date.now() - harvestStartedMs;
      await new Promise((r) => setTimeout(r, elapsed < 120_000 ? 3_000 : 8_000));
      continue;
    }

    // idle / unknown: agent may still be running.
    if (probe.state === "unknown") {
      consecutiveUnknown += 1;
      // Old image without status: only pull after we have been waiting a while,
      // and only treat success as terminal if export actually returns a body.
      // Do NOT pause solely on opportunistic pull of a leftover tar (export
      // now requires ready marker, so this is rare).
      if (consecutiveUnknown >= 5 && env.USER_STATE) {
        const ok = await pullCheckpointOnce(env, row);
        if (ok) return { ok: true, safeToPause: true, reason: "harvested", detail: "unknown_fallback" };
      }
    } else {
      consecutiveUnknown = 0;
    }

    // After packing, brief idle before ready marker is visible — try pull once.
    if (sawPacking && probe.state === "idle" && env.USER_STATE) {
      const ok = await pullCheckpointOnce(env, row);
      if (ok) return { ok: true, safeToPause: true, reason: "harvested" };
    }

    const elapsed = Date.now() - harvestStartedMs;
    const delayMs = elapsed < 120_000 ? 3_000 : 8_000;
    await new Promise((r) => setTimeout(r, delayMs));
  }

  // Timed out without a turn-scoped terminal stage.
  if (sawPacking && env.USER_STATE) {
    const lastChance = await pullCheckpointOnce(env, row);
    if (lastChance) return { ok: true, safeToPause: true, reason: "harvested" };
    // Packing was observed; agent likely finished — allow pause even if export missed.
    return {
      ok: false,
      safeToPause: true,
      reason: "timeout",
      detail: "timeout_after_packing",
    };
  }

  console.log(
    `checkpoint harvest timed out (agent may still be running) for ${row.user_id}`,
  );
  return {
    ok: false,
    safeToPause: false,
    reason: "timeout_agent_maybe_running",
    detail: "no_packing_observed_within_budget",
  };
}

/**
 * After a terminal pack: if no newer inject for POST_TURN_QUIET_MS, pause the VM.
 * Newer activity_epoch (another message) cancels the pause.
 */
async function pauseAfterQuietIfIdle(
  env: Env,
  row: Pick<UserAgentRow, "gateway" | "gateway_user_id" | "runtime_id" | "user_id">,
  epochAtSchedule: number,
): Promise<"paused" | "skipped_newer_activity" | "skipped_no_runtime" | "pause_failed"> {
  if (!row.runtime_id || row.runtime_id.startsWith("provisioning:")) {
    return "skipped_no_runtime";
  }

  await new Promise((r) => setTimeout(r, POST_TURN_QUIET_MS));

  const current = await readActivityEpoch(env, row.gateway, row.gateway_user_id);
  if (current !== epochAtSchedule) {
    return "skipped_newer_activity";
  }

  // Confirm runtime_id still matches (replaceRuntime may have remapped).
  const live = await lookup(env, row.gateway, row.gateway_user_id);
  if (!live || live.runtime_id !== row.runtime_id || live.status !== "ready") {
    return "skipped_newer_activity";
  }

  const paused = await pauseSandboxBestEffort(env, row.runtime_id);
  return paused ? "paused" : "pause_failed";
}

/**
 * Full post-turn lifecycle: wait for terminal pack → harvest → 1 min quiet → pause.
 * Never pauses while status stayed idle for the whole window (agent may still run).
 * Must run in ctx.waitUntil (long-running).
 */
async function runPostTurnLifecycle(
  env: Env,
  row: UserAgentRow,
  epochAtSchedule: number,
): Promise<void> {
  try {
    const harvest = await harvestCheckpointAfterTurn(env, row);
    if (!harvest.safeToPause) {
      console.log(
        `post-turn skip pause for ${row.user_id}: ${harvest.reason} (safeToPause=false)`,
      );
      return;
    }

    const pauseOutcome = await pauseAfterQuietIfIdle(env, row, epochAtSchedule);
    if (pauseOutcome === "paused") {
      console.log(`sandbox paused after quiet for ${row.user_id} (${row.runtime_id})`);
    } else {
      console.log(`post-turn pause outcome for ${row.user_id}: ${pauseOutcome}`);
    }
  } catch (error) {
    console.error(
      `post-turn lifecycle error for ${row.user_id}:`,
      error instanceof Error ? error.message : error,
    );
  }
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
 * Default (requireComposio=false): soft — Telegram always comes up; Composio mint is
 * best-effort. Used by per-message inject so a transient remint glitch never 500s chat.
 *
 * Hard (requireComposio=true): provision + replaceRuntime must pass this. Fails (and
 * kills the sandbox / leaves user not-ready) unless harness /health reports
 * composio_mcp_ready === true. Do not mark D1 ready without Composio.
 */
async function bootstrapHarness(
  env: Env,
  row: Pick<UserAgentRow, "user_id" | "gateway_user_id" | "gateway_conversation_id" | "runtime_id" | "runtime_domain">,
  opts?: { requireComposio?: boolean },
): Promise<void> {
  // Soft-default for inject; callers that provision must pass requireComposio:true.
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
      const detail = getLastComposioMintError() || "unknown mint failure";
      lastError =
        `composio mint returned null (attempt ${attempt + 1}/${mintAttempts.length}): ${detail}`;
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
    // Provision hard-requires Composio: fail (kill sandbox) rather than mark ready
    // when harness health.composio_mcp_ready is not true.
    await bootstrapHarness(env, pending, { requireComposio: true });
    await restoreCheckpointToRuntime(env, pending);
    // Second bootstrap is idempotent (same secret): re-applies composio token
    // and restarts/reloads gateway tooling after restore may have overwritten
    // ~/.hermes/config.yaml.
    await bootstrapHarness(env, pending, { requireComposio: true });

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

    // Hard-require Composio on replace (same policy as first provision).
    await bootstrapHarness(env, pending, { requireComposio: true });
    // Critical: replaceRuntime kills the old box — restore then re-bootstrap so
    // composio MCP / telegram proxy win over checkpoint-overwritten config.
    await restoreCheckpointToRuntime(env, pending);
    await bootstrapHarness(env, pending, { requireComposio: true });

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
      // Warm inject skips /bootstrap — keep presence plugin env fresh every turn.
      "x-fromdonna-user-id": row.user_id,
      "x-fromdonna-chat-id": row.gateway_conversation_id,
      "x-fromdonna-worker-url": workerPublicUrl(env),
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
): Promise<UserAgentRow> {
  if (row.runtime_provider !== "e2b") throw new Error(`Unsupported runtime provider: ${row.runtime_provider}`);

  let current = row;
  let lastError = "inject failed";
  // Cancel any in-flight post-turn pause for this user (new activity).
  const epoch = await bumpActivityEpoch(env, current.gateway, current.gateway_user_id);
  current = { ...current, activity_epoch: epoch };

  // Attempt 0: resume existing box. Attempt 1: replace runtime if gone/broken.
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const alive = await ensureSandboxRunning(env, current.runtime_id);
      if (!alive) {
        lastError = "E2B sandbox missing";
        current = await replaceRuntime(env, current);
        // fall through to inject on the new box
      } else {
        // Warm path: single health probe. If gateway is already live, skip
        // full /bootstrap (composio remint + proxy re-apply + MCP rediscover)
        // and skip blocking pre-inject checkpoint pull — those dominated
        // pre-typing latency (~2.5s + ~3.8s on baseline warm DM).
        // Cold / pause→resume: wait for harness, then bootstrap soft (no
        // requireComposio so chat still works if mint is slow).
        let health = await fetchHarnessHealth(env, current.runtime_id, current.runtime_domain);
        if (!shouldSkipBootstrap(health, { requireComposio: false })) {
          await waitForHarness(env, current.runtime_id, current.runtime_domain, 90);
          health = await fetchHarnessHealth(env, current.runtime_id, current.runtime_domain);
        }

        if (!shouldSkipBootstrap(health, { requireComposio: false })) {
          await bootstrapHarness(env, current, { requireComposio: false });
        }

        // Checkpoint: never block inject on warm path. On cold path, only pull
        // when a pack is actually staged (ready/packing); skip idle/failed so
        // dual harness+envd probes do not pad resume latency for no benefit.
        const stageProbe = shouldSkipPreInjectCheckpoint(health)
          ? { state: "idle" as const }
          : await probeCheckpointStage(env, current);
        if (!shouldSkipPreInjectCheckpoint(health, stageProbe.state)) {
          await pullCheckpointOnce(env, current);
        }
      }

      let response = await postTelegramUpdate(env, current, update);
      if (!response.ok) {
        const detail = await response.text().catch(() => "");
        lastError = `Sandbox telegram inject failed with HTTP ${response.status}${detail ? `: ${detail.slice(0, 300)}` : ""}`;
        // One soft retry on same box after re-bootstrap (stale gateway thread / lock).
        await bootstrapHarness(env, current, { requireComposio: false });
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

  // Early typing from the edge (real bot token). Fire-and-forget so users see
  // "typing…" during D1 route / E2B connect / inject. Best-effort only.
  if (shouldSendEarlyTyping(event)) {
    ctx.waitUntil(
      telegram(env, "sendChatAction", {
        chat_id: gatewayConversationId,
        action: "typing",
      }).catch((error) => {
        console.error(
          "early typing failed:",
          error instanceof Error ? error.message : error,
        );
      }),
    );
  }

  // Contextual presence ack (slot 1) — MUST land before Hermes final when possible.
  // Await with hard cap so inject is only slightly delayed; never waitUntil-only
  // (that raced finals ahead of slow LLM acks).
  let presenceAckPromise: Promise<void> | null = null;
  if (event.type === "message" && event.message.text?.trim()) {
    const userText = event.message.text.trim();
    presenceAckPromise = sendPresenceAck({
      env,
      userId,
      chatId: gatewayConversationId,
      currentUserText: userText,
    }).catch((error) => {
      console.error(
        "presence ack failed:",
        error instanceof Error ? error.message : error,
      );
    });
    // Bound wait: prefer sending ack before inject, but don't stall cold path forever.
    await Promise.race([
      presenceAckPromise,
      new Promise<void>((r) => setTimeout(r, 1400)),
    ]);
    // If we hit the cap early, still let ack finish in background.
    ctx.waitUntil(presenceAckPromise);
  } else if (event.type === "message" || event.type === "callback") {
    // Non-text turns still need a fresh process budget so stale max_process_lines
    // from a prior text turn does not block stages.
    // (callback_query handled via event.type from normalize — keep message branch.)
    ctx.waitUntil(
      resetPresenceTurn(env.FROMDONNA_ROUTING, userId).catch(() => {}),
    );
  }

  const typingStop = { done: false };
  if (shouldSendEarlyTyping(event)) {
    ctx.waitUntil(
      typingUntil(env, gatewayConversationId, typingStop).catch(() => {}),
    );
  }

  try {
    const resolved = await resolveReadyRow(env, gateway, gatewayUserId, gatewayConversationId);
    if (resolved === "provisioning") {
      typingStop.done = true;
      await telegram(env, "sendMessage", {
        chat_id: gatewayConversationId,
        text: "Setting up your private assistant — one moment, then send that again.",
      });
      return;
    }

    // Official path: sandbox Hermes Telegram runtime sends via Bot API proxy.
    // Worker does not render agent final text itself (only edge presence status).
    const live = await injectTelegramUpdate(env, resolved, update);
    typingStop.done = true;
    // Post-turn lifecycle in its own waitUntil: harvest staged checkpoint →
    // 1 min quiet (unless newer activity_epoch) → E2B pause.
    const epochAtSchedule = Number(live.activity_epoch ?? 0);
    ctx.waitUntil(runPostTurnLifecycle(env, live, epochAtSchedule));
  } catch (error) {
    typingStop.done = true;
    const detail = error instanceof Error ? error.message : "processTelegramUpdate failed";
    console.error("processTelegramUpdate", detail);
    try {
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

      // Presence process stages (msg 2–3): sandbox Hermes plugin → edge light LLM.
      if (request.method === "POST" && url.pathname === "/internal/presence/stage") {
        return await handlePresenceStage(request, env);
      }

      // Official Hermes TelegramAdapter Bot API reverse proxy (token never leaves Worker).
      // Capture final assistant text into presence ring for next-turn context.
      const proxied = await handleBotApiProxy({
        request,
        url,
        realBotToken: required(env, "TELEGRAM_BOT_TOKEN"),
        proxySecret: required(env, "WORKER_TO_HARNESS_SECRET"),
        onOutboundText: async (identity, text) => {
          if (!text.trim() || isPresenceStatusLine(text)) return;
          await appendPresenceSnippets(env.FROMDONNA_ROUTING, identity.userId, [
            { role: "assistant", text },
          ]);
          // Hermes final landed — block late process WIP under this turn.
          await markPresenceTurnFinal(env.FROMDONNA_ROUTING, identity.userId);
        },
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
