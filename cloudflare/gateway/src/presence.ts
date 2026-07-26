/**
 * Product-layer chat presence: contextual short WIP lines while Hermes works.
 *
 * - Slot 1: immediate contextual ack (rules + optional tiny LLM, hard deadline)
 * - Max pre-final status messages: 2 (final from Hermes is separate → max 3 total)
 * - Human intent only; no tool/MCP/skill IDs
 *
 * Tiny LLM uses product llm-proxy **chat/completions** (gateway mints capability).
 * Not Hermes agent loop; not /v1/responses (proxy only exposes chat/completions).
 */

export type PresenceRole = "user" | "assistant" | "status";

export type PresenceSnippet = {
  role: PresenceRole;
  text: string;
};

export type PresenceConfig = {
  enabled: boolean;
  contextMessages: number;
  ackDeadlineMs: number;
  tinyLlmAck: boolean;
  maxPreFinalStatus: number;
  fallbackPool: string[];
  model: string;
  llmProxyBaseUrl: string;
};

export const DEFAULT_PRESENCE_CONFIG: PresenceConfig = {
  enabled: true,
  contextMessages: 10,
  ackDeadlineMs: 400,
  tinyLlmAck: true,
  maxPreFinalStatus: 2,
  fallbackPool: ["On it.", "One sec.", "Got it."],
  model: "grok-4.5",
  llmProxyBaseUrl: "https://fromdonna-llm-proxy.code-df4.workers.dev",
};

/** System instruction for the tiny presence-ack model. */
export const PRESENCE_ACK_SYSTEM_PROMPT = `You write ONE short status line for Donna, a personal assistant on Telegram.

Rules:
- Output only the status line. No quotes, no markdown, no bullet points.
- Max 8 words. Trailing ellipsis (…) is OK.
- Human intent only: what she is doing for the user (e.g. Checking that email…).
- Never invent tools, APIs, skill names, MCP, Composio, system talk, or "how I know".
- Never ask a question. Never give the final answer. Never apologize at length.
- Match language/register of the latest user message when obvious (e.g. Hinglish → short Hinglish).
- If intent is unclear, reply exactly: On it.
- Prefer concrete WIP over generic when the thread makes intent clear.`;

export type PresenceAckResult = {
  text: string;
  source: "rules" | "tiny_llm" | "fallback";
};

/** Keyword / phrase rules over recent text → contextual WIP line. */
const INTENT_RULES: Array<{ re: RegExp; line: string }> = [
  { re: /\b(gmail|inbox|email|e-?mail|mail|invoice|receipt)\b/i, line: "Checking that email…" },
  { re: /\b(calendar|schedule|what.?s on|tomorrow|meeting|availab)/i, line: "Looking at your calendar…" },
  { re: /\b(drive|docs?|sheet|slides|file|folder)\b/i, line: "Looking through your files…" },
  { re: /\b(github|pr\b|pull request|repo|commit)\b/i, line: "Opening the repo…" },
  { re: /\b(linkedin)\b/i, line: "Checking LinkedIn…" },
  { re: /\b(dropbox)\b/i, line: "Checking Dropbox…" },
  { re: /\b(outlook|teams|onedrive|sharepoint|onenote)\b/i, line: "Checking Microsoft…" },
  { re: /\b(search|look up|find out|web|news|price)\b/i, line: "Looking that up…" },
  { re: /\b(connect|link|authorize|log ?in|oauth)\b/i, line: "Getting the connect link…" },
  { re: /\b(remind|todo|task|follow.?up)\b/i, line: "On that follow-up…" },
  { re: /\b(flight|hotel|travel|trip)\b/i, line: "Looking up the trip…" },
  { re: /\b(pay|money|transfer|split)\b/i, line: "Sorting the money bit…" },
  { re: /\b(summar|tldr|recap)\b/i, line: "Pulling a summary…" },
  { re: /\b(draft|write|reply|respond)\b/i, line: "Drafting that…" },
];

export function normalizeSnippetText(text: string, maxLen = 280): string {
  return text.replace(/\s+/g, " ").trim().slice(0, maxLen);
}

export function isPresenceStatusLine(text: string): boolean {
  const t = text.trim();
  if (!t) return false;
  // Trailing WIP ellipsis or known fallbacks / rule lines.
  if (/…$|\.\.\.$/.test(t) && t.length <= 80) return true;
  const lower = t.toLowerCase();
  if (["on it.", "one sec.", "got it.", "on it", "one sec", "got it"].includes(lower)) return true;
  return false;
}

export function pushPresenceRing(
  existing: PresenceSnippet[],
  next: PresenceSnippet,
  max = DEFAULT_PRESENCE_CONFIG.contextMessages,
): PresenceSnippet[] {
  const text = normalizeSnippetText(next.text);
  if (!text) return existing.slice(-max);
  const out = [...existing, { role: next.role, text }];
  return out.slice(-max);
}

export function parsePresenceRingJson(raw: string | null | undefined): PresenceSnippet[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    const out: PresenceSnippet[] = [];
    for (const item of parsed) {
      if (!item || typeof item !== "object") continue;
      const role = (item as { role?: unknown }).role;
      const text = (item as { text?: unknown }).text;
      if (role !== "user" && role !== "assistant" && role !== "status") continue;
      if (typeof text !== "string" || !text.trim()) continue;
      out.push({ role, text: normalizeSnippetText(text) });
    }
    return out;
  } catch {
    return [];
  }
}

export function ruleBasedPresenceAck(snippets: PresenceSnippet[], currentUserText: string): string | null {
  const blob = [...snippets.map((s) => s.text), currentUserText].join(" \n ");
  for (const rule of INTENT_RULES) {
    if (rule.re.test(blob) || rule.re.test(currentUserText)) return rule.line;
  }
  return null;
}

export function pickFallbackAck(pool: string[], seed: string): string {
  const list = pool.length > 0 ? pool : DEFAULT_PRESENCE_CONFIG.fallbackPool;
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  return list[h % list.length] ?? "On it.";
}

/** Build chat/completions messages for the tiny presence model. */
export function buildPresenceAckChatMessages(
  snippets: PresenceSnippet[],
  currentUserText: string,
  maxContext = DEFAULT_PRESENCE_CONFIG.contextMessages,
): Array<{ role: "system" | "user" | "assistant"; content: string }> {
  const recent = snippets
    .filter((s) => s.role !== "status")
    .slice(-maxContext);
  const lines: string[] = [];
  for (const s of recent) {
    const who = s.role === "user" ? "User" : "Donna";
    lines.push(`${who}: ${s.text}`);
  }
  lines.push(`User: ${normalizeSnippetText(currentUserText)}`);
  const userBlock =
    `Recent chat (oldest → newest):\n${lines.join("\n")}\n\n` +
    `Write the single WIP status line now.`;
  return [
    { role: "system", content: PRESENCE_ACK_SYSTEM_PROMPT },
    { role: "user", content: userBlock },
  ];
}

/**
 * OpenAI-compatible chat/completions body sent to fromdonna-llm-proxy.
 * (Product proxy does not expose /v1/responses; Hermes also uses chat_completions.)
 */
export function buildPresenceAckChatCompletionRequest(
  snippets: PresenceSnippet[],
  currentUserText: string,
  config: Pick<PresenceConfig, "model" | "contextMessages"> = DEFAULT_PRESENCE_CONFIG,
): {
  model: string;
  temperature: number;
  max_tokens: number;
  stream: false;
  messages: Array<{ role: "system" | "user" | "assistant"; content: string }>;
} {
  return {
    model: config.model,
    temperature: 0.4,
    max_tokens: 24,
    stream: false,
    messages: buildPresenceAckChatMessages(snippets, currentUserText, config.contextMessages),
  };
}

export function sanitizePresenceAckLine(raw: string): string | null {
  let t = raw.replace(/\s+/g, " ").trim();
  // Strip wrapping quotes.
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
    t = t.slice(1, -1).trim();
  }
  // First line only.
  t = t.split("\n")[0]?.trim() ?? "";
  if (!t) return null;
  // Reject tool/system leakage.
  if (/(composio|skill_view|\bmcp\b|tool_call|function_call|gpt-|grok-)/i.test(t)) return null;
  // Cap length.
  const words = t.split(/\s+/);
  if (words.length > 12) t = words.slice(0, 8).join(" ");
  if (t.length > 80) t = t.slice(0, 77).trimEnd() + "…";
  return t || null;
}

export function extractChatCompletionText(body: unknown): string | null {
  if (!body || typeof body !== "object") return null;
  const choices = (body as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || !choices[0]) return null;
  const msg = (choices[0] as { message?: { content?: unknown } }).message;
  const content = msg?.content;
  if (typeof content === "string") return content;
  return null;
}

export async function raceWithDeadline<T>(
  promise: Promise<T>,
  deadlineMs: number,
): Promise<{ ok: true; value: T } | { ok: false }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([
      promise.then((value) => ({ tag: "value" as const, value })),
      new Promise<{ tag: "timeout" }>((resolve) => {
        timer = setTimeout(() => resolve({ tag: "timeout" }), deadlineMs);
      }),
    ]);
    if (result.tag === "timeout") return { ok: false };
    return { ok: true, value: result.value };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Resolve ack text: rules first (instant), race tiny LLM against deadline,
 * fallback pool if both fail.
 */
export async function resolvePresenceAck(args: {
  snippets: PresenceSnippet[];
  currentUserText: string;
  seed: string;
  config?: Partial<PresenceConfig>;
  /** Optional: call product llm-proxy with capability. */
  callTinyLlm?: (requestBody: ReturnType<typeof buildPresenceAckChatCompletionRequest>) => Promise<string | null>;
}): Promise<PresenceAckResult> {
  const config: PresenceConfig = { ...DEFAULT_PRESENCE_CONFIG, ...args.config };
  const rule = ruleBasedPresenceAck(args.snippets, args.currentUserText);

  if (config.tinyLlmAck && args.callTinyLlm) {
    const body = buildPresenceAckChatCompletionRequest(args.snippets, args.currentUserText, config);
    const raced = await raceWithDeadline(args.callTinyLlm(body), config.ackDeadlineMs);
    if (raced.ok) {
      const cleaned = raced.value ? sanitizePresenceAckLine(raced.value) : null;
      if (cleaned) return { text: cleaned, source: "tiny_llm" };
    }
  }

  if (rule) return { text: rule, source: "rules" };
  return {
    text: pickFallbackAck(config.fallbackPool, args.seed),
    source: "fallback",
  };
}

/** Parallel: start tiny LLM immediately but prefer rules if LLM loses the race. */
export async function resolvePresenceAckPreferFast(args: {
  snippets: PresenceSnippet[];
  currentUserText: string;
  seed: string;
  config?: Partial<PresenceConfig>;
  callTinyLlm?: (requestBody: ReturnType<typeof buildPresenceAckChatCompletionRequest>) => Promise<string | null>;
}): Promise<PresenceAckResult> {
  const config: PresenceConfig = { ...DEFAULT_PRESENCE_CONFIG, ...args.config };
  const rule = ruleBasedPresenceAck(args.snippets, args.currentUserText);

  // Fire tiny LLM in parallel when enabled; still return by deadline.
  if (config.tinyLlmAck && args.callTinyLlm) {
    const body = buildPresenceAckChatCompletionRequest(args.snippets, args.currentUserText, config);
    const llmPromise = args.callTinyLlm(body).catch(() => null);
    const raced = await raceWithDeadline(llmPromise, config.ackDeadlineMs);
    if (raced.ok) {
      const cleaned = raced.value ? sanitizePresenceAckLine(raced.value) : null;
      // Prefer LLM when it beats deadline; else rules/fallback.
      if (cleaned) return { text: cleaned, source: "tiny_llm" };
    }
  }

  if (rule) return { text: rule, source: "rules" };
  return {
    text: pickFallbackAck(config.fallbackPool, args.seed),
    source: "fallback",
  };
}

// ── D1 ring buffer ──────────────────────────────────────────────────────────

export async function loadPresenceRing(db: D1Database, userId: string): Promise<PresenceSnippet[]> {
  try {
    const row = await db
      .prepare(`SELECT messages_json FROM user_presence_ring WHERE user_id = ?1`)
      .bind(userId)
      .first<{ messages_json: string }>();
    return parsePresenceRingJson(row?.messages_json);
  } catch {
    // Table may not exist until migration is applied.
    return [];
  }
}

export async function savePresenceRing(
  db: D1Database,
  userId: string,
  snippets: PresenceSnippet[],
  max = DEFAULT_PRESENCE_CONFIG.contextMessages,
): Promise<void> {
  const trimmed = snippets.slice(-max);
  const json = JSON.stringify(trimmed);
  try {
    await db
      .prepare(
        `INSERT INTO user_presence_ring (user_id, messages_json, updated_at)
         VALUES (?1, ?2, CURRENT_TIMESTAMP)
         ON CONFLICT(user_id) DO UPDATE SET
           messages_json = excluded.messages_json,
           updated_at = CURRENT_TIMESTAMP`,
      )
      .bind(userId, json)
      .run();
  } catch (error) {
    console.error(
      "presence ring save failed:",
      error instanceof Error ? error.message : error,
    );
  }
}

export async function appendPresenceSnippets(
  db: D1Database,
  userId: string,
  additions: PresenceSnippet[],
  max = DEFAULT_PRESENCE_CONFIG.contextMessages,
): Promise<PresenceSnippet[]> {
  let ring = await loadPresenceRing(db, userId);
  for (const a of additions) {
    ring = pushPresenceRing(ring, a, max);
  }
  await savePresenceRing(db, userId, ring, max);
  return ring;
}

export async function callPresenceTinyLlm(args: {
  llmProxyBaseUrl: string;
  capabilityToken: string;
  body: ReturnType<typeof buildPresenceAckChatCompletionRequest>;
}): Promise<string | null> {
  const base = args.llmProxyBaseUrl.replace(/\/$/, "");
  const url = `${base}/v1/chat/completions`;
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${args.capabilityToken}`,
    },
    body: JSON.stringify(args.body),
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    console.error(`presence tiny llm HTTP ${response.status}: ${detail.slice(0, 200)}`);
    return null;
  }
  const json = (await response.json()) as unknown;
  return extractChatCompletionText(json);
}
