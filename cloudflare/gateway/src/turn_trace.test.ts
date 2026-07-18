import { describe, expect, it } from "vitest";
import { inboundPreviewFromUpdate, newTurnId } from "./turn_trace";

describe("turn_trace helpers", () => {
  it("mints unique turn ids", () => {
    const a = newTurnId();
    const b = newTurnId();
    expect(a).toMatch(/^[0-9a-f-]{36}$/i);
    expect(a).not.toBe(b);
  });

  it("previews plain messages", () => {
    const r = inboundPreviewFromUpdate({ message: { text: "hello donna" } });
    expect(r.kind).toBe("message");
    expect(r.preview).toBe("hello donna");
  });

  it("previews callbacks", () => {
    const r = inboundPreviewFromUpdate({ callback_query: { data: "connect:gmail" } });
    expect(r.kind).toBe("callback_query");
    expect(r.preview).toBe("connect:gmail");
  });
});
