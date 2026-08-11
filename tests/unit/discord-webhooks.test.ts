import { describe, expect, it, vi } from "vitest";

import { encryptDiscordBotCredential } from "../../src/lib/channels/discord-credentials";
import type { ProviderReceiptClaim, ProviderReceiptStore } from "../../src/lib/channels/ingress";
import { processDiscordWebhook } from "../../src/lib/channels/discord-webhooks";
import { toBase64Url } from "../../src/lib/core/ids";
import type { AppBindings } from "../../src/lib/platform/bindings";

const NOW = new Date("2026-08-02T12:00:00.000Z");
const SHOP_ID = "shop-001";
const CONNECTION_ID = "connection-001";
const CONNECTION_PUBLIC_ID = "discord-connection-001";
const DISCORD_APP_ID = "123456789012345678";
const CREDENTIAL_ID = "credential-001";
const HMAC_SECRET = "identifier-hmac-secret";
const KEK = toBase64Url(new Uint8Array(32).fill(7));

function hex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function signedRequest(body: string, keyPair: CryptoKeyPair): Promise<Request> {
  const timestamp = String(Math.floor(NOW.getTime() / 1_000));
  const signature = new Uint8Array(await crypto.subtle.sign("Ed25519", keyPair.privateKey, new TextEncoder().encode(`${timestamp}${body}`)));
  return new Request("https://api.test/webhooks/discord", {
    body,
    headers: {
      "X-Signature-Ed25519": hex(signature),
      "X-Signature-Timestamp": timestamp,
    },
    method: "POST",
  });
}

function fakeDatabase(row: Record<string, unknown>) {
  const prepare = vi.fn((sql: string) => ({
    bind: (...values: unknown[]) => {
      void values;
      return {
        first: <T>() => Promise.resolve(sql.includes("FROM channel_connections") ? row as T : null),
      };
    },
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

function receiptStore() {
  const events = new Map<string, ProviderReceiptClaim["event"]>();
  const claim = vi.fn((event: ProviderReceiptClaim["event"]): Promise<ProviderReceiptClaim> => {
    const key = `${event.shopId}:${event.connectionId}:${event.eventId}`;
    const existing = events.get(key);
    if (existing === undefined) {
      events.set(key, event);
      return Promise.resolve({ event, result: "accepted" });
    }
    return Promise.resolve({ event, result: existing.payloadReference === event.payloadReference ? "replay" : "conflict" });
  });
  return { claim } satisfies ProviderReceiptStore;
}

async function contextRow(publicKeyHex: string) {
  const envelope = await encryptDiscordBotCredential({
    connectionId: CONNECTION_ID,
    credentialId: CREDENTIAL_ID,
    hmacSecret: HMAC_SECRET,
    kek: KEK,
    keyVersion: "v1",
    publicKeyHex,
    shopId: SHOP_ID,
  });
  return {
    channelStatus: "enabled",
    connectionId: CONNECTION_ID,
    connectionPublicId: CONNECTION_PUBLIC_ID,
    connectionStatus: "active",
    externalAccountId: DISCORD_APP_ID,
    credentialEnvelopeCiphertextB64: envelope.credentialEnvelopeCiphertextB64,
    credentialEnvelopeIvB64: envelope.credentialEnvelopeIvB64,
    credentialFingerprint: envelope.credentialFingerprint,
    credentialId: CREDENTIAL_ID,
    credentialStatus: "active",
    keyVersion: envelope.keyVersion,
    providerCode: "discord.bot",
    shopId: SHOP_ID,
    subscriptionState: "active",
    currentPeriodEnd: "2099-01-01T00:00:00.000Z",
    trialEndsAt: null,
    graceEndsAt: null,
  };
}

describe("Discord interactions webhook route service", () => {
  it("returns a verified ping without claiming a durable receipt", async () => {
    const keyPair = await crypto.subtle.generateKey({ name: "Ed25519", namedCurve: "Ed25519" }, true, ["sign", "verify"]);
    const publicKeyHex = hex(new Uint8Array(await crypto.subtle.exportKey("raw", keyPair.publicKey)));
    const database = fakeDatabase(await contextRow(publicKeyHex));
    const store = receiptStore();
    const body = JSON.stringify({ type: 1 });
    await expect(processDiscordWebhook({
      connectionPublicId: CONNECTION_PUBLIC_ID,
      env: bindings(database),
      now: NOW,
      receiptStore: store,
      request: await signedRequest(body, keyPair),
    })).resolves.toEqual({ eventId: null, interactionType: 1, result: "ping" });
    expect(store.claim).not.toHaveBeenCalled();
  });

  it("claims normal interactions and treats identical retries as replay", async () => {
    const keyPair = await crypto.subtle.generateKey({ name: "Ed25519", namedCurve: "Ed25519" }, true, ["sign", "verify"]);
    const publicKeyHex = hex(new Uint8Array(await crypto.subtle.exportKey("raw", keyPair.publicKey)));
    const database = fakeDatabase(await contextRow(publicKeyHex));
    const store = receiptStore();
    const body = JSON.stringify({ application_id: DISCORD_APP_ID, id: "interaction-001", type: 2 });
    const input = {
      connectionPublicId: CONNECTION_PUBLIC_ID,
      env: bindings(database),
      now: NOW,
      receiptStore: store,
    };
    await expect(processDiscordWebhook({ ...input, request: await signedRequest(body, keyPair) })).resolves.toMatchObject({
      eventId: "interaction-001",
      interactionType: 2,
      result: "accepted",
    });
    await expect(processDiscordWebhook({ ...input, request: await signedRequest(body, keyPair) })).resolves.toMatchObject({ result: "replay" });
    expect(store.claim).toHaveBeenCalledTimes(2);
  });

  it("fails closed on a conflicting payload or invalid credential envelope", async () => {
    const keyPair = await crypto.subtle.generateKey({ name: "Ed25519", namedCurve: "Ed25519" }, true, ["sign", "verify"]);
    const publicKeyHex = hex(new Uint8Array(await crypto.subtle.exportKey("raw", keyPair.publicKey)));
    const row = await contextRow(publicKeyHex);
    const database = fakeDatabase(row);
    const store = receiptStore();
    await processDiscordWebhook({
      connectionPublicId: CONNECTION_PUBLIC_ID,
      env: bindings(database),
      now: NOW,
      receiptStore: store,
      request: await signedRequest(JSON.stringify({ application_id: DISCORD_APP_ID, id: "interaction-002", type: 2, token: "a" }), keyPair),
    });
    await expect(processDiscordWebhook({
      connectionPublicId: CONNECTION_PUBLIC_ID,
      env: bindings(database),
      now: NOW,
      receiptStore: store,
      request: await signedRequest(JSON.stringify({ application_id: DISCORD_APP_ID, id: "interaction-002", type: 2, token: "b" }), keyPair),
    })).rejects.toMatchObject({ code: "channel_provider_event_conflict", status: 409 });
    const broken = fakeDatabase({ ...row, credentialEnvelopeCiphertextB64: "broken" });
    await expect(processDiscordWebhook({
      connectionPublicId: CONNECTION_PUBLIC_ID,
      env: bindings(broken),
      now: NOW,
      receiptStore: receiptStore(),
      request: await signedRequest(JSON.stringify({ type: 1 }), keyPair),
    })).rejects.toMatchObject({ code: "channel_credential_unavailable", status: 503 });
  });

  it("keeps an injectable resolver for isolated route tests", async () => {
    const keyPair = await crypto.subtle.generateKey({ name: "Ed25519", namedCurve: "Ed25519" }, true, ["sign", "verify"]);
    const publicKeyHex = hex(new Uint8Array(await crypto.subtle.exportKey("raw", keyPair.publicKey)));
    const database = fakeDatabase(await contextRow(publicKeyHex));
    const resolver = vi.fn(() => Promise.resolve(publicKeyHex));
    const store = receiptStore();
    await expect(processDiscordWebhook({
      connectionPublicId: CONNECTION_PUBLIC_ID,
      env: bindings(database),
      now: NOW,
      publicKeyResolver: resolver,
      receiptStore: store,
      request: await signedRequest(JSON.stringify({ type: 1 }), keyPair),
    })).resolves.toMatchObject({ result: "ping" });
    expect(resolver).toHaveBeenCalledOnce();
  });

  it("does not admit a mismatched provider or inactive connection", async () => {
    const keyPair = await crypto.subtle.generateKey({ name: "Ed25519", namedCurve: "Ed25519" }, true, ["sign", "verify"]);
    const publicKeyHex = hex(new Uint8Array(await crypto.subtle.exportKey("raw", keyPair.publicKey)));
    const row = await contextRow(publicKeyHex);
    const body = JSON.stringify({ type: 1 });
    await expect(processDiscordWebhook({
      connectionPublicId: CONNECTION_PUBLIC_ID,
      env: bindings(fakeDatabase({ ...row, providerCode: "whatsapp.cloud" })),
      now: NOW,
      request: await signedRequest(body, keyPair),
    })).rejects.toMatchObject({ code: "webhook_not_found", status: 404 });
    await expect(processDiscordWebhook({
      connectionPublicId: CONNECTION_PUBLIC_ID,
      env: bindings(fakeDatabase({ ...row, connectionStatus: "disconnected" })),
      now: NOW,
      request: await signedRequest(body, keyPair),
    })).rejects.toMatchObject({ code: "webhook_not_found", status: 404 });
  });

  it("rejects an interaction whose application id is bound to another connection", async () => {
    const keyPair = await crypto.subtle.generateKey({ name: "Ed25519", namedCurve: "Ed25519" }, true, ["sign", "verify"]);
    const publicKeyHex = hex(new Uint8Array(await crypto.subtle.exportKey("raw", keyPair.publicKey)));
    const database = fakeDatabase(await contextRow(publicKeyHex));
    await expect(processDiscordWebhook({
      connectionPublicId: CONNECTION_PUBLIC_ID,
      env: bindings(database),
      now: NOW,
      request: await signedRequest(JSON.stringify({ application_id: "987654321098765432", id: "interaction-003", type: 2 }), keyPair),
    })).rejects.toMatchObject({ code: "channel_tenant_mismatch", status: 403 });
  });

  it("rejects an active connection without a tenant-bound application id", async () => {
    const keyPair = await crypto.subtle.generateKey({ name: "Ed25519", namedCurve: "Ed25519" }, true, ["sign", "verify"]);
    const publicKeyHex = hex(new Uint8Array(await crypto.subtle.exportKey("raw", keyPair.publicKey)));
    const row = await contextRow(publicKeyHex);
    await expect(processDiscordWebhook({
      connectionPublicId: CONNECTION_PUBLIC_ID,
      env: bindings(fakeDatabase({ ...row, externalAccountId: null })),
      now: NOW,
      request: await signedRequest(JSON.stringify({ type: 1 }), keyPair),
    })).rejects.toMatchObject({ code: "channel_provider_identity_unverified", status: 409 });
  });
});
