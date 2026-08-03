import { describe, expect, it, vi } from "vitest";

import { toBase64Url } from "../../src/lib/core/ids";
import { encryptWhatsAppCloudCredential } from "../../src/lib/channels/whatsapp-credentials";
import { encryptZaloMiniAppCredential } from "../../src/lib/channels/zalo-mini-app-credentials";
import { loadProviderRuntimeContext } from "../../src/lib/channels/provider-context";
import type { AppBindings } from "../../src/lib/platform/bindings";

const KEK = toBase64Url(new Uint8Array(32).fill(7));
const HMAC_SECRET = "identifier-hmac-secret";
const SHOP_ID = "shop-001";
const SHOP_PUBLIC_ID = "shop-public-001";
const CONNECTION_ID = "connection-001";
const CONNECTION_PUBLIC_ID = "connection-public-001";
const CREDENTIAL_ID = "credential-001";

type ContextRow = Record<string, unknown>;

function fakeDatabase(row: ContextRow | null) {
  const prepare = vi.fn((sql: string) => ({
    bind: (...values: unknown[]) => ({
      first: <T>() => {
        expect(sql).toContain("FROM channel_connections");
        expect(values[0]).toBe(CONNECTION_PUBLIC_ID);
        expect(typeof values[1]).toBe("string");
        return Promise.resolve(row as T | null);
      },
    }),
  }));
  return { prepare };
}

function bindings(database: ReturnType<typeof fakeDatabase>): AppBindings {
  return {
    ACTIVE_CREDENTIAL_KEY_VERSION: "v1",
    APP_ENV: "local",
    CREDENTIAL_KEK_V1: KEK,
    IDENTIFIER_HMAC_SECRET: HMAC_SECRET,
    PLATFORM_DB: database,
  } as unknown as AppBindings;
}

function baseRow(providerCode: string, envelope: { credentialEnvelopeCiphertextB64: string; credentialEnvelopeIvB64: string; credentialFingerprint: string }): ContextRow {
  return {
    channelCode: providerCode,
    channelStatus: "enabled",
    connectionId: CONNECTION_ID,
    connectionPublicId: CONNECTION_PUBLIC_ID,
    connectionStatus: "active",
    credentialEnvelopeCiphertextB64: envelope.credentialEnvelopeCiphertextB64,
    credentialEnvelopeIvB64: envelope.credentialEnvelopeIvB64,
    credentialFingerprint: envelope.credentialFingerprint,
    credentialId: CREDENTIAL_ID,
    credentialKeyVersion: "v1",
    credentialStatus: "active",
    credentialVersion: 3,
    providerCode,
    shopId: SHOP_ID,
    shopPublicId: SHOP_PUBLIC_ID,
    shopStatus: "active",
    subscriptionState: "active",
  };
}

async function discordEnvelope(publicKeyHex = "ab".repeat(32)) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await crypto.subtle.importKey("raw", new Uint8Array(32).fill(7), { name: "AES-GCM" }, false, ["encrypt"]);
  const aad = new TextEncoder().encode(`provider-credential\0discord.bot\0v1\0${SHOP_ID}\0${CONNECTION_ID}\0${CREDENTIAL_ID}\0envelope`);
  const plaintext = new TextEncoder().encode(JSON.stringify({ publicKeyHex }));
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ additionalData: aad, iv, name: "AES-GCM", tagLength: 128 }, key, plaintext));
  return {
    credentialEnvelopeCiphertextB64: toBase64Url(ciphertext),
    credentialEnvelopeIvB64: toBase64Url(iv),
    credentialFingerprint: "f".repeat(43),
  };
}

describe("provider runtime context", () => {
  it("binds the public connection to its tenant and decrypts WhatsApp credentials", async () => {
    const envelope = await encryptWhatsAppCloudCredential({
      appSecret: "whatsapp-app-secret-123456",
      businessAccountId: "waba-001",
      connectionId: CONNECTION_ID,
      credentialId: CREDENTIAL_ID,
      hmacSecret: HMAC_SECRET,
      kek: KEK,
      keyVersion: "v1",
      shopId: SHOP_ID,
      phoneNumberId: "phone-001",
      verifyToken: "whatsapp-verify-token-123456",
    });
    const row = baseRow("whatsapp.cloud", envelope);
    const context = await loadProviderRuntimeContext(bindings(fakeDatabase(row)), {
      connectionPublicId: CONNECTION_PUBLIC_ID,
      providerCode: "whatsapp.cloud",
    });

    expect(context).toMatchObject({
      connectionId: CONNECTION_ID,
      providerCode: "whatsapp.cloud",
      credentialVersion: 3,
      credential: {
        appSecret: "whatsapp-app-secret-123456",
        businessAccountId: "waba-001",
        phoneNumberId: "phone-001",
        verifyToken: "whatsapp-verify-token-123456",
      },
    });
    expect(context).not.toHaveProperty("credentialEnvelopeCiphertextB64");
    expect(context).not.toHaveProperty("credentialEnvelopeIvB64");
  });

  it("dispatches strict Zalo Mini App credentials", async () => {
    const envelope = await encryptZaloMiniAppCredential({
      apiKey: "zalo-api-key-123456",
      appId: "zalo-app-123",
      connectionId: CONNECTION_ID,
      credentialId: CREDENTIAL_ID,
      hmacSecret: HMAC_SECRET,
      kek: KEK,
      keyVersion: "v1",
      shopId: SHOP_ID,
    });
    const context = await loadProviderRuntimeContext(bindings(fakeDatabase(baseRow("zalo.mini_app", envelope))), {
      connectionPublicId: CONNECTION_PUBLIC_ID,
      providerCode: "zalo.mini_app",
    });
    expect(context.credential).toEqual({ apiKey: "zalo-api-key-123456", appId: "zalo-app-123" });
  });

  it("decrypts and normalizes a Discord public key", async () => {
    const context = await loadProviderRuntimeContext(bindings(fakeDatabase(baseRow("discord.bot", await discordEnvelope()))), {
      connectionPublicId: CONNECTION_PUBLIC_ID,
      providerCode: "discord.bot",
    });
    expect(context.credential).toEqual({ publicKeyHex: "ab".repeat(32) });
  });

  it("fails closed for cross-provider, inactive, and tampered credentials", async () => {
    const discord = await discordEnvelope("CD".repeat(32));
    const mismatchRow = baseRow("whatsapp.cloud", discord);
    await expect(loadProviderRuntimeContext(bindings(fakeDatabase(mismatchRow)), {
      connectionPublicId: CONNECTION_PUBLIC_ID,
      providerCode: "discord.bot",
    })).rejects.toMatchObject({ code: "channel_provider_mismatch", status: 403 });

    const inactive = baseRow("discord.bot", discord);
    inactive.connectionStatus = "disconnected";
    await expect(loadProviderRuntimeContext(bindings(fakeDatabase(inactive)), {
      connectionPublicId: CONNECTION_PUBLIC_ID,
      providerCode: "discord.bot",
    })).rejects.toMatchObject({ code: "channel_connection_unavailable", status: 409 });

    const tampered = baseRow("discord.bot", discord);
    tampered.credentialId = "credential-002";
    await expect(loadProviderRuntimeContext(bindings(fakeDatabase(tampered)), {
      connectionPublicId: CONNECTION_PUBLIC_ID,
      providerCode: "discord.bot",
    })).rejects.toMatchObject({ code: "channel_credential_decryption_failed", status: 500 });
  });

  it("enforces trial and grace deadlines before decrypting provider credentials", async () => {
    const envelope = await encryptWhatsAppCloudCredential({
      appSecret: "whatsapp-app-secret-123456",
      businessAccountId: "waba-001",
      connectionId: CONNECTION_ID,
      credentialId: CREDENTIAL_ID,
      hmacSecret: HMAC_SECRET,
      kek: KEK,
      keyVersion: "v1",
      shopId: SHOP_ID,
      phoneNumberId: "phone-001",
      verifyToken: "whatsapp-verify-token-123456",
    });
    const expired = baseRow("whatsapp.cloud", envelope);
    expired.subscriptionState = "past_due";
    expired.graceEndsAt = "2026-08-02T00:00:00.000Z";
    await expect(loadProviderRuntimeContext(bindings(fakeDatabase(expired)), {
      connectionPublicId: CONNECTION_PUBLIC_ID,
      providerCode: "whatsapp.cloud",
    })).rejects.toMatchObject({ code: "channel_connection_unavailable", status: 409 });

    const valid = baseRow("whatsapp.cloud", envelope);
    valid.subscriptionState = "grace_period";
    valid.graceEndsAt = "2099-01-01T00:00:00.000Z";
    await expect(loadProviderRuntimeContext(bindings(fakeDatabase(valid)), {
      connectionPublicId: CONNECTION_PUBLIC_ID,
      providerCode: "whatsapp.cloud",
    })).resolves.toMatchObject({ subscriptionState: "grace_period" });
  });

  it("keeps Zalo OA credential support behind the provider-pending gate", async () => {
    const database = fakeDatabase(null);
    await expect(loadProviderRuntimeContext(bindings(database), {
      connectionPublicId: CONNECTION_PUBLIC_ID,
      providerCode: "zalo.oa",
    })).rejects.toMatchObject({ code: "channel_provider_pending", status: 409 });
    expect(database.prepare).not.toHaveBeenCalled();
  });
});
