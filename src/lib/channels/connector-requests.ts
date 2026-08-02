import { hmacToken, sha256Json } from "../core/crypto";
import { AppError } from "../core/errors";
import { createId } from "../core/ids";
import type { AppBindings } from "../platform/bindings";
import { getShopForMember } from "../tenants/store";
import { listChannelExpansionCatalog, requireChannelExpansion, type ChannelExpansionStage } from "./expansion";

const IDEMPOTENCY_TTL_MS = 24 * 60 * 60_000;
const IDEMPOTENCY_KEY = /^[A-Za-z0-9._:-]{8,128}$/u;
const REQUEST_ID = /^[A-Za-z0-9._:-]{8,128}$/u;
const PUBLIC_ID = /^creq_[0-9a-f-]{36}$/u;

type ExistingIdempotency = { request_hash: string; response_json: string };
type ConnectorRequestRow = {
  channelCode: string;
  createdAt: string;
  failureCode: string | null;
  id: string;
  providerCode: string;
  requestPublicId: string;
  requestedAt: string;
  status: "active" | "canceled" | "provider_pending" | "rejected" | "requested";
  updatedAt: string;
  version: number;
};

export type ChannelConnectorRequest = ConnectorRequestRow & {
  providerExecution: ChannelExpansionStage;
  requestPublicId: string;
};

function requireIdempotencyKey(value: string | null): string {
  if (value === null || !IDEMPOTENCY_KEY.test(value)) throw new AppError("validation_failed", 400, ["idempotency_key_required"]);
  return value;
}

function mapRequest(row: ConnectorRequestRow): ChannelConnectorRequest {
  return {
    ...row,
    providerExecution: requireChannelExpansion(row.channelCode).providerExecution,
    requestPublicId: row.requestPublicId,
  };
}

async function loadRequest(env: AppBindings, shopId: string, requestPublicId: string): Promise<ConnectorRequestRow> {
  if (!PUBLIC_ID.test(requestPublicId)) throw new AppError("channel_connector_request_not_found", 404);
  const row = await env.PLATFORM_DB.prepare(`
    SELECT id, public_id AS requestPublicId, channel_code AS channelCode, provider_code AS providerCode,
      status, failure_code AS failureCode, created_at AS createdAt,
      created_at AS requestedAt, updated_at AS updatedAt, version
    FROM channel_connector_requests
    WHERE shop_id = ? AND public_id = ?
    LIMIT 1
  `).bind(shopId, requestPublicId).first<ConnectorRequestRow>();
  if (row === null) throw new AppError("channel_connector_request_not_found", 404);
  return row;
}

export function listAvailableChannelExpansions() {
  return listChannelExpansionCatalog().map((entry) => ({ ...entry, capabilities: [...entry.capabilities] }));
}

export async function listChannelConnectorRequests(input: {
  env: AppBindings;
  shopPublicId: string;
  userId: string;
}): Promise<ChannelConnectorRequest[]> {
  const actor = await getShopForMember({ capability: "shop:read", env: input.env, shopPublicId: input.shopPublicId, userId: input.userId });
  const rows = await input.env.PLATFORM_DB.prepare(`
    SELECT id, public_id AS requestPublicId, channel_code AS channelCode, provider_code AS providerCode,
      status, failure_code AS failureCode, created_at AS createdAt,
      created_at AS requestedAt, updated_at AS updatedAt, version
    FROM channel_connector_requests
    WHERE shop_id = ?
    ORDER BY created_at DESC, id DESC
    LIMIT 100
  `).bind(actor.row.shop_id).all<ConnectorRequestRow>();
  return rows.results.map(mapRequest);
}

export async function createChannelConnectorRequest(input: {
  channelCode: string;
  env: AppBindings;
  idempotencyKey: string | null;
  providerCode: string;
  requestId: string;
  shopPublicId: string;
  userId: string;
  now?: Date;
}): Promise<ChannelConnectorRequest> {
  const idempotencyKey = requireIdempotencyKey(input.idempotencyKey);
  if (!REQUEST_ID.test(input.requestId)) throw new AppError("validation_failed", 400, ["request_id_invalid"]);
  const expansion = requireChannelExpansion(input.channelCode);
  if (input.providerCode !== expansion.providerCode) throw new AppError("validation_failed", 400, ["channel_provider_mismatch"]);
  const actor = await getShopForMember({ capability: "integrations:manage", env: input.env, shopPublicId: input.shopPublicId, userId: input.userId });
  const now = input.now ?? new Date();
  if (!Number.isFinite(now.getTime())) throw new AppError("validation_failed", 400, ["request_time_invalid"]);
  const nowIso = now.toISOString();
  const namespace = `channel-connector.create.v1:${actor.row.shop_id}`;
  const keyHash = await hmacToken(input.env.SESSION_SECRET, "channel-connector-idempotency:v1", idempotencyKey);
  const requestHash = await sha256Json({ channelCode: expansion.code, providerCode: expansion.providerCode, shopId: actor.row.shop_id });
  const replay = await input.env.PLATFORM_DB.prepare(`
    SELECT request_hash, response_json
    FROM idempotency_records
    WHERE actor_user_id = ? AND namespace = ? AND key_hash = ? AND expires_at > ?
    LIMIT 1
  `).bind(input.userId, namespace, keyHash, nowIso).first<ExistingIdempotency>();
  if (replay !== null) {
    if (replay.request_hash !== requestHash) throw new AppError("idempotency_conflict", 409);
    const reference = JSON.parse(replay.response_json) as { requestPublicId?: string };
    if (typeof reference.requestPublicId !== "string") throw new AppError("channel_connector_replay_invalid", 500);
    return mapRequest(await loadRequest(input.env, actor.row.shop_id, reference.requestPublicId));
  }
  const active = await input.env.PLATFORM_DB.prepare(`
    SELECT id FROM channel_connector_requests
    WHERE shop_id = ? AND provider_code = ?
      AND status IN ('requested', 'provider_pending', 'active')
    LIMIT 1
  `).bind(actor.row.shop_id, expansion.providerCode).first<{ id: string }>();
  if (active !== null) throw new AppError("channel_connector_pending", 409);
  const requestId = createId("creq");
  await input.env.PLATFORM_DB.batch([
    input.env.PLATFORM_DB.prepare(`
      INSERT INTO channel_connector_requests (
        id, public_id, shop_id, channel_code, provider_code,
        requested_by_user_id, status, idempotency_key_hash, request_hash,
        created_at, updated_at, version
      ) VALUES (?, ?, ?, ?, ?, ?, 'requested', ?, ?, ?, ?, 1)
    `).bind(requestId, requestId, actor.row.shop_id, expansion.code, expansion.providerCode, input.userId, keyHash, requestHash, nowIso, nowIso),
    input.env.PLATFORM_DB.prepare(`
      INSERT INTO audit_logs (
        id, shop_id, actor_type, actor_id, action, resource_type, resource_id,
        safe_metadata_json, request_id, source_kind, retention_class, created_at
      ) VALUES (?, ?, 'user', ?, 'channel.connector_requested', 'channel_connector_request', ?, ?, ?, 'http', 'standard', ?)
    `).bind(createId("aud"), actor.row.shop_id, input.userId, requestId, JSON.stringify({ channelCode: expansion.code, providerCode: expansion.providerCode, providerExecution: expansion.providerExecution }), input.requestId, nowIso),
    input.env.PLATFORM_DB.prepare(`
      INSERT INTO idempotency_records (
        actor_user_id, namespace, key_hash, request_hash, response_json,
        created_at, expires_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).bind(input.userId, namespace, keyHash, requestHash, JSON.stringify({ requestPublicId: requestId }), nowIso, new Date(now.getTime() + IDEMPOTENCY_TTL_MS).toISOString()),
  ]);
  return mapRequest(await loadRequest(input.env, actor.row.shop_id, requestId));
}

export async function cancelChannelConnectorRequest(input: {
  env: AppBindings;
  expectedVersion: number;
  idempotencyKey: string | null;
  requestId: string;
  requestPublicId: string;
  shopPublicId: string;
  userId: string;
  now?: Date;
}): Promise<ChannelConnectorRequest> {
  if (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 1) throw new AppError("validation_failed", 400, ["expected_version_invalid"]);
  const idempotencyKey = requireIdempotencyKey(input.idempotencyKey);
  if (!REQUEST_ID.test(input.requestId)) throw new AppError("validation_failed", 400, ["request_id_invalid"]);
  const actor = await getShopForMember({ capability: "integrations:manage", env: input.env, shopPublicId: input.shopPublicId, userId: input.userId });
  const current = await loadRequest(input.env, actor.row.shop_id, input.requestPublicId);
  const now = input.now ?? new Date();
  if (!Number.isFinite(now.getTime())) throw new AppError("validation_failed", 400, ["request_time_invalid"]);
  const nowIso = now.toISOString();
  const namespace = `channel-connector.cancel.v1:${actor.row.shop_id}:${input.requestPublicId}`;
  const keyHash = await hmacToken(input.env.SESSION_SECRET, "channel-connector-idempotency:v1", idempotencyKey);
  const requestHash = await sha256Json({ expectedVersion: input.expectedVersion, requestPublicId: input.requestPublicId, shopId: actor.row.shop_id });
  const replay = await input.env.PLATFORM_DB.prepare(`
    SELECT request_hash FROM idempotency_records
    WHERE actor_user_id = ? AND namespace = ? AND key_hash = ? AND expires_at > ?
    LIMIT 1
  `).bind(input.userId, namespace, keyHash, nowIso).first<{ request_hash: string }>();
  if (replay !== null) {
    if (replay.request_hash !== requestHash) throw new AppError("idempotency_conflict", 409);
    return mapRequest(await loadRequest(input.env, actor.row.shop_id, input.requestPublicId));
  }
  if (current.status !== "requested" && current.status !== "provider_pending") throw new AppError("channel_connector_state_conflict", 409);
  const mutation = await input.env.PLATFORM_DB.batch([
    input.env.PLATFORM_DB.prepare(`
      UPDATE channel_connector_requests
      SET status = 'canceled', updated_at = ?, version = version + 1
      WHERE shop_id = ? AND public_id = ?
        AND status IN ('requested', 'provider_pending') AND version = ?
    `).bind(nowIso, actor.row.shop_id, input.requestPublicId, input.expectedVersion),
    input.env.PLATFORM_DB.prepare(`
      INSERT INTO audit_logs (
        id, shop_id, actor_type, actor_id, action, resource_type, resource_id,
        safe_metadata_json, request_id, source_kind, retention_class, created_at
      ) SELECT ?, shop_id, 'user', ?, 'channel.connector_canceled', 'channel_connector_request', ?, '{}', ?, 'http', 'standard', ?
      FROM channel_connector_requests
      WHERE shop_id = ? AND public_id = ? AND status = 'canceled' AND version = ?
    `).bind(createId("aud"), input.userId, input.requestPublicId, input.requestId, nowIso, actor.row.shop_id, input.requestPublicId, input.expectedVersion + 1),
    input.env.PLATFORM_DB.prepare(`
      INSERT INTO idempotency_records (
        actor_user_id, namespace, key_hash, request_hash, response_json,
        created_at, expires_at
      ) SELECT ?, ?, ?, ?, ?, ?, ?
      WHERE EXISTS (
        SELECT 1 FROM channel_connector_requests
        WHERE shop_id = ? AND public_id = ? AND status = 'canceled' AND version = ?
      )
    `).bind(input.userId, namespace, keyHash, requestHash, JSON.stringify({ requestPublicId: input.requestPublicId }), nowIso, new Date(now.getTime() + IDEMPOTENCY_TTL_MS).toISOString(), actor.row.shop_id, input.requestPublicId, input.expectedVersion + 1),
  ]);
  if (mutation[0]?.meta.changes !== 1 || mutation[1]?.meta.changes !== 1 || mutation[2]?.meta.changes !== 1) throw new AppError("version_conflict", 409);
  return mapRequest(await loadRequest(input.env, actor.row.shop_id, input.requestPublicId));
}
