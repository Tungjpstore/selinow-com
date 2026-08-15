import { AppError } from "../core/errors";
import { constantTimeEqual } from "../core/crypto";
import { toBase64Url } from "../core/ids";
import { readBoundedBytes } from "../http/request";
import {
  getProviderRuntimeContract,
  normalizeProviderEvent,
  verifyProviderWebhook,
  verifyTelegramMiniAppLaunch,
  type RawBody,
} from "./provider-contracts";
import type { NormalizedChannelEvent } from "./types";

/**
 * Provider routes must retain the exact bytes for signature verification and
 * never parse a payload before the provider proof has passed.
 */
export const MAX_PROVIDER_WEBHOOK_BODY_BYTES = 3 * 1024 * 1024;

const SAFE_REFERENCE = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/u;
const SAFE_CHALLENGE = /^[\x20-\x7e]{1,512}$/u;
const encoder = new TextEncoder();

export type ProviderConnectionBinding = {
  connectionId: string;
  providerCode: string;
  shopId: string;
};

export type TelegramMiniAppClaims = {
  authDate: string;
  connectionId: string;
  initDataHash: string;
  providerCode: "telegram.mini_app";
  providerUserId: string;
  queryId: string | null;
  replayKey: string;
  shopId: string;
  startParam: string | null;
};

export type DiscordInteractionEnvelope =
  | { applicationId: string | null; kind: "ping"; type: 1 }
  | { applicationId: string; id: string | null; kind: "interaction"; type: number };

function requireReference(value: string, issue: string): void {
  if (typeof value !== "string" || !SAFE_REFERENCE.test(value)) {
    throw new AppError("channel_reference_invalid", 400, [issue]);
  }
}

function rejectProviderRoute(issue: string, status = 401): never {
  throw new AppError("channel_route_invalid", status, [issue]);
}

function decodeJsonObject(rawBody: Uint8Array): Record<string, unknown> {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(rawBody);
  } catch {
    rejectProviderRoute("json_invalid");
  }
  try {
    const value = JSON.parse(text) as unknown;
    if (typeof value !== "object" || value === null || Array.isArray(value)) rejectProviderRoute("json_object_required");
    return value as Record<string, unknown>;
  } catch (error) {
    if (error instanceof AppError) throw error;
    rejectProviderRoute("json_invalid");
  }
}

function eventHeader(request: Request, code: string, kind: "signature" | "timestamp"): string | null {
  const verification = getProviderRuntimeContract(code).verification;
  if (kind === "timestamp" && verification.kind === "ed25519_headers") {
    return request.headers.get(verification.timestampHeader);
  }
  if (kind === "signature") {
    if (verification.kind === "shared_secret_header" || verification.kind === "hmac_sha256_header") {
      return request.headers.get(verification.header);
    }
    if (verification.kind === "ed25519_headers") return request.headers.get(verification.signatureHeader);
    if (verification.kind === "zalo_event_signature") return request.headers.get(verification.header);
  }
  return null;
}

export type ZaloMiniAppWebhookClaims = {
  appId: string;
  event: string;
  eventId: string;
  payloadReference: string;
  replayKey: string;
  timestamp: string;
  userId: string | null;
};

const SAFE_PROVIDER_VALUE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const DECIMAL_TIMESTAMP = /^\d{1,20}$/u;
const DISCORD_INTERACTION_TYPES = new Set([1, 2, 3, 4, 5]);

function providerValue(value: unknown, issue: string): string {
  if (typeof value !== "string" || !SAFE_PROVIDER_VALUE.test(value)) rejectProviderRoute(issue);
  return value;
}

function providerIdentity(value: unknown, issue: string): string {
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value < 0) rejectProviderRoute(issue);
    return providerValue(String(value), issue);
  }
  return providerValue(value, issue);
}

function providerTimestamp(value: unknown): string {
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value < 0) rejectProviderRoute("zalo_timestamp_invalid");
    return String(value);
  }
  if (typeof value !== "string" || !DECIMAL_TIMESTAMP.test(value)) rejectProviderRoute("zalo_timestamp_invalid");
  return value;
}

/**
 * Parses a verified Zalo Mini App Open API event into a reference-only claim.
 * Call this only after `verifyZaloMiniAppWebhook`; the helper deliberately
 * does not perform provider proof itself. Zalo does not document a provider
 * event ID or replay TTL, so the local replay key includes tenant, event
 * identity, timestamp and the bounded payload digest.
 */
export async function parseZaloMiniAppWebhook(input: {
  connectionId: string;
  expectedAppId: string;
  rawBody: RawBody;
  shopId: string;
}): Promise<ZaloMiniAppWebhookClaims> {
  requireReference(input.connectionId, "connection_id_invalid");
  requireReference(input.shopId, "shop_id_invalid");
  const expectedAppId = providerValue(input.expectedAppId, "zalo_app_id_invalid");
  const rawBytes = typeof input.rawBody === "string" ? encoder.encode(input.rawBody) : input.rawBody;
  if (rawBytes.byteLength > getProviderRuntimeContract("zalo.mini_app").maxInboundBodyBytes) {
    rejectProviderRoute("body_too_large", 413);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(rawBytes)) as unknown;
  } catch {
    rejectProviderRoute("json_invalid");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    rejectProviderRoute("json_object_required");
  }
  const record = parsed as Record<string, unknown>;
  const appId = providerIdentity(record.appId, "zalo_app_id_invalid");
  if (!constantTimeEqual(appId, expectedAppId)) throw new AppError("channel_tenant_mismatch", 403);
  const event = providerValue(record.event, "zalo_event_invalid");
  const timestamp = providerTimestamp(record.timestamp);
  const rawUserId = record.userId;
  const userId = rawUserId === undefined || rawUserId === null ? null : providerIdentity(rawUserId, "zalo_user_id_invalid");
  const ownedRawBytes = new Uint8Array(rawBytes.byteLength);
  ownedRawBytes.set(rawBytes);
  const payloadDigest = new Uint8Array(await crypto.subtle.digest("SHA-256", ownedRawBytes.buffer));
  const payloadReference = toBase64Url(payloadDigest);
  const replayMaterial = `${input.shopId}\n${input.connectionId}\n${appId}\n${event}\n${userId ?? ""}\n${timestamp}\n${payloadReference}`;
  const replayDigest = new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(replayMaterial)));
  const replayKey = `zalo.mini_app:${toBase64Url(replayDigest)}`;
  return Object.freeze({
    appId,
    event,
    eventId: `zalo_${payloadReference}`,
    payloadReference,
    replayKey,
    timestamp,
    userId,
  });
}

/**
 * Verifies a provider webhook and returns a reference-only normalized event.
 * The connection resolver and receipt store remain injected by the eventual
 * route so this helper cannot guess a tenant or silently claim a retry.
 */
export async function readAndVerifyProviderWebhook(input: {
  action: string;
  connectionId: string;
  credentialSecret?: string;
  eventId: string;
  now?: Date;
  publicKeyHex?: string;
  providerCode: string;
  request: Request;
  shopId: string;
}): Promise<{ event: NormalizedChannelEvent; rawBody: Uint8Array }> {
  const contract = getProviderRuntimeContract(input.providerCode);
  const signature = eventHeader(input.request, input.providerCode, "signature");

  // Provider-pending and launch-data contracts are not webhook routes. Reject
  // before consuming an attacker-controlled body or making a tenant claim.
  if (contract.stage === "provider_pending" || contract.verification.kind === "provider_pending" || contract.verification.kind === "init_data_hmac") {
    await verifyProviderWebhook({ code: input.providerCode, rawBody: "", signature });
  }

  // Secret-header providers can reject before reading or parsing an untrusted
  // body. HMAC/Ed25519 providers must read the exact bytes before verification.
  if (contract.verification.kind === "shared_secret_header") {
    await verifyProviderWebhook({
      code: input.providerCode,
      ...(input.credentialSecret === undefined ? {} : { credentialSecret: input.credentialSecret }),
      rawBody: "",
      signature,
    });
  }
  const rawBody = await readBoundedBytes(input.request, contract.maxInboundBodyBytes);
  await verifyProviderWebhook({
    code: input.providerCode,
    ...(input.credentialSecret === undefined ? {} : { credentialSecret: input.credentialSecret }),
    ...(input.now === undefined ? {} : { now: input.now }),
    ...(input.publicKeyHex === undefined ? {} : { publicKeyHex: input.publicKeyHex }),
    rawBody,
    signature,
    timestamp: eventHeader(input.request, input.providerCode, "timestamp"),
  });
  const event = await normalizeProviderEvent({
    action: input.action,
    connectionId: input.connectionId,
    eventId: input.eventId,
    providerCode: input.providerCode,
    rawBody,
    shopId: input.shopId,
    ...(input.now === undefined ? {} : { receivedAt: input.now }),
  });
  return { event, rawBody };
}

export function assertProviderConnectionBinding(input: {
  actual: ProviderConnectionBinding;
  expected: ProviderConnectionBinding;
}): void {
  requireReference(input.actual.connectionId, "actual_connection_id_invalid");
  requireReference(input.actual.shopId, "actual_shop_id_invalid");
  requireReference(input.expected.connectionId, "expected_connection_id_invalid");
  requireReference(input.expected.shopId, "expected_shop_id_invalid");
  getProviderRuntimeContract(input.expected.providerCode);
  if (input.actual.providerCode !== input.expected.providerCode) {
    throw new AppError("channel_provider_mismatch", 403);
  }
  if (input.actual.connectionId !== input.expected.connectionId || input.actual.shopId !== input.expected.shopId) {
    throw new AppError("channel_tenant_mismatch", 403);
  }
}

/**
 * Builds short-lived, reference-only claims after Telegram initData proof.
 * Replay prevention still belongs to a durable session/receipt store.
 */
export async function createTelegramMiniAppClaims(input: {
  botToken: string;
  connectionId: string;
  initData: string;
  maxAgeSeconds?: number;
  now?: Date;
  shopId: string;
}): Promise<TelegramMiniAppClaims> {
  requireReference(input.connectionId, "connection_id_invalid");
  requireReference(input.shopId, "shop_id_invalid");
  const launch = await verifyTelegramMiniAppLaunch({
    botToken: input.botToken,
    initData: input.initData,
    ...(input.maxAgeSeconds === undefined ? {} : { maxAgeSeconds: input.maxAgeSeconds }),
    ...(input.now === undefined ? {} : { now: input.now }),
  });
  // Hash Telegram's canonical signed fields so query-parameter ordering or
  // equivalent URL encoding cannot bypass replay-key deduplication.
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(launch.dataCheckString)));
  const initDataHash = toBase64Url(digest);
  return Object.freeze({
    authDate: launch.authDate.toISOString(),
    connectionId: input.connectionId,
    initDataHash,
    providerCode: "telegram.mini_app",
    providerUserId: launch.user.id,
    queryId: launch.queryId,
    replayKey: `telegram.mini_app:${input.connectionId}:${initDataHash}`,
    shopId: input.shopId,
    startParam: launch.startParam,
  });
}

/** Meta's GET challenge is separate from the signed raw-body POST contract. */
export function verifyWhatsAppWebhookChallenge(input: {
  challenge: string | null;
  expectedToken: string;
  mode: string | null;
  providedToken: string | null;
}): string {
  if (input.mode !== "subscribe") rejectProviderRoute("whatsapp_mode_invalid");
  if (input.expectedToken.length < 16 || input.expectedToken.length > 512 || input.providedToken === null
    || input.providedToken.length < 16 || input.providedToken.length > 512
    || !constantTimeEqual(input.expectedToken, input.providedToken)) {
    rejectProviderRoute("whatsapp_verify_token_invalid");
  }
  if (input.challenge === null || !SAFE_CHALLENGE.test(input.challenge)) rejectProviderRoute("whatsapp_challenge_invalid");
  return input.challenge;
}

export function parseDiscordInteraction(rawBody: RawBody): DiscordInteractionEnvelope {
  const bytes = typeof rawBody === "string" ? encoder.encode(rawBody) : rawBody;
  if (bytes.byteLength > getProviderRuntimeContract("discord.bot").maxInboundBodyBytes) rejectProviderRoute("body_too_large", 413);
  const record = decodeJsonObject(bytes);
  const type = record.type;
  if (typeof type !== "number" || !Number.isSafeInteger(type) || !DISCORD_INTERACTION_TYPES.has(type)) {
    rejectProviderRoute("discord_type_invalid");
  }
  const rawApplicationId = record.application_id;
  if (type === 1) {
    if (rawApplicationId === undefined || rawApplicationId === null) return { applicationId: null, kind: "ping", type: 1 };
    return { applicationId: providerIdentity(rawApplicationId, "discord_application_id_invalid"), kind: "ping", type: 1 };
  }
  const applicationId = providerIdentity(rawApplicationId, "discord_application_id_invalid");
  const rawId = record.id;
  if (rawId !== undefined && rawId !== null && typeof rawId !== "string") rejectProviderRoute("discord_id_invalid");
  if (typeof rawId === "string") requireReference(rawId, "discord_id_invalid");
  return {
    applicationId,
    id: rawId === undefined || rawId === null ? null : rawId,
    kind: "interaction",
    type,
  };
}
