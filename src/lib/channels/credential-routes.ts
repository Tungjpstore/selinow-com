import { hmacToken, sha256Json } from "../core/crypto";
import { AppError } from "../core/errors";
import { createId } from "../core/ids";
import type { AppBindings } from "../platform/bindings";
import { getShopForMember } from "../tenants/store";
import { platformChannelRegistry } from "./expansion";
import { D1ChannelConnectionRepository } from "./store";
import type { ChannelCredentialStatus } from "./types";

const IDEMPOTENCY_KEY = /^[A-Za-z0-9._:-]{8,128}$/u;
const CONNECTION_PUBLIC_ID = /^channel_[0-9a-f-]{36}$/u;
const KEY_VERSION = /^v[1-9][0-9]{0,3}$/u;
const IDEMPOTENCY_TTL_MS = 24 * 60 * 60_000;

type ConnectionRow = {
  id: string;
  publicId: string;
  providerCode: string;
  status: "active" | "degraded" | "disconnected" | "pending";
};

type CredentialProjectionRow = {
  connectionPublicId: string;
  createdAt: string;
  credentialId: string;
  keyVersion: string;
  providerCode: string;
  status: ChannelCredentialStatus;
  version: number;
};

type ExistingIdempotency = {
  request_hash: string;
  response_json: string;
};

type ReplayReference = {
  credentialId: string;
  shopId: string;
};

type CredentialIdempotencyState = ReplayReference & {
  state: "completed" | "processing";
};

export type ChannelCredentialEnvelopeInput = {
  ciphertextB64: string;
  connectionPublicId: string;
  fingerprint: string;
  ivB64: string;
  keyVersion: string;
};

export type ChannelCredentialProjection = CredentialProjectionRow;

export type CreateChannelCredentialResult = {
  credential: ChannelCredentialProjection;
  replayed: boolean;
};

function validation(issue: string): AppError {
  return new AppError("validation_failed", 400, [issue]);
}

function requireIdempotencyKey(value: string | null): string {
  if (value === null || !IDEMPOTENCY_KEY.test(value)) throw validation("idempotency_key_invalid");
  return value;
}

function requireString(value: unknown, issue: string): string {
  if (typeof value !== "string" || value.length === 0) throw validation(issue);
  return value;
}

function requireConnectionPublicId(value: unknown): string {
  const candidate = requireString(value, "connection_public_id_required");
  if (!CONNECTION_PUBLIC_ID.test(candidate)) throw validation("connection_public_id_invalid");
  return candidate;
}

function requireKeyVersion(value: unknown): string {
  const candidate = requireString(value, "channel_credential_key_version_required");
  if (!KEY_VERSION.test(candidate)) throw validation("channel_credential_key_version_invalid");
  return candidate;
}

export function parseChannelCredentialEnvelopeInput(
  value: Record<string, unknown>,
): ChannelCredentialEnvelopeInput {
  return {
    ciphertextB64: requireString(value.ciphertextB64, "channel_credential_ciphertext_required"),
    connectionPublicId: requireConnectionPublicId(value.connectionPublicId),
    fingerprint: requireString(value.fingerprint, "channel_credential_fingerprint_required"),
    ivB64: requireString(value.ivB64, "channel_credential_iv_required"),
    keyVersion: requireKeyVersion(value.keyVersion),
  };
}

function mapProjection(row: CredentialProjectionRow): ChannelCredentialProjection {
  return { ...row };
}

async function loadConnection(
  env: AppBindings,
  shopId: string,
  connectionPublicId: string,
): Promise<ConnectionRow> {
  const row = await env.PLATFORM_DB.prepare(`
    SELECT id, public_id AS publicId, provider_code AS providerCode, status
    FROM channel_connections
    WHERE shop_id = ? AND public_id = ?
    LIMIT 1
  `).bind(shopId, connectionPublicId).first<ConnectionRow>();
  if (row === null) throw new AppError("channel_connection_not_found", 404);
  if (row.status === "disconnected") {
    throw new AppError("channel_connection_unavailable", 409);
  }
  platformChannelRegistry.require(row.providerCode);
  return row;
}

async function loadProjection(
  env: AppBindings,
  shopId: string,
  credentialId: string,
): Promise<ChannelCredentialProjection | null> {
  const row = await env.PLATFORM_DB.prepare(`
    SELECT connection.public_id AS connectionPublicId,
      credential.created_at AS createdAt,
      credential.id AS credentialId,
      credential.key_version AS keyVersion,
      credential.provider_code AS providerCode,
      credential.status,
      credential.version
    FROM channel_credentials AS credential
    INNER JOIN channel_connections AS connection
      ON connection.shop_id = credential.shop_id
      AND connection.id = credential.connection_id
      AND connection.provider_code = credential.provider_code
    WHERE credential.shop_id = ? AND credential.id = ?
    LIMIT 1
  `).bind(shopId, credentialId).first<CredentialProjectionRow>();
  return row === null ? null : mapProjection(row);
}

function parseCredentialIdempotencyState(value: string): CredentialIdempotencyState {
  try {
    const parsed = JSON.parse(value) as Partial<ReplayReference>;
    if (typeof parsed.credentialId !== "string" || typeof parsed.shopId !== "string") {
      throw new Error("channel_credential_replay_invalid");
    }
    if (!/^ccred_[0-9a-f-]{36}$/u.test(parsed.credentialId)) throw new Error("channel_credential_replay_invalid");
    const state = (parsed as { state?: unknown }).state;
    if (state !== undefined && state !== "completed" && state !== "processing") {
      throw new Error("channel_credential_replay_invalid");
    }
    return { credentialId: parsed.credentialId, shopId: parsed.shopId, state: state === "processing" ? "processing" : "completed" };
  } catch {
    throw new AppError("channel_credential_replay_invalid", 500);
  }
}

export async function listChannelCredentialProjections(input: {
  env: AppBindings;
  shopPublicId: string;
  userId: string;
}): Promise<readonly ChannelCredentialProjection[]> {
  const actor = await getShopForMember({
    capability: "integrations:credentials",
    env: input.env,
    shopPublicId: input.shopPublicId,
    userId: input.userId,
  });
  const rows = await input.env.PLATFORM_DB.prepare(`
    SELECT connection.public_id AS connectionPublicId,
      credential.created_at AS createdAt,
      credential.id AS credentialId,
      credential.key_version AS keyVersion,
      credential.provider_code AS providerCode,
      credential.status,
      credential.version
    FROM channel_credentials AS credential
    INNER JOIN channel_connections AS connection
      ON connection.shop_id = credential.shop_id
      AND connection.id = credential.connection_id
      AND connection.provider_code = credential.provider_code
    WHERE credential.shop_id = ?
    ORDER BY credential.created_at DESC, credential.id DESC
    LIMIT 100
  `).bind(actor.row.shop_id).all<CredentialProjectionRow>();
  return rows.results.map(mapProjection);
}

export async function createChannelCredentialEnvelope(input: {
  env: AppBindings;
  envelope: ChannelCredentialEnvelopeInput;
  idempotencyKey: string | null;
  shopPublicId: string;
  userId: string;
}): Promise<CreateChannelCredentialResult> {
  const idempotencyKey = requireIdempotencyKey(input.idempotencyKey);
  const actor = await getShopForMember({
    capability: "integrations:credentials",
    env: input.env,
    shopPublicId: input.shopPublicId,
    userId: input.userId,
  });
  if (actor.row.shop_status === "suspended" || actor.row.shop_status === "archived") {
    throw new AppError("tenant_suspended", 403);
  }
  const connection = await loadConnection(input.env, actor.row.shop_id, input.envelope.connectionPublicId);
  const namespace = `channel-credential.create.v1:${actor.row.shop_id}`;
  const keyHash = await hmacToken(input.env.SESSION_SECRET, "channel-credential-idempotency:v1", idempotencyKey);
  const requestHash = await sha256Json({
    ciphertextB64: input.envelope.ciphertextB64,
    connectionPublicId: input.envelope.connectionPublicId,
    fingerprint: input.envelope.fingerprint,
    ivB64: input.envelope.ivB64,
    keyVersion: input.envelope.keyVersion,
    shopId: actor.row.shop_id,
  });
  const now = new Date();
  const existing = await input.env.PLATFORM_DB.prepare(`
    SELECT request_hash, response_json
    FROM idempotency_records
    WHERE actor_user_id = ? AND namespace = ? AND key_hash = ? AND expires_at > ?
    LIMIT 1
  `).bind(input.userId, namespace, keyHash, now.toISOString()).first<ExistingIdempotency>();
  if (existing !== null) {
    if (existing.request_hash !== requestHash) throw new AppError("idempotency_conflict", 409);
    const replay = parseCredentialIdempotencyState(existing.response_json);
    if (replay.shopId !== actor.row.shop_id) throw new AppError("idempotency_conflict", 409);
    const credential = await loadProjection(input.env, actor.row.shop_id, replay.credentialId);
    // A processing reservation is recoverable: a retried request reuses the
    // reserved credential ID instead of creating a second pending envelope.
    if (replay.state === "completed") {
      if (credential === null) throw new AppError("channel_credential_replay_invalid", 500);
      return { credential, replayed: true };
    }
    if (credential !== null) return { credential, replayed: true };
  }

  const nowIso = now.toISOString();
  const credentialId = existing === null
    ? createId("ccred")
    : parseCredentialIdempotencyState(existing.response_json).credentialId;
  await input.env.PLATFORM_DB.prepare(`
    DELETE FROM idempotency_records
    WHERE actor_user_id = ? AND namespace = ? AND key_hash = ? AND expires_at <= ?
  `).bind(input.userId, namespace, keyHash, nowIso).run();
  try {
    await input.env.PLATFORM_DB.prepare(`
      INSERT INTO idempotency_records (
        actor_user_id, namespace, key_hash, request_hash, response_json,
        created_at, expires_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(actor_user_id, namespace, key_hash) DO NOTHING
    `).bind(
      input.userId,
      namespace,
      keyHash,
      requestHash,
      JSON.stringify({ credentialId, shopId: actor.row.shop_id, state: "processing" }),
      nowIso,
      new Date(now.getTime() + IDEMPOTENCY_TTL_MS).toISOString(),
    ).run();
  } catch {
    throw new AppError("channel_credential_idempotency_failed", 500);
  }
  const reservation = await input.env.PLATFORM_DB.prepare(`
    SELECT request_hash, response_json
    FROM idempotency_records
    WHERE actor_user_id = ? AND namespace = ? AND key_hash = ? AND expires_at > ?
    LIMIT 1
  `).bind(input.userId, namespace, keyHash, nowIso).first<ExistingIdempotency>();
  if (reservation === null || reservation.request_hash !== requestHash) {
    throw new AppError("idempotency_conflict", 409);
  }
  const reserved = parseCredentialIdempotencyState(reservation.response_json);
  if (reserved.shopId !== actor.row.shop_id) throw new AppError("idempotency_conflict", 409);
  const reservedCredential = await loadProjection(input.env, actor.row.shop_id, reserved.credentialId);
  if (reserved.state === "completed" || reservedCredential !== null) {
    if (reservedCredential === null) throw new AppError("channel_credential_replay_invalid", 500);
    return { credential: reservedCredential, replayed: true };
  }

  const repository = new D1ChannelConnectionRepository(input.env.PLATFORM_DB, platformChannelRegistry);
  let created: { id: string };
  try {
    created = await repository.createCredentialEnvelope({
      ciphertextB64: input.envelope.ciphertextB64,
      createdByUserId: input.userId,
      fingerprint: input.envelope.fingerprint,
      ivB64: input.envelope.ivB64,
      keyVersion: input.envelope.keyVersion,
      connectionId: connection.id,
      credentialId: reserved.credentialId,
      shopId: actor.row.shop_id,
    });
  } catch (error) {
    const raced = await loadProjection(input.env, actor.row.shop_id, reserved.credentialId);
    if (raced !== null) return { credential: raced, replayed: true };
    throw error;
  }
  const credential = await loadProjection(input.env, actor.row.shop_id, created.id);
  if (credential === null) throw new AppError("channel_credential_conflict", 409);
  const finalized = await input.env.PLATFORM_DB.prepare(`
    UPDATE idempotency_records
    SET response_json = ?
    WHERE actor_user_id = ? AND namespace = ? AND key_hash = ?
      AND request_hash = ? AND response_json = ?
  `).bind(
    JSON.stringify({ credentialId: created.id, shopId: actor.row.shop_id }),
    input.userId,
    namespace,
    keyHash,
    requestHash,
    reservation.response_json,
  ).run();
  if (finalized.meta.changes !== 1) {
    const raced = await input.env.PLATFORM_DB.prepare(`
      SELECT request_hash, response_json
      FROM idempotency_records
      WHERE actor_user_id = ? AND namespace = ? AND key_hash = ? AND expires_at > ?
      LIMIT 1
    `).bind(input.userId, namespace, keyHash, nowIso).first<ExistingIdempotency>();
    if (raced === null || raced.request_hash !== requestHash) throw new AppError("idempotency_conflict", 409);
    const replay = parseCredentialIdempotencyState(raced.response_json);
    const replayCredential = await loadProjection(input.env, actor.row.shop_id, replay.credentialId);
    if (replay.shopId !== actor.row.shop_id || replayCredential === null) {
      throw new AppError("channel_credential_replay_invalid", 500);
    }
    return { credential: replayCredential, replayed: true };
  }
  return { credential, replayed: false };
}
