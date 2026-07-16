import { describe, expect, it } from "vitest";
import { authorizeHarness } from "./checkpoint";

describe("checkpoint auth", () => {
  it("accepts a matching bearer secret", () => {
    const env = { WORKER_TO_HARNESS_SECRET: "s".repeat(32) };
    const request = new Request("https://example.test/internal/checkpoint", {
      headers: { authorization: `Bearer ${"s".repeat(32)}` },
    });
    expect(authorizeHarness(request, env)).toBe(true);
  });

  it("rejects a wrong bearer secret", () => {
    const env = { WORKER_TO_HARNESS_SECRET: "s".repeat(32) };
    const request = new Request("https://example.test/internal/checkpoint", {
      headers: { authorization: "Bearer wrong-secret-value-here-123456" },
    });
    expect(authorizeHarness(request, env)).toBe(false);
  });
});
