import { describe, expect, it } from "vitest";

import { decryptDiscordBotCredential, encryptDiscordBotCredential } from "../../src/lib/channels/discord-credentials";
import { toBase64Url } from "../../src/lib/core/ids";

const KEY = toBase64Url(new Uint8Array(32).fill(7));
const CONTEXT = {
  connectionId: "connection-001",
  credentialId: "credential-001",
  keyVersion: "v1",
  shopId: "shop-001",
};
const PUBLIC_KEY_HEX = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const ENV = { CREDENTIAL_KEK_V1: KEY };

describe("Discord Bot credential envelope", () => {
  it("round-trips the tenant-bound encrypted public key", async () => {
    const envelope = await encryptDiscordBotCredential({
      ...CONTEXT,
      hmacSecret: "identifier-hmac-secret",
      kek: KEY,
      publicKeyHex: PUBLIC_KEY_HEX,
    });
    expect(JSON.stringify(envelope)).not.toContain(PUBLIC_KEY_HEX);
    await expect(decryptDiscordBotCredential({ env: ENV, row: { ...CONTEXT, ...envelope } })).resolves.toEqual({
      publicKeyHex: PUBLIC_KEY_HEX,
    });
  });

  it("rejects an envelope replayed across a tenant or credential", async () => {
    const envelope = await encryptDiscordBotCredential({
      ...CONTEXT,
      hmacSecret: "identifier-hmac-secret",
      kek: KEY,
      publicKeyHex: PUBLIC_KEY_HEX,
    });
    await expect(decryptDiscordBotCredential({
      env: ENV,
      row: { ...CONTEXT, ...envelope, shopId: "shop-002" },
    })).rejects.toMatchObject({ code: "channel_credential_decryption_failed" });
    await expect(decryptDiscordBotCredential({
      env: ENV,
      row: { ...CONTEXT, ...envelope, credentialId: "credential-002" },
    })).rejects.toMatchObject({ code: "channel_credential_decryption_failed" });
  });

  it("rejects an invalid Discord public key", async () => {
    await expect(encryptDiscordBotCredential({
      ...CONTEXT,
      hmacSecret: "identifier-hmac-secret",
      kek: KEY,
      publicKeyHex: "not-a-public-key",
    })).rejects.toMatchObject({ code: "channel_credential_decryption_failed" });
  });
});
