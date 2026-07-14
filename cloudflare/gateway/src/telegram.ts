/**
 * Telegram-specific shapes at the Worker edge. Everything exported as an event
 * or action is deliberately channel-neutral apart from opaque artifact IDs.
 * Telegram credentials and file download URLs never cross the sandbox boundary.
 */

export type TelegramChat = { id: number | string };
export type TelegramUser = { id: number | string };

export type TelegramPhoto = {
  file_id: string;
  file_unique_id?: string;
  file_size?: number;
  width?: number;
  height?: number;
};

export type TelegramFile = {
  file_id: string;
  file_unique_id?: string;
  file_size?: number;
  mime_type?: string;
  file_name?: string;
  duration?: number;
  width?: number;
  height?: number;
};

export type TelegramMessage = {
  message_id: number | string;
  chat: TelegramChat;
  from?: TelegramUser;
  text?: string;
  caption?: string;
  reply_to_message?: TelegramMessage;
  photo?: TelegramPhoto[];
  video?: TelegramFile;
  document?: TelegramFile;
  audio?: TelegramFile;
  voice?: TelegramFile;
};

export type TelegramCallbackQuery = {
  id: string;
  from?: TelegramUser;
  data?: string;
  message?: TelegramMessage;
};

export type TelegramUpdate = {
  update_id: number | string;
  message?: TelegramMessage;
  edited_message?: TelegramMessage;
  callback_query?: TelegramCallbackQuery;
};

export type ArtifactKind = "photo" | "video" | "document" | "audio" | "voice";

/**
 * A reusable Telegram file reference and non-sensitive metadata only. The
 * sandbox cannot turn this into a download request because it never receives
 * the bot token.
 */
export type ArtifactDescriptor = {
  kind: ArtifactKind;
  reference: string;
  uniqueReference?: string;
  mimeType?: string;
  fileName?: string;
  sizeBytes?: number;
  width?: number;
  height?: number;
  durationSeconds?: number;
};

export type MessageContext = {
  id: string;
  text?: string;
  attachments: ArtifactDescriptor[];
  replyTo?: MessageContext;
};

export type NormalizedTelegramEvent =
  | {
      id: string;
      type: "message";
      conversationId: string;
      actorId: string;
      message: MessageContext;
      edited?: true;
    }
  | {
      id: string;
      type: "callback";
      conversationId: string;
      actorId: string;
      callback: { id: string; data?: string; messageId?: string };
    };

export type InlineKeyboardButton = {
  text: string;
  callbackData?: string;
  url?: string;
};

type LegacyHarnessAction =
  | {
      type: "sendMessage";
      text: string;
      replyToMessageId?: string;
      inlineKeyboard?: InlineKeyboardButton[][];
    }
  | {
      type: "sendMedia";
      mediaType: ArtifactKind;
      /** An opaque Telegram file ID supplied by a previous event. */
      reference?: string;
      /** A public HTTPS URL Telegram can fetch directly. */
      url?: string;
      caption?: string;
      replyToMessageId?: string;
      inlineKeyboard?: InlineKeyboardButton[][];
    }
  | {
      type: "answerCallbackQuery";
      text?: string;
      showAlert?: boolean;
      url?: string;
      cacheTime?: number;
    };

/** The native FromDonna harness contract: no chat IDs, bot token, or Telegram file IDs. */
type HarnessArtifact = { uri: string; name?: string; mimeType?: string };
type NativeHarnessAction =
  | { type: "sendMessage"; text: string }
  | { type: "sendMedia"; artifact: HarnessArtifact; caption?: string }
  | { type: "inlineButtons"; buttons: InlineKeyboardButton[][]; targetActionIndex?: number };

export type HarnessAction = LegacyHarnessAction | NativeHarnessAction;

export type HarnessReply = { text?: string; actions?: HarnessAction[] };
export type TelegramApiCall = { method: string; body: Record<string, unknown> };

function optionalText(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function photoDescriptor(photos: TelegramPhoto[]): ArtifactDescriptor | undefined {
  const photo = photos.reduce<TelegramPhoto | undefined>((largest, candidate) => {
    if (!largest) return candidate;
    const largestArea = (largest.width ?? 0) * (largest.height ?? 0);
    const candidateArea = (candidate.width ?? 0) * (candidate.height ?? 0);
    return candidateArea >= largestArea ? candidate : largest;
  }, undefined);
  if (!photo?.file_id) return undefined;
  return {
    kind: "photo",
    reference: photo.file_id,
    ...(optionalText(photo.file_unique_id) ? { uniqueReference: photo.file_unique_id } : {}),
    ...(typeof photo.file_size === "number" ? { sizeBytes: photo.file_size } : {}),
    ...(typeof photo.width === "number" ? { width: photo.width } : {}),
    ...(typeof photo.height === "number" ? { height: photo.height } : {}),
  };
}

function fileDescriptor(kind: Exclude<ArtifactKind, "photo">, file: TelegramFile | undefined): ArtifactDescriptor | undefined {
  if (!file?.file_id) return undefined;
  return {
    kind,
    reference: file.file_id,
    ...(optionalText(file.file_unique_id) ? { uniqueReference: file.file_unique_id } : {}),
    ...(optionalText(file.mime_type) ? { mimeType: file.mime_type } : {}),
    ...(optionalText(file.file_name) ? { fileName: file.file_name } : {}),
    ...(typeof file.file_size === "number" ? { sizeBytes: file.file_size } : {}),
    ...(typeof file.width === "number" ? { width: file.width } : {}),
    ...(typeof file.height === "number" ? { height: file.height } : {}),
    ...(typeof file.duration === "number" ? { durationSeconds: file.duration } : {}),
  };
}

function attachmentsFor(message: TelegramMessage): ArtifactDescriptor[] {
  return [
    message.photo ? photoDescriptor(message.photo) : undefined,
    fileDescriptor("video", message.video),
    fileDescriptor("document", message.document),
    fileDescriptor("audio", message.audio),
    fileDescriptor("voice", message.voice),
  ].filter((artifact): artifact is ArtifactDescriptor => artifact !== undefined);
}

function messageContext(message: TelegramMessage): MessageContext {
  return {
    id: String(message.message_id),
    // Telegram captions are user-authored message text too.
    ...(optionalText(message.text ?? message.caption) ? { text: message.text ?? message.caption } : {}),
    attachments: attachmentsFor(message),
  };
}

/** Converts supported Telegram updates to a sandbox-facing neutral event. */
export function normalizeTelegramUpdate(update: TelegramUpdate): NormalizedTelegramEvent | null {
  const callback = update.callback_query;
  if (callback?.from && callback.message) {
    return {
      id: `telegram:update:${update.update_id}`,
      type: "callback",
      conversationId: String(callback.message.chat.id),
      actorId: String(callback.from.id),
      callback: {
        id: callback.id,
        ...(optionalText(callback.data) ? { data: callback.data } : {}),
        messageId: String(callback.message.message_id),
      },
    };
  }

  const message = update.message ?? update.edited_message;
  if (!message?.from) return null;
  return {
    id: `telegram:update:${update.update_id}`,
    type: "message",
    conversationId: String(message.chat.id),
    actorId: String(message.from.id),
    message: {
      ...messageContext(message),
      ...(message.reply_to_message ? { replyTo: messageContext(message.reply_to_message) } : {}),
    },
    ...(update.edited_message ? { edited: true } : {}),
  };
}

export function splitTelegramText(text: string): string[] {
  const chunks: string[] = [];
  for (let index = 0; index < text.length; index += 4000) chunks.push(text.slice(index, index + 4000));
  return chunks;
}

function safeHttpsUrl(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    return new URL(value).protocol === "https:" ? value : undefined;
  } catch {
    return undefined;
  }
}

function replyMarkup(buttons: InlineKeyboardButton[][] | undefined): Record<string, unknown> | undefined {
  if (!buttons) return undefined;
  const inlineKeyboard = buttons
    .map((row) =>
      row.flatMap((button) => {
        if (!button || !optionalText(button.text)) return [];
        const url = safeHttpsUrl(button.url);
        const callbackData = optionalText(button.callbackData);
        if (!url && !callbackData) return [];
        return [{ text: button.text, ...(url ? { url } : { callback_data: callbackData }) }];
      }),
    )
    .filter((row) => row.length > 0);
  return inlineKeyboard.length > 0 ? { inline_keyboard: inlineKeyboard } : undefined;
}

type LegacyDeliveryAction = Exclude<LegacyHarnessAction, { type: "answerCallbackQuery" }>;
type LegacyMediaAction = Extract<LegacyHarnessAction, { type: "sendMedia" }>;
type NativeMediaAction = Extract<NativeHarnessAction, { type: "sendMedia" }>;
type DeliveryAction = Extract<HarnessAction, { type: "sendMessage" | "sendMedia" }>;

function isNativeMedia(action: Extract<HarnessAction, { type: "sendMedia" }>): action is NativeMediaAction {
  return "artifact" in action;
}

function withOptionalMessageFields(
  body: Record<string, unknown>,
  action: DeliveryAction,
  attachedButtons?: InlineKeyboardButton[][],
): Record<string, unknown> {
  const legacy = action as LegacyDeliveryAction;
  const replyToMessageId = optionalText(legacy.replyToMessageId);
  const markup = replyMarkup(attachedButtons ?? legacy.inlineKeyboard);
  return {
    ...body,
    ...(replyToMessageId ? { reply_to_message_id: replyToMessageId } : {}),
    ...(markup ? { reply_markup: markup } : {}),
  };
}

function mediaSource(action: Extract<HarnessAction, { type: "sendMedia" }>): string | undefined {
  if (isNativeMedia(action)) return safeHttpsUrl(action.artifact.uri);
  const legacy = action as LegacyMediaAction;
  // A legacy reference is an opaque Telegram file ID; legacy URLs are HTTPS-only.
  return optionalText(legacy.reference) ?? safeHttpsUrl(legacy.url);
}

function mediaField(action: Extract<HarnessAction, { type: "sendMedia" }>): ArtifactKind {
  if (!isNativeMedia(action)) return (action as LegacyMediaAction).mediaType;
  const mime = action.artifact.mimeType?.toLowerCase() ?? "";
  if (mime.startsWith("image/")) return "photo";
  if (mime.startsWith("video/")) return "video";
  if (mime.startsWith("audio/")) return "audio";
  return "document";
}

/**
 * Renders sandbox actions into a small allowlist of Telegram Bot API calls.
 * The sandbox never controls the recipient chat or callback query ID.
 */
export function renderTelegramActions(
  reply: HarnessReply,
  chatId: string,
  callbackQueryId?: string,
): TelegramApiCall[] {
  // Action envelopes are authoritative. Harness keeps `text` for legacy clients,
  // but it also records ordinary final text as a sendMessage action; rendering
  // both would send every response twice.
  const legacyText = optionalText(reply.text);
  const actions: HarnessAction[] = Array.isArray(reply.actions)
    ? [...reply.actions]
    : legacyText
      ? [{ type: "sendMessage", text: legacyText }]
      : [];

  // A button action decorates a preceding (or explicitly indexed) outgoing
  // action. Keeping the recipient entirely here preserves the sandbox boundary.
  const buttonsForAction = new Map<number, InlineKeyboardButton[][]>();
  actions.forEach((action, index) => {
    if (action.type !== "inlineButtons") return;
    const target = action.targetActionIndex ?? index - 1;
    if (target >= 0 && target < actions.length && actions[target]?.type !== "inlineButtons") {
      buttonsForAction.set(target, action.buttons);
    }
  });

  const calls: TelegramApiCall[] = [];
  actions.forEach((action, index) => {
    if (action.type === "inlineButtons") return;
    const buttons = buttonsForAction.get(index);

    if (action.type === "sendMessage") {
      const text = optionalText(action.text);
      if (!text) return;
      const chunks = splitTelegramText(text);
      chunks.forEach((chunk, chunkIndex) => {
        calls.push({
          method: "sendMessage",
          body: withOptionalMessageFields({ chat_id: chatId, text: chunk }, action, chunkIndex === chunks.length - 1 ? buttons : undefined),
        });
      });
      return;
    }

    if (action.type === "sendMedia") {
      const source = mediaSource(action);
      if (!source) return;
      const field = mediaField(action);
      const method = `send${field[0].toUpperCase()}${field.slice(1)}`;
      calls.push({
        method,
        body: withOptionalMessageFields(
          {
            chat_id: chatId,
            [field]: source,
            ...(optionalText(action.caption) ? { caption: action.caption } : {}),
          },
          action,
          buttons,
        ),
      });
      return;
    }

    if (action.type === "answerCallbackQuery" && callbackQueryId) {
      const url = safeHttpsUrl(action.url);
      calls.push({
        method: "answerCallbackQuery",
        body: {
          callback_query_id: callbackQueryId,
          ...(optionalText(action.text) ? { text: action.text } : {}),
          ...(typeof action.showAlert === "boolean" ? { show_alert: action.showAlert } : {}),
          ...(url ? { url } : {}),
          ...(typeof action.cacheTime === "number" ? { cache_time: action.cacheTime } : {}),
        },
      });
    }
  });
  return calls;
}
