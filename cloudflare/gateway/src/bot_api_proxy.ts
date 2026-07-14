/**
 * Telegram Bot API reverse proxy for in-sandbox official Hermes TelegramAdapter.
 *
 * Sandbox uses python-telegram-bot with:
 *   base_url      = https://<worker>/telegram-bot-api/bot
 *   base_file_url = https://<worker>/telegram-bot-api/file/bot
 *   token         = FromDonna proxy token (NOT the real bot token)
 *
 * Worker validates the proxy token, scopes chat_id to that user, and forwards
 * to api.telegram.org with the real TELEGRAM_BOT_TOKEN.
 */

export type ProxyIdentity = {
  userId: string;
  gatewayUserId: string;
  gatewayConversationId: string;
};

const encoder = new TextEncoder();

function encodeBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function decodeBase64Url(text: string): Uint8Array {
  const padded = text.replaceAll("-", "+").replaceAll("_", "/") + "===".slice((text.length + 3) % 4);
  const binary = atob(padded);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

/** Deterministic per-user proxy token: fd1.<b64url(userId)>.<b64url(chatId)>.<b64url(hmac16)>. */
export async function mintBotProxyToken(
  secret: string,
  userId: string,
  gatewayConversationId: string,
): Promise<string> {
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
  ]);
  const material = `bot-proxy:v2:${userId}:${gatewayConversationId}`;
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(material)));
  return [
    "fd1",
    encodeBase64Url(encoder.encode(userId)),
    encodeBase64Url(encoder.encode(gatewayConversationId)),
    encodeBase64Url(sig.slice(0, 16)),
  ].join(".");
}

export async function verifyBotProxyToken(secret: string, token: string): Promise<ProxyIdentity | null> {
  const parts = token.split(".");
  if (parts.length !== 4 || parts[0] !== "fd1") return null;
  const userId = new TextDecoder().decode(decodeBase64Url(parts[1]));
  const gatewayConversationId = new TextDecoder().decode(decodeBase64Url(parts[2]));
  const expected = await mintBotProxyToken(secret, userId, gatewayConversationId);
  if (expected.length !== token.length) return null;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ token.charCodeAt(i);
  if (diff !== 0) return null;
  const gatewayUserId = userId.includes(":") ? userId.split(":").slice(1).join(":") : userId;
  return { userId, gatewayUserId, gatewayConversationId };
}

const NOOP_OK = () => Response.json({ ok: true, result: true });
const EMPTY_UPDATES = () => Response.json({ ok: true, result: [] });

/** Methods that must not be callable by sandboxes (webhook ownership stays on Worker). */
const BLOCKED_METHODS = new Set([
  "setwebhook",
  "deletewebhook",
  "getwebhookinfo",
  "getupdates",
  "logout",
  "close",
]);

/** Methods that include a chat_id we force-bind to the routed user. */
const CHAT_SCOPED_METHODS = new Set([
  "sendmessage",
  "sendphoto",
  "senddocument",
  "sendaudio",
  "sendvideo",
  "sendvoice",
  "sendanimation",
  "sendsticker",
  "sendvideonote",
  "sendmediagroup",
  "sendlocation",
  "sendvenue",
  "sendcontact",
  "sendpoll",
  "senddice",
  "sendchataction",
  "editmessagetext",
  "editmessagecaption",
  "editmessagemedia",
  "editmessagereplymarkup",
  "deletemessage",
  "pinchatmessage",
  "unpinchatmessage",
  "forwardmessage",
  "copymessage",
]);

function methodName(pathname: string, prefix: string): { token: string; method: string } | null {
  // /telegram-bot-api/bot{token}/{method}
  if (!pathname.startsWith(prefix)) return null;
  const rest = pathname.slice(prefix.length);
  const slash = rest.indexOf("/");
  if (slash <= 0) return null;
  const token = rest.slice(0, slash);
  const method = rest.slice(slash + 1);
  if (!token || !method) return null;
  return { token, method };
}

function filePath(pathname: string, prefix: string): { token: string; filePath: string } | null {
  // /telegram-bot-api/file/bot{token}/{file_path}
  if (!pathname.startsWith(prefix)) return null;
  const rest = pathname.slice(prefix.length);
  const slash = rest.indexOf("/");
  if (slash <= 0) return null;
  return { token: rest.slice(0, slash), filePath: rest.slice(slash + 1) };
}

async function readBodyAsTelegramPayload(request: Request): Promise<{
  kind: "json" | "form" | "empty";
  json?: Record<string, unknown>;
  form?: FormData;
}> {
  if (request.method === "GET" || request.method === "HEAD") return { kind: "empty" };
  const contentType = request.headers.get("content-type") || "";
  if (contentType.includes("application/json")) {
    const json = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    return { kind: "json", json };
  }
  if (contentType.includes("multipart/form-data") || contentType.includes("application/x-www-form-urlencoded")) {
    const form = await request.formData();
    return { kind: "form", form };
  }
  // PTB sometimes POSTs empty body with query params
  return { kind: "empty" };
}

function formGet(form: FormData, key: string): string | null {
  const value = form.get(key);
  return typeof value === "string" ? value : null;
}

function enforceChatScope(
  method: string,
  identity: ProxyIdentity,
  payload: { kind: "json" | "form" | "empty"; json?: Record<string, unknown>; form?: FormData },
): Response | null {
  if (!CHAT_SCOPED_METHODS.has(method.toLowerCase())) return null;
  const bound = identity.gatewayConversationId;
  if (payload.kind === "json" && payload.json) {
    const chatId = payload.json.chat_id;
    if (chatId !== undefined && String(chatId) !== String(bound)) {
      return Response.json(
        { ok: false, error_code: 403, description: "chat_id is not bound to this sandbox user" },
        { status: 403 },
      );
    }
    payload.json.chat_id = bound;
  } else if (payload.kind === "form" && payload.form) {
    const chatId = formGet(payload.form, "chat_id");
    if (chatId !== null && String(chatId) !== String(bound)) {
      return Response.json(
        { ok: false, error_code: 403, description: "chat_id is not bound to this sandbox user" },
        { status: 403 },
      );
    }
    payload.form.set("chat_id", bound);
  }
  return null;
}

export async function handleBotApiProxy(args: {
  request: Request;
  url: URL;
  realBotToken: string;
  proxySecret: string;
}): Promise<Response | null> {
  const { request, url, realBotToken, proxySecret } = args;

  // File downloads: /telegram-bot-api/file/bot{token}/{path}
  const file = filePath(url.pathname, "/telegram-bot-api/file/bot");
  if (file) {
    const identity = await verifyBotProxyToken(proxySecret, file.token);
    if (!identity) return Response.json({ ok: false, error_code: 401, description: "Unauthorized" }, { status: 401 });
    const upstream = await fetch(`https://api.telegram.org/file/bot${realBotToken}/${file.filePath}`, {
      method: "GET",
    });
    return new Response(upstream.body, {
      status: upstream.status,
      headers: {
        "content-type": upstream.headers.get("content-type") || "application/octet-stream",
        "cache-control": "private, max-age=60",
      },
    });
  }

  const parsed = methodName(url.pathname, "/telegram-bot-api/bot");
  if (!parsed) return null;

  const identity = await verifyBotProxyToken(proxySecret, parsed.token);
  if (!identity) return Response.json({ ok: false, error_code: 401, description: "Unauthorized" }, { status: 401 });

  const method = parsed.method.split("?")[0] || parsed.method;
  const lower = method.toLowerCase();

  // Polling / webhook ownership: never let sandboxes touch the real wire control plane.
  if (lower === "getupdates") return EMPTY_UPDATES();
  if (lower === "setwebhook" || lower === "deletewebhook") return NOOP_OK();
  if (lower === "getwebhookinfo") {
    return Response.json({
      ok: true,
      result: { url: "", has_custom_certificate: false, pending_update_count: 0 },
    });
  }
  if (BLOCKED_METHODS.has(lower) && lower !== "getupdates") {
    return Response.json({ ok: false, error_code: 403, description: `Method ${method} is owned by the edge gateway` }, { status: 403 });
  }

  const payload = await readBodyAsTelegramPayload(request);
  // Merge query params for methods PTB issues as GET/query.
  if (url.searchParams.size > 0) {
    if (payload.kind === "empty") {
      const json: Record<string, unknown> = {};
      url.searchParams.forEach((v, k) => {
        json[k] = v;
      });
      payload.kind = "json";
      payload.json = json;
    } else if (payload.kind === "json" && payload.json) {
      url.searchParams.forEach((v, k) => {
        if (payload.json![k] === undefined) payload.json![k] = v;
      });
    }
  }

  const denied = enforceChatScope(method, identity, payload);
  if (denied) return denied;

  const upstreamUrl = `https://api.telegram.org/bot${realBotToken}/${method}${url.search}`;
  let upstream: Response;
  if (payload.kind === "form" && payload.form) {
    upstream = await fetch(upstreamUrl, { method: "POST", body: payload.form });
  } else if (payload.kind === "json" && payload.json) {
    upstream = await fetch(upstreamUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload.json),
    });
  } else {
    upstream = await fetch(upstreamUrl, { method: request.method === "GET" ? "GET" : "POST" });
  }

  const body = await upstream.arrayBuffer();
  return new Response(body, {
    status: upstream.status,
    headers: { "content-type": upstream.headers.get("content-type") || "application/json" },
  });
}
