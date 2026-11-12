import type { InlineKeyboardMarkup, TelegramReplyMarkup } from "./types";
import { persianNumber } from "./time";

interface TelegramResponse<T> {
  ok: boolean;
  result?: T;
  description?: string;
  error_code?: number;
}

export class TelegramError extends Error {
  constructor(
    message: string,
    readonly code: number | undefined,
  ) {
    super(message);
  }
}

export interface SentMessage {
  message_id: number;
  chat: { id: number };
  audio?: {
    file_id: string;
    file_unique_id: string;
    duration: number;
    file_name?: string;
    file_size?: number;
  };
}

export interface OutgoingTextMessage {
  text: string;
  keyboard?: TelegramReplyMarkup;
}

interface EphemeralOwner {
  telegram_user_id: number;
  ephemeral_generation: number;
  last_ephemeral_message_ids_json: string | null;
}

export class TelegramClient {
  constructor(
    private readonly token: string,
    private readonly db?: D1Database,
  ) {}

  async sendMessage(chatId: number, text: string, keyboard?: TelegramReplyMarkup): Promise<SentMessage> {
    const [sent] = await this.sendEphemeralMessages(chatId, [{ text, ...(keyboard ? { keyboard } : {}) }]);
    if (!sent) throw new Error("Telegram did not return an ephemeral message");
    return sent;
  }

  async sendEphemeralMessages(chatId: number, messages: OutgoingTextMessage[]): Promise<SentMessage[]> {
    const reservation = await this.reserveEphemeralSlot(chatId);
    const sent: SentMessage[] = [];
    try {
      for (const message of messages) sent.push(await this.sendMessageRaw(chatId, message.text, message.keyboard));
    } catch (error) {
      await this.deleteMessages(chatId, sent.map((message) => message.message_id));
      throw error;
    }
    if (!reservation || !this.db) return sent;
    const stored = await this.db.prepare(`
      UPDATE users SET last_ephemeral_message_ids_json = ?
      WHERE telegram_user_id = ? AND ephemeral_generation = ?
    `).bind(JSON.stringify(sent.map((message) => message.message_id)), reservation.userId, reservation.generation).run();
    if ((stored.meta.changes ?? 0) !== 1) {
      await this.deleteMessages(chatId, sent.map((message) => message.message_id));
    }
    return sent;
  }

  async sendPersistentMessages(chatId: number, messages: OutgoingTextMessage[]): Promise<SentMessage[]> {
    await this.clearEphemeralMessages(chatId);
    const sent: SentMessage[] = [];
    try {
      for (const message of messages) sent.push(await this.sendMessageRaw(chatId, message.text, message.keyboard));
      return sent;
    } catch (error) {
      await this.deleteMessages(chatId, sent.map((message) => message.message_id));
      throw error;
    }
  }

  async clearEphemeralMessages(chatId: number): Promise<void> {
    await this.reserveEphemeralSlot(chatId);
  }

  private sendMessageRaw(chatId: number, text: string, keyboard?: TelegramReplyMarkup): Promise<SentMessage> {
    return this.call<SentMessage>("sendMessage", {
      chat_id: chatId,
      text,
      parse_mode: "HTML",
      disable_web_page_preview: true,
      ...(keyboard ? { reply_markup: keyboard } : {}),
    });
  }

  async sendAudio(chatId: number, fileId: string, caption: string, keyboard?: InlineKeyboardMarkup, duration?: number): Promise<SentMessage> {
    await this.clearEphemeralMessages(chatId);
    return this.call<SentMessage>("sendAudio", {
      chat_id: chatId,
      audio: fileId,
      caption,
      parse_mode: "HTML",
      ...(duration && duration > 0 ? { duration } : {}),
      ...(keyboard ? { reply_markup: keyboard } : {}),
    });
  }

  async uploadAudio(chatId: string, bytes: ArrayBuffer, fileName: string, lessonNumber: number, duration?: number): Promise<SentMessage> {
    const body = new FormData();
    body.set("chat_id", chatId);
    body.set("caption", `ACIM Farsi — درس ${persianNumber(lessonNumber)} از ۳۶۵`);
    body.set("title", `درس ${persianNumber(lessonNumber)} از ۳۶۵`);
    body.set("performer", "ACIM Farsi");
    if (duration && duration > 0) body.set("duration", String(duration));
    body.set("disable_notification", "true");
    body.set("audio", new Blob([bytes], { type: "audio/mpeg" }), fileName);
    const response = await fetch(`https://api.telegram.org/bot${this.token}/sendAudio`, {
      method: "POST",
      body,
      signal: AbortSignal.timeout(120_000),
    });
    return this.readResponse<SentMessage>(response, "Telegram sendAudio upload failed");
  }

  deleteMessage(chatId: string | number, messageId: number): Promise<true> {
    return this.call<true>("deleteMessage", {
      chat_id: chatId,
      message_id: messageId,
    });
  }

  editMessageText(chatId: number, messageId: number, text: string, keyboard?: InlineKeyboardMarkup): Promise<SentMessage> {
    return this.call<SentMessage>("editMessageText", {
      chat_id: chatId,
      message_id: messageId,
      text,
      parse_mode: "HTML",
      disable_web_page_preview: true,
      ...(keyboard ? { reply_markup: keyboard } : {}),
    });
  }

  editKeyboard(chatId: number, messageId: number, keyboard: InlineKeyboardMarkup): Promise<true> {
    return this.call<true>("editMessageReplyMarkup", {
      chat_id: chatId,
      message_id: messageId,
      reply_markup: keyboard,
    });
  }

  answerCallback(id: string, text?: string): Promise<true> {
    return this.call<true>("answerCallbackQuery", {
      callback_query_id: id,
      ...(text ? { text } : {}),
    });
  }

  private async reserveEphemeralSlot(chatId: number): Promise<{ userId: number; generation: number } | null> {
    if (!this.db) return null;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const owner = await this.db.prepare(`
        SELECT telegram_user_id, ephemeral_generation, last_ephemeral_message_ids_json
        FROM users WHERE chat_id = ? LIMIT 1
      `).bind(chatId).first<EphemeralOwner>();
      if (!owner) return null;
      const generation = owner.ephemeral_generation + 1;
      const claimed = await this.db.prepare(`
        UPDATE users
        SET ephemeral_generation = ?, last_ephemeral_message_ids_json = NULL
        WHERE telegram_user_id = ? AND ephemeral_generation = ?
      `).bind(generation, owner.telegram_user_id, owner.ephemeral_generation).run();
      if ((claimed.meta.changes ?? 0) !== 1) continue;
      await this.deleteMessages(chatId, parseMessageIds(owner.last_ephemeral_message_ids_json));
      return { userId: owner.telegram_user_id, generation };
    }
    throw new Error("Could not reserve the ephemeral message slot");
  }

  private async deleteMessages(chatId: number, messageIds: number[]): Promise<void> {
    await Promise.all(messageIds.map((messageId) => this.deleteMessage(chatId, messageId).catch(() => undefined)));
  }

  private async call<T>(method: string, payload: Record<string, unknown>): Promise<T> {
    const response = await fetch(`https://api.telegram.org/bot${this.token}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(10_000),
    });
    return this.readResponse<T>(response, `Telegram ${method} failed`);
  }

  private async readResponse<T>(response: Response, fallback: string): Promise<T> {
    const result = (await response.json()) as TelegramResponse<T>;
    if (!response.ok || !result.ok || result.result === undefined) {
      throw new TelegramError(result.description ?? fallback, result.error_code);
    }
    return result.result;
  }
}

function parseMessageIds(value: string | null): number[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is number => Number.isSafeInteger(item) && item > 0);
  } catch {
    return [];
  }
}
