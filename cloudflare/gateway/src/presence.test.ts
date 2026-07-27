import { describe, expect, it, vi } from "vitest";
import {
  PRESENCE_ACK_FALLBACK,
  PRESENCE_ACK_SYSTEM_PROMPT,
  PRESENCE_PROCESS_FALLBACK,
  PRESENCE_PROCESS_SYSTEM_PROMPT,
  buildPresenceAckChatCompletionRequest,
  buildPresenceAckChatMessages,
  buildPresenceProcessChatCompletionRequest,
  canSendProcessLine,
  extractChatCompletionText,
  isBannedFillerLine,
  isPresenceStatusLine,
  parsePresenceRingJson,
  pickFallbackAck,
  pushPresenceRing,
  raceWithDeadline,
  resolvePresenceAckPreferFast,
  resolvePresenceGate,
  resolvePresenceProcessLine,
  ruleBasedPresenceAck,
  sanitizePresenceAckLine,
  shouldSendPresenceAck,
  stageFromToolName,
} from "./presence";

describe("presence gate (structural only)", () => {
  it("skips greetings and simple acks", () => {
    expect(shouldSendPresenceAck("hi").send).toBe(false);
    expect(shouldSendPresenceAck("thanks").send).toBe(false);
    expect(shouldSendPresenceAck("ok").send).toBe(false);
  });

  it("skips echo probes", () => {
    expect(shouldSendPresenceAck("echo this: banana-42").send).toBe(false);
    expect(shouldSendPresenceAck("Reply with exactly: FOO").send).toBe(false);
  });

  it("sends on real asks without scenario lists", () => {
    expect(shouldSendPresenceAck("Can you install pi agent on my device?").send).toBe(true);
    expect(shouldSendPresenceAck("check my gmail please").send).toBe(true);
  });

  it("micro-gate can skip default_on with no", async () => {
    // Force a default_on-ish medium line if possible
    const text = "maybe stuff later";
    const base = shouldSendPresenceAck(text);
    if (base.reason === "default_on") {
      const d = await resolvePresenceGate({
        text,
        callTinyLlm: async () => "no",
        deadlineMs: 100,
      });
      expect(d.send).toBe(false);
    }
  });
});

describe("no scenario hardcoding", () => {
  it("ruleBasedPresenceAck always null", () => {
    expect(ruleBasedPresenceAck([], "check my gmail for the invoice")).toBeNull();
    expect(ruleBasedPresenceAck([], "install pi agent")).toBeNull();
  });

  it("stageFromToolName is id-only with generic fallback line", () => {
    const g = stageFromToolName("COMPOSIO_GMAIL_FETCH_EMAILS");
    expect(g.line).toBe(PRESENCE_PROCESS_FALLBACK);
    expect(g.stage).toMatch(/composio|gmail|fetch/i);
    const t = stageFromToolName("terminal");
    expect(t.line).toBe(PRESENCE_PROCESS_FALLBACK);
  });

  it("fallback is never One sec / On it", () => {
    const line = pickFallbackAck([], "seed");
    expect(line).toBe(PRESENCE_ACK_FALLBACK);
    expect(isBannedFillerLine(line)).toBe(false);
    expect(line.toLowerCase()).not.toMatch(/one sec|on it\.?$/);
  });
});

describe("presence ring", () => {
  it("caps length", () => {
    let ring = pushPresenceRing([], { role: "user", text: "a" }, 3);
    ring = pushPresenceRing(ring, { role: "assistant", text: "b" }, 3);
    ring = pushPresenceRing(ring, { role: "user", text: "c" }, 3);
    ring = pushPresenceRing(ring, { role: "user", text: "d" }, 3);
    expect(ring.map((s) => s.text)).toEqual(["b", "c", "d"]);
  });

  it("parses json", () => {
    const raw = JSON.stringify([
      { role: "user", text: "hello" },
      { role: "status", text: "Working on that…" },
      { role: "assistant", text: "hey" },
    ]);
    expect(parsePresenceRingJson(raw)).toHaveLength(3);
  });
});

describe("sanitize + status detect", () => {
  it("strips quotes, rejects tool leakage and banned filler", () => {
    expect(sanitizePresenceAckLine('"Checking email…"')).toBe("Checking email…");
    expect(sanitizePresenceAckLine("calling COMPOSIO_MANAGE_CONNECTIONS")).toBeNull();
    expect(sanitizePresenceAckLine("One sec.")).toBeNull();
    expect(sanitizePresenceAckLine("On it.")).toBeNull();
  });

  it("detects status lines heuristically", () => {
    expect(isPresenceStatusLine("Opening Gmail…")).toBe(true);
    expect(isPresenceStatusLine("Working on that…")).toBe(true);
    expect(isPresenceStatusLine("...")).toBe(true);
    expect(isPresenceStatusLine("Here is your full report with details about everything")).toBe(false);
  });
});

describe("chat completion request shape", () => {
  it("builds latest-first user block with general system prompt", () => {
    const msgs = buildPresenceAckChatMessages(
      [
        { role: "user", text: "need gmail" },
        { role: "assistant", text: "ok" },
        { role: "status", text: "Working on that…" },
      ],
      "install pi agent",
    );
    expect(msgs[0]?.content).toBe(PRESENCE_ACK_SYSTEM_PROMPT);
    expect(msgs[1]?.content).toContain("Latest user message:");
    expect(msgs[1]?.content).toContain("install pi agent");
    expect(msgs[1]?.content).not.toContain("Working on that…");

    const body = buildPresenceAckChatCompletionRequest([], "email me later");
    expect(body.model).toBe("grok-4.20-0309-non-reasoning");
    expect(body.messages).toHaveLength(2);
  });

  it("extracts completion text", () => {
    expect(
      extractChatCompletionText({
        choices: [{ message: { content: "Looking into Pi…" } }],
      }),
    ).toBe("Looking into Pi…");
  });
});

describe("resolvePresenceAckPreferFast LLM-first", () => {
  it("uses tiny llm when available", async () => {
    const result = await resolvePresenceAckPreferFast({
      snippets: [],
      currentUserText: "Can you install pi agent on my device?",
      seed: "u1",
      config: { ackDeadlineMs: 200, tinyLlmAck: true },
      callTinyLlm: async () => "Looking into installing Pi…",
    });
    expect(result.source).toBe("tiny_llm");
    expect(result.text.toLowerCase()).toMatch(/pi|install/);
  });

  it("rejects banned filler from llm and falls back bland", async () => {
    const result = await resolvePresenceAckPreferFast({
      snippets: [],
      currentUserText: "install something please now",
      seed: "u1",
      config: { ackDeadlineMs: 200, tinyLlmAck: true },
      callTinyLlm: async () => "One sec.",
    });
    expect(result.source).toBe("fallback");
    expect(result.text).toBe(PRESENCE_ACK_FALLBACK);
  });

  it("fallback when llm times out", async () => {
    const result = await resolvePresenceAckPreferFast({
      snippets: [],
      currentUserText: "check something for me please",
      seed: "u1",
      config: { ackDeadlineMs: 30, tinyLlmAck: true },
      callTinyLlm: async () => {
        await new Promise((r) => setTimeout(r, 200));
        return "late";
      },
    });
    expect(result.source).toBe("fallback");
    expect(result.text).toBe(PRESENCE_ACK_FALLBACK);
  });
});

describe("raceWithDeadline", () => {
  it("times out", async () => {
    const r = await raceWithDeadline(new Promise((r) => setTimeout(() => r(1), 100)), 10);
    expect(r.ok).toBe(false);
  });

  it("returns value", async () => {
    const r = await raceWithDeadline(Promise.resolve(42), 100);
    expect(r).toEqual({ ok: true, value: 42 });
  });
});

describe("process stages LLM-first", () => {
  it("builds process request with latest user + live signal", () => {
    const body = buildPresenceProcessChatCompletionRequest(
      [{ role: "user", text: "install pi" }],
      "terminal",
      PRESENCE_PROCESS_FALLBACK,
      undefined,
      "install pi",
    );
    expect(body.messages[0]?.content).toBe(PRESENCE_PROCESS_SYSTEM_PROMPT);
    expect(body.messages[1]?.content).toContain("install pi");
    expect(body.messages[1]?.content).toContain("Live signal");
  });

  it("resolve process prefers llm", async () => {
    const r = await resolvePresenceProcessLine({
      snippets: [{ role: "user", text: "install pi agent" }],
      toolName: "terminal",
      seed: "u",
      latestUserText: "install pi agent",
      config: { tinyLlmAck: true, processDeadlineMs: 200 },
      callTinyLlm: async () => "Downloading Pi agent…",
    });
    expect("skipped" in r).toBe(false);
    if ("skipped" in r) return;
    expect(r.source).toBe("tiny_llm");
    expect(r.text).toMatch(/Pi|Download|install/i);
  });

  it("process fallback is generic not scenario", async () => {
    const r = await resolvePresenceProcessLine({
      snippets: [{ role: "user", text: "install pi" }],
      toolName: "gmail_list",
      seed: "u",
      config: { tinyLlmAck: false },
    });
    expect("skipped" in r).toBe(false);
    if ("skipped" in r) return;
    expect(r.source).toBe("fallback");
    expect(r.text).toBe(PRESENCE_PROCESS_FALLBACK);
  });

  it("skips duplicate process fallback", async () => {
    const r = await resolvePresenceProcessLine({
      snippets: [{ role: "status", text: PRESENCE_PROCESS_FALLBACK }],
      toolName: "terminal",
      seed: "u",
      config: { tinyLlmAck: false },
    });
    expect("skipped" in r).toBe(true);
  });

  it("enforces process budget", () => {
    expect(
      canSendProcessLine(
        { process_count: 2, pre_final_count: 3, last_stage: "a", last_line_at_ms: 0 },
        "b",
        Date.now(),
      ).ok,
    ).toBe(false);
    expect(
      canSendProcessLine(
        { process_count: 0, pre_final_count: 1, last_stage: null, last_line_at_ms: 0 },
        "terminal",
        Date.now(),
      ).ok,
    ).toBe(true);
  });
});

void vi;
