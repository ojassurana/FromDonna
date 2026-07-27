import { describe, expect, it, vi } from "vitest";
import {
  PRESENCE_ACK_SYSTEM_PROMPT,
  PRESENCE_PROCESS_SYSTEM_PROMPT,
  buildPresenceAckChatCompletionRequest,
  buildPresenceAckChatMessages,
  buildPresenceProcessChatCompletionRequest,
  canSendProcessLine,
  extractChatCompletionText,
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

describe("presence gate", () => {
  it("skips greetings and simple acks", () => {
    expect(shouldSendPresenceAck("hi").send).toBe(false);
    expect(shouldSendPresenceAck("thanks").send).toBe(false);
    expect(shouldSendPresenceAck("ok").send).toBe(false);
    expect(shouldSendPresenceAck("yes").reason).toBe("greeting_or_ack");
  });

  it("skips echo / nonce-only probes", () => {
    expect(shouldSendPresenceAck("echo this: banana-42").send).toBe(false);
    expect(shouldSendPresenceAck("Reply with exactly: FOO").send).toBe(false);
    expect(shouldSendPresenceAck('include exact nonce PRES_X').send).toBe(false);
  });

  it("forces ON for email / calendar work", () => {
    expect(shouldSendPresenceAck("check my gmail").send).toBe(true);
    expect(shouldSendPresenceAck("anything new in my email?").reason).toMatch(/force/);
    expect(shouldSendPresenceAck("what's on my calendar tomorrow").send).toBe(true);
  });

  it("micro-gate can skip ambiguous default_on", async () => {
    const d = await resolvePresenceGate({
      text: "maybe later about stuff randomly",
      callTinyLlm: async () => "no",
      deadlineMs: 100,
    });
    // Either rules already decided, or LLM said no
    if (shouldSendPresenceAck("maybe later about stuff randomly").reason === "default_on") {
      expect(d.send).toBe(false);
    }
  });
});

describe("presence rules", () => {
  it("maps email intent from current message only", () => {
    expect(ruleBasedPresenceAck([], "check my gmail for the invoice")).toBe("Opening Gmail…");
  });

  it("does not poison from ring history alone", () => {
    expect(
      ruleBasedPresenceAck(
        [{ role: "user", text: "search the web for news" }, { role: "assistant", text: "ok" }],
        "hi again friend",
      ),
    ).toBeNull();
  });

  it("maps calendar on affirmation follow-up from prior user", () => {
    expect(
      ruleBasedPresenceAck(
        [{ role: "user", text: "what meetings do I have tomorrow" }, { role: "assistant", text: "Want me to check calendar?" }],
        "yes",
      ),
    ).toMatch(/calendar/i);
  });

  it("returns null for thin hi", () => {
    expect(ruleBasedPresenceAck([], "hi")).toBeNull();
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
      { role: "status", text: "On it." },
      { role: "assistant", text: "hey" },
    ]);
    expect(parsePresenceRingJson(raw)).toHaveLength(3);
  });
});

describe("sanitize + status detect", () => {
  it("strips quotes and rejects tool leakage", () => {
    expect(sanitizePresenceAckLine('"Checking email…"')).toBe("Checking email…");
    expect(sanitizePresenceAckLine("calling COMPOSIO_MANAGE_CONNECTIONS")).toBeNull();
  });

  it("detects status lines", () => {
    expect(isPresenceStatusLine("Opening Gmail…")).toBe(true);
    expect(isPresenceStatusLine("On it.")).toBe(true);
    expect(isPresenceStatusLine("...")).toBe(true);
    expect(isPresenceStatusLine(".")).toBe(true);
    expect(isPresenceStatusLine("All set…")).toBe(false);
    expect(isPresenceStatusLine("Here is your full report with details")).toBe(false);
  });
});

describe("chat completion request shape", () => {
  it("builds latest-first user block", () => {
    const msgs = buildPresenceAckChatMessages(
      [
        { role: "user", text: "need gmail" },
        { role: "assistant", text: "ok" },
        { role: "status", text: "On it." },
      ],
      "check invoice",
    );
    expect(msgs[0]?.role).toBe("system");
    expect(msgs[0]?.content).toBe(PRESENCE_ACK_SYSTEM_PROMPT);
    expect(msgs[1]?.role).toBe("user");
    expect(msgs[1]?.content).toContain("Latest user message:");
    expect(msgs[1]?.content).toContain("check invoice");
    expect(msgs[1]?.content).toContain("need gmail");
    expect(msgs[1]?.content).not.toContain("On it.");

    const body = buildPresenceAckChatCompletionRequest(
      [{ role: "user", text: "hi" }],
      "email me later",
    );
    expect(body.model).toBe("grok-4.5");
    expect(body.messages).toHaveLength(2);
  });

  it("extracts completion text", () => {
    expect(
      extractChatCompletionText({
        choices: [{ message: { content: "Opening Gmail…" } }],
      }),
    ).toBe("Opening Gmail…");
  });
});

describe("resolvePresenceAckPreferFast", () => {
  it("uses tiny llm when concrete", async () => {
    const result = await resolvePresenceAckPreferFast({
      snippets: [],
      currentUserText: "hi there please help with something long enough maybe",
      seed: "u1",
      config: { ackDeadlineMs: 200, tinyLlmAck: true },
      callTinyLlm: async () => "Sorting that out…",
    });
    expect(result.source).toBe("tiny_llm");
    expect(result.text).toContain("Sorting");
  });

  it("falls back to rules when llm times out on gmail", async () => {
    const result = await resolvePresenceAckPreferFast({
      snippets: [],
      currentUserText: "check my gmail",
      seed: "u1",
      config: { ackDeadlineMs: 30, tinyLlmAck: true },
      callTinyLlm: async () => {
        await new Promise((r) => setTimeout(r, 200));
        return "late";
      },
    });
    expect(result.source).toBe("rules");
    expect(result.text).toMatch(/Gmail|email/i);
  });

  it("uses fallback pool when thin", async () => {
    const result = await resolvePresenceAckPreferFast({
      snippets: [],
      currentUserText: "please help me with this multi word request today",
      seed: "seed",
      config: { tinyLlmAck: false },
    });
    // may be rules null → fallback
    expect(["fallback", "rules"]).toContain(result.source);
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

describe("pickFallbackAck", () => {
  it("is deterministic for seed", () => {
    expect(pickFallbackAck(["A", "B"], "x")).toBe(pickFallbackAck(["A", "B"], "x"));
  });
});

describe("process stages", () => {
  it("maps tool names to human stages", () => {
    expect(stageFromToolName("COMPOSIO_GMAIL_FETCH_EMAILS").stage).toBe("checking_email");
    expect(stageFromToolName("COMPOSIO_GMAIL_FETCH_EMAILS").line).toMatch(/Gmail/i);
    expect(stageFromToolName("web_search").line).toMatch(/Looking/i);
  });

  it("builds process completion request with runtime stage", () => {
    const body = buildPresenceProcessChatCompletionRequest(
      [{ role: "user", text: "check inbox" }],
      "checking_email",
      "Opening Gmail…",
    );
    expect(body.messages[0]?.content).toBe(PRESENCE_PROCESS_SYSTEM_PROMPT);
    expect(body.messages[1]?.content).toContain("Runtime stage: checking_email");
    expect(body.messages[1]?.content).toContain("check inbox");
  });

  it("resolve process line prefers rules when no llm", async () => {
    const r = await resolvePresenceProcessLine({
      snippets: [],
      toolName: "gmail_list",
      seed: "u",
      config: { tinyLlmAck: false },
    });
    expect("skipped" in r).toBe(false);
    if ("skipped" in r) return;
    expect(r.source).toBe("rules");
    expect(r.stage).toBe("checking_email");
  });

  it("skips duplicate process text matching prior status", async () => {
    const r = await resolvePresenceProcessLine({
      snippets: [{ role: "status", text: "Opening Gmail…" }],
      toolName: "gmail_list",
      seed: "u",
      config: { tinyLlmAck: false },
    });
    expect("skipped" in r).toBe(false);
    if ("skipped" in r) return;
    expect(r.text).toMatch(/Still on it/i);
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
        { process_count: 0, pre_final_count: 1, last_stage: "checking_email", last_line_at_ms: Date.now() },
        "checking_email",
        Date.now(),
      ).ok,
    ).toBe(false);
    expect(
      canSendProcessLine(
        { process_count: 0, pre_final_count: 1, last_stage: null, last_line_at_ms: 0 },
        "checking_email",
        Date.now(),
      ).ok,
    ).toBe(true);
    const now = Date.now();
    expect(
      canSendProcessLine(
        { process_count: 1, pre_final_count: 1, last_stage: "checking_email", last_line_at_ms: now },
        "looking_up",
        now + 100,
      ).ok,
    ).toBe(false);
    expect(
      canSendProcessLine(
        { process_count: 1, pre_final_count: 1, last_stage: "checking_email", last_line_at_ms: now },
        "looking_up",
        now + 2600,
      ).ok,
    ).toBe(true);
  });
});

void vi;
