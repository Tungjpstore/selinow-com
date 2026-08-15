import { describe, expect, it } from "vitest";

import { toBase64Url } from "../../src/lib/core/ids";
import {
  decryptZaloOfficialAccountCredential,
  encryptZaloOfficialAccountCredential,
} from "../../src/lib/channels/zalo-oa-credentials";
import type { AppBindings } from "../../src/lib/platform/bindings";

const KEK = toBase64Url(new Uint8Array(32).fill(4));
const HMAC_SECRET = "identifier-hmac-secret";
const BASE = {
  accessToken: "access-token-secret",
  accessTokenExpiresAt: "2026-09-01T00:00:00.000Z",
  appId: "zalo-app-123",
  connectionId: "connection-001",
  credentialId: "credential-001",
  hmacSecret: HMAC_SECRET,
  kek: KEK,
  keyVersion: "v1",
  oaId: "oa-123",
  refreshToken: "refresh-token-secret",
  refreshTokenExpiresAt: "2026-11-01T00:00:00.000Z",
  secretKey: "zalo-secret-key-123456",
  shopId: "shop-001",
};

function bindings(): AppBindings {
  return {
    ACTIVE_CREDENTIAL_KEY_VERSION: "v1",
    APP_ENV: "local",
    CREDENTIAL_KEK_V1: KEK,
    IDENTIFIER_HMAC_SECRET: HMAC_SECRET,
  } as unknown as AppBindings;
}

describe("Zalo Official Account credential vault", () => {
  it("encrypts a tenant-bound token envelope and decrypts it in memory", async () => {
    const envelope = await encryptZaloOfficialAccountCredential(BASE);
    const credential = await decryptZaloOfficialAccountCredential({
      env: bindings(),
      row: { ...envelope, connectionId: BASE.connectionId, credentialId: BASE.credentialId, keyVersion: BASE.keyVersion, shopId: BASE.shopId },
    });
    expect(credential).toEqual({
      accessToken: BASE.accessToken,
      accessTokenExpiresAt: BASE.accessTokenExpiresAt,
      appId: BASE.appId,
      oaId: BASE.oaId,
      refreshToken: BASE.refreshToken,
      refreshTokenExpiresAt: BASE.refreshTokenExpiresAt,
      secretKey: BASE.secretKey,
    });
    expect(JSON.stringify(envelope)).not.toContain(BASE.accessToken);
    expect(JSON.stringify(envelope)).not.toContain(BASE.refreshToken);
    expect(envelope.credentialFingerprint).not.toContain(BASE.oaId);
  });

  it("binds ciphertext to the exact shop, connection, credential and key version", async () => {
    const envelope = await encryptZaloOfficialAccountCredential(BASE);
    await expect(decryptZaloOfficialAccountCredential({
      env: bindings(),
      row: { ...envelope, connectionId: BASE.connectionId, credentialId: BASE.credentialId, keyVersion: BASE.keyVersion, shopId: "shop-other" },
    })).rejects.toMatchObject({ code: "channel_credential_decryption_failed", status: 500 });
  });

  it("rejects malformed identity, expiry metadata, and tampered ciphertext", async () => {
    await expect(encryptZaloOfficialAccountCredential({ ...BASE, oaId: "oa" })).rejects.toMatchObject({ code: "channel_credential_decryption_failed" });
    await expect(encryptZaloOfficialAccountCredential({ ...BASE, secretKey: "short" })).rejects.toMatchObject({ code: "channel_credential_decryption_failed" });
    await expect(encryptZaloOfficialAccountCredential({ ...BASE, accessTokenExpiresAt: "2026-09-01" })).rejects.toMatchObject({ code: "channel_credential_decryption_failed" });
    const envelope = await encryptZaloOfficialAccountCredential(BASE);
    const tampered = { ...envelope, credentialEnvelopeCiphertextB64: `${envelope.credentialEnvelopeCiphertextB64}A` };
    await expect(decryptZaloOfficialAccountCredential({
      env: bindings(),
      row: { ...tampered, connectionId: BASE.connectionId, credentialId: BASE.credentialId, keyVersion: BASE.keyVersion, shopId: BASE.shopId },
    })).rejects.toMatchObject({ code: "channel_credential_decryption_failed", status: 500 });
  });

  it("keeps expired access metadata decryptable so refresh rotation can recover", async () => {
    const envelope = await encryptZaloOfficialAccountCredential({ ...BASE, accessTokenExpiresAt: "2020-01-01T00:00:00.000Z" });
    await expect(decryptZaloOfficialAccountCredential({
      env: bindings(),
      row: { ...envelope, connectionId: BASE.connectionId, credentialId: BASE.credentialId, keyVersion: BASE.keyVersion, shopId: BASE.shopId },
    })).resolves.toMatchObject({ accessTokenExpiresAt: "2020-01-01T00:00:00.000Z" });
  });
});
