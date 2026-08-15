export type TelegramUser = {
  firstName: string;
  id: number;
  isBot: boolean;
  languageCode: string | null;
  lastName: string | null;
  username: string | null;
};

export type TelegramChat = {
  id: number;
  type: "channel" | "group" | "private" | "supergroup";
};

export type TelegramMessageUpdate = {
  chat: TelegramChat;
  kind: "message";
  messageId: number;
  text: string;
  updateId: number;
  user: TelegramUser;
};

export type TelegramCallbackUpdate = {
  callbackId: string;
  chat: TelegramChat;
  data: string;
  kind: "callback_query";
  messageId: number;
  updateId: number;
  user: TelegramUser;
};

// Inline callback queries have no message/chat and cannot enter private-chat
// commerce, but they must still be acknowledged and recorded to stop retries.
export type TelegramUnsupportedCallbackUpdate = {
  callbackId: string;
  kind: "unsupported_callback_query";
  updateId: number;
  user: TelegramUser;
};

export type TelegramUpdate = TelegramCallbackUpdate | TelegramMessageUpdate | TelegramUnsupportedCallbackUpdate;

export type TelegramInlineKeyboard = Array<Array<{ callback_data: string; text: string }>>;

export type TelegramWebhookInfo = {
  allowedUpdates: string[];
  hasDeliveryError: boolean;
  maxConnections: number | null;
  pendingUpdateCount: number;
  url: string;
};

export type TelegramBotIdentity = {
  displayName: string;
  id: string;
  username: string;
};
