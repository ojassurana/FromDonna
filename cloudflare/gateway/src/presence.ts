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
  /** LLM-first ack — allow enough time for edge proxy + small model. */
  ackDeadlineMs: 1200,
  /** Short — claim then one contextual LLM line before send. */
  processDeadlineMs: 450,
  tinyLlmAck: true,
  maxProcessLines: 2,
  processMinIntervalMs: 1800,
  /** Single bland line only — never scenario copy. Not One sec / On it. */
  fallbackPool: ["Working on that…"],
  /** Prefer fast non-reasoning when available via product proxy. */
  model: "grok-4.20-0309-non-reasoning",
  llmProxyBaseUrl: "https://fromdonna-llm-proxy.code-df4.workers.dev",
};

/** Banned empty filler — never send these as ack/process (LLM or fallback). */
export const PRESENCE_BANNED_FILLER = [
  "on it.",
  "one sec.",
  "got it.",
  "on it",
  "one sec",
  "got it",
  "looking that up…",
  "looking that up...",
  "on that follow-up…",
  "on that follow-up...",
  // Vague process lines the light LLM must not emit (fallback path handles separately).
  "still working…",
  "still working...",
  "checking that…",
  "checking that...",
  "hang tight…",
  "hang tight...",
  "almost there…",
  "almost there...",
];

export const PRESENCE_ACK_FALLBACK = "Working on that…";
export const PRESENCE_PROCESS_FALLBACK = "Still working…";

/**
 * System instruction for tiny presence-ack (msg 1).
 * General only — no app/scenario catalog; model invents the line from latest text.
 */
export const PRESENCE_ACK_SYSTEM_PROMPT = `You write ONE short status line for Donna on Telegram — what she is starting RIGHT NOW for the user.

Output only the status line. No quotes, no markdown, no bullets.
Max 6 words. Trailing ellipsis (…) preferred.
Use the LATEST user message as the only strong signal (older chat is weak context).

Be specific to THIS request: name the thing they asked about when clear (app, file, agent, topic).
Prefer a clear progressive verb (Checking, Installing, Looking into, Opening, Drafting…).
Never invent tools, MCP, Composio, APIs, skill names, or system talk.
Never ask a question. Never give the final answer.
Match language/register of the latest user message when obvious.

If truly unclear, still prefer a concrete guess from the words they used (topic/object) over empty filler.
Never output: One sec. · On it. · Got it. · Looking that up… · On that follow-up… · Working on that…`

/** System instruction for process WIP lines (msg 2–3). General; driven by live tool activity + user ask. */
export const PRESENCE_PROCESS_SYSTEM_PROMPT = `You write ONE short mid-work status line for Donna on Telegram — warm personal assistant, mid-task.

The agent just started real work on the user's request.
Output only the status line. No quotes, no markdown, no bullets.
Max 8 words. Trailing ellipsis (…) preferred.
MUST be specific to the latest user message (name the topic/place/app/thing they asked about).
Examples of GOOD shape (invent for THIS ask, do not copy): "Pulling OpenAI headlines…", "Checking Singapore time…", "Reading your TLDR email…"
BAD (never): Working on that… · Still working… · Checking that… · On it. · One sec. · Got it. · Looking that up…
Never name tools, APIs, MCP, Composio, skill ids, or system internals.
Never ask a question. Never give the final answer.
Do not repeat the previous status line if one is shown.
If truly unclear: use the strongest concrete noun from their message + a progressive verb.`;

/** Optional micro-gate: structural only, not product scenarios. */
export const PRESENCE_GATE_SYSTEM_PROMPT = `Answer only yes or no.
Is the latest user message a real request or question (not only a greeting, thanks, pure echo/repeat, or one-word ack)?
yes = send a short WIP status. no = skip.`;

export type PresenceAckResult = {
  text: string;
  source: "tiny_llm" | "fallback";
};

export type PresenceProcessResult = {
  text: string;
  source: "tiny_llm" | "fallback";
  stage: string;
};

export type PresenceGateDecision = {
  send: boolean;
  reason: string;
};

/** Stable stage id for budget/dedup only — NOT user-facing copy. No scenario catalog. */
export function stageFromToolName(toolName: string): { stage: string; line: string } {
  const stage = sanitizeStageId(toolName || "working");
  return { stage, line: PRESENCE_PROCESS_FALLBACK };
}

export function sanitizeStageId(raw: string): string {
  return (
    raw
      .toLowerCase()
      .replace(/[^a-z0-9_]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 48) || "working"
  );
}

// ── Structural presence gate only (not product scenarios) ──────────────────

const GATE_SKIP_EXACT =
  /^(hi|hii+|hello|hey|yo|sup|hola|namaste|thanks|thank you|thx|ty|ok|okay|k|kk|yes|yep|yeah|yup|no|nope|nah|sure|cool|great|nice|👍|🙏|lol|haha|hm+|hmm+|idk|np|bye|good morning|good night|gm|gn)[.!?]*$/i;

const GATE_SKIP_ECHO =
  /^(echo|repeat|say)\b|^reply with exactly\b|^include (this )?exact nonce\b/i;

/**
 * Structural gate: skip greetings/echo/very short acks; otherwise ON.
 * No app/intent scenario lists. Optional micro-LLM only for default_on medium text.
 */
export function shouldSendPresenceAck(text: string): PresenceGateDecision {
  const t = text.replace(/\s+/g, " ").trim();
  if (!t) return { send: false, reason: "empty" };

  if (GATE_SKIP_ECHO.test(t)) return { send: false, reason: "echo" };
  if (GATE_SKIP_EXACT.test(t)) return { send: false, reason: "greeting_or_ack" };

  if (/^["'`].+["'`]$/.test(t) && t.length < 80) return { send: false, reason: "quoted_only" };

  const words = t.split(/\s+/).filter(Boolean);
  if (words.length <= 2 && t.length <= 18 && !/[?]/.test(t)) {
    return { send: false, reason: "very_short" };
  }
  // 3-word soft acks without question mark
  if (words.length <= 3 && t.length <= 24 && !/[?]/.test(t) && !/\b(can|could|please|help|need|want|install|download|check|how)\b/i.test(t)) {
    return { send: false, reason: "short_simple" };
  }

  if (words.length >= 8 || t.length >= 40 || /[?]/.test(t)) {
    return { send: true, reason: "substantive" };
  }
  return { send: true, reason: "default_on" };
}

/**
 * Resolve gate; optional micro yes/no only when reason is default_on.
 * Timeout on micro-call → send ON (prefer presence over silence for real-ish text).
 */
export async function resolvePresenceGate(args: {
  text: string;
  callTinyLlm?: (body: {
    model: string;
    temperature: number;
    max_tokens: number;
    stream: false;
    messages: Array<{ role: "system" | "user"; content: string }>;
  }) => Promise<string | null>;
  model?: string;
  deadlineMs?: number;
}): Promise<PresenceGateDecision> {
  const base = shouldSendPresenceAck(args.text);
  if (base.reason !== "default_on" || !args.callTinyLlm) return base;

  const body = {
    model: args.model || DEFAULT_PRESENCE_CONFIG.model,
    temperature: 0,
    max_tokens: 3,
    stream: false as const,
    messages: [
      { role: "system" as const, content: PRESENCE_GATE_SYSTEM_PROMPT },
      { role: "user" as const, content: `Latest user message:\n${args.text.trim()}\n\nAnswer yes or no.` },
    ],
  };
  const raced = await raceWithDeadline(args.callTinyLlm(body).catch(() => null), args.deadlineMs ?? 180);
  // Prefer showing presence on ambiguous medium text if gate LLM is slow.
  if (!raced.ok || !raced.value) return { send: true, reason: "gate_llm_timeout_on" };
  const v = raced.value.trim().toLowerCase();
  if (/^no\b/.test(v)) return { send: false, reason: "gate_llm_no" };
  if (/^yes\b/.test(v)) return { send: true, reason: "gate_llm_yes" };
  return { send: true, reason: "gate_llm_unclear_on" };
}

export function normalizeSnippetText(text: string, maxLen = 280): string {
  return text.replace(/\s+/g, " ").trim().slice(0, maxLen);
}

export function isBannedFillerLine(text: string): boolean {
  const lower = text.trim().toLowerCase();
  return PRESENCE_BANNED_FILLER.includes(lower);
}

/** Detect presence WIP lines for ring filtering (heuristic; no scenario catalog). */
export function isPresenceStatusLine(text: string): boolean {
  const t = text.trim();
  if (!t) return false;
  if (/^\.{1,3}$/.test(t)) return true;
  const lower = t.toLowerCase();
  if (isBannedFillerLine(t)) return true;
  if (
    lower === "working on that…" ||
    lower === "working on that..." ||
    lower === "still working…" ||
    lower === "still working..." ||
    lower === "still on it…" ||
    lower === "still on it..." ||
    lower === "working on it…" ||
    lower === "working on it..."
  ) {
    return true;
  }
  // Short progressive line ending in ellipsis — typical WIP, not a final answer.
  const words = t.split(/\s+/);
  if (
    words.length <= 8 &&
    t.length <= 80 &&
    !/[?]/.test(t) &&
    (/…$|\.\.\.$/.test(t) || /ing\b/i.test(t))
  ) {
    // Exclude obvious multi-sentence finals
    if (!/[.!]\s+[A-Z]/.test(t) && t.split("\n").length === 1) return true;
  }
  return false;
}

export function isGenericPresenceLine(text: string): boolean {
  const lower = text.trim().toLowerCase();
  if (isBannedFillerLine(text)) return true;
  return [
    "working on that…",
    "working on that...",
    "still working…",
    "still working...",
    "still on it…",
    "still on it...",
    "working on it…",
    "working on it...",
  ].includes(lower);
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

/** @deprecated No scenario rules — always null. Kept for import compatibility. */
export function ruleBasedPresenceAck(_snippets: PresenceSnippet[], _currentUserText: string): string | null {
  return null;
}

export function pickFallbackAck(pool: string[], _seed: string): string {
  const list = pool.length > 0 ? pool : DEFAULT_PRESENCE_CONFIG.fallbackPool;
  const line = list[0] ?? PRESENCE_ACK_FALLBACK;
  if (isBannedFillerLine(line)) return PRESENCE_ACK_FALLBACK;
  return line;
}

/** Build chat/completions messages for the tiny presence-ack model. */
export function buildPresenceAckChatMessages(
  snippets: PresenceSnippet[],
  currentUserText: string,
  maxContext = DEFAULT_PRESENCE_CONFIG.contextMessages,
): Array<{ role: "system" | "user" | "assistant"; content: string }> {
  const recent = snippets.filter((s) => s.role !== "status").slice(-Math.min(3, maxContext));
  const weak: string[] = [];
  for (const s of recent) {
    const who = s.role === "user" ? "User" : "Donna";
    weak.push(`${who}: ${s.text}`);
  }
  const userBlock =
    `Latest user message:\n${normalizeSnippetText(currentUserText)}\n\n` +
    (weak.length
      ? `Optional weak context (older, may be stale — do not overfit):\n${weak.join("\n")}\n\n`
      : "") +
    `Write the single WIP status line now.`;
  return [
    { role: "system", content: PRESENCE_ACK_SYSTEM_PROMPT },
    { role: "user", content: userBlock },
  ];
}

/**
 * OpenAI-compatible chat/completions body sent to fromdonna-llm-proxy.
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
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
    t = t.slice(1, -1).trim();
  }
  t = t.split("\n")[0]?.trim() ?? "";
  if (!t) return null;
  if (/(composio|skill_view|\bmcp\b|tool_call|function_call|gpt-|grok-)/i.test(t)) return null;
  // Strip test nonces / gate tokens — never surface in WIP.
  t = t.replace(/\bGATE_[A-Za-z0-9_]+\b/g, "").replace(/\s{2,}/g, " ").trim();
  t = t.replace(/\s*[:\-–—]+\s*$/g, "").trim();
  if (!t) return null;
  if (isBannedFillerLine(t)) return null;
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

/** LLM-first ack. No scenario rules. Bland fallback only if LLM fails. */
export async function resolvePresenceAck(args: {
  snippets: PresenceSnippet[];
  currentUserText: string;
  seed: string;
  config?: Partial<PresenceConfig>;
  callTinyLlm?: (requestBody: ReturnType<typeof buildPresenceAckChatCompletionRequest>) => Promise<string | null>;
}): Promise<PresenceAckResult> {
  return resolvePresenceAckPreferFast(args);
}

/** LLM-first ack with deadline; single non-scenario fallback. */
export async function resolvePresenceAckPreferFast(args: {
  snippets: PresenceSnippet[];
  currentUserText: string;
  seed: string;
  config?: Partial<PresenceConfig>;
  callTinyLlm?: (requestBody: ReturnType<typeof buildPresenceAckChatCompletionRequest>) => Promise<string | null>;
}): Promise<PresenceAckResult> {
  const config: PresenceConfig = { ...DEFAULT_PRESENCE_CONFIG, ...args.config };

  if (config.tinyLlmAck && args.callTinyLlm) {
    const body = buildPresenceAckChatCompletionRequest(args.snippets, args.currentUserText, config);
    const llmPromise = args.callTinyLlm(body).catch(() => null);
    const raced = await raceWithDeadline(llmPromise, config.ackDeadlineMs);
    if (raced.ok) {
      const cleaned = raced.value ? sanitizePresenceAckLine(raced.value) : null;
      if (cleaned) return { text: cleaned, source: "tiny_llm" };
    }
  }

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
  latestUserText?: string,
): Array<{ role: "system" | "user" | "assistant"; content: string }> {
  const recent = snippets.filter((s) => s.role !== "status").slice(-Math.min(3, maxContext));
  const weak: string[] = [];
  for (const s of recent) {
    weak.push(`${s.role === "user" ? "User" : "Donna"}: ${s.text}`);
  }
  const lastUser =
    (latestUserText && normalizeSnippetText(latestUserText)) ||
    [...snippets].reverse().find((s) => s.role === "user")?.text ||
    "";
  const lastStatus = [...snippets].reverse().find((s) => s.role === "status");
  // stage id is for dedup only; do not expose raw tool catalogs as user copy.
  const userBlock =
    `Latest user message:\n${lastUser || "(unknown)"}\n\n` +
    `Live signal: the agent just started a runtime action (internal id: ${stage}).\n` +
    `Write a human mid-work status for the user — do not echo the internal id.\n` +
    (lastStatus ? `Previous status line: ${lastStatus.text}\n` : "") +
    (weak.length ? `Weak context:\n${weak.join("\n")}\n` : "") +
    `\nWrite the single WIP status line now (must differ from previous status if possible).`;
  void stageHint;
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
  latestUserText?: string,
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
    messages: buildPresenceProcessChatMessages(
      snippets,
      stage,
      stageHint,
      config.contextMessages,
      latestUserText,
    ),
  };
}

export async function resolvePresenceProcessLine(args: {
  snippets: PresenceSnippet[];
  toolName?: string;
  stage?: string;
  seed: string;
  config?: Partial<PresenceConfig>;
  latestUserText?: string;
  callTinyLlm?: (
    requestBody: ReturnType<typeof buildPresenceProcessChatCompletionRequest>,
  ) => Promise<string | null>;
}): Promise<PresenceProcessResult | { skipped: true; reason: string; stage: string }> {
  const config: PresenceConfig = { ...DEFAULT_PRESENCE_CONFIG, ...args.config };
  const mapped = stageFromToolName(args.toolName || args.stage || "working");
  const stage = sanitizeStageId(args.stage || mapped.stage);
  const lastStatus = [...args.snippets].reverse().find((s) => s.role === "status");

  if (config.tinyLlmAck && args.callTinyLlm) {
    const body = buildPresenceProcessChatCompletionRequest(
      args.snippets,
      stage,
      PRESENCE_PROCESS_FALLBACK,
      config,
      args.latestUserText,
    );
    const raced = await raceWithDeadline(args.callTinyLlm(body), config.processDeadlineMs);
    if (raced.ok) {
      const cleaned = raced.value ? sanitizePresenceAckLine(raced.value) : null;
      if (cleaned && (!lastStatus || !samePresenceText(lastStatus.text, cleaned))) {
        return { text: cleaned, source: "tiny_llm", stage };
      }
    }
  }

  const fallback = PRESENCE_PROCESS_FALLBACK;
  if (!lastStatus || !samePresenceText(lastStatus.text, fallback)) {
    return { text: fallback, source: "fallback", stage };
  }
  return { skipped: true, reason: "duplicate_status", stage };
}

export async function callPresenceTinyLlm(args: {
  /** Prefer Worker service binding (CF blocks Worker→workers.dev fetch with 1042). */
  fetcher?: Fetcher;
  llmProxyBaseUrl: string;
  capabilityToken: string;
  body:
    | ReturnType<typeof buildPresenceAckChatCompletionRequest>
    | ReturnType<typeof buildPresenceProcessChatCompletionRequest>
    | {
        model: string;
        temperature: number;
        max_tokens: number;
        stream: false;
        messages: Array<{ role: "system" | "user" | "assistant"; content: string }>;
      };
}): Promise<string | null> {
  const url = args.fetcher
    ? "https://llm-proxy/v1/chat/completions"
    : `${args.llmProxyBaseUrl.replace(/\/$/, "")}/v1/chat/completions`;
  const init: RequestInit = {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${args.capabilityToken}`,
    },
    body: JSON.stringify(args.body),
  };
  const response = args.fetcher
    ? await args.fetcher.fetch(url, init)
    : await fetch(url, init);
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    console.error(`presence tiny llm HTTP ${response.status}: ${detail.slice(0, 200)}`);
    return null;
  }
  const json = (await response.json()) as unknown;
  const text = extractChatCompletionText(json);
  if (!text) {
    console.error("presence tiny llm empty content");
  }
  return text;
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

/** Final landed this turn (markPresenceTurnFinal stamps process_count = 999). */
export function isPresenceTurnFinalized(turn: PresenceTurnState): boolean {
  return turn.process_count >= 900;
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
