import { describe, expect, it } from "vitest";
import {
  isWarmHarnessReady,
  shouldSendEarlyTyping,
  shouldSkipBootstrap,
  shouldSkipPreInjectCheckpoint,
  type WarmPathHealth,
} from "./warm_path";

const WARM: WarmPathHealth = {
  ok: true,
  auth_ready: true,
  telegram_proxy_ready: true,
  gateway_running: true,
  composio_mcp_ready: true,
};

describe("isWarmHarnessReady", () => {
  it("accepts fully ready health", () => {
    expect(isWarmHarnessReady(WARM)).toBe(true);
  });

  it("rejects null/undefined and partial health", () => {
    expect(isWarmHarnessReady(null)).toBe(false);
    expect(isWarmHarnessReady(undefined)).toBe(false);
    expect(isWarmHarnessReady({ ...WARM, gateway_running: false })).toBe(false);
    expect(isWarmHarnessReady({ ...WARM, telegram_proxy_ready: false })).toBe(false);
    expect(isWarmHarnessReady({ ...WARM, auth_ready: false })).toBe(false);
    expect(isWarmHarnessReady({ ...WARM, ok: false })).toBe(false);
  });
});

describe("shouldSkipBootstrap", () => {
  it("skips on warm inject path", () => {
    expect(shouldSkipBootstrap(WARM)).toBe(true);
    expect(shouldSkipBootstrap(WARM, { requireComposio: false })).toBe(true);
  });

  it("never skips when requireComposio (provision/replace)", () => {
    expect(shouldSkipBootstrap(WARM, { requireComposio: true })).toBe(false);
  });

  it("does not skip when gateway is down", () => {
    expect(shouldSkipBootstrap({ ...WARM, gateway_running: false })).toBe(false);
    expect(shouldSkipBootstrap(null)).toBe(false);
  });

  it("still skips warm gateway even if composio flag is false (soft inject)", () => {
    expect(shouldSkipBootstrap({ ...WARM, composio_mcp_ready: false })).toBe(true);
  });
});

describe("shouldSkipPreInjectCheckpoint", () => {
  it("skips when warm (checkpoint harvest is post-inject)", () => {
    expect(shouldSkipPreInjectCheckpoint(WARM)).toBe(true);
  });

  it("does not skip when cold / not ready", () => {
    expect(shouldSkipPreInjectCheckpoint({ ...WARM, gateway_running: false })).toBe(false);
    expect(shouldSkipPreInjectCheckpoint(null)).toBe(false);
  });
});

describe("shouldSendEarlyTyping", () => {
  it("types for inbound messages", () => {
    expect(shouldSendEarlyTyping({ type: "message" })).toBe(true);
  });

  it("does not type for callbacks or empty", () => {
    expect(shouldSendEarlyTyping({ type: "callback" })).toBe(false);
    expect(shouldSendEarlyTyping(null)).toBe(false);
    expect(shouldSendEarlyTyping(undefined)).toBe(false);
  });
});
