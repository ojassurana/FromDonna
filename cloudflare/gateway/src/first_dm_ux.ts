/**
 * First-DM interview UX while the gateway provisions a new user's sandbox.
 *
 * Worker-owned (bot token stays on the edge). Parallel editMessageText animation
 * during provision; on success delete the loader and send Donna's welcome.
 * The bootstrap-triggering update is intentionally NOT injected.
 */

export const FIRST_DM_INTERVIEW_BASE =
  "Interviewing your new assistant. She’s hiring herself";

export const FIRST_DM_WELCOME =
  "Let’s skip the part where I list what I can do and you nod politely.\n" +
  "Text me like I’ve worked for you for years. The rest sorts itself out.\n" +
  "— Donna";

/** Trailing-dot frames for editMessageText animation. */
export const DOT_FRAMES = ["", ".", "..", "..."] as const;

/** Target interval between edits (~fast; Telegram flood-control errors are ignored). */
export const ANIM_INTERVAL_MS = 350;

export type TelegramCaller = (
  method: string,
  body: Record<string, unknown>,
) => Promise<unknown>;

export function interviewText(frameIndex: number): string {
  const frame = DOT_FRAMES[((frameIndex % DOT_FRAMES.length) + DOT_FRAMES.length) % DOT_FRAMES.length];
  return FIRST_DM_INTERVIEW_BASE + frame;
}

function messageIdFromSendResult(payload: unknown): number | string | null {
  if (!payload || typeof payload !== "object") return null;
  const result = (payload as { result?: unknown }).result;
  if (!result || typeof result !== "object") return null;
  const id = (result as { message_id?: unknown }).message_id;
  if (typeof id === "number" || typeof id === "string") return id;
  return null;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export type RunFirstDmProvisionUxOptions<T> = {
  chatId: string | number;
  telegramCall: TelegramCaller;
  provision: () => Promise<T>;
  /** Injectable for tests. */
  sleep?: (ms: number) => Promise<void>;
  intervalMs?: number;
};

/**
 * Send interview loader, animate dots while `provision` runs, then delete loader
 * and send welcome on success. On failure: stop anim, best-effort delete, rethrow
 * (no welcome).
 */
export async function runFirstDmProvisionUx<T>(
  opts: RunFirstDmProvisionUxOptions<T>,
): Promise<T> {
  const sleep = opts.sleep ?? defaultSleep;
  const intervalMs = opts.intervalMs ?? ANIM_INTERVAL_MS;
  const { chatId, telegramCall, provision } = opts;

  // Start on full "..." so the first paint matches product copy.
  const sent = await telegramCall("sendMessage", {
    chat_id: chatId,
    text: interviewText(3),
  });
  const messageId = messageIdFromSendResult(sent);
  if (messageId == null) {
    throw new Error("Telegram sendMessage did not return message_id for first-DM interview.");
  }

  let stopped = false;
  /** Resolves the in-flight anim sleep so teardown does not wait a full interval. */
  let wakeAnimSleep: (() => void) | null = null;

  const animSleep = (ms: number) =>
    new Promise<void>((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        if (wakeAnimSleep === finish) wakeAnimSleep = null;
        resolve();
      };
      wakeAnimSleep = finish;
      void sleep(ms).then(finish, finish);
    });

  const anim = (async () => {
    let i = 3;
    while (!stopped) {
      await animSleep(intervalMs);
      if (stopped) break;
      i = (i + 1) % DOT_FRAMES.length;
      try {
        await telegramCall("editMessageText", {
          chat_id: chatId,
          message_id: messageId,
          text: interviewText(i),
        });
      } catch {
        // Flood control / "message is not modified" — keep looping.
      }
    }
  })();

  const stopAndDelete = async () => {
    stopped = true;
    wakeAnimSleep?.();
    await anim.catch(() => {});
    try {
      await telegramCall("deleteMessage", {
        chat_id: chatId,
        message_id: messageId,
      });
    } catch {
      // Best-effort; welcome may briefly coexist with a stuck loader.
    }
  };

  try {
    const row = await provision();
    await stopAndDelete();
    await telegramCall("sendMessage", {
      chat_id: chatId,
      text: FIRST_DM_WELCOME,
    });
    return row;
  } catch (error) {
    await stopAndDelete();
    throw error;
  }
}
