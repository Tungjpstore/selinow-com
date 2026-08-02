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
export const MAX_PROVIDER_WEBHOOK_BODY_BYTES = 512 * 1024;

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
  | { kind: "ping"; type: 1 }
  | { id: string | null; kind: "interaction"; type: number };

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
  }
  return null;
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
  if (contract.verification.kind === "provider_pending" || contract.verification.kind === "init_data_hmac") {
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
  const rawBody = await readBoundedBytes(input.request, MAX_PROVIDER_WEBHOOK_BODY_BYTES);
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
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(input.initData)));
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
    || !constantTimeEqual(input.expectedToken, input.providedToken)) {
    rejectProviderRoute("whatsapp_verify_token_invalid");
  }
  if (input.challenge === null || !SAFE_CHALLENGE.test(input.challenge)) rejectProviderRoute("whatsapp_challenge_invalid");
  return input.challenge;
}

export function parseDiscordInteraction(rawBody: RawBody): DiscordInteractionEnvelope {
  const bytes = typeof rawBody === "string" ? encoder.encode(rawBody) : rawBody;
  if (bytes.byteLength > MAX_PROVIDER_WEBHOOK_BODY_BYTES) rejectProviderRoute("body_too_large", 413);
  const record = decodeJsonObject(bytes);
  const type = record.type;
  if (typeof type !== "number" || !Number.isSafeInteger(type) || type < 1 || type > 255) rejectProviderRoute("discord_type_invalid");
  if (type === 1) return { kind: "ping", type: 1 };
  const rawId = record.id;
  if (rawId !== undefined && rawId !== null && typeof rawId !== "string") rejectProviderRoute("discord_id_invalid");
  if (typeof rawId === "string") requireReference(rawId, "discord_id_invalid");
  return {
    id: rawId === undefined || rawId === null ? null : rawId,
    kind: "interaction",
    type,
  };
}
