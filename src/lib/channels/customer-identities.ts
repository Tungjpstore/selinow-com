import { hmacToken } from "../core/crypto";
import { AppError } from "../core/errors";
import { createId } from "../core/ids";
import type { AppBindings } from "../platform/bindings";

const SAFE_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/u;
const SAFE_PROVIDER_CODE = /^[a-z][a-z0-9]*(?:[._:-][a-z0-9]+)*$/u;
const SAFE_LANGUAGE = /^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$/u;
const IDENTITY_SUBJECT_MAX = 512;

type IdentityRow = {
  connectionId: string;
  createdAt: string;
  customerId: string;
  displayHandle: string | null;
  displayName: string | null;
  externalSubjectHash: string;
  id: string;
  languageCode: string | null;
  providerCode: string;
  shopId: string;
  updatedAt: string;
  verifiedAt: string;
};

export type ChannelCustomerIdentity = IdentityRow;

function requireIdentifier(value: string, issue: string): string {
  if (typeof value !== "string" || !SAFE_IDENTIFIER.test(value)) throw new AppError("validation_failed", 400, [issue]);
  return value;
}

function requireProviderCode(value: string): string {
  if (typeof value !== "string" || value.length > 64 || !SAFE_PROVIDER_CODE.test(value)) {
    throw new AppError("validation_failed", 400, ["provider_code_invalid"]);
  }
  return value;
}

function optionalSafeText(value: string | null | undefined, maximum: number, issue: string): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") throw new AppError("validation_failed", 400, [issue]);
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length > maximum) throw new AppError("validation_failed", 400, [issue]);
  for (let index = 0; index < normalized.length; index += 1) {
    const codeUnit = normalized.charCodeAt(index);
    if (codeUnit < 32 || codeUnit === 127) throw new AppError("validation_failed", 400, [issue]);
  }
  return normalized;
}

function optionalLanguage(value: string | null | undefined): string | null {
  const normalized = optionalSafeText(value, 35, "language_code_invalid");
  if (normalized !== null && !SAFE_LANGUAGE.test(normalized)) throw new AppError("validation_failed", 400, ["language_code_invalid"]);
  return normalized;
}

function normalizeSubject(value: string): string {
  if (typeof value !== "string") throw new AppError("validation_failed", 400, ["external_subject_invalid"]);
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length > IDENTITY_SUBJECT_MAX) throw new AppError("validation_failed", 400, ["external_subject_invalid"]);
  for (let index = 0; index < normalized.length; index += 1) {
    const codeUnit = normalized.charCodeAt(index);
    if (codeUnit < 32 || codeUnit === 127) throw new AppError("validation_failed", 400, ["external_subject_invalid"]);
  }
  return normalized;
}

function normalizeTimestamp(value: Date | string | undefined, issue: string): string {
  const date = value instanceof Date ? value : new Date(value ?? Date.now());
  if (!Number.isFinite(date.getTime())) throw new AppError("validation_failed", 400, [issue]);
  return date.toISOString();
}

function mapIdentity(row: IdentityRow): ChannelCustomerIdentity {
  return { ...row };
}

async function loadIdentity(database: D1Database, input: {
  connectionId: string;
  externalSubjectHash: string;
  providerCode: string;
  shopId: string;
}): Promise<IdentityRow | null> {
  return database.prepare(`
    SELECT id, shop_id AS shopId, customer_id AS customerId,
      connection_id AS connectionId, provider_code AS providerCode,
      external_subject_hash AS externalSubjectHash,
      display_name_sanitized AS displayName,
      display_handle_sanitized AS displayHandle,
      language_code AS languageCode, verified_at AS verifiedAt,
      created_at AS createdAt, updated_at AS updatedAt
    FROM channel_customer_identities
    WHERE shop_id = ? AND connection_id = ? AND provider_code = ?
      AND external_subject_hash = ?
    LIMIT 1
  `).bind(input.shopId, input.connectionId, input.providerCode, input.externalSubjectHash).first<IdentityRow>();
}

/**
 * Hashes a provider subject with tenant/connection-bound purpose and upserts
 * only safe display metadata. Raw provider subjects never reach D1 or logs.
 */
export async function upsertChannelCustomerIdentity(input: {
  connectionId: string;
  customerId: string;
  displayHandle?: string | null;
  displayName?: string | null;
  env: Pick<AppBindings, "IDENTIFIER_HMAC_SECRET" | "PLATFORM_DB">;
  externalSubject: string;
  languageCode?: string | null;
  providerCode: string;
  shopId: string;
  verifiedAt?: Date | string;
  now?: Date | string;
}): Promise<ChannelCustomerIdentity> {
  const shopId = requireIdentifier(input.shopId, "shop_id_invalid");
  const customerId = requireIdentifier(input.customerId, "customer_id_invalid");
  const connectionId = requireIdentifier(input.connectionId, "connection_id_invalid");
  const providerCode = requireProviderCode(input.providerCode);
  const externalSubject = normalizeSubject(input.externalSubject);
  const displayName = optionalSafeText(input.displayName, 200, "display_name_invalid");
  const displayHandle = optionalSafeText(input.displayHandle, 128, "display_handle_invalid");
  const languageCode = optionalLanguage(input.languageCode);
  const now = normalizeTimestamp(input.now, "request_time_invalid");
  const verifiedAt = normalizeTimestamp(input.verifiedAt ?? now, "verified_at_invalid");
  if (typeof input.env.IDENTIFIER_HMAC_SECRET !== "string" || input.env.IDENTIFIER_HMAC_SECRET.length < 16) {
    throw new AppError("configuration_invalid", 500, ["identifier_hmac_secret_missing"]);
  }

  const scope = await input.env.PLATFORM_DB.prepare(`
    SELECT connection.provider_code AS providerCode,
      connection.status AS connectionStatus, customers.id AS customerId
    FROM channel_connections AS connection
    INNER JOIN shop_customers AS customers
      ON customers.shop_id = connection.shop_id AND customers.id = ?
    INNER JOIN shop_channels AS channel
      ON channel.shop_id = connection.shop_id
      AND channel.id = connection.shop_channel_id
      AND channel.channel_code = connection.provider_code
    WHERE connection.shop_id = ? AND connection.id = ?
      AND channel.status = 'enabled'
    LIMIT 1
  `).bind(customerId, shopId, connectionId).first<{ connectionStatus: string; customerId: string; providerCode: string }>();
  if (scope === null || scope.providerCode !== providerCode || !["active", "degraded"].includes(scope.connectionStatus)) {
    throw new AppError("channel_customer_identity_scope_invalid", 409);
  }

  const externalSubjectHash = await hmacToken(
    input.env.IDENTIFIER_HMAC_SECRET,
    `channel-customer-identity:v1:${shopId}:${connectionId}:${providerCode}`,
    externalSubject,
  );
  const existing = await loadIdentity(input.env.PLATFORM_DB, { connectionId, externalSubjectHash, providerCode, shopId });
  if (existing !== null && existing.customerId !== customerId) {
    throw new AppError("channel_customer_identity_conflict", 409);
  }

  const identityId = createId("ccid");
  try {
    await input.env.PLATFORM_DB.prepare(`
      INSERT INTO channel_customer_identities (
        id, shop_id, customer_id, connection_id, provider_code,
        external_subject_hash, display_name_sanitized, display_handle_sanitized,
        language_code, verified_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(shop_id, connection_id, provider_code, external_subject_hash)
      DO UPDATE SET
        display_name_sanitized = excluded.display_name_sanitized,
        display_handle_sanitized = excluded.display_handle_sanitized,
        language_code = excluded.language_code,
        verified_at = excluded.verified_at,
        updated_at = excluded.updated_at
      WHERE channel_customer_identities.customer_id = excluded.customer_id
    `).bind(
      identityId, shopId, customerId, connectionId, providerCode,
      externalSubjectHash, displayName, displayHandle, languageCode,
      verifiedAt, now, now,
    ).run();
  } catch {
    const raced = await loadIdentity(input.env.PLATFORM_DB, { connectionId, externalSubjectHash, providerCode, shopId });
    if (raced === null) throw new AppError("channel_customer_identity_upsert_failed", 500);
    if (raced.customerId !== customerId) throw new AppError("channel_customer_identity_conflict", 409);
    return mapIdentity(raced);
  }

  const identity = await loadIdentity(input.env.PLATFORM_DB, { connectionId, externalSubjectHash, providerCode, shopId });
  if (identity === null) throw new AppError("channel_customer_identity_upsert_failed", 500);
  if (identity.customerId !== customerId) throw new AppError("channel_customer_identity_conflict", 409);
  return mapIdentity(identity);
}
