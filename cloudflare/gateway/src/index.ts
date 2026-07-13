export interface Env {
  FROMDONNA_ROUTING: D1Database;
  TELEGRAM_BOT_TOKEN: string;
  TELEGRAM_WEBHOOK_SECRET: string;
  E2B_API_KEY: string;
  WORKER_TO_HARNESS_SECRET: string;
  E2B_TEMPLATE: string;
  HARNESS_PORT: string;
}

type TelegramUpdate = {
  update_id: number;
  message?: {
    message_id: number;
    chat: { id: number | string };
    from?: { id: number | string };
    text?: string;
  };
};

type SandboxRow = {
  telegram_user_id: string;
  telegram_chat_id: string;
  user_id: string;
  e2b_sandbox_id: string;
  e2b_sandbox_domain: string | null;
  status: "provisioning" | "ready" | "failed";
};

type E2bSandbox = { sandboxID: string; domain?: string };
type HarnessReply = { text?: string };

const json = (body: unknown, status = 200) => Response.json(body, { status });

function internalUserId(telegramUserId: string): string {
  return `telegram:${telegramUserId}`;
}

function required(env: Env, key: keyof Env): string {
  const value = env[key];
  if (typeof value !== "string" || !value) throw new Error(`Worker secret/config ${key} is missing.`);
  return value;
}

async function telegram(env: Env, method: string, body: Record<string, unknown>): Promise<void> {
  const response = await fetch(`https://api.telegram.org/bot${required(env, "TELEGRAM_BOT_TOKEN")}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`Telegram ${method} failed with HTTP ${response.status}.`);
}

async function createSandbox(env: Env, telegramUserId: string): Promise<E2bSandbox> {
  const response = await fetch("https://api.e2b.app/sandboxes", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "X-API-KEY": required(env, "E2B_API_KEY"),
    },
    body: JSON.stringify({
      templateID: required(env, "E2B_TEMPLATE"),
      autoPause: true,
      timeout: 3600,
      secure: true,
      allow_internet_access: true,
      metadata: { fromdonna_user_id: internalUserId(telegramUserId) },
    }),
  });
  if (!response.ok) throw new Error(`E2B sandbox create failed with HTTP ${response.status}.`);
  const payload = await response.json<E2bSandbox>();
  if (!payload.sandboxID || !payload.domain) throw new Error("E2B did not return a sandbox ID and domain.");
  return payload;
}

async function lookup(env: Env, telegramUserId: string): Promise<SandboxRow | null> {
  return env.FROMDONNA_ROUTING
    .prepare(`SELECT telegram_user_id, telegram_chat_id, user_id, e2b_sandbox_id, e2b_sandbox_domain, status
              FROM telegram_user_sandboxes WHERE telegram_user_id = ?1`)
    .bind(telegramUserId)
    .first<SandboxRow>();
}

/** Claim first-message provisioning atomically. Only the request that inserted the row may create E2B. */
async function claimProvisioning(env: Env, telegramUserId: string, chatId: string): Promise<boolean> {
  const placeholder = `provisioning:${crypto.randomUUID()}`;
  const result = await env.FROMDONNA_ROUTING
    .prepare(`INSERT INTO telegram_user_sandboxes
      (telegram_user_id, telegram_chat_id, user_id, e2b_sandbox_id, status, provisioning_started_at)
      VALUES (?1, ?2, ?3, ?4, 'provisioning', CURRENT_TIMESTAMP)
      ON CONFLICT(telegram_user_id) DO NOTHING`)
    .bind(telegramUserId, chatId, internalUserId(telegramUserId), placeholder)
    .run();
  return result.meta.changes === 1;
}

async function provision(env: Env, telegramUserId: string): Promise<SandboxRow> {
  const sandbox = await createSandbox(env, telegramUserId);
  await env.FROMDONNA_ROUTING
    .prepare(`UPDATE telegram_user_sandboxes
              SET e2b_sandbox_id = ?2, e2b_sandbox_domain = ?3, status = 'ready', updated_at = CURRENT_TIMESTAMP
              WHERE telegram_user_id = ?1 AND status = 'provisioning'`)
    .bind(telegramUserId, sandbox.sandboxID, sandbox.domain)
    .run();
  const row = await lookup(env, telegramUserId);
  if (!row || row.status !== "ready") throw new Error("Sandbox was created but routing row was not finalized.");
  return row;
}

async function sendTurn(env: Env, row: SandboxRow, update: TelegramUpdate): Promise<HarnessReply> {
  if (!row.e2b_sandbox_domain) throw new Error("Ready routing row has no sandbox domain.");
  // Mirrors E2B Sandbox.getHost(port): `${port}-${sandboxId}.${sandboxDomain}`.
  const url = `https://${required(env, "HARNESS_PORT")}-${row.e2b_sandbox_id}.${row.e2b_sandbox_domain}/turn`;
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${required(env, "WORKER_TO_HARNESS_SECRET")}`,
    },
    body: JSON.stringify({
      userId: row.user_id,
      gateway: "telegram",
      gatewayChatId: String(update.message?.chat.id ?? ""),
      gatewayMessageId: String(update.message?.message_id ?? ""),
      text: update.message?.text ?? "",
    }),
  });
  if (!response.ok) throw new Error(`Sandbox harness failed with HTTP ${response.status}.`);
  return response.json<HarnessReply>();
}

async function handleTelegram(request: Request, env: Env): Promise<Response> {
  if (request.headers.get("X-Telegram-Bot-Api-Secret-Token") !== required(env, "TELEGRAM_WEBHOOK_SECRET")) {
    return new Response("Unauthorized", { status: 401 });
  }

  const update = await request.json<TelegramUpdate>();
  const message = update.message;
  if (!message?.from || !message.text?.trim()) return json({ ok: true, ignored: true });

  const telegramUserId = String(message.from.id);
  const chatId = String(message.chat.id);
  let row = await lookup(env, telegramUserId);

  if (!row) {
    const claimed = await claimProvisioning(env, telegramUserId, chatId);
    if (claimed) {
      try {
        row = await provision(env, telegramUserId);
      } catch (error) {
        await env.FROMDONNA_ROUTING
          .prepare(`UPDATE telegram_user_sandboxes SET status = 'failed', updated_at = CURRENT_TIMESTAMP WHERE telegram_user_id = ?1`)
          .bind(telegramUserId)
          .run();
        throw error;
      }
    } else {
      row = await lookup(env, telegramUserId);
    }
  }

  if (!row || row.status === "provisioning") {
    await telegram(env, "sendMessage", { chat_id: chatId, text: "Setting up your private assistant — send that again in a moment." });
    return json({ ok: true, provisioning: true });
  }
  if (row.status !== "ready") throw new Error("Sandbox provisioning failed; retrying requires an operator recovery path.");

  const reply = await sendTurn(env, row, update);
  if (reply.text?.trim()) await telegram(env, "sendMessage", { chat_id: chatId, text: reply.text });
  return json({ ok: true });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    try {
      if (request.method === "GET" && url.pathname === "/health") return json({ ok: true, service: "fromdonna-telegram-gateway" });
      if (request.method === "POST" && url.pathname === "/telegram/webhook") return await handleTelegram(request, env);
      return new Response("Not found", { status: 404 });
    } catch (error) {
      console.error(error instanceof Error ? error.message : "Unhandled gateway error");
      return json({ ok: false, error: "gateway_request_failed" }, 500);
    }
  },
} satisfies ExportedHandler<Env>;
