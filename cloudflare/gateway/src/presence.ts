/**
 * Product-layer chat presence while Hermes works (Hermes mid-turn chat OFF).
 *
 * Message budget per user turn (max 4 including Hermes final):
 *   1. Ack — light LLM + chat context (gateway edge)
 *   2–3. Process — light LLM + chat context + sanitized runtime stage
 *   4. Final — Hermes full agent only
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
  processDeadlineMs: number;
  tinyLlmAck: boolean;
  /** Max process lines (msg 2–3) after ack. */
  maxProcessLines: number;
  /** Min ms between process lines. */
  processMinIntervalMs: number;
  fallbackPool: string[];
  model: string;
  llmProxyBaseUrl: string;
};

export const DEFAULT_PRESENCE_CONFIG: PresenceConfig = {
  enabled: true,
  contextMessages: 10,
  ackDeadlineMs: 400,
  processDeadlineMs: 500,
  tinyLlmAck: true,
  maxProcessLines: 2,
  processMinIntervalMs: 2500,
  fallbackPool: ["On it.", "One sec.", "Got it."],
  model: "grok-4.5",
  llmProxyBaseUrl: "https://fromdonna-llm-proxy.code-df4.workers.dev",
};

/** System instruction for the tiny presence-ack model (msg 1). */
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

/** System instruction for process WIP lines (msg 2–3). */
export const PRESENCE_PROCESS_SYSTEM_PROMPT = `You write ONE short mid-work status line for Donna on Telegram.

Rules:
- Output only the status line. No quotes, no markdown.
- Max 8 words. Trailing ellipsis (…) is OK.
- Use the runtime stage + recent chat to say what she is doing NOW in human words.
- Human intent only. Never name tools, APIs, MCP, Composio, skill ids, or system internals.
- Never ask a question. Never give the final answer.
- Do not repeat the previous status line if one is shown.
- If stage is unclear, say: Still on it…`;

export type PresenceAckResult = {
  text: string;
  source: "rules" | "tiny_llm" | "fallback";
};

export type PresenceProcessResult = {
  text: string;
  source: "rules" | "tiny_llm" | "fallback";
  stage: string;
};

/** Tool name / stage id → human fallback line (also used when tiny LLM is slow). */
export const STAGE_RULES: Array<{ re: RegExp; stage: string; line: string }> = [
  { re: /gmail|mail|inbox|email/i, stage: "checking_email", line: "Checking that email…" },
  { re: /calendar|schedule|meeting/i, stage: "checking_calendar", line: "Looking at your calendar…" },
  { re: /drive|docs?|sheet|slides|file|folder|onedrive|dropbox/i, stage: "checking_files", line: "Looking through your files…" },
  { re: /github|pull_request|repo|commit/i, stage: "checking_github", line: "Opening the repo…" },
  { re: /linkedin/i, stage: "checking_linkedin", line: "Checking LinkedIn…" },
  { re: /outlook|teams|sharepoint|onenote|excel/i, stage: "checking_microsoft", line: "Checking Microsoft…" },
  { re: /web_search|web_browse|search|exa|browser/i, stage: "looking_up", line: "Looking that up…" },
  { re: /connect|composio|manage.connection|oauth/i, stage: "connecting_app", line: "Getting the connect link…" },
  { re: /skill_view|skill_manage|skills_list/i, stage: "loading_skill", line: "Pulling the right playbook…" },
  { re: /terminal|bash|shell|execute/i, stage: "running_command", line: "Running that…" },
  { re: /read_file|write_file|patch|search_files/i, stage: "working_files", line: "Working through the files…" },
  { re: /memory/i, stage: "memory", line: "Still on it…" },
  { re: /mcp|tool/i, stage: "using_tools", line: "Working on it…" },
];

export function stageFromToolName(toolName: string): { stage: string; line: string } {
  const name = toolName || "tool";
  for (const rule of STAGE_RULES) {
    if (rule.re.test(name)) return { stage: rule.stage, line: rule.line };
  }
  return { stage: "working", line: "Still on it…" };
}

export function sanitizeStageId(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 48) || "working";
}

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

/** Known product WIP lines (do not treat arbitrary short “All set…” finals as status). */
export function isPresenceStatusLine(text: string): boolean {
  const t = text.trim();
  if (!t) return false;
  // Thinking-dots frames (FromDonna UX) must never land in the assistant ring.
  if (/^\.{1,3}$/.test(t)) return true;
  const lower = t.toLowerCase();
  if (["on it.", "one sec.", "got it.", "on it", "one sec", "got it", "still on it…", "still on it..."].includes(lower)) {
    return true;
  }
  for (const rule of STAGE_RULES) {
    if (rule.line.toLowerCase() === lower) return true;
  }
  for (const rule of INTENT_RULES) {
    if (rule.line.toLowerCase() === lower) return true;
  }
  return false;
}

export function isGenericPresenceLine(text: string): boolean {
  const lower = text.trim().toLowerCase();
  return ["on it.", "one sec.", "got it.", "on it", "one sec", "got it", "still on it…", "still on it...", "working on it…", "working on it..."].includes(
    lower,
  );
}

export function samePresenceText(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
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
      if (cleaned) {
        // Prefer concrete rules over a generic LLM line when rules already know intent.
        if (rule && isGenericPresenceLine(cleaned) && !isGenericPresenceLine(rule)) {
          return { text: rule, source: "rules" };
        }
        return { text: cleaned, source: "tiny_llm" };
      }
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
  // Compare-and-swap on messages_json so concurrent ack/process/final don't clobber.
  for (let attempt = 0; attempt < 6; attempt++) {
    let priorJson = "[]";
    try {
      const row = await db
        .prepare(`SELECT messages_json FROM user_presence_ring WHERE user_id = ?1`)
        .bind(userId)
        .first<{ messages_json: string }>();
      if (row?.messages_json) priorJson = row.messages_json;
    } catch {
      // table may not exist
    }
    let ring = parsePresenceRingJson(priorJson);
    for (const a of additions) {
      ring = pushPresenceRing(ring, a, max);
    }
    const nextJson = JSON.stringify(ring.slice(-max));
    try {
      if (priorJson === "[]") {
        // Insert-or-update: only win insert when missing; else CAS update.
        const inserted = await db
          .prepare(
            `INSERT INTO user_presence_ring (user_id, messages_json, updated_at)
             VALUES (?1, ?2, CURRENT_TIMESTAMP)
             ON CONFLICT(user_id) DO NOTHING`,
          )
          .bind(userId, nextJson)
          .run();
        const changes = Number((inserted as { meta?: { changes?: number } })?.meta?.changes ?? 0);
        if (changes > 0) return ring;
        // Row existed — fall through to CAS update with re-read next loop.
        const cas = await db
          .prepare(
            `UPDATE user_presence_ring
             SET messages_json = ?2, updated_at = CURRENT_TIMESTAMP
             WHERE user_id = ?1 AND messages_json = ?3`,
          )
          .bind(userId, nextJson, priorJson)
          .run();
        const casChanges = Number((cas as { meta?: { changes?: number } })?.meta?.changes ?? 0);
        if (casChanges > 0) return ring;
      } else {
        const cas = await db
          .prepare(
            `UPDATE user_presence_ring
             SET messages_json = ?2, updated_at = CURRENT_TIMESTAMP
             WHERE user_id = ?1 AND messages_json = ?3`,
          )
          .bind(userId, nextJson, priorJson)
          .run();
        const casChanges = Number((cas as { meta?: { changes?: number } })?.meta?.changes ?? 0);
        if (casChanges > 0) return ring;
      }
    } catch (error) {
      console.error(
        "presence ring append failed:",
        error instanceof Error ? error.message : error,
      );
      return ring;
    }
  }
  // Last resort write (still better than dropping).
  let ring = await loadPresenceRing(db, userId);
  for (const a of additions) ring = pushPresenceRing(ring, a, max);
  await savePresenceRing(db, userId, ring, max);
  return ring;
}

export function buildPresenceProcessChatMessages(
  snippets: PresenceSnippet[],
  stage: string,
  stageHint: string,
  maxContext = DEFAULT_PRESENCE_CONFIG.contextMessages,
): Array<{ role: "system" | "user" | "assistant"; content: string }> {
  const recent = snippets.filter((s) => s.role !== "status").slice(-maxContext);
  const lines: string[] = [];
  for (const s of recent) {
    lines.push(`${s.role === "user" ? "User" : "Donna"}: ${s.text}`);
  }
  const lastStatus = [...snippets].reverse().find((s) => s.role === "status");
  const userBlock =
    `Recent chat (oldest → newest):\n${lines.join("\n") || "(empty)"}\n\n` +
    `Runtime stage: ${stage}\n` +
    `Stage hint: ${stageHint}\n` +
    (lastStatus ? `Previous status line: ${lastStatus.text}\n` : "") +
    `\nWrite the single WIP status line now (must differ from previous status if possible).`;
  return [
    { role: "system", content: PRESENCE_PROCESS_SYSTEM_PROMPT },
    { role: "user", content: userBlock },
  ];
}

export function buildPresenceProcessChatCompletionRequest(
  snippets: PresenceSnippet[],
  stage: string,
  stageHint: string,
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
    messages: buildPresenceProcessChatMessages(snippets, stage, stageHint, config.contextMessages),
  };
}

export async function resolvePresenceProcessLine(args: {
  snippets: PresenceSnippet[];
  toolName?: string;
  stage?: string;
  seed: string;
  config?: Partial<PresenceConfig>;
  callTinyLlm?: (
    requestBody: ReturnType<typeof buildPresenceProcessChatCompletionRequest>,
  ) => Promise<string | null>;
}): Promise<PresenceProcessResult | { skipped: true; reason: string; stage: string }> {
  const config: PresenceConfig = { ...DEFAULT_PRESENCE_CONFIG, ...args.config };
  const mapped = stageFromToolName(args.toolName || args.stage || "working");
  const stage = sanitizeStageId(args.stage || mapped.stage);
  const stageHint = mapped.line;
  const lastStatus = [...args.snippets].reverse().find((s) => s.role === "status");

  if (config.tinyLlmAck && args.callTinyLlm) {
    const body = buildPresenceProcessChatCompletionRequest(args.snippets, stage, stageHint, config);
    const raced = await raceWithDeadline(args.callTinyLlm(body), config.processDeadlineMs);
    if (raced.ok) {
      const cleaned = raced.value ? sanitizePresenceAckLine(raced.value) : null;
      if (cleaned && (!lastStatus || !samePresenceText(lastStatus.text, cleaned))) {
        return { text: cleaned, source: "tiny_llm", stage };
      }
    }
  }

  // Rules path must also avoid duplicate of ack / prior status.
  if (!lastStatus || !samePresenceText(lastStatus.text, stageHint)) {
    return { text: stageHint, source: "rules", stage };
  }
  const alt = "Still on it…";
  if (!samePresenceText(lastStatus.text, alt)) {
    return { text: alt, source: "fallback", stage };
  }
  return { skipped: true, reason: "duplicate_status", stage };
}

export async function callPresenceTinyLlm(args: {
  llmProxyBaseUrl: string;
  capabilityToken: string;
  body:
    | ReturnType<typeof buildPresenceAckChatCompletionRequest>
    | ReturnType<typeof buildPresenceProcessChatCompletionRequest>;
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

// ── Turn budget (D1) ────────────────────────────────────────────────────────
// pre_final_count is reused as turn_epoch (bumped on each ack / turn open).

export type PresenceTurnState = {
  process_count: number;
  /** Turn epoch (bumped on reset). Stages claim against this so late ack reset can't steal budget. */
  pre_final_count: number;
  last_stage: string | null;
  last_line_at_ms: number;
};

/**
 * Open a new presence turn (msg 1 / new user text).
 * - process_count = 0
 * - last_line_at_ms = 0  (min_interval is BETWEEN process lines only — never after ack)
 * - last_stage = null
 * - pre_final_count (epoch) += 1
 */
export async function resetPresenceTurn(db: D1Database, userId: string): Promise<PresenceTurnState> {
  try {
    await db
      .prepare(
        `INSERT INTO user_presence_turn (user_id, process_count, pre_final_count, last_stage, last_line_at_ms, updated_at)
         VALUES (?1, 0, 1, NULL, 0, CURRENT_TIMESTAMP)
         ON CONFLICT(user_id) DO UPDATE SET
           process_count = 0,
           pre_final_count = user_presence_turn.pre_final_count + 1,
           last_stage = NULL,
           last_line_at_ms = 0,
           updated_at = CURRENT_TIMESTAMP`,
      )
      .bind(userId)
      .run();
  } catch (error) {
    console.error("presence turn reset failed:", error instanceof Error ? error.message : error);
  }
  return loadPresenceTurn(db, userId);
}

export async function loadPresenceTurn(db: D1Database, userId: string): Promise<PresenceTurnState> {
  try {
    const row = await db
      .prepare(
        `SELECT process_count, pre_final_count, last_stage, last_line_at_ms
         FROM user_presence_turn WHERE user_id = ?1`,
      )
      .bind(userId)
      .first<PresenceTurnState>();
    if (row) {
      return {
        process_count: Number(row.process_count) || 0,
        pre_final_count: Number(row.pre_final_count) || 0,
        last_stage: row.last_stage ?? null,
        last_line_at_ms: Number(row.last_line_at_ms) || 0,
      };
    }
  } catch {
    // table missing
  }
  return { process_count: 0, pre_final_count: 0, last_stage: null, last_line_at_ms: 0 };
}

/**
 * Atomically reserve a process-line slot for this turn epoch + stage.
 * Returns ok:false if budget/interval/same_stage/epoch mismatch (TOCTOU-safe).
 */
export async function claimPresenceProcessSlot(
  db: D1Database,
  userId: string,
  stage: string,
  turnEpoch: number,
  nowMs: number = Date.now(),
  config: Pick<PresenceConfig, "maxProcessLines" | "processMinIntervalMs"> = DEFAULT_PRESENCE_CONFIG,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const stageId = sanitizeStageId(stage);
  const max = config.maxProcessLines;
  const minInterval = config.processMinIntervalMs;
  try {
    // Ensure row exists (epoch 0) so UPDATE can match.
    await db
      .prepare(
        `INSERT INTO user_presence_turn (user_id, process_count, pre_final_count, last_stage, last_line_at_ms, updated_at)
         VALUES (?1, 0, 0, NULL, 0, CURRENT_TIMESTAMP)
         ON CONFLICT(user_id) DO NOTHING`,
      )
      .bind(userId)
      .run();

    const result = await db
      .prepare(
        `UPDATE user_presence_turn
         SET process_count = process_count + 1,
             last_stage = ?2,
             last_line_at_ms = ?3,
             updated_at = CURRENT_TIMESTAMP
         WHERE user_id = ?1
           AND pre_final_count = ?4
           AND process_count < ?5
           AND (last_stage IS NULL OR last_stage != ?2)
           AND (last_line_at_ms = 0 OR (?3 - last_line_at_ms) >= ?6)`,
      )
      .bind(userId, stageId, nowMs, turnEpoch, max, minInterval)
      .run();
    const changes = Number((result as { meta?: { changes?: number } })?.meta?.changes ?? 0);
    if (changes > 0) return { ok: true };

    const turn = await loadPresenceTurn(db, userId);
    if (turn.pre_final_count !== turnEpoch) return { ok: false, reason: "stale_turn" };
    if (turn.process_count >= max) return { ok: false, reason: "max_process_lines" };
    if (turn.last_stage && turn.last_stage === stageId) return { ok: false, reason: "same_stage" };
    if (turn.last_line_at_ms > 0 && nowMs - turn.last_line_at_ms < minInterval) {
      return { ok: false, reason: "min_interval" };
    }
    return { ok: false, reason: "claim_lost" };
  } catch (error) {
    console.error("presence process claim failed:", error instanceof Error ? error.message : error);
    return { ok: false, reason: "claim_error" };
  }
}

/** @deprecated Prefer claimPresenceProcessSlot (atomic). Kept for tests/callers. */
export async function recordPresenceProcessLine(
  db: D1Database,
  userId: string,
  stage: string,
): Promise<void> {
  const turn = await loadPresenceTurn(db, userId);
  await claimPresenceProcessSlot(db, userId, stage, turn.pre_final_count);
}

/** Block further process lines after Hermes final (msg 4) lands. */
export async function markPresenceTurnFinal(db: D1Database, userId: string): Promise<void> {
  try {
    await db
      .prepare(
        `UPDATE user_presence_turn
         SET process_count = 999,
             last_line_at_ms = ?2,
             updated_at = CURRENT_TIMESTAMP
         WHERE user_id = ?1`,
      )
      .bind(userId, Date.now())
      .run();
  } catch (error) {
    console.error("presence turn final mark failed:", error instanceof Error ? error.message : error);
  }
}

/** Whether we may send another process line (msg 2–3). Pure check (tests). */
export function canSendProcessLine(
  turn: PresenceTurnState,
  stage: string,
  nowMs: number,
  config: Pick<PresenceConfig, "maxProcessLines" | "processMinIntervalMs"> = DEFAULT_PRESENCE_CONFIG,
): { ok: true } | { ok: false; reason: string } {
  const stageId = sanitizeStageId(stage);
  if (turn.process_count >= config.maxProcessLines) {
    return { ok: false, reason: "max_process_lines" };
  }
  if (turn.last_stage && turn.last_stage === stageId) {
    return { ok: false, reason: "same_stage" };
  }
  // last_line_at_ms=0 means “no process line yet this turn” (ack must not stamp it).
  if (turn.last_line_at_ms > 0 && nowMs - turn.last_line_at_ms < config.processMinIntervalMs) {
    return { ok: false, reason: "min_interval" };
  }
  return { ok: true };
}
