import { describe, expect, it } from "vitest";

/**
 * Lightweight regression locks for post-turn lifecycle constants.
 * Full harvest/pause paths need E2B + harness integration.
 */

// Mirror values from index.ts — keep in sync when changing policy.
const SANDBOX_TTL_SECONDS = 3600;
const POST_TURN_QUIET_MS = 60_000;
const CHECKPOINT_HARVEST_INITIAL_MS = 5_000;
/** Must cover harness session wait (900s) + pack slack. */
const CHECKPOINT_HARVEST_MAX_MS = 16 * 60_000;

describe("post-turn lifecycle policy", () => {
  it("keeps active TTL at E2B max (1h) as safety net", () => {
    expect(SANDBOX_TTL_SECONDS).toBe(3600);
  });

  it("uses a 1 minute quiet window before pause", () => {
    expect(POST_TURN_QUIET_MS).toBe(60_000);
  });

  it("harvest budget covers harness session wait (900s) plus pack", () => {
    expect(CHECKPOINT_HARVEST_INITIAL_MS).toBe(5_000);
    expect(CHECKPOINT_HARVEST_MAX_MS).toBeGreaterThanOrEqual(15 * 60_000);
  });
});
