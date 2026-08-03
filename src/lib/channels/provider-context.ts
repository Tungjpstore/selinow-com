import { AppError } from "../core/errors";
import { subscriptionAllows } from "../billing/entitlements";
import type { AppBindings } from "../platform/bindings";
import { decryptDiscordBotCredential, type DiscordBotCredential } from "./discord-credentials";
import {
  decryptWhatsAppCloudCredential,
  type WhatsAppCloudCredential,
} from "./whatsapp-credentials";
import {
  decryptZaloMiniAppCredential,
  type ZaloMiniAppCredential,
} from "./zalo-mini-app-credentials";
import {
  decryptZaloOfficialAccountCredential,
  type ZaloOfficialAccountCredential,
} from "./zalo-oa-credentials";

export type { DiscordBotCredential } from "./discord-credentials";

const PROVIDER_CODE_PATTERN = /^[a-z][a-z0-9]*(?:[._:-][a-z0-9]+)*$/u;
const PUBLIC_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,95}$/u;
const REFERENCE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/u;
const KEY_VERSION_PATTERN = /^v[1-9][0-9]{0,3}$/u;

export type ProviderRuntimeCredential =
  | WhatsAppCloudCredential
  | DiscordBotCredential
  | ZaloMiniAppCredential
  | ZaloOfficialAccountCredential;

export type ProviderRuntimeProviderCode =
  | "whatsapp.cloud"
  | "discord.bot"
  | "zalo.mini_app"
  | "zalo.oa";

export type ProviderRuntimeContext = {
  connectionId: string;
  connectionPublicId: string;
  shopId: string;
  shopPublicId: string;
  providerCode: ProviderRuntimeProviderCode;
  channelCode: string;
  status: "active" | "degraded";
  credentialId: string;
  credentialVersion: number;
  credentialKeyVersion: string;
  credentialFingerprint: string;
  credential: ProviderRuntimeCredential;
  shopStatus: "active";
  subscriptionState: "trialing" | "active" | "past_due" | "grace_period";
};

type ProviderCredentialRow = {
  connectionId: string;
  connectionPublicId: string;
  shopId: string;
  shopPublicId: string;
  providerCode: string;
  channelCode: string;
  connectionStatus: string;
  channelStatus: string;
  shopStatus: string;
  subscriptionState: string;
  trialEndsAt: string | null;
  graceEndsAt: string | null;
  credentialId: string;
  credentialVersion: number;
  credentialKeyVersion: string;
  credentialEnvelopeCiphertextB64: string;
  credentialEnvelopeIvB64: string;
  credentialFingerprint: string;
  credentialStatus: string;
};

type CredentialEnvelopeRow = Pick<
  ProviderCredentialRow,
  | "connectionId"
  | "shopId"
  | "credentialId"
  | "credentialKeyVersion"
  | "credentialEnvelopeCiphertextB64"
  | "credentialEnvelopeIvB64"
  | "credentialFingerprint"
>;

function unavailable(): never {
  throw new AppError("channel_connection_unavailable", 409);
}

function notFound(): never {
  throw new AppError("webhook_not_found", 404);
}

function credentialFailure(issue?: string): never {
  throw new AppError("channel_credential_decryption_failed", 500, issue === undefined ? undefined : [issue]);
}

function requireProviderCode(value: unknown): ProviderRuntimeProviderCode {
  if (typeof value !== "string" || !PROVIDER_CODE_PATTERN.test(value)) {
    throw new AppError("channel_provider_code_invalid", 400);
  }
  if (value !== "whatsapp.cloud" && value !== "discord.bot" && value !== "zalo.mini_app" && value !== "zalo.oa") {
    throw new AppError("channel_adapter_unknown", 404, [value]);
  }
  return value;
}

function requirePublicId(value: unknown): string {
  if (typeof value !== "string" || !PUBLIC_ID_PATTERN.test(value)) notFound();
  return value;
}

function requireReference(value: unknown, issue: string): string {
  if (typeof value !== "string" || !REFERENCE_PATTERN.test(value)) credentialFailure(issue);
  return value;
}

function requireKeyVersion(value: unknown): string {
  if (typeof value !== "string" || !KEY_VERSION_PATTERN.test(value)) credentialFailure("key_version_invalid");
  return value;
}

async function decryptProviderCredential(
  env: AppBindings,
  providerCode: ProviderRuntimeProviderCode,
  row: CredentialEnvelopeRow,
): Promise<ProviderRuntimeCredential> {
  try {
    if (providerCode === "whatsapp.cloud") {
      return Object.freeze(await decryptWhatsAppCloudCredential({ env, row: { ...row, keyVersion: row.credentialKeyVersion } }));
    }
    if (providerCode === "zalo.mini_app") {
      return Object.freeze(await decryptZaloMiniAppCredential({ env, row: { ...row, keyVersion: row.credentialKeyVersion } }));
    }
    if (providerCode === "zalo.oa") {
      return Object.freeze(await decryptZaloOfficialAccountCredential({ env, row: { ...row, keyVersion: row.credentialKeyVersion } }));
    }
    return Object.freeze(await decryptDiscordBotCredential({
      env,
      row: {
        connectionId: row.connectionId,
        credentialEnvelopeCiphertextB64: row.credentialEnvelopeCiphertextB64,
        credentialEnvelopeIvB64: row.credentialEnvelopeIvB64,
        credentialFingerprint: row.credentialFingerprint,
        credentialId: row.credentialId,
        keyVersion: row.credentialKeyVersion,
        shopId: row.shopId,
      },
    }));
  } catch (error) {
    if (error instanceof AppError && error.code === "channel_credential_decryption_failed") throw error;
    credentialFailure();
  }
}

function assertLiveRow(row: ProviderCredentialRow, providerCode: ProviderRuntimeProviderCode): void {
  if (row.providerCode !== providerCode || row.channelCode !== providerCode) {
    throw new AppError("channel_provider_mismatch", 403);
  }
  if (row.connectionStatus !== "active" && row.connectionStatus !== "degraded") unavailable();
  if (row.channelStatus !== "enabled" || row.shopStatus !== "active") unavailable();
  if (!subscriptionAllows({ graceEndsAt: row.graceEndsAt, subscriptionState: row.subscriptionState, trialEndsAt: row.trialEndsAt })) unavailable();
  if (row.credentialStatus !== "active") unavailable();
  requireReference(row.connectionId, "connection_id_invalid");
  requireReference(row.shopId, "shop_id_invalid");
  requireReference(row.credentialId, "credential_id_invalid");
  requirePublicId(row.connectionPublicId);
  requirePublicId(row.shopPublicId);
  if (!Number.isSafeInteger(row.credentialVersion) || row.credentialVersion < 1) credentialFailure("credential_version_invalid");
  requireKeyVersion(row.credentialKeyVersion);
  if (typeof row.credentialFingerprint !== "string" || row.credentialFingerprint.length < 32 || row.credentialFingerprint.length > 128) {
    credentialFailure("fingerprint_invalid");
  }
}

/**
 * Resolves a live provider connection and decrypts its active credential in
 * memory. The returned projection intentionally omits the encrypted envelope;
 * callers must not persist or serialize `credential` outside the request.
 */
export async function loadProviderRuntimeContext(
  env: AppBindings,
  input: { connectionPublicId: string; providerCode: string },
): Promise<ProviderRuntimeContext> {
  const connectionPublicId = requirePublicId(input.connectionPublicId);
  const providerCode = requireProviderCode(input.providerCode);
  if (providerCode === "zalo.oa") {
    // The envelope contract is ready for a reviewed adapter, but no OA route
    // may resolve live credentials until OAuth, webhook and capability gates
    // have external acceptance evidence.
    throw new AppError("channel_provider_pending", 409, [providerCode]);
  }
  const row = await env.PLATFORM_DB.prepare(`
    SELECT
      connection.id AS connectionId,
      connection.public_id AS connectionPublicId,
      connection.shop_id AS shopId,
      connection.provider_code AS providerCode,
      connection.status AS connectionStatus,
      shopChannel.channel_code AS channelCode,
      shopChannel.status AS channelStatus,
      shops.public_id AS shopPublicId,
      shops.status AS shopStatus,
      subscription.state AS subscriptionState,
      subscription.trial_ends_at AS trialEndsAt,
      subscription.grace_ends_at AS graceEndsAt,
      credential.id AS credentialId,
      credential.version AS credentialVersion,
      credential.key_version AS credentialKeyVersion,
      credential.credential_envelope_ciphertext_b64 AS credentialEnvelopeCiphertextB64,
      credential.credential_envelope_iv_b64 AS credentialEnvelopeIvB64,
      credential.credential_fingerprint AS credentialFingerprint,
      credential.status AS credentialStatus
    FROM channel_connections AS connection
    INNER JOIN shop_channels AS shopChannel
      ON shopChannel.shop_id = connection.shop_id
      AND shopChannel.id = connection.shop_channel_id
      AND shopChannel.channel_code = connection.provider_code
    INNER JOIN shops
      ON shops.id = connection.shop_id
    INNER JOIN shop_subscriptions AS subscription
      ON subscription.shop_id = connection.shop_id
    INNER JOIN channel_credentials AS credential
      ON credential.shop_id = connection.shop_id
      AND credential.connection_id = connection.id
      AND credential.provider_code = connection.provider_code
    WHERE connection.public_id = ?
      AND connection.provider_code = ?
      AND connection.status IN ('active', 'degraded')
      AND shopChannel.status = 'enabled'
      AND shops.status = 'active'
      AND credential.status = 'active'
    LIMIT 1
  `).bind(connectionPublicId, providerCode).first<ProviderCredentialRow>();
  if (row === null) notFound();
  assertLiveRow(row, providerCode);
  const credential = await decryptProviderCredential(env, providerCode, row);
  const status = row.connectionStatus === "active" ? "active" : "degraded";
  const subscriptionState = row.subscriptionState as ProviderRuntimeContext["subscriptionState"];
  return Object.freeze({
    connectionId: row.connectionId,
    connectionPublicId: row.connectionPublicId,
    shopId: row.shopId,
    shopPublicId: row.shopPublicId,
    providerCode,
    channelCode: row.channelCode,
    status,
    credentialId: row.credentialId,
    credentialVersion: row.credentialVersion,
    credentialKeyVersion: row.credentialKeyVersion,
    credentialFingerprint: row.credentialFingerprint,
    credential,
    shopStatus: "active",
    subscriptionState,
  });
}

export const resolveProviderRuntimeContext = loadProviderRuntimeContext;
