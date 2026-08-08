import { AppError } from "../core/errors";
import { createId } from "../core/ids";
import type { AppBindings } from "../platform/bindings";
import { subscriptionAllows } from "../billing/entitlements";
import { getProviderRuntimeContract } from "./provider-contracts";
import { requireChannelExpansion } from "./expansion";

const SAFE_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/u;
const HASH_REFERENCE = /^[A-Za-z0-9_-]{43}$/u;
const PROVIDER_CODE = /^[a-z][a-z0-9]*(?:[._:-][a-z0-9]+)*$/u;
const SAFE_METADATA_KEY = /^[a-z][a-z0-9_]{1,63}$/u;
const FORBIDDEN_METADATA_KEY = /(?:secret|token|payload|body|credential|password|authorization|header|raw|cipher|iv)/iu;
const EVIDENCE_KINDS = ["webhook", "identity", "capability", "outbound_acceptance"] as const;

export type ProviderVerificationKind = typeof EVIDENCE_KINDS[number];
export type ProviderVerificationStatus = "observed" | "reviewed" | "rejected";

export type ProviderVerificationEvidence = {
  connectionId: string;
  credentialFingerprint: string;
  credentialVersion: number;
  evidenceReference: string;
  expiresAt: string;
  id: string;
  providerCode: string;
  providerIdentityFingerprint: string | null;
  reviewedAt: string | null;
  reviewedByUserId: string | null;
  safeMetadata: Readonly<Record<string, string | number | boolean | null>>;
  shopId: string;
  status: ProviderVerificationStatus;
  verificationKind: ProviderVerificationKind;
  verifiedAt: string;
  version: number;
};

type EvidenceRow = {
  connectionId: string;
  credentialFingerprint: string;
  credentialVersion: number;
  evidenceReference: string;
  expiresAt: string;
  id: string;
  providerCode: string;
  providerIdentityFingerprint: string | null;
  reviewedAt: string | null;
  reviewedByUserId: string | null;
  safeMetadataJson: string;
  shopId: string;
  status: ProviderVerificationStatus;
  verificationKind: ProviderVerificationKind;
  verifiedAt: string;
  version: number;
};

type ConnectionEvidenceContext = {
  channelStatus: string;
  connectionStatus: string;
  credentialFingerprint: string;
  credentialId: string;
  credentialStatus: string;
  credentialVersion: number;
  providerCode: string;
  shopId: string;
  shopStatus: string;
  subscriptionState: string;
  trialEndsAt: string | null;
  graceEndsAt: string | null;
};

type EvidenceResult = { evidence: ProviderVerificationEvidence; result: "accepted" | "replay" };

export type ProviderVerificationEvidenceInput = {
  evidenceReference: string;
  expiresAt: string;
  providerIdentityFingerprint?: string | null;
  safeMetadata?: Readonly<Record<string, unknown>>;
  verificationKind: string;
  verifiedAt?: string;
};

export type ProviderVerificationAdmissionResult =
  | {
      evidence: readonly ProviderVerificationEvidence[];
      mode: "pending-only";
      pendingReason: "provider_contract_pending";
      providerCode: string;
      persisted: false;
    }
  | {
      evidence: readonly ProviderVerificationEvidence[];
      mode: "recorded";
      pendingReason: "manual_review_required";
      providerCode: string;
      persisted: true;
      replayedEvidenceCount: number;
      result: "accepted" | "replay";
    };

function requireIdentifier(value: string, issue: string): string {
  if (!SAFE_IDENTIFIER.test(value)) throw new AppError("channel_reference_invalid", 400, [issue]);
  return value;
}

function requireProviderCode(value: string): string {
  if (!PROVIDER_CODE.test(value)) throw new AppError("channel_provider_code_invalid", 400);
  getProviderRuntimeContract(value);
  return value;
}

function requireHash(value: string, issue: string): string {
  if (!HASH_REFERENCE.test(value)) throw new AppError("validation_failed", 400, [issue]);
  return value;
}

function requireVersion(value: number, issue: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new AppError("validation_failed", 400, [issue]);
  return value;
}

function requireIso(value: string, issue: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime()) || date.toISOString() !== value) throw new AppError("validation_failed", 400, [issue]);
  return value;
}

function requireKind(value: string): ProviderVerificationKind {
  if (!(EVIDENCE_KINDS as readonly string[]).includes(value)) throw new AppError("validation_failed", 400, ["verification_kind_invalid"]);
  return value as ProviderVerificationKind;
}

function safeMetadata(value: Readonly<Record<string, unknown>> | undefined): Readonly<Record<string, string | number | boolean | null>> {
  const record = value ?? {};
  const output: Record<string, string | number | boolean | null> = {};
  const keys = Object.keys(record);
  if (keys.length > 16) throw new AppError("validation_failed", 400, ["safe_metadata_too_large"]);
  for (const key of keys) {
    if (!SAFE_METADATA_KEY.test(key) || FORBIDDEN_METADATA_KEY.test(key)) throw new AppError("validation_failed", 400, ["safe_metadata_key_invalid"]);
    const item = record[key];
    if (item !== null && typeof item !== "string" && typeof item !== "number" && typeof item !== "boolean") {
      throw new AppError("validation_failed", 400, ["safe_metadata_value_invalid"]);
    }
    if (typeof item === "string") {
      if (item.length > 256) throw new AppError("validation_failed", 400, ["safe_metadata_value_invalid"]);
      for (const character of item) {
        const code = character.codePointAt(0) ?? 0;
        if (code < 0x20 || code === 0x7f) throw new AppError("validation_failed", 400, ["safe_metadata_value_invalid"]);
      }
    }
    if (typeof item === "number" && !Number.isFinite(item)) throw new AppError("validation_failed", 400, ["safe_metadata_value_invalid"]);
    output[key] = item;
  }
  return Object.freeze(output);
}

function parseSafeMetadata(value: string): Readonly<Record<string, string | number | boolean | null>> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch {
    throw new AppError("channel_provider_verification_invalid", 500);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new AppError("channel_provider_verification_invalid", 500);
  return safeMetadata(parsed as Record<string, unknown>);
}

function serializeSafeMetadata(value: Readonly<Record<string, string | number | boolean | null>>): string {
  // Stable key ordering makes idempotent evidence comparisons semantic rather
  // than dependent on the caller's object insertion order.
  const serialized = JSON.stringify(Object.fromEntries(Object.keys(value).sort().map((key) => [key, value[key]])));
  if (serialized.length > 4_096) throw new AppError("validation_failed", 400, ["safe_metadata_too_large"]);
  return serialized;
}

function mapEvidence(row: EvidenceRow): ProviderVerificationEvidence {
  return Object.freeze({
    connectionId: row.connectionId,
    credentialFingerprint: row.credentialFingerprint,
    credentialVersion: row.credentialVersion,
    evidenceReference: row.evidenceReference,
    expiresAt: row.expiresAt,
    id: row.id,
    providerCode: row.providerCode,
    providerIdentityFingerprint: row.providerIdentityFingerprint,
    reviewedAt: row.reviewedAt,
    reviewedByUserId: row.reviewedByUserId,
    safeMetadata: parseSafeMetadata(row.safeMetadataJson),
    shopId: row.shopId,
    status: row.status,
    verificationKind: row.verificationKind,
    verifiedAt: row.verifiedAt,
    version: row.version,
  });
}

function validateTimeWindow(verifiedAt: string, expiresAt: string, now: Date): void {
  const verified = Date.parse(verifiedAt);
  const expires = Date.parse(expiresAt);
  if (!Number.isFinite(now.getTime()) || !Number.isFinite(verified) || !Number.isFinite(expires) || expires <= verified) {
    throw new AppError("validation_failed", 400, ["verification_time_invalid"]);
  }
  if (verified > now.getTime()) throw new AppError("validation_failed", 400, ["verification_time_invalid"]);
  if (expires <= now.getTime()) throw new AppError("channel_provider_verification_expired", 409);
}

async function loadConnectionEvidenceContext(env: AppBindings, input: {
  connectionId: string;
  providerCode: string;
  shopId: string;
}): Promise<ConnectionEvidenceContext> {
  const row = await env.PLATFORM_DB.prepare(`
    SELECT
      connection.provider_code AS providerCode,
      connection.status AS connectionStatus,
      channel.status AS channelStatus,
      shops.status AS shopStatus,
      subscription.state AS subscriptionState,
      subscription.trial_ends_at AS trialEndsAt,
      subscription.grace_ends_at AS graceEndsAt,
      credential.id AS credentialId,
      credential.status AS credentialStatus,
      credential.version AS credentialVersion,
      credential.credential_fingerprint AS credentialFingerprint
    FROM channel_connections AS connection
    INNER JOIN shop_channels AS channel
      ON channel.shop_id = connection.shop_id
      AND channel.id = connection.shop_channel_id
      AND channel.channel_code = connection.provider_code
    INNER JOIN shops ON shops.id = connection.shop_id
    INNER JOIN shop_subscriptions AS subscription ON subscription.shop_id = connection.shop_id
    INNER JOIN channel_credentials AS credential
      ON credential.shop_id = connection.shop_id
      AND credential.connection_id = connection.id
      AND credential.provider_code = connection.provider_code
      AND credential.status IN ('pending', 'active')
    WHERE connection.shop_id = ? AND connection.id = ? AND connection.provider_code = ?
    ORDER BY credential.version DESC LIMIT 1
  `).bind(input.shopId, input.connectionId, input.providerCode).first<ConnectionEvidenceContext>();
  if (row === null) throw new AppError("channel_connection_not_found", 404);
  if (row.providerCode !== input.providerCode) throw new AppError("channel_provider_mismatch", 403);
  if (row.channelStatus !== "enabled" || row.shopStatus !== "active" || !subscriptionAllows({ graceEndsAt: row.graceEndsAt, subscriptionState: row.subscriptionState, trialEndsAt: row.trialEndsAt })) {
    throw new AppError("channel_connection_unavailable", 409);
  }
  if (!Number.isSafeInteger(row.credentialVersion) || row.credentialVersion < 1) throw new AppError("channel_credential_invalid", 500);
  return row;
}

async function loadEvidence(env: AppBindings, input: { evidenceId: string; providerCode: string; shopId: string; connectionId: string }): Promise<EvidenceRow | null> {
  return env.PLATFORM_DB.prepare(`
    SELECT id, shop_id AS shopId, connection_id AS connectionId, provider_code AS providerCode,
      credential_version AS credentialVersion, credential_fingerprint AS credentialFingerprint,
      verification_kind AS verificationKind, evidence_reference AS evidenceReference,
      provider_identity_fingerprint AS providerIdentityFingerprint,
      safe_metadata_json AS safeMetadataJson, status, verified_at AS verifiedAt,
      expires_at AS expiresAt, reviewed_by_user_id AS reviewedByUserId,
      reviewed_at AS reviewedAt, version
    FROM channel_provider_verification_evidence
    WHERE id = ? AND shop_id = ? AND connection_id = ? AND provider_code = ?
    LIMIT 1
  `).bind(input.evidenceId, input.shopId, input.connectionId, input.providerCode).first<EvidenceRow>();
}

export async function recordProviderVerificationEvidence(input: {
  env: AppBindings;
  connectionId: string;
  credentialFingerprint: string;
  credentialVersion: number;
  evidenceReference: string;
  expiresAt: string;
  providerCode: string;
  providerIdentityFingerprint?: string | null;
  requestId: string;
  safeMetadata?: Readonly<Record<string, unknown>>;
  shopId: string;
  verificationKind: string;
  verifiedAt?: string;
}): Promise<EvidenceResult> {
  requireIdentifier(input.shopId, "shop_id_invalid");
  requireIdentifier(input.connectionId, "connection_id_invalid");
  requireIdentifier(input.requestId, "request_id_invalid");
  const providerCode = requireProviderCode(input.providerCode);
  const evidenceReference = requireHash(input.evidenceReference, "evidence_reference_invalid");
  const credentialFingerprint = requireHash(input.credentialFingerprint, "credential_fingerprint_invalid");
  const credentialVersion = requireVersion(input.credentialVersion, "credential_version_invalid");
  const verificationKind = requireKind(input.verificationKind);
  const providerIdentityFingerprint = input.providerIdentityFingerprint === undefined || input.providerIdentityFingerprint === null
    ? null
    : requireHash(input.providerIdentityFingerprint, "provider_identity_fingerprint_invalid");
  const metadata = safeMetadata(input.safeMetadata);
  const now = new Date();
  const verifiedAt = requireIso(input.verifiedAt ?? now.toISOString(), "verified_at_invalid");
  const expiresAt = requireIso(input.expiresAt, "expires_at_invalid");
  validateTimeWindow(verifiedAt, expiresAt, now);
  if (verificationKind === "identity" && providerIdentityFingerprint === null) {
    throw new AppError("validation_failed", 400, ["provider_identity_fingerprint_required"]);
  }
  const context = await loadConnectionEvidenceContext(input.env, { connectionId: input.connectionId, providerCode, shopId: input.shopId });
  if (context.credentialVersion !== credentialVersion || context.credentialFingerprint !== credentialFingerprint) {
    throw new AppError("channel_credential_conflict", 409);
  }
  const id = createId("cve");
  const nowIso = now.toISOString();
  const inserted = await input.env.PLATFORM_DB.prepare(`
    INSERT OR IGNORE INTO channel_provider_verification_evidence (
      id, shop_id, connection_id, provider_code, credential_version,
      credential_fingerprint, verification_kind, evidence_reference,
      provider_identity_fingerprint, safe_metadata_json, status, verified_at,
      expires_at, created_at, updated_at, version
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'observed', ?, ?, ?, ?, 1)
  `).bind(
    id, input.shopId, input.connectionId, providerCode, credentialVersion,
    credentialFingerprint, verificationKind, evidenceReference,
    providerIdentityFingerprint, serializeSafeMetadata(metadata), verifiedAt,
    expiresAt, nowIso, nowIso,
  ).run();
  const row = await loadEvidence(input.env, { evidenceId: id, providerCode, shopId: input.shopId, connectionId: input.connectionId })
    ?? await input.env.PLATFORM_DB.prepare(`
      SELECT id, shop_id AS shopId, connection_id AS connectionId, provider_code AS providerCode,
        credential_version AS credentialVersion, credential_fingerprint AS credentialFingerprint,
        verification_kind AS verificationKind, evidence_reference AS evidenceReference,
        provider_identity_fingerprint AS providerIdentityFingerprint,
        safe_metadata_json AS safeMetadataJson, status, verified_at AS verifiedAt,
        expires_at AS expiresAt, reviewed_by_user_id AS reviewedByUserId,
        reviewed_at AS reviewedAt, version
      FROM channel_provider_verification_evidence
      WHERE shop_id = ? AND connection_id = ? AND provider_code = ?
        AND verification_kind = ? AND evidence_reference = ?
      LIMIT 1
    `).bind(input.shopId, input.connectionId, providerCode, verificationKind, evidenceReference).first<EvidenceRow>();
  if (row === null) throw new AppError("channel_provider_verification_failed", 500);
  const mapped = mapEvidence(row);
  if (inserted.meta.changes === 1) return { evidence: mapped, result: "accepted" };
  const same = mapped.credentialVersion === credentialVersion
    && mapped.credentialFingerprint === credentialFingerprint
    && mapped.providerIdentityFingerprint === providerIdentityFingerprint
    && mapped.verifiedAt === verifiedAt
    && mapped.expiresAt === expiresAt
    && serializeSafeMetadata(mapped.safeMetadata) === serializeSafeMetadata(metadata);
  if (!same) throw new AppError("channel_provider_verification_conflict", 409);
  return { evidence: mapped, result: "replay" };
}

/**
 * Records a provider evidence bundle without ever making the connection
 * executable. The bundle is tenant/credential bound and is inserted with a
 * single D1 batch so a partial webhook/identity/capability set cannot leak
 * into the ledger. Provider-pending contracts return a read-only result and
 * do not mutate D1; reviewed human promotion remains a separate operation.
 */
export async function admitProviderVerificationEvidence(input: {
  connectionId: string;
  credentialFingerprint: string;
  credentialVersion: number;
  env: AppBindings;
  evidence: readonly ProviderVerificationEvidenceInput[];
  providerCode: string;
  requestId: string;
  shopId: string;
}): Promise<ProviderVerificationAdmissionResult> {
  requireIdentifier(input.shopId, "shop_id_invalid");
  requireIdentifier(input.connectionId, "connection_id_invalid");
  requireIdentifier(input.requestId, "request_id_invalid");
  const providerCode = requireProviderCode(input.providerCode);
  const credentialFingerprint = requireHash(input.credentialFingerprint, "credential_fingerprint_invalid");
  const credentialVersion = requireVersion(input.credentialVersion, "credential_version_invalid");
  if (input.evidence.length < 1 || input.evidence.length > 16) {
    throw new AppError("validation_failed", 400, ["evidence_bundle_invalid"]);
  }

  const now = new Date();
  const preparedEvidence = input.evidence.map((item) => {
    const evidenceReference = requireHash(item.evidenceReference, "evidence_reference_invalid");
    const verificationKind = requireKind(item.verificationKind);
    const providerIdentityFingerprint = item.providerIdentityFingerprint === undefined || item.providerIdentityFingerprint === null
      ? null
      : requireHash(item.providerIdentityFingerprint, "provider_identity_fingerprint_invalid");
    const metadata = safeMetadata(item.safeMetadata);
    const verifiedAt = requireIso(item.verifiedAt ?? now.toISOString(), "verified_at_invalid");
    const expiresAt = requireIso(item.expiresAt, "expires_at_invalid");
    validateTimeWindow(verifiedAt, expiresAt, now);
    if (verificationKind === "identity" && providerIdentityFingerprint === null) {
      throw new AppError("validation_failed", 400, ["provider_identity_fingerprint_required"]);
    }
    return Object.freeze({
      evidenceReference,
      expiresAt,
      metadata,
      providerIdentityFingerprint,
      verificationKind,
      verifiedAt,
    });
  });
  const identity = new Set(preparedEvidence.map((item) => `${item.verificationKind}:${item.evidenceReference}`));
  if (identity.size !== preparedEvidence.length) {
    throw new AppError("validation_failed", 400, ["evidence_bundle_duplicate"]);
  }

  const context = await loadConnectionEvidenceContext(input.env, {
    connectionId: input.connectionId,
    providerCode,
    shopId: input.shopId,
  });
  if (context.credentialVersion !== credentialVersion || context.credentialFingerprint !== credentialFingerprint) {
    throw new AppError("channel_credential_conflict", 409);
  }

  if (getProviderRuntimeContract(providerCode).stage === "provider_pending") {
    return Object.freeze({
      evidence: Object.freeze([]),
      mode: "pending-only",
      pendingReason: "provider_contract_pending",
      providerCode,
      persisted: false,
    });
  }

  const nowIso = now.toISOString();
  const statements = preparedEvidence.map((item) => input.env.PLATFORM_DB.prepare(`
    INSERT OR IGNORE INTO channel_provider_verification_evidence (
      id, shop_id, connection_id, provider_code, credential_version,
      credential_fingerprint, verification_kind, evidence_reference,
      provider_identity_fingerprint, safe_metadata_json, status, verified_at,
      expires_at, created_at, updated_at, version
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'observed', ?, ?, ?, ?, 1)
  `).bind(
    createId("cve"), input.shopId, input.connectionId, providerCode, credentialVersion,
    credentialFingerprint, item.verificationKind, item.evidenceReference,
    item.providerIdentityFingerprint, serializeSafeMetadata(item.metadata),
    item.verifiedAt, item.expiresAt, nowIso, nowIso,
  ));
  let batchResults: readonly { meta: { changes: number } }[];
  try {
    batchResults = await input.env.PLATFORM_DB.batch(statements);
  } catch {
    // D1 batches are atomic; avoid exposing provider/database details in the
    // error surface while preserving the fail-closed mutation boundary.
    throw new AppError("channel_provider_verification_failed", 500);
  }
  if (batchResults.length !== preparedEvidence.length) {
    throw new AppError("channel_provider_verification_failed", 500);
  }

  const pairClauses = preparedEvidence.map(() => "(verification_kind = ? AND evidence_reference = ?)").join(" OR ");
  const rows = await input.env.PLATFORM_DB.prepare(`
    SELECT id, shop_id AS shopId, connection_id AS connectionId, provider_code AS providerCode,
      credential_version AS credentialVersion, credential_fingerprint AS credentialFingerprint,
      verification_kind AS verificationKind, evidence_reference AS evidenceReference,
      provider_identity_fingerprint AS providerIdentityFingerprint,
      safe_metadata_json AS safeMetadataJson, status, verified_at AS verifiedAt,
      expires_at AS expiresAt, reviewed_by_user_id AS reviewedByUserId,
      reviewed_at AS reviewedAt, version
    FROM channel_provider_verification_evidence
    WHERE shop_id = ? AND connection_id = ? AND provider_code = ?
      AND (${pairClauses})
  `).bind(
    input.shopId, input.connectionId, providerCode,
    ...preparedEvidence.flatMap((item) => [item.verificationKind, item.evidenceReference]),
  ).all<EvidenceRow>();
  if (rows.results.length !== preparedEvidence.length) {
    throw new AppError("channel_provider_verification_failed", 500);
  }
  const byIdentity = new Map(rows.results.map((row) => [`${row.verificationKind}:${row.evidenceReference}`, row]));
  let replayedEvidenceCount = 0;
  const evidence = preparedEvidence.map((item) => {
    const row = byIdentity.get(`${item.verificationKind}:${item.evidenceReference}`);
    if (row === undefined) throw new AppError("channel_provider_verification_failed", 500);
    const same = row.credentialVersion === credentialVersion
      && row.credentialFingerprint === credentialFingerprint
      && row.providerIdentityFingerprint === item.providerIdentityFingerprint
      && row.verifiedAt === item.verifiedAt
      && row.expiresAt === item.expiresAt
      && row.safeMetadataJson === serializeSafeMetadata(item.metadata);
    if (!same) {
      throw new AppError("channel_provider_verification_conflict", 409);
    }
    if (row.status !== "observed") throw new AppError("channel_provider_verification_conflict", 409);
    const resultIndex = preparedEvidence.indexOf(item);
    if (batchResults[resultIndex]?.meta.changes === 0) replayedEvidenceCount += 1;
    return mapEvidence(row);
  });
  return Object.freeze({
    evidence: Object.freeze(evidence),
    mode: "recorded",
    pendingReason: "manual_review_required",
    providerCode,
    persisted: true,
    replayedEvidenceCount,
    result: replayedEvidenceCount === preparedEvidence.length ? "replay" : "accepted",
  });
}

export async function reviewProviderVerificationEvidence(input: {
  decision: "reviewed" | "rejected";
  env: AppBindings;
  evidenceId: string;
  expectedVersion: number;
  requestId: string;
  reviewerUserId: string;
  shopId: string;
}): Promise<ProviderVerificationEvidence> {
  requireIdentifier(input.shopId, "shop_id_invalid");
  requireIdentifier(input.evidenceId, "evidence_id_invalid");
  requireIdentifier(input.reviewerUserId, "reviewer_id_invalid");
  requireVersion(input.expectedVersion, "evidence_version_invalid");
  const reviewer = await input.env.PLATFORM_DB.prepare(`
    SELECT 1 AS allowed FROM shop_members
    WHERE shop_id = ? AND user_id = ? AND status = 'active' AND role IN ('owner', 'manager') LIMIT 1
  `).bind(input.shopId, input.reviewerUserId).first<{ allowed: number }>();
  if (reviewer === null) throw new AppError("authorization_denied", 403);
  const row = await input.env.PLATFORM_DB.prepare(`
    SELECT id, shop_id AS shopId, connection_id AS connectionId, provider_code AS providerCode,
      credential_version AS credentialVersion, credential_fingerprint AS credentialFingerprint,
      verification_kind AS verificationKind, evidence_reference AS evidenceReference,
      provider_identity_fingerprint AS providerIdentityFingerprint,
      safe_metadata_json AS safeMetadataJson, status, verified_at AS verifiedAt,
      expires_at AS expiresAt, reviewed_by_user_id AS reviewedByUserId,
      reviewed_at AS reviewedAt, version
    FROM channel_provider_verification_evidence
    WHERE id = ? AND shop_id = ? LIMIT 1
  `).bind(input.evidenceId, input.shopId).first<EvidenceRow>();
  if (row === null) throw new AppError("channel_provider_verification_not_found", 404);
  const now = new Date();
  if (Date.parse(row.expiresAt) <= now.getTime()) throw new AppError("channel_provider_verification_expired", 409);
  if (row.status !== "observed") {
    if (row.status === input.decision && row.reviewedByUserId === input.reviewerUserId) return mapEvidence(row);
    throw new AppError("channel_provider_verification_conflict", 409);
  }
  const reviewedAt = now.toISOString();
  const updated = await input.env.PLATFORM_DB.prepare(`
    UPDATE channel_provider_verification_evidence
    SET status = ?, reviewed_by_user_id = ?, reviewed_at = ?,
      updated_at = ?, version = version + 1
    WHERE id = ? AND shop_id = ? AND status = 'observed' AND version = ?
  `).bind(input.decision, input.reviewerUserId, reviewedAt, reviewedAt, input.evidenceId, input.shopId, input.expectedVersion).run();
  if (updated.meta.changes !== 1) throw new AppError("channel_provider_verification_conflict", 409);
  const result = await input.env.PLATFORM_DB.prepare(`
    SELECT id, shop_id AS shopId, connection_id AS connectionId, provider_code AS providerCode,
      credential_version AS credentialVersion, credential_fingerprint AS credentialFingerprint,
      verification_kind AS verificationKind, evidence_reference AS evidenceReference,
      provider_identity_fingerprint AS providerIdentityFingerprint,
      safe_metadata_json AS safeMetadataJson, status, verified_at AS verifiedAt,
      expires_at AS expiresAt, reviewed_by_user_id AS reviewedByUserId,
      reviewed_at AS reviewedAt, version
    FROM channel_provider_verification_evidence WHERE id = ? AND shop_id = ? LIMIT 1
  `).bind(input.evidenceId, input.shopId).first<EvidenceRow>();
  if (result === null) throw new AppError("channel_provider_verification_failed", 500);
  return mapEvidence(result);
}

export async function promoteProviderConnectionFromEvidence(input: {
  connectionId: string;
  env: AppBindings;
  evidenceIds: readonly string[];
  expectedConnectionVersion: number;
  providerCode: string;
  requestId: string;
  reviewerUserId: string;
  shopId: string;
  requiredKinds?: readonly ProviderVerificationKind[];
}): Promise<{ connectionId: string; status: "active"; version: number }> {
  requireIdentifier(input.shopId, "shop_id_invalid");
  requireIdentifier(input.connectionId, "connection_id_invalid");
  requireIdentifier(input.reviewerUserId, "reviewer_id_invalid");
  requireVersion(input.expectedConnectionVersion, "connection_version_invalid");
  const providerCode = requireProviderCode(input.providerCode);
  if (requireChannelExpansion(providerCode).providerExecution === "provider_pending") throw new AppError("channel_provider_pending", 409, [providerCode]);
  const requiredKinds = input.requiredKinds ?? ["webhook", "identity", "capability"];
  const required = new Set(requiredKinds.map(requireKind));
  if (required.size < 2) throw new AppError("validation_failed", 400, ["required_evidence_incomplete"]);
  const ids = [...new Set(input.evidenceIds)];
  if (ids.length < required.size || ids.length > 16 || ids.some((id) => !SAFE_IDENTIFIER.test(id))) {
    throw new AppError("validation_failed", 400, ["evidence_ids_invalid"]);
  }
  const placeholders = ids.map(() => "?").join(",");
  const rows = await input.env.PLATFORM_DB.prepare(`
    SELECT id, shop_id AS shopId, connection_id AS connectionId, provider_code AS providerCode,
      credential_version AS credentialVersion, credential_fingerprint AS credentialFingerprint,
      verification_kind AS verificationKind, evidence_reference AS evidenceReference,
      provider_identity_fingerprint AS providerIdentityFingerprint,
      safe_metadata_json AS safeMetadataJson, status, verified_at AS verifiedAt,
      expires_at AS expiresAt, reviewed_by_user_id AS reviewedByUserId,
      reviewed_at AS reviewedAt, version
    FROM channel_provider_verification_evidence
    WHERE shop_id = ? AND connection_id = ? AND provider_code = ? AND id IN (${placeholders})
  `).bind(input.shopId, input.connectionId, providerCode, ...ids).all<EvidenceRow>();
  if (rows.results.length !== ids.length) throw new AppError("channel_provider_verification_not_found", 404);
  const connection = await input.env.PLATFORM_DB.prepare(`
    SELECT connection.status AS connectionStatus, connection.version AS connectionVersion,
      subscription.state AS subscriptionState,
      subscription.trial_ends_at AS trialEndsAt,
      subscription.grace_ends_at AS graceEndsAt,
      credential.status AS credentialStatus, credential.version AS credentialVersion,
      credential.credential_fingerprint AS credentialFingerprint, channel.status AS channelStatus
    FROM channel_connections AS connection
    INNER JOIN shop_channels AS channel ON channel.shop_id = connection.shop_id AND channel.id = connection.shop_channel_id
    INNER JOIN shops
      ON shops.id = connection.shop_id
      AND shops.status = 'active'
    INNER JOIN shop_subscriptions AS subscription
      ON subscription.shop_id = connection.shop_id
    INNER JOIN plans
      ON plans.id = subscription.plan_id
      AND plans.is_active = 1
    INNER JOIN channel_credentials AS credential ON credential.shop_id = connection.shop_id
      AND credential.connection_id = connection.id AND credential.provider_code = connection.provider_code
      AND credential.status = 'active'
    WHERE connection.shop_id = ? AND connection.id = ? AND connection.provider_code = ? LIMIT 1
  `).bind(input.shopId, input.connectionId, providerCode).first<{
    channelStatus: string; connectionStatus: string; connectionVersion: number; credentialFingerprint: string; credentialStatus: string; credentialVersion: number; graceEndsAt: string | null; subscriptionState: string; trialEndsAt: string | null;
  }>();
  if (connection === null) throw new AppError("channel_connection_not_found", 404);
  if (!subscriptionAllows({ graceEndsAt: connection.graceEndsAt, subscriptionState: connection.subscriptionState, trialEndsAt: connection.trialEndsAt })) {
    throw new AppError("channel_connection_unavailable", 409);
  }
  if (connection.channelStatus !== "enabled" || connection.credentialStatus !== "active" || connection.connectionStatus !== "pending") {
    throw new AppError("channel_connection_unavailable", 409);
  }
  if (connection.connectionVersion !== input.expectedConnectionVersion) throw new AppError("channel_connection_version_conflict", 409);
  const now = new Date();
  const seen = new Set<ProviderVerificationKind>();
  for (const row of rows.results) {
    if (row.status !== "reviewed" || row.credentialVersion !== connection.credentialVersion || row.credentialFingerprint !== connection.credentialFingerprint || Date.parse(row.expiresAt) <= now.getTime()) {
      throw new AppError("channel_provider_verification_incomplete", 409);
    }
    if (row.verificationKind === "identity" && row.providerIdentityFingerprint === null) throw new AppError("channel_provider_verification_incomplete", 409);
    seen.add(row.verificationKind);
  }
  for (const kind of required) if (!seen.has(kind)) throw new AppError("channel_provider_verification_incomplete", 409);
  const nowIso = now.toISOString();
  const updated = await input.env.PLATFORM_DB.prepare(`
    UPDATE channel_connections
    SET status = 'active', connected_at = COALESCE(connected_at, ?), disconnected_at = NULL,
      last_safe_error_code = NULL, last_health_at = ?, updated_at = ?, version = version + 1
    WHERE shop_id = ? AND id = ? AND provider_code = ? AND status = 'pending' AND version = ?
  `).bind(nowIso, nowIso, nowIso, input.shopId, input.connectionId, providerCode, input.expectedConnectionVersion).run();
  if (updated.meta.changes !== 1) throw new AppError("channel_connection_version_conflict", 409);
  const result = await input.env.PLATFORM_DB.prepare(`SELECT version FROM channel_connections WHERE shop_id = ? AND id = ? LIMIT 1`).bind(input.shopId, input.connectionId).first<{ version: number }>();
  if (result === null) throw new AppError("channel_connection_not_found", 404);
  return { connectionId: input.connectionId, status: "active", version: result.version };
}
