import { AppError } from "../core/errors";
import { sanitizeBotDisplayName, sanitizeBotUsername } from "./policy";
import type { TelegramBotIdentity, TelegramInlineKeyboard, TelegramWebhookInfo } from "./types";
import { telegramCommands } from "./localization";

const TELEGRAM_BASE_URL = "https://api.telegram.org";
const MAX_RESPONSE_BYTES = 256 * 1024;
const TELEGRAM_ID_MAX = 4_503_599_627_370_495n;

type TelegramEnvelope = {
  description?: unknown;
  error_code?: unknown;
  ok?: unknown;
  parameters?: unknown;
  result?: unknown;
};

export class TelegramProviderError extends AppError {
  readonly providerStatus: number;
  readonly retryAfter: number | null;

  constructor(code: string, status = 503, providerStatus = 0, retryAfter: number | null = null) {
    super(code, status);
    this.providerStatus = providerStatus;
    this.retryAfter = retryAfter;
  }
}

function requireRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new TelegramProviderError("provider_response_invalid");
  return value as Record<string, unknown>;
}

async function readBoundedEnvelope(response: Response): Promise<TelegramEnvelope> {
  const text = await response.text();
  if (new TextEncoder().encode(text).byteLength > MAX_RESPONSE_BYTES) throw new TelegramProviderError("provider_response_too_large");
  try {
    return requireRecord(JSON.parse(text));
  } catch (error) {
    if (error instanceof TelegramProviderError) throw error;
    throw new TelegramProviderError("provider_response_invalid");
  }
}

function readRetryAfter(value: unknown): number | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const retryAfter = (value as Record<string, unknown>).retry_after;
  return typeof retryAfter === "number" && Number.isSafeInteger(retryAfter) && retryAfter > 0 ? Math.min(retryAfter, 86_400) : null;
}

function mapProviderError(response: Response, envelope: TelegramEnvelope): TelegramProviderError {
  const providerStatus = typeof envelope.error_code === "number" && Number.isSafeInteger(envelope.error_code) ? envelope.error_code : response.status;
  if (providerStatus === 401) return new TelegramProviderError("telegram_unauthorized", 409, providerStatus);
  if (providerStatus === 429) return new TelegramProviderError("telegram_rate_limited", 503, providerStatus, readRetryAfter(envelope.parameters));
  if (providerStatus >= 500 || response.status >= 500) return new TelegramProviderError("provider_unavailable", 503, providerStatus);
  if (providerStatus === 400) return new TelegramProviderError("telegram_request_rejected", 409, providerStatus);
  if (providerStatus === 403) return new TelegramProviderError("telegram_recipient_unavailable", 409, providerStatus);
  return new TelegramProviderError("telegram_provider_rejected", 409, providerStatus);
}

export class TelegramClient {
  readonly botToken: string;
  readonly fetcher: typeof fetch;

  constructor(botToken: string, fetcher: typeof fetch = fetch) {
    this.botToken = botToken;
    this.fetcher = fetcher;
  }

  private async request(method: string, body: Record<string, unknown> = {}): Promise<unknown> {
    const fetcher = this.fetcher;
    let response: Response;
    try {
      response = await fetcher(`${TELEGRAM_BASE_URL}/bot${this.botToken}/${method}`, {
        body: JSON.stringify(body),
        headers: { "Content-Type": "application/json" },
        method: "POST",
        signal: AbortSignal.timeout(8_000),
      });
    } catch {
      throw new TelegramProviderError("provider_timeout");
    }
    const envelope = await readBoundedEnvelope(response);
    if (!response.ok || envelope.ok !== true || envelope.result === undefined) throw mapProviderError(response, envelope);
    return envelope.result;
  }

  async getMe(): Promise<TelegramBotIdentity> {
    const result = requireRecord(await this.request("getMe"));
    if (result.is_bot !== true || (typeof result.id !== "number" && typeof result.id !== "string")) throw new TelegramProviderError("telegram_provider_identity_invalid", 409);
    if (typeof result.id === "number" && !Number.isSafeInteger(result.id)) throw new TelegramProviderError("telegram_provider_identity_invalid", 409);
    const id = String(result.id);
    if (!/^\d{1,20}$/u.test(id) || BigInt(id) > TELEGRAM_ID_MAX) throw new TelegramProviderError("telegram_provider_identity_invalid", 409);
    return { displayName: sanitizeBotDisplayName(result.first_name), id, username: sanitizeBotUsername(result.username) };
  }

  async setMyCommands(commands: Array<{ command: string; description: string }>, languageCode?: string): Promise<void> {
    await this.request("setMyCommands", { commands, ...(languageCode === undefined ? {} : { language_code: languageCode }) });
  }

  async setChatMenuButton(): Promise<void> {
    await this.request("setChatMenuButton", { menu_button: { type: "commands" } });
  }

  async setWebhook(input: { allowedUpdates: string[]; dropPendingUpdates?: boolean; maxConnections: number; secretToken: string; url: string }): Promise<void> {
    await this.request("setWebhook", {
      allowed_updates: input.allowedUpdates,
      drop_pending_updates: input.dropPendingUpdates === true,
      max_connections: input.maxConnections,
      secret_token: input.secretToken,
      url: input.url,
    });
  }

  async getWebhookInfo(): Promise<TelegramWebhookInfo> {
    const result = requireRecord(await this.request("getWebhookInfo"));
    if (typeof result.url !== "string" || typeof result.pending_update_count !== "number" || !Number.isSafeInteger(result.pending_update_count) || result.pending_update_count < 0) throw new TelegramProviderError("provider_response_invalid");
    const allowedUpdates = Array.isArray(result.allowed_updates) ? result.allowed_updates.filter((value): value is string => typeof value === "string") : [];
    return {
      allowedUpdates,
      hasDeliveryError: typeof result.last_error_date === "number" || typeof result.last_error_message === "string",
      maxConnections: typeof result.max_connections === "number" && Number.isSafeInteger(result.max_connections) ? result.max_connections : null,
      pendingUpdateCount: result.pending_update_count,
      url: result.url,
    };
  }

  async deleteWebhook(dropPendingUpdates = false): Promise<void> {
    await this.request("deleteWebhook", { drop_pending_updates: dropPendingUpdates });
  }

  async sendMessage(input: { chatId: string; keyboard?: TelegramInlineKeyboard; protectContent?: boolean; text: string }): Promise<void> {
    if (input.text.length === 0 || input.text.length > 4096) throw new AppError("telegram_message_invalid", 500);
    await this.request("sendMessage", {
      chat_id: input.chatId,
      link_preview_options: { is_disabled: true },
      protect_content: input.protectContent === true,
      ...(input.keyboard === undefined ? {} : { reply_markup: { inline_keyboard: input.keyboard } }),
      text: input.text,
    });
  }

  async answerCallbackQuery(callbackQueryId: string, text?: string): Promise<void> {
    await this.request("answerCallbackQuery", { callback_query_id: callbackQueryId, ...(text === undefined ? {} : { text: text.slice(0, 200) }) });
  }
}

export const TELEGRAM_DEFAULT_COMMANDS = telegramCommands("en");
export const TELEGRAM_VI_COMMANDS = telegramCommands("vi-VN");
