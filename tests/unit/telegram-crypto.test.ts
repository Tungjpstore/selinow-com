import { describe, expect, it } from "vitest";

import { decryptTelegramChatId, decryptTelegramCredential, encryptTelegramChatId, encryptTelegramCredential } from "../../src/lib/telegram/crypto";

const KEK = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

describe("Telegram credential encryption", () => {
  it("encrypts token and webhook secret with tenant-bound AAD", async () => {
    const context = { credentialId: "credential-a", hmacSecret: "identifier-secret", integrationId: "integration-a", kek: KEK, keyVersion: "v1", shopId: "shop-a" };
    const encrypted = await encryptTelegramCredential({ ...context, botToken: "123456789:abcdefghijklmnopqrstuvwxyzABCDE", webhookSecret: "webhook_secret_value" });

    await expect(decryptTelegramCredential(encrypted, context)).resolves.toEqual({
      botToken: "123456789:abcdefghijklmnopqrstuvwxyzABCDE",
      webhookSecret: "webhook_secret_value",
    });
    await expect(decryptTelegramCredential(encrypted, { ...context, shopId: "shop-b" })).rejects.toMatchObject({ code: "credential_decryption_failed" });
    expect(JSON.stringify(encrypted)).not.toContain("webhook_secret_value");
    expect(JSON.stringify(encrypted)).not.toContain("abcdefghijklmnopqrstuvwxyzABCDE");
  });

  it("encrypts recipient chat IDs separately from bot credentials", async () => {
    const input = { chatId: "9007199254740000", hmacSecret: "identifier-secret", identityId: "identity-a", integrationId: "integration-a", kek: KEK, keyVersion: "v1", shopId: "shop-a" };
    const encrypted = await encryptTelegramChatId(input);

    await expect(decryptTelegramChatId(encrypted, input)).resolves.toBe(input.chatId);
    await expect(decryptTelegramChatId(encrypted, { ...input, identityId: "identity-b" })).rejects.toMatchObject({ code: "credential_decryption_failed" });
    expect(encrypted.subjectHash).not.toContain(input.chatId);
  });
});
