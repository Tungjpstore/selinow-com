import { describe, expect, it } from "vitest";

import { toBase64Url } from "../../src/lib/core/ids";
import {
  decryptZaloMiniAppCredential,
  encryptZaloMiniAppCredential,
} from "../../src/lib/channels/zalo-mini-app-credentials";

const KEY = toBase64Url(new Uint8Array(32).fill(7));
const CONTEXT = {
  connectionId: "connection-001",
  credentialId: "credential-001",
  keyVersion: "v1",
  shopId: "shop-001",
};
const ENV = { CREDENTIAL_KEK_V1: KEY };

describe("Zalo Mini App credential envelope", () => {
  it("round-trips the tenant-bound encrypted app key without exposing plaintext", async () => {
    const envelope = await encryptZaloMiniAppCredential({
      ...CONTEXT,
      apiKey: "zalo-mini-app-api-key-1234",
      appId: "zalo-app-001",
      hmacSecret: "identifier-hmac-secret",
      kek: KEY,
    });
    expect(JSON.stringify(envelope)).not.toContain("zalo-mini-app-api-key-1234");
    await expect(decryptZaloMiniAppCredential({ env: ENV, row: { ...CONTEXT, ...envelope } })).resolves.toEqual({
      apiKey: "zalo-mini-app-api-key-1234",
      appId: "zalo-app-001",
    });
  });

  it("rejects a credential envelope replayed across a tenant or credential", async () => {
    const envelope = await encryptZaloMiniAppCredential({
      ...CONTEXT,
      apiKey: "zalo-mini-app-api-key-1234",
      appId: "zalo-app-001",
      hmacSecret: "identifier-hmac-secret",
      kek: KEY,
    });
    await expect(decryptZaloMiniAppCredential({
      env: ENV,
      row: { ...CONTEXT, ...envelope, shopId: "shop-002" },
    })).rejects.toMatchObject({ code: "channel_credential_decryption_failed" });
    await expect(decryptZaloMiniAppCredential({
      env: ENV,
      row: { ...CONTEXT, ...envelope, credentialId: "credential-002" },
    })).rejects.toMatchObject({ code: "channel_credential_decryption_failed" });
  });

  it("rejects an invalid app identity before decrypting", async () => {
    await expect(encryptZaloMiniAppCredential({
      ...CONTEXT,
      apiKey: "zalo-mini-app-api-key-1234",
      appId: "bad app id",
      hmacSecret: "identifier-hmac-secret",
      kek: KEY,
    })).rejects.toMatchObject({ code: "channel_credential_decryption_failed" });
  });
});
