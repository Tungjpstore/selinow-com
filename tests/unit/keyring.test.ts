import { describe, expect, it } from "vitest";

import { decryptInventoryKey, encryptInventoryKey } from "../../src/lib/crypto/inventory";
import { resolveActiveEncryptionKey, resolveEncryptionKey } from "../../src/lib/crypto/keyring";
import { loadCredentialById } from "../../src/lib/payments/credentials";
import { encryptPayOSCredentials } from "../../src/lib/payments/crypto";
import type { AppBindings } from "../../src/lib/platform/bindings";
import { decryptTelegramCredentialRow, decryptTelegramRecipientRow } from "../../src/lib/telegram/credentials";
import { encryptTelegramChatId, encryptTelegramCredential } from "../../src/lib/telegram/crypto";

const KEK_V1 = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const KEK_V2 = "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";

function bindings(overrides: Record<string, unknown> = {}): AppBindings {
  return {
    ACTIVE_CREDENTIAL_KEY_VERSION: "v2",
    ACTIVE_INVENTORY_KEY_VERSION: "v2",
    CREDENTIAL_KEK_V1: KEK_V1,
    CREDENTIAL_KEK_V2: KEK_V2,
    IDENTIFIER_HMAC_SECRET: "identifier-secret",
    INVENTORY_KEK_V1: KEK_V1,
    INVENTORY_KEK_V2: KEK_V2,
    ...overrides,
  } as unknown as AppBindings;
}

describe("exact-version encryption keyring", () => {
  it("selects the configured exact and active versions", () => {
    const env = bindings();
    expect(resolveEncryptionKey(env, "credential", "v1")).toMatchObject({ kek: KEK_V1, version: "v1" });
    expect(resolveEncryptionKey(env, "credential", "v2")).toMatchObject({ kek: KEK_V2, version: "v2" });
    expect(resolveActiveEncryptionKey(env, "inventory")).toMatchObject({ kek: KEK_V2, version: "v2" });
  });

  it("never falls back to another configured key when the row version is missing", () => {
    const env = bindings({ CREDENTIAL_KEK_V2: undefined });
    expect(() => resolveEncryptionKey(env, "credential", "v2")).toThrow("encryption_key_version_unavailable");
  });

  it("loads PayOS credentials with the row's v2 key only", async () => {
    const encrypted = await encryptPayOSCredentials({ apiKey: "api-v2", checksumKey: "checksum-v2", clientId: "client-v2" }, {
      credentialId: "credential-a",
      hmacSecret: "identifier-secret",
      integrationId: "integration-a",
      kek: KEK_V2,
      keyVersion: "v2",
      shopId: "shop-a",
    });
    const row = { ...encrypted, credentialId: "credential-a", integrationId: "integration-a", keyVersion: "v2", providerOwnershipFingerprint: "provider-ownership-a", shopId: "shop-a", status: "active" };
    const env = bindings({
      PLATFORM_DB: { prepare: () => ({ bind: () => ({ first: () => Promise.resolve(row) }) }) },
    });

    await expect(loadCredentialById(env, row.credentialId, row.shopId)).resolves.toMatchObject({
      credentials: { apiKey: "api-v2", checksumKey: "checksum-v2", clientId: "client-v2" },
    });
    await expect(loadCredentialById(bindings({ CREDENTIAL_KEK_V2: undefined, PLATFORM_DB: env.PLATFORM_DB }), row.credentialId, row.shopId)).rejects.toMatchObject({ code: "encryption_key_version_unavailable" });
  });

  it("decrypts Telegram credentials and recipients with exact row versions and AAD", async () => {
    const credential = await encryptTelegramCredential({
      botToken: "123456789:abcdefghijklmnopqrstuvwxyzABCDE",
      credentialId: "credential-a",
      hmacSecret: "identifier-secret",
      integrationId: "integration-a",
      kek: KEK_V2,
      keyVersion: "v2",
      shopId: "shop-a",
      webhookSecret: "webhook-secret",
    });
    await expect(decryptTelegramCredentialRow(bindings(), { ...credential, credentialId: "credential-a", integrationId: "integration-a", keyVersion: "v2", shopId: "shop-a", status: "active" })).resolves.toMatchObject({ botToken: "123456789:abcdefghijklmnopqrstuvwxyzABCDE", webhookSecret: "webhook-secret" });

    const recipient = await encryptTelegramChatId({ chatId: "9007199254740000", hmacSecret: "identifier-secret", identityId: "identity-a", integrationId: "integration-a", kek: KEK_V2, keyVersion: "v2", shopId: "shop-a" });
    const row = { ciphertextB64: recipient.ciphertextB64, identityId: "identity-a", integrationId: "integration-a", ivB64: recipient.ivB64, keyVersion: "v2", shopId: "shop-a" };
    await expect(decryptTelegramRecipientRow(bindings(), row)).resolves.toBe("9007199254740000");
    await expect(decryptTelegramRecipientRow(bindings(), { ...row, identityId: "identity-b" })).rejects.toMatchObject({ code: "credential_decryption_failed" });
  });

  it("decrypts inventory using only the exact stored version", async () => {
    const encrypted = await encryptInventoryKey({ hmacSecret: "identifier-secret", keyVersion: "v2", kek: KEK_V2, plaintext: "LICENSE-V2", shopId: "shop-a", variantId: "variant-a" });
    const key = resolveEncryptionKey(bindings(), "inventory", encrypted.keyVersion);
    await expect(decryptInventoryKey({ ...encrypted, kek: key.kek, shopId: "shop-a", variantId: "variant-a" })).resolves.toBe("LICENSE-V2");
    expect(() => resolveEncryptionKey(bindings({ INVENTORY_KEK_V2: undefined }), "inventory", encrypted.keyVersion)).toThrow("encryption_key_version_unavailable");
  });
});
