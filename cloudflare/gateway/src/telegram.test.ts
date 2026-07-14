import { describe, expect, it } from "vitest";

import { normalizeTelegramUpdate, renderTelegramActions } from "./telegram";

describe("normalizeTelegramUpdate", () => {
  it("normalizes text, reply context, and safe media descriptors without Telegram credentials", () => {
    const event = normalizeTelegramUpdate({
      update_id: 101,
      message: {
        message_id: 22,
        chat: { id: -100456 },
        from: { id: 77 },
        caption: "Here are the files",
        reply_to_message: {
          message_id: 21,
          chat: { id: -100456 },
          from: { id: 88 },
          text: "Please review this",
          document: {
            file_id: "doc-file-id",
            file_unique_id: "doc-stable-id",
            file_name: "brief.pdf",
            mime_type: "application/pdf",
            file_size: 400,
          },
        },
        photo: [
          { file_id: "small-photo", width: 100, height: 100 },
          { file_id: "large-photo", file_unique_id: "photo-stable-id", width: 1600, height: 900, file_size: 2000 },
        ],
        video: { file_id: "video-file-id", mime_type: "video/mp4", duration: 12, width: 1920, height: 1080 },
        audio: { file_id: "audio-file-id", file_name: "song.mp3", duration: 180 },
        voice: { file_id: "voice-file-id", mime_type: "audio/ogg", duration: 3 },
      },
    });

    expect(event).toEqual({
      id: "telegram:update:101",
      type: "message",
      conversationId: "-100456",
      actorId: "77",
      message: {
        id: "22",
        text: "Here are the files",
        attachments: [
          {
            kind: "photo",
            reference: "large-photo",
            uniqueReference: "photo-stable-id",
            sizeBytes: 2000,
            width: 1600,
            height: 900,
          },
          { kind: "video", reference: "video-file-id", mimeType: "video/mp4", width: 1920, height: 1080, durationSeconds: 12 },
          { kind: "audio", reference: "audio-file-id", fileName: "song.mp3", durationSeconds: 180 },
          { kind: "voice", reference: "voice-file-id", mimeType: "audio/ogg", durationSeconds: 3 },
        ],
        replyTo: {
          id: "21",
          text: "Please review this",
          attachments: [
            {
              kind: "document",
              reference: "doc-file-id",
              uniqueReference: "doc-stable-id",
              mimeType: "application/pdf",
              fileName: "brief.pdf",
              sizeBytes: 400,
            },
          ],
        },
      },
    });
  });

  it("normalizes callback queries and marks edited messages", () => {
    expect(
      normalizeTelegramUpdate({
        update_id: 102,
        callback_query: {
          id: "callback-id",
          from: { id: 77 },
          data: "approve:42",
          message: { message_id: 31, chat: { id: 900 }, from: { id: 1 }, text: "Approve?" },
        },
      }),
    ).toEqual({
      id: "telegram:update:102",
      type: "callback",
      conversationId: "900",
      actorId: "77",
      callback: { id: "callback-id", data: "approve:42", messageId: "31" },
    });

    expect(
      normalizeTelegramUpdate({
        update_id: 103,
        edited_message: { message_id: 32, chat: { id: 900 }, from: { id: 77 }, text: "edited" },
      }),
    ).toMatchObject({ type: "message", edited: true, message: { id: "32", text: "edited" } });
  });
});

describe("renderTelegramActions", () => {
  it("keeps the legacy text response path and chunks Telegram messages", () => {
    const longText = "x".repeat(4001);
    expect(renderTelegramActions({ text: longText }, "chat-1")).toEqual([
      { method: "sendMessage", body: { chat_id: "chat-1", text: "x".repeat(4000) } },
      { method: "sendMessage", body: { chat_id: "chat-1", text: "x" } },
    ]);
  });

  it("renders allowed message, media, keyboard, and callback actions without sandbox-selected recipients", () => {
    expect(
      renderTelegramActions(
        {
          actions: [
            {
              type: "sendMessage",
              text: "Pick one",
              replyToMessageId: "12",
              inlineKeyboard: [
                [{ text: "Approve", callbackData: "approve:42" }, { text: "Open", url: "https://example.com/item" }],
                [{ text: "Bad URL", url: "javascript:alert(1)" }],
              ],
            },
            {
              type: "sendMedia",
              mediaType: "photo",
              reference: "telegram-file-id",
              caption: "Receipt",
              inlineKeyboard: [[{ text: "Details", url: "https://example.com/details" }]],
            },
            { type: "sendMedia", mediaType: "document", url: "http://unsafe.example/file.pdf" },
            { type: "answerCallbackQuery", text: "Saved", showAlert: true, url: "https://example.com/next", cacheTime: 4 },
          ],
        },
        "chat-1",
        "callback-from-update",
      ),
    ).toEqual([
      {
        method: "sendMessage",
        body: {
          chat_id: "chat-1",
          text: "Pick one",
          reply_to_message_id: "12",
          reply_markup: {
            inline_keyboard: [
              [
                { text: "Approve", callback_data: "approve:42" },
                { text: "Open", url: "https://example.com/item" },
              ],
            ],
          },
        },
      },
      {
        method: "sendPhoto",
        body: {
          chat_id: "chat-1",
          photo: "telegram-file-id",
          caption: "Receipt",
          reply_markup: { inline_keyboard: [[{ text: "Details", url: "https://example.com/details" }]] },
        },
      },
      {
        method: "answerCallbackQuery",
        body: {
          callback_query_id: "callback-from-update",
          text: "Saved",
          show_alert: true,
          url: "https://example.com/next",
          cache_time: 4,
        },
      },
    ]);
  });

  it("renders native harness actions with a button decoration and HTTPS artifact", () => {
    expect(
      renderTelegramActions(
        {
          text: "A duplicate legacy convenience value",
          actions: [
            { type: "sendMessage", text: "Choose a report" },
            { type: "inlineButtons", buttons: [[{ text: "Open", callbackData: "open:report" }]], targetActionIndex: 0 },
            { type: "sendMedia", artifact: { uri: "https://files.example.test/report.pdf", mimeType: "application/pdf" }, caption: "Your report" },
          ],
        },
        "chat-1",
      ),
    ).toEqual([
      {
        method: "sendMessage",
        body: {
          chat_id: "chat-1",
          text: "Choose a report",
          reply_markup: { inline_keyboard: [[{ text: "Open", callback_data: "open:report" }]] },
        },
      },
      {
        method: "sendDocument",
        body: { chat_id: "chat-1", document: "https://files.example.test/report.pdf", caption: "Your report" },
      },
    ]);
  });
});
