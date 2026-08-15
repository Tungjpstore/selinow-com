import { AppError } from "../core/errors";
import { canonicalizeLocale } from "../i18n/locale";
import type { TelegramCallbackUpdate, TelegramChat, TelegramMessageUpdate, TelegramUpdate, TelegramUser } from "./types";

const BOT_TOKEN_PATTERN = /^\d{6,20}:[A-Za-z0-9_-]{20,128}$/u;
const CALLBACK_PATTERN = /^(?:add:var_[0-9a-f-]{36}|cart|buy|menu|pay:order_[0-9a-f-]{36}|ord:order_[0-9a-f-]{36}|key:order_[0-9a-f-]{36})$/u;
const TELEGRAM_ID_MAX = 4_503_599_627_370_495n;

function requireRecord(value: unknown, issue: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new AppError("telegram_update_invalid", 400, [issue]);
  return value as Record<string, unknown>;
}

function requireInteger(value: unknown, issue: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new AppError("telegram_update_invalid", 400, [issue]);
  return value;
}

function requireSignedInteger(value: unknown, issue: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) throw new AppError("telegram_update_invalid", 400, [issue]);
  return value;
}

function requireTelegramUserId(value: unknown): number {
  const id = requireInteger(value, "user_id_invalid");
  if (BigInt(id) > TELEGRAM_ID_MAX) throw new AppError("telegram_update_invalid", 400, ["user_id_invalid"]);
  return id;
}

function requireTelegramChatId(value: unknown): number {
  const id = requireSignedInteger(value, "chat_id_invalid");
  const magnitude = BigInt(id < 0 ? -id : id);
  if (magnitude > TELEGRAM_ID_MAX) throw new AppError("telegram_update_invalid", 400, ["chat_id_invalid"]);
  return id;
}

function sanitizeText(value: unknown, maximum: number): string | null {
  if (typeof value !== "string") return null;
  const normalized = Array.from(value).filter((character) => {
    const code = character.charCodeAt(0);
    return code > 31 && code !== 127;
  }).join("").trim().replace(/\s+/gu, " ");
  return normalized.length === 0 ? null : normalized.slice(0, maximum);
}

function parseUser(value: unknown): TelegramUser {
  const row = requireRecord(value, "user_invalid");
  const firstName = sanitizeText(row.first_name, 80);
  if (firstName === null || typeof row.is_bot !== "boolean") throw new AppError("telegram_update_invalid", 400, ["user_invalid"]);
  const username = sanitizeText(row.username, 64);
  const languageCode = canonicalizeLocale(sanitizeText(row.language_code, 128));
  return {
    firstName,
    id: requireTelegramUserId(row.id),
    isBot: row.is_bot,
    languageCode,
    lastName: sanitizeText(row.last_name, 80),
    username: username !== null && /^[A-Za-z0-9_]{3,64}$/u.test(username) ? username : null,
  };
}

function parseChat(value: unknown): TelegramChat {
  const row = requireRecord(value, "chat_invalid");
  if (!new Set(["channel", "group", "private", "supergroup"]).has(String(row.type))) throw new AppError("telegram_update_invalid", 400, ["chat_type_invalid"]);
  return { id: requireTelegramChatId(row.id), type: row.type as TelegramChat["type"] };
}

export function parseBotToken(value: unknown): string {
  if (typeof value !== "string") throw new AppError("validation_failed", 400, ["bot_token_required"]);
  const token = value.trim();
  if (!BOT_TOKEN_PATTERN.test(token)) throw new AppError("validation_failed", 400, ["bot_token_invalid"]);
  return token;
}

export function parseConnectTelegramBody(body: Record<string, unknown>): { botToken: string; replaceBot: boolean } {
  if (Object.keys(body).some((field) => !new Set(["botToken", "replaceBot"]).has(field))) throw new AppError("validation_failed", 400, ["credential_fields_invalid"]);
  if (body.replaceBot !== undefined && typeof body.replaceBot !== "boolean") throw new AppError("validation_failed", 400, ["replace_bot_invalid"]);
  return { botToken: parseBotToken(body.botToken), replaceBot: body.replaceBot === true };
}

export function parseCallbackData(value: unknown): string {
  if (typeof value !== "string" || new TextEncoder().encode(value).byteLength > 64 || !CALLBACK_PATTERN.test(value)) throw new AppError("telegram_callback_invalid", 400);
  return value;
}

export function parseTelegramUpdate(body: Record<string, unknown>): TelegramUpdate {
  const updateId = requireInteger(body.update_id, "update_id_invalid");
  if (body.message !== undefined) {
    const message = requireRecord(body.message, "message_invalid");
    const text = sanitizeText(message.text, 4096) ?? "";
    const update: TelegramMessageUpdate = {
      chat: parseChat(message.chat),
      kind: "message",
      messageId: requireInteger(message.message_id, "message_id_invalid"),
      text,
      updateId,
      user: parseUser(message.from),
    };
    return update;
  }
  if (body.callback_query !== undefined) {
    const callback = requireRecord(body.callback_query, "callback_query_invalid");
    const callbackId = sanitizeText(callback.id, 128);
    if (callbackId === null) throw new AppError("telegram_update_invalid", 400, ["callback_id_invalid"]);
    const user = parseUser(callback.from);
    const inlineMessageId = sanitizeText(callback.inline_message_id, 256);
    if ((callback.message === undefined || callback.message === null) && inlineMessageId !== null) {
      return { callbackId, kind: "unsupported_callback_query", updateId, user };
    }
    const message = requireRecord(callback.message, "callback_message_invalid");
    const update: TelegramCallbackUpdate = {
      callbackId,
      chat: parseChat(message.chat),
      data: parseCallbackData(callback.data),
      kind: "callback_query",
      messageId: requireInteger(message.message_id, "message_id_invalid"),
      updateId,
      user,
    };
    return update;
  }
  throw new AppError("telegram_update_unsupported", 400);
}

export function normalizeDiscountCode(value: string): string {
  const normalized = value.trim().toUpperCase();
  if (!/^[A-Z0-9_-]{3,32}$/u.test(normalized)) throw new AppError("discount_invalid", 409);
  return normalized;
}

export function sanitizeBotUsername(value: unknown): string {
  if (typeof value !== "string") throw new AppError("telegram_provider_identity_invalid", 409);
  const username = value.trim();
  if (!/^[A-Za-z0-9_]{5,64}bot$/iu.test(username)) throw new AppError("telegram_provider_identity_invalid", 409);
  return username;
}

export function sanitizeBotDisplayName(value: unknown): string {
  const displayName = sanitizeText(value, 80);
  if (displayName === null) throw new AppError("telegram_provider_identity_invalid", 409);
  return displayName;
}
