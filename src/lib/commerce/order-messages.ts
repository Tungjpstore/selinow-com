import { hmacToken, sha256Json } from "../core/crypto";
import { AppError } from "../core/errors";
import { createId } from "../core/ids";
import type { AppBindings } from "../platform/bindings";
import { getShopForMember } from "../tenants/store";

const IDEMPOTENCY_TTL_MS = 24 * 60 * 60_000;
const MESSAGE_MAX = 4_000;
const MESSAGE_ID_PATTERN = /^omsg_[A-Za-z0-9_-]{20,128}$/u;

type ExistingIdempotency = { request_hash: string; response_json: string };
type OrderRow = { id: string; publicId: string; sourceChannel: "web" | "telegram"; status: string };
type MessageRow = {
  authorDisplayName: string;
  body: string;
  channelCode: "web" | "telegram";
  createdAt: string;
  failureCode: string | null;
  id: string;
  redactedAt: string | null;
  sentAt: string | null;
  status: "canceled" | "failed" | "provider_pending" | "redacted" | "sent";
  updatedAt: string;
  version: number;
};

export type SellerOrderMessage = {
  authorDisplayName: string;
  body: string;
  channelCode: "web" | "telegram";
  createdAt: string;
  failureCode: string | null;
  messagePublicId: string;
  redactedAt: string | null;
  sentAt: string | null;
  status: MessageRow["status"];
  updatedAt: string;
  version: number;
};

function requireIdempotencyKey(value: string | null): string {
  if (value === null || !/^[A-Za-z0-9._:-]{8,128}$/u.test(value)) {
    throw new AppError("validation_failed", 400, ["idempotency_key_required"]);
  }
  return value;
}

function sanitizeBody(value: string): string {
  let clean = "";
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    if ((codePoint >= 0 && codePoint <= 8) || codePoint === 11 || codePoint === 12 || (codePoint >= 14 && codePoint <= 31) || codePoint === 127) continue;
    clean += character;
  }
  const normalized = clean.replace(/\r\n?/gu, "\n").trim();
  if (normalized.length < 1 || normalized.length > MESSAGE_MAX) {
    throw new AppError("validation_failed", 400, ["message_body_invalid"]);
  }
  if (/\b(?:api[_ -]?key|secret|password|token|credential)\s*[:=]/iu.test(normalized)) {
    throw new AppError("validation_failed", 400, ["message_sensitive_content"]);
  }
  return normalized;
}

function mapMessage(row: MessageRow): SellerOrderMessage {
  return {
    authorDisplayName: row.authorDisplayName,
    body: row.status === "redacted" ? "" : row.body,
    channelCode: row.channelCode,
    createdAt: row.createdAt,
    failureCode: row.failureCode,
    messagePublicId: row.id,
    redactedAt: row.redactedAt,
    sentAt: row.sentAt,
    status: row.status,
    updatedAt: row.updatedAt,
    version: row.version,
  };
}

async function loadOrder(env: AppBindings, shopId: string, orderPublicId: string): Promise<OrderRow> {
  const row = await env.PLATFORM_DB.prepare(`
    SELECT id, public_id AS publicId, source_channel AS sourceChannel, status
    FROM orders
    WHERE shop_id = ? AND public_id = ?
    LIMIT 1
  `).bind(shopId, orderPublicId).first<OrderRow>();
  if (row === null) throw new AppError("order_not_found", 404);
  return row;
}

function assertOrderMessageAvailable(order: OrderRow): void {
  if (order.status === "expired" || order.status === "canceled") throw new AppError("order_message_unavailable", 409);
}

async function loadMessage(env: AppBindings, shopId: string, orderId: string, messagePublicId: string): Promise<MessageRow> {
  if (!MESSAGE_ID_PATTERN.test(messagePublicId)) throw new AppError("message_not_found", 404);
  const row = await env.PLATFORM_DB.prepare(`
    SELECT order_messages.id, order_messages.body,
      order_messages.channel_code AS channelCode,
      order_messages.status, order_messages.failure_code AS failureCode,
      order_messages.redacted_at AS redactedAt, order_messages.sent_at AS sentAt,
      order_messages.created_at AS createdAt, order_messages.updated_at AS updatedAt,
      order_messages.version, platform_users.display_name AS authorDisplayName
    FROM order_messages
    INNER JOIN platform_users ON platform_users.id = order_messages.author_user_id
    WHERE order_messages.shop_id = ? AND order_messages.order_id = ?
      AND order_messages.public_id = ?
    LIMIT 1
  `).bind(shopId, orderId, messagePublicId).first<MessageRow>();
  if (row === null) throw new AppError("message_not_found", 404);
  return row;
}

export async function listOrderMessages(input: {
  env: AppBindings;
  orderPublicId: string;
  shopPublicId: string;
  userId: string;
}): Promise<SellerOrderMessage[]> {
  const actor = await getShopForMember({ capability: "shop:read", env: input.env, shopPublicId: input.shopPublicId, userId: input.userId });
  const order = await loadOrder(input.env, actor.row.shop_id, input.orderPublicId);
  assertOrderMessageAvailable(order);
  const rows = await input.env.PLATFORM_DB.prepare(`
    SELECT order_messages.id, order_messages.body,
      order_messages.channel_code AS channelCode,
      order_messages.status, order_messages.failure_code AS failureCode,
      order_messages.redacted_at AS redactedAt, order_messages.sent_at AS sentAt,
      order_messages.created_at AS createdAt, order_messages.updated_at AS updatedAt,
      order_messages.version, platform_users.display_name AS authorDisplayName
    FROM order_messages
    INNER JOIN platform_users ON platform_users.id = order_messages.author_user_id
    WHERE order_messages.shop_id = ? AND order_messages.order_id = ?
    ORDER BY order_messages.created_at ASC, order_messages.id ASC
    LIMIT 100
  `).bind(actor.row.shop_id, order.id).all<MessageRow>();
  return rows.results.map((row) => mapMessage(row));
}

export async function appendOrderMessage(input: {
  body: string;
  env: AppBindings;
  idempotencyKey: string | null;
  orderPublicId: string;
  requestId: string;
  shopPublicId: string;
  userId: string;
  now?: Date;
}): Promise<SellerOrderMessage> {
  const idempotencyKey = requireIdempotencyKey(input.idempotencyKey);
  const body = sanitizeBody(input.body);
  const actor = await getShopForMember({ capability: "fulfillment:manage", env: input.env, shopPublicId: input.shopPublicId, userId: input.userId });
  const order = await loadOrder(input.env, actor.row.shop_id, input.orderPublicId);
  const now = input.now ?? new Date();
  const nowIso = now.toISOString();
  const namespace = `order-message.create.v1:${actor.row.shop_id}:${order.id}`;
  const keyHash = await hmacToken(input.env.SESSION_SECRET, "order-message-idempotency:v1", idempotencyKey);
  const requestHash = await sha256Json({ body, channelCode: order.sourceChannel, orderId: order.id, shopId: actor.row.shop_id });
  const replay = await input.env.PLATFORM_DB.prepare(`
    SELECT request_hash, response_json
    FROM idempotency_records
    WHERE actor_user_id = ? AND namespace = ? AND key_hash = ? AND expires_at > ?
    LIMIT 1
  `).bind(input.userId, namespace, keyHash, nowIso).first<ExistingIdempotency>();
  if (replay !== null) {
    if (replay.request_hash !== requestHash) throw new AppError("idempotency_conflict", 409);
    const reference = JSON.parse(replay.response_json) as { messagePublicId?: string };
    if (typeof reference.messagePublicId !== "string") throw new AppError("message_replay_invalid", 500);
    return mapMessage(await loadMessage(input.env, actor.row.shop_id, order.id, reference.messagePublicId));
  }
  assertOrderMessageAvailable(order);

  const messageId = createId("omsg");
  await input.env.PLATFORM_DB.batch([
    input.env.PLATFORM_DB.prepare(`
      INSERT INTO order_messages (
        id, public_id, shop_id, order_id, author_user_id, channel_code,
        direction, status, body, idempotency_key_hash, request_hash,
        created_at, updated_at, version
      ) VALUES (?, ?, ?, ?, ?, ?, 'seller_to_buyer', 'provider_pending', ?, ?, ?, ?, ?, 1)
    `).bind(messageId, messageId, actor.row.shop_id, order.id, input.userId, order.sourceChannel, body, keyHash, requestHash, nowIso, nowIso),
    input.env.PLATFORM_DB.prepare(`
      INSERT INTO audit_logs (
        id, shop_id, actor_type, actor_id, action, resource_type, resource_id,
        safe_metadata_json, request_id, source_kind, retention_class, created_at
      ) VALUES (?, ?, 'user', ?, 'order.message_requested', 'order_message', ?, ?, ?, 'http', 'standard', ?)
    `).bind(createId("aud"), actor.row.shop_id, input.userId, messageId, JSON.stringify({ bodyLength: body.length, channelCode: order.sourceChannel, deliveryStatus: "provider_pending" }), input.requestId, nowIso),
    input.env.PLATFORM_DB.prepare(`
      INSERT INTO idempotency_records (
        actor_user_id, namespace, key_hash, request_hash, response_json,
        created_at, expires_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).bind(input.userId, namespace, keyHash, requestHash, JSON.stringify({ messagePublicId: messageId }), nowIso, new Date(now.getTime() + IDEMPOTENCY_TTL_MS).toISOString()),
  ]);
  return mapMessage(await loadMessage(input.env, actor.row.shop_id, order.id, messageId));
}

export async function redactOrderMessage(input: {
  env: AppBindings;
  expectedVersion: number;
  idempotencyKey: string | null;
  messagePublicId: string;
  orderPublicId: string;
  requestId: string;
  shopPublicId: string;
  userId: string;
  now?: Date;
}): Promise<SellerOrderMessage> {
  if (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 1) throw new AppError("validation_failed", 400, ["expected_version_invalid"]);
  const idempotencyKey = requireIdempotencyKey(input.idempotencyKey);
  const actor = await getShopForMember({ capability: "fulfillment:manage", env: input.env, shopPublicId: input.shopPublicId, userId: input.userId });
  const order = await loadOrder(input.env, actor.row.shop_id, input.orderPublicId);
  const existing = await loadMessage(input.env, actor.row.shop_id, order.id, input.messagePublicId);
  const now = input.now ?? new Date();
  const nowIso = now.toISOString();
  const namespace = `order-message.redact.v1:${actor.row.shop_id}:${order.id}:${input.messagePublicId}`;
  const keyHash = await hmacToken(input.env.SESSION_SECRET, "order-message-idempotency:v1", idempotencyKey);
  const requestHash = await sha256Json({ expectedVersion: input.expectedVersion, messagePublicId: input.messagePublicId, orderId: order.id, shopId: actor.row.shop_id });
  const replay = await input.env.PLATFORM_DB.prepare("SELECT request_hash FROM idempotency_records WHERE actor_user_id = ? AND namespace = ? AND key_hash = ? AND expires_at > ? LIMIT 1").bind(input.userId, namespace, keyHash, nowIso).first<{ request_hash: string }>();
  if (replay !== null) {
    if (replay.request_hash !== requestHash) throw new AppError("idempotency_conflict", 409);
    return mapMessage(await loadMessage(input.env, actor.row.shop_id, order.id, input.messagePublicId));
  }
  assertOrderMessageAvailable(order);
  const mutation = await input.env.PLATFORM_DB.batch([
    input.env.PLATFORM_DB.prepare(`
      UPDATE order_messages
      SET body = '', status = 'redacted', redacted_at = ?, updated_at = ?, version = version + 1
      WHERE shop_id = ? AND order_id = ? AND public_id = ?
        AND status IN ('provider_pending', 'failed') AND version = ?
    `).bind(nowIso, nowIso, actor.row.shop_id, order.id, input.messagePublicId, input.expectedVersion),
    input.env.PLATFORM_DB.prepare(`
      INSERT INTO audit_logs (
        id, shop_id, actor_type, actor_id, action, resource_type, resource_id,
        safe_metadata_json, request_id, source_kind, retention_class, created_at
      ) SELECT ?, ?, 'user', ?, 'order.message_redacted', 'order_message', ?, '{}', ?, 'http', 'security', ?
      WHERE EXISTS (
        SELECT 1 FROM order_messages
        WHERE shop_id = ? AND order_id = ? AND public_id = ? AND status = 'redacted' AND version = ?
      )
    `).bind(createId("aud"), actor.row.shop_id, input.userId, input.messagePublicId, input.requestId, nowIso, actor.row.shop_id, order.id, input.messagePublicId, input.expectedVersion + 1),
    input.env.PLATFORM_DB.prepare(`
      INSERT INTO idempotency_records (
        actor_user_id, namespace, key_hash, request_hash, response_json,
        created_at, expires_at
      ) SELECT ?, ?, ?, ?, ?, ?, ?
      WHERE EXISTS (
        SELECT 1 FROM order_messages
        WHERE shop_id = ? AND order_id = ? AND public_id = ? AND status = 'redacted' AND version = ?
      )
    `).bind(input.userId, namespace, keyHash, requestHash, JSON.stringify({ messagePublicId: input.messagePublicId }), nowIso, new Date(now.getTime() + IDEMPOTENCY_TTL_MS).toISOString(), actor.row.shop_id, order.id, input.messagePublicId, input.expectedVersion + 1),
  ]);
  if (mutation[0]?.meta.changes !== 1 || mutation[1]?.meta.changes !== 1 || mutation[2]?.meta.changes !== 1) {
    if (existing.status === "redacted") throw new AppError("version_conflict", 409);
    throw new AppError("version_conflict", 409);
  }
  return mapMessage(await loadMessage(input.env, actor.row.shop_id, order.id, input.messagePublicId));
}

/** Provider workers call this only after verified delivery evidence. */
export async function markOrderMessageDelivered(input: {
  env: AppBindings;
  messageId: string;
  providerReference: string;
  shopId: string;
  now?: Date;
}): Promise<boolean> {
  if (!MESSAGE_ID_PATTERN.test(input.messageId) || input.providerReference.length < 1 || input.providerReference.length > 256) throw new AppError("validation_failed", 400, ["message_delivery_reference_invalid"]);
  const now = input.now ?? new Date();
  const nowIso = now.toISOString();
  const providerReferenceHash = await hmacToken(input.env.IDENTIFIER_HMAC_SECRET, "order-message-provider-reference:v1", input.providerReference);
  const result = await input.env.PLATFORM_DB.prepare(`
    UPDATE order_messages
    SET status = 'sent', provider_reference_hash = ?, sent_at = ?, updated_at = ?, version = version + 1
    WHERE shop_id = ? AND id = ? AND status = 'provider_pending'
  `).bind(providerReferenceHash, nowIso, nowIso, input.shopId, input.messageId).run();
  return result.meta.changes === 1;
}
