import { describe, expect, it, vi } from "vitest";
import {
  PRESENCE_ACK_SYSTEM_PROMPT,
  buildPresenceAckChatCompletionRequest,
  buildPresenceAckChatMessages,
  extractChatCompletionText,
  isPresenceStatusLine,
  parsePresenceRingJson,
  pickFallbackAck,
  pushPresenceRing,
  raceWithDeadline,
  resolvePresenceAckPreferFast,
  ruleBasedPresenceAck,
  sanitizePresenceAckLine,
} from "./presence";

describe("presence rules", () => {
  it("maps email intent from current message", () => {
    expect(ruleBasedPresenceAck([], "check my gmail for the invoice")).toBe(
      "Checking that email…",
    );
  });

  it("maps calendar from history", () => {
    expect(
      ruleBasedPresenceAck(
        [{ role: "user", text: "what meetings do I have" }, { role: "assistant", text: "Want me to check calendar?" }],
        "yes tomorrow",
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
    expect(isPresenceStatusLine("Checking that email…")).toBe(true);
    expect(isPresenceStatusLine("On it.")).toBe(true);
    expect(isPresenceStatusLine("Here is your full report with details")).toBe(false);
  });
});

describe("chat completion request shape", () => {
  it("builds system + user messages with last context", () => {
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
    expect(msgs[1]?.content).toContain("User: need gmail");
    expect(msgs[1]?.content).toContain("Donna: ok");
    // status lines stripped from context block
    expect(msgs[1]?.content).not.toContain("On it.");
    expect(msgs[1]?.content).toContain("User: check invoice");

    const body = buildPresenceAckChatCompletionRequest(
      [{ role: "user", text: "hi" }],
      "email me later",
    );
    expect(body.stream).toBe(false);
    expect(body.max_tokens).toBe(24);
    expect(body.model).toBe("grok-4.5");
    expect(body.messages).toHaveLength(2);
  });

  it("extracts completion text", () => {
    expect(
      extractChatCompletionText({
        choices: [{ message: { content: "Checking that email…" } }],
      }),
    ).toBe("Checking that email…");
  });
});

describe("resolvePresenceAckPreferFast", () => {
  it("uses tiny llm when it wins", async () => {
    const result = await resolvePresenceAckPreferFast({
      snippets: [],
      currentUserText: "hi",
      seed: "u1",
      config: { ackDeadlineMs: 200, tinyLlmAck: true },
      callTinyLlm: async () => "Sorting that out…",
    });
    expect(result.source).toBe("tiny_llm");
    expect(result.text).toContain("Sorting");
  });

  it("falls back to rules when llm times out", async () => {
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
    expect(result.text).toMatch(/email/i);
  });

  it("uses fallback pool when thin", async () => {
    const result = await resolvePresenceAckPreferFast({
      snippets: [],
      currentUserText: "hi",
      seed: "seed",
      config: { tinyLlmAck: false },
    });
    expect(result.source).toBe("fallback");
    expect(["On it.", "One sec.", "Got it."]).toContain(result.text);
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

// silence unused import if any
void vi;
