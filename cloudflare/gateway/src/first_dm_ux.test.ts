import assert from "node:assert/strict";
import { describe, it } from "vitest";
import {
  DOT_FRAMES,
  FIRST_DM_INTERVIEW_BASE,
  FIRST_DM_WELCOME,
  interviewText,
  runFirstDmProvisionUx,
} from "./first_dm_ux";

describe("interviewText", () => {
  it("cycles trailing dots including empty frame", () => {
    assert.equal(interviewText(0), FIRST_DM_INTERVIEW_BASE);
    assert.equal(interviewText(1), FIRST_DM_INTERVIEW_BASE + ".");
    assert.equal(interviewText(2), FIRST_DM_INTERVIEW_BASE + "..");
    assert.equal(interviewText(3), FIRST_DM_INTERVIEW_BASE + "...");
    assert.equal(interviewText(4), FIRST_DM_INTERVIEW_BASE);
    assert.equal(DOT_FRAMES.length, 4);
  });
});

describe("runFirstDmProvisionUx", () => {
  type Call = { method: string; body: Record<string, unknown> };

  function mockTelegram(calls: Call[], opts?: { failEdit?: boolean }) {
    return async (method: string, body: Record<string, unknown>) => {
      calls.push({ method, body });
      if (method === "sendMessage" && body.text === FIRST_DM_WELCOME) {
        return { ok: true, result: { message_id: 99 } };
      }
      if (method === "sendMessage") {
        return { ok: true, result: { message_id: 42 } };
      }
      if (method === "editMessageText" && opts?.failEdit) {
        throw new Error("Flood control");
      }
      if (method === "editMessageText" || method === "deleteMessage") {
        return { ok: true, result: true };
      }
      return { ok: true };
    };
  }

  it("animates during provision then deletes and sends welcome", async () => {
    const calls: Call[] = [];

    const result = await runFirstDmProvisionUx({
      chatId: "chat-1",
      telegramCall: mockTelegram(calls),
      intervalMs: 15,
      provision: async () => {
        // Long enough for several edit frames at 15ms.
        await new Promise((r) => setTimeout(r, 70));
        return "ready-row";
      },
    });

    assert.equal(result, "ready-row");
    assert.equal(calls[0]?.method, "sendMessage");
    assert.equal(calls[0]?.body.chat_id, "chat-1");
    assert.equal(calls[0]?.body.text, FIRST_DM_INTERVIEW_BASE + "...");

    const edits = calls.filter((c) => c.method === "editMessageText");
    assert.ok(edits.length >= 1, "expected at least one editMessageText");
    for (const edit of edits) {
      assert.equal(edit.body.message_id, 42);
      assert.ok(String(edit.body.text).startsWith(FIRST_DM_INTERVIEW_BASE));
    }

    const methods = calls.map((c) => c.method);
    const deleteIdx = methods.indexOf("deleteMessage");
    const welcomeIdx = methods.findIndex(
      (m, i) => m === "sendMessage" && i > 0 && calls[i]?.body.text === FIRST_DM_WELCOME,
    );
    assert.ok(deleteIdx >= 0, "expected deleteMessage");
    assert.ok(welcomeIdx >= 0, "expected welcome sendMessage");
    assert.ok(deleteIdx < welcomeIdx, "delete must precede welcome");
    assert.equal(calls[deleteIdx]?.body.message_id, 42);
  });

  it("on provision failure deletes interview and does not send welcome", async () => {
    const calls: Call[] = [];

    await assert.rejects(
      runFirstDmProvisionUx({
        chatId: 7,
        telegramCall: mockTelegram(calls, { failEdit: true }),
        intervalMs: 15,
        provision: async () => {
          await new Promise((r) => setTimeout(r, 40));
          throw new Error("E2B create failed");
        },
      }),
      /E2B create failed/,
    );

    assert.ok(calls.some((c) => c.method === "deleteMessage"));
    assert.ok(!calls.some((c) => c.method === "sendMessage" && c.body.text === FIRST_DM_WELCOME));
  });

  it("throws if sendMessage omits message_id", async () => {
    await assert.rejects(
      runFirstDmProvisionUx({
        chatId: "x",
        telegramCall: async () => ({ ok: true, result: {} }),
        provision: async () => "nope",
      }),
      /message_id/,
    );
  });
});
