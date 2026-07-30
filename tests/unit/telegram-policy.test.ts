import { describe, expect, it } from "vitest";

import { parseBotToken, parseCallbackData, parseTelegramUpdate } from "../../src/lib/telegram/policy";

function parsedLanguageCode(languageCode: unknown): string | null {
  return parseTelegramUpdate({
    message: {
      chat: { id: 42, type: "private" },
      from: { first_name: "Buyer", id: 42, is_bot: false, language_code: languageCode },
      message_id: 7,
      text: "/start",
    },
    update_id: 100,
  }).user.languageCode;
}

describe("Telegram webhook policy", () => {
  it("accepts a BotFather-shaped token and rejects malformed credentials", () => {
    expect(parseBotToken("123456789:abcdefghijklmnopqrstuvwxyzABCDE")).toContain(":");
    expect(() => parseBotToken("not-a-token")).toThrow(expect.objectContaining({ code: "validation_failed" }));
  });

  it("allowlists short callback intents instead of serialized client state", () => {
    expect(parseCallbackData("add:var_00000000-0000-4000-8000-000000000000")).toContain("var_");
    expect(parseCallbackData("key:order_00000000-0000-4000-8000-000000000000")).toContain("order_");
    expect(() => parseCallbackData('{"price":1000,"shop":"other"}')).toThrow(expect.objectContaining({ code: "telegram_callback_invalid" }));
  });

  it("parses private messages and preserves negative group chat IDs for the private-chat guard", () => {
    expect(parseTelegramUpdate({
      message: { chat: { id: 42, type: "private" }, from: { first_name: "Buyer", id: 42, is_bot: false, language_code: "vi" }, message_id: 7, text: "/start" },
      update_id: 100,
    })).toMatchObject({ chat: { id: 42, type: "private" }, kind: "message", updateId: 100 });

    expect(parseTelegramUpdate({
      message: { chat: { id: -100123456789, type: "supergroup" }, from: { first_name: "Buyer", id: 42, is_bot: false }, message_id: 8, text: "/keys" },
      update_id: 101,
    })).toMatchObject({ chat: { id: -100123456789, type: "supergroup" } });
  });

  it.each([
    [" EN-us ", "en-US"],
    ["zh-hant-tw", "zh-Hant-TW"],
    ["en-us-u-nu-latn", "en-US-u-nu-latn"],
    ["fr-fr", "fr-FR"],
  ])("canonicalizes valid Telegram BCP47 language hint %s", (input, expected) => {
    expect(parsedLanguageCode(input)).toBe(expected);
  });

  it.each(["vi_VN", "not a locale", "en--US", null, 123])("drops malformed Telegram language hint %s", (input) => {
    expect(parsedLanguageCode(input)).toBeNull();
  });

  it("rejects unsupported updates and oversized callback data", () => {
    expect(() => parseTelegramUpdate({ edited_message: {}, update_id: 102 })).toThrow(expect.objectContaining({ code: "telegram_update_unsupported" }));
    expect(() => parseCallbackData(`menu${"x".repeat(70)}`)).toThrow();
  });
});
