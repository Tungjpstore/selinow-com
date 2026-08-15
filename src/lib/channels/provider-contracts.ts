import { AppError } from "../core/errors";
import { constantTimeEqual } from "../core/crypto";
import { toBase64Url } from "../core/ids";
import { verifyTelegramMiniAppInitData, type TelegramMiniAppLaunch } from "./mini-app";
import type { NormalizedChannelEvent } from "./types";

/**
 * Provider-facing rules live here instead of in individual routes. The
 * contract is intentionally descriptive: a contract-ready provider still
 * fails closed until credentials, webhook evidence and outbound grants exist.
 */
export type ProviderRuntimeStage = "implemented" | "contract_ready" | "provider_pending";

export type ProviderVerification =
  | { kind: "ed25519_headers"; signatureHeader: string; timestampHeader: string }
  | { kind: "hmac_sha256_header"; header: string; prefix: string }
  | { kind: "init_data_hmac" }
  | { kind: "zalo_event_signature"; header: string }
  | { kind: "shared_secret_header"; header: string }
  | { kind: "provider_pending" };

export type ProviderRuntimeContract = {
  code: string;
  displayName: string;
  inbound: "webhook" | "launch_data" | "provider_pending";
  maxInboundBodyBytes: number;
  outboundOrigin: string | null;
  replayWindowSeconds: number | null;
  stage: ProviderRuntimeStage;
  verification: ProviderVerification;
};

const SAFE_CODE = /^[a-z][a-z0-9]*(?:[._:-][a-z0-9]+)*$/u;
const SAFE_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/u;
const SAFE_EVENT_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u;
const HEX = /^[0-9a-f]+$/iu;
const MAX_WEBHOOK_BODY_BYTES = 3 * 1024 * 1024;
const TELEGRAM_WEBHOOK_BODY_BYTES = 512 * 1024;
const TELEGRAM_MINI_APP_BODY_BYTES = 16 * 1024;
const DISCORD_INTERACTION_BODY_BYTES = 512 * 1024;
const encoder = new TextEncoder();

function ownedBuffer(value: Uint8Array): ArrayBuffer {
  const buffer = new ArrayBuffer(value.byteLength);
  new Uint8Array(buffer).set(value);
  return buffer;
}

export type RawBody = string | Uint8Array;

function bodyBytes(value: RawBody, maximumBytes = MAX_WEBHOOK_BODY_BYTES): Uint8Array {
  const bytes = typeof value === "string" ? encoder.encode(value) : value;
  if (bytes.byteLength > maximumBytes) throw new AppError("channel_webhook_body_too_large", 413);
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy;
}

export const PROVIDER_RUNTIME_CONTRACTS: readonly ProviderRuntimeContract[] = Object.freeze([
  {
    code: "telegram",
    displayName: "Telegram Bot",
    inbound: "webhook",
    maxInboundBodyBytes: TELEGRAM_WEBHOOK_BODY_BYTES,
    outboundOrigin: "https://api.telegram.org",
    replayWindowSeconds: null,
    stage: "implemented",
    verification: { kind: "shared_secret_header", header: "X-Telegram-Bot-Api-Secret-Token" },
  },
  {
    code: "telegram.mini_app",
    displayName: "Telegram Mini App",
    inbound: "launch_data",
    maxInboundBodyBytes: TELEGRAM_MINI_APP_BODY_BYTES,
    outboundOrigin: "https://api.telegram.org",
    replayWindowSeconds: 300,
    stage: "contract_ready",
    verification: { kind: "init_data_hmac" },
  },
  {
    code: "zalo.mini_app",
    displayName: "Zalo Mini App",
    inbound: "webhook",
    maxInboundBodyBytes: MAX_WEBHOOK_BODY_BYTES,
    outboundOrigin: null,
    replayWindowSeconds: null,
    stage: "provider_pending",
    verification: { kind: "zalo_event_signature", header: "x-zevent-signature" },
  },
  {
    code: "zalo.oa",
    displayName: "Zalo Official Account",
    inbound: "provider_pending",
    maxInboundBodyBytes: MAX_WEBHOOK_BODY_BYTES,
    outboundOrigin: null,
    replayWindowSeconds: null,
    stage: "provider_pending",
    verification: { kind: "provider_pending" },
  },
  {
    code: "whatsapp.cloud",
    displayName: "WhatsApp Cloud",
    inbound: "webhook",
    maxInboundBodyBytes: MAX_WEBHOOK_BODY_BYTES,
    outboundOrigin: "https://graph.facebook.com",
    // Meta has no signed timestamp/replay TTL. Duplicate delivery, including
    // retries for up to seven days, is handled by the durable receipt ledger.
    replayWindowSeconds: null,
    stage: "contract_ready",
    verification: { kind: "hmac_sha256_header", header: "X-Hub-Signature-256", prefix: "sha256=" },
  },
  {
    code: "discord.bot",
    displayName: "Discord Bot",
    inbound: "webhook",
    maxInboundBodyBytes: DISCORD_INTERACTION_BODY_BYTES,
    outboundOrigin: "https://discord.com",
    replayWindowSeconds: 300,
    stage: "contract_ready",
    verification: { kind: "ed25519_headers", signatureHeader: "X-Signature-Ed25519", timestampHeader: "X-Signature-Timestamp" },
  },
]);

function requireContract(code: string): ProviderRuntimeContract {
  if (typeof code !== "string" || !SAFE_CODE.test(code)) throw new AppError("channel_provider_code_invalid", 400);
  const contract = PROVIDER_RUNTIME_CONTRACTS.find((candidate) => candidate.code === code);
  if (contract === undefined) throw new AppError("channel_adapter_unknown", 404, [code]);
  return contract;
}

function hexBytes(value: string, issue: string, expectedBytes: number): Uint8Array {
  if (value.length !== expectedBytes * 2 || !HEX.test(value)) throw new AppError("channel_webhook_invalid", 401, [issue]);
  const bytes = new Uint8Array(expectedBytes);
  for (let index = 0; index < expectedBytes; index += 1) {
    bytes[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

async function hmacHex(secret: string, body: RawBody): Promise<string> {
  if (secret.length < 16 || secret.length > 512) throw new AppError("channel_webhook_invalid", 401, ["secret_invalid"]);
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { hash: "SHA-256", name: "HMAC" }, false, ["sign"]);
  const signature = new Uint8Array(await crypto.subtle.sign("HMAC", key, ownedBuffer(bodyBytes(body, MAX_WEBHOOK_BODY_BYTES))));
  return [...signature].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function rejectZaloSignature(issue: string): never {
  throw new AppError("channel_webhook_invalid", 401, [issue]);
}

function zaloCanonicalValue(value: unknown): string {
  if (typeof value === "object" && value !== null) {
    return JSON.stringify(value);
  }
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean" || typeof value === "number") return String(value);
  rejectZaloSignature("zalo_payload_invalid");
}

function zaloCanonicalContent(rawBody: RawBody): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bodyBytes(rawBody, MAX_WEBHOOK_BODY_BYTES))) as unknown;
  } catch {
    rejectZaloSignature("zalo_payload_invalid");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) rejectZaloSignature("zalo_payload_invalid");
  return Object.keys(parsed as Record<string, unknown>)
    .sort()
    .map((key) => zaloCanonicalValue((parsed as Record<string, unknown>)[key]))
    .join("");
}

/**
 * Zalo Mini App Open API signs the parsed event, not the raw JSON bytes:
 * SHA-256(sorted field values + API key), compared with x-zevent-signature.
 * Keep this verifier separate because canonicalization necessarily parses a
 * bounded body before proof, unlike Telegram/Meta/Discord raw-byte proofs.
 */
export async function verifyZaloMiniAppWebhook(input: {
  apiKey: string;
  rawBody: RawBody;
  signature: string | null;
}): Promise<void> {
  if (input.apiKey.length < 16 || input.apiKey.length > 512) rejectZaloSignature("zalo_api_key_invalid");
  const signature = input.signature;
  if (signature === null || signature.length !== 64 || !HEX.test(signature)) rejectZaloSignature("zalo_signature_invalid");
  const content = `${zaloCanonicalContent(input.rawBody)}${input.apiKey}`;
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(content)));
  const expected = [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  if (!constantTimeEqual(expected, signature.toLowerCase())) rejectZaloSignature("zalo_signature_invalid");
}

/** Computes the Zalo Mini App `appsecret_proof` sent with server-side profile calls. */
export async function createZaloMiniAppAppSecretProof(input: {
  accessToken: string;
  appSecret: string;
}): Promise<string> {
  if (input.accessToken.length < 1 || input.accessToken.length > 512) {
    throw new AppError("channel_credential_invalid", 400, ["zalo_access_token_invalid"]);
  }
  return hmacHex(input.appSecret, input.accessToken);
}

function parseTimestamp(value: string, now: Date, maxAgeSeconds: number): void {
  if (!/^\d{1,12}$/u.test(value)) throw new AppError("channel_webhook_invalid", 401, ["timestamp_invalid"]);
  const timestampSeconds = Number(value);
  if (!Number.isSafeInteger(timestampSeconds) || !Number.isFinite(now.getTime())) {
    throw new AppError("channel_webhook_invalid", 401, ["timestamp_invalid"]);
  }
  const age = Math.floor(now.getTime() / 1_000) - timestampSeconds;
  if (age < -30 || age > maxAgeSeconds) throw new AppError("channel_webhook_replay", 401);
}

export function getProviderRuntimeContract(code: string): ProviderRuntimeContract {
  return requireContract(code);
}

export function listProviderRuntimeContracts(): readonly ProviderRuntimeContract[] {
  return PROVIDER_RUNTIME_CONTRACTS;
}

export function assertProviderEndpoint(code: string, value: string): URL {
  const contract = requireContract(code);
  if (contract.outboundOrigin === null) throw new AppError("channel_provider_pending", 409, [code]);
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new AppError("channel_provider_endpoint_invalid", 400);
  }
  if (url.origin !== contract.outboundOrigin || url.protocol !== "https:") {
    throw new AppError("channel_provider_endpoint_invalid", 400, [code]);
  }
  return url;
}

export function verifyTelegramWebhookSecret(input: { expected: string; provided: string | null }): void {
  const validToken = (value: string): boolean => value.length >= 1 && value.length <= 256 && /^[A-Za-z0-9_-]+$/u.test(value);
  if (!validToken(input.expected) || input.provided === null || !validToken(input.provided)
    || !constantTimeEqual(input.expected, input.provided)) {
    throw new AppError("channel_webhook_invalid", 401, ["telegram_secret_invalid"]);
  }
}

export async function verifyWhatsAppCloudWebhook(input: {
  appSecret: string;
  rawBody: RawBody;
  signature: string | null;
}): Promise<void> {
  const signature = input.signature;
  const prefix = "sha256=";
  if (signature === null || !signature.startsWith(prefix)) throw new AppError("channel_webhook_invalid", 401, ["whatsapp_signature_missing"]);
  const received = signature.slice(prefix.length);
  if (received.length !== 64 || !HEX.test(received)) throw new AppError("channel_webhook_invalid", 401, ["whatsapp_signature_invalid"]);
  const expected = await hmacHex(input.appSecret, input.rawBody);
  if (!constantTimeEqual(expected, received.toLowerCase())) throw new AppError("channel_webhook_invalid", 401, ["whatsapp_signature_invalid"]);
  // WhatsApp signs the body, while the replay fence is enforced by the
  // provider event idempotency ledger at the route boundary.
}

export async function verifyDiscordInteraction(input: {
  now?: Date;
  publicKeyHex: string;
  rawBody: RawBody;
  signatureHex: string | null;
  timestamp: string | null;
}): Promise<void> {
  const now = input.now ?? new Date();
  if (input.signatureHex === null || input.timestamp === null) throw new AppError("channel_webhook_invalid", 401, ["discord_signature_missing"]);
  parseTimestamp(input.timestamp, now, 300);
  const signature = hexBytes(input.signatureHex, "discord_signature_invalid", 64);
  const publicKey = hexBytes(input.publicKeyHex, "discord_public_key_invalid", 32);
  let key: CryptoKey;
  try {
    key = await crypto.subtle.importKey("raw", ownedBuffer(publicKey), { name: "Ed25519" }, false, ["verify"]);
  } catch {
    throw new AppError("channel_webhook_invalid", 401, ["discord_public_key_invalid"]);
  }
  const body = bodyBytes(input.rawBody, DISCORD_INTERACTION_BODY_BYTES);
  const timestampBytes = encoder.encode(input.timestamp);
  const message = new Uint8Array(timestampBytes.byteLength + body.byteLength);
  message.set(timestampBytes);
  message.set(body, timestampBytes.byteLength);
  const valid = await crypto.subtle.verify("Ed25519", key, ownedBuffer(signature), ownedBuffer(message));
  if (!valid) throw new AppError("channel_webhook_invalid", 401, ["discord_signature_invalid"]);
}

export async function verifyProviderWebhook(input: {
  code: string;
  credentialSecret?: string;
  now?: Date;
  publicKeyHex?: string;
  rawBody: RawBody;
  signature?: string | null;
  timestamp?: string | null;
}): Promise<void> {
  const contract = requireContract(input.code);
  if (contract.stage === "provider_pending") throw new AppError("channel_provider_pending", 409, [contract.code]);
  switch (contract.verification.kind) {
    case "shared_secret_header":
      verifyTelegramWebhookSecret({ expected: input.credentialSecret ?? "", provided: input.signature ?? null });
      return;
    case "hmac_sha256_header":
      await verifyWhatsAppCloudWebhook({ appSecret: input.credentialSecret ?? "", rawBody: input.rawBody, signature: input.signature ?? null });
      return;
    case "ed25519_headers":
      await verifyDiscordInteraction({ now: input.now ?? new Date(), publicKeyHex: input.publicKeyHex ?? "", rawBody: input.rawBody, signatureHex: input.signature ?? null, timestamp: input.timestamp ?? null });
      return;
    case "zalo_event_signature":
      await verifyZaloMiniAppWebhook({ apiKey: input.credentialSecret ?? "", rawBody: input.rawBody, signature: input.signature ?? null });
      return;
    case "provider_pending":
      throw new AppError("channel_provider_pending", 409, [contract.code]);
    case "init_data_hmac":
      throw new AppError("channel_init_data_required", 400, [contract.code]);
  }
}

export async function verifyTelegramMiniAppLaunch(input: {
  botToken: string;
  initData: string;
  maxAgeSeconds?: number;
  now?: Date;
}): Promise<TelegramMiniAppLaunch> {
  const launch = await verifyTelegramMiniAppInitData({
    ...input,
    maxAgeSeconds: input.maxAgeSeconds ?? 300,
  });
  // Telegram user IDs are numeric provider identifiers. Keep them as strings
  // to avoid precision loss, but reject arbitrary browser-supplied subjects.
  if (!/^\d{1,16}$/u.test(launch.user.id)) throw new AppError("telegram_mini_app_invalid", 401);
  return launch;
}

export async function normalizeProviderEvent(input: {
  action: string;
  connectionId: string;
  eventId: string;
  providerCode: string;
  rawBody: RawBody;
  receivedAt?: Date;
  shopId: string;
}): Promise<NormalizedChannelEvent> {
  const contract = requireContract(input.providerCode);
  if (contract.stage === "provider_pending") throw new AppError("channel_provider_pending", 409, [contract.code]);
  if (!SAFE_IDENTIFIER.test(input.connectionId) || !SAFE_IDENTIFIER.test(input.shopId) || !SAFE_EVENT_ID.test(input.eventId)) {
    throw new AppError("channel_event_invalid", 400);
  }
  if (!SAFE_CODE.test(input.action)) throw new AppError("channel_event_invalid", 400, ["action_invalid"]);
  const receivedAt = input.receivedAt ?? new Date();
  if (!Number.isFinite(receivedAt.getTime())) throw new AppError("channel_event_invalid", 400, ["received_at_invalid"]);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", ownedBuffer(bodyBytes(input.rawBody, contract.maxInboundBodyBytes))));
  const payloadReference = toBase64Url(digest);
  return Object.freeze({
    action: input.action,
    channelCode: contract.code,
    connectionId: input.connectionId,
    eventId: input.eventId,
    idempotencyKey: `${contract.code}:${input.eventId}`,
    payloadReference,
    receivedAt: receivedAt.toISOString(),
    shopId: input.shopId,
  });
}
