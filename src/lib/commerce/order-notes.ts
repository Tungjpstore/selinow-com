import { hmacToken, sha256Json } from "../core/crypto";
import { AppError } from "../core/errors";
import { createId } from "../core/ids";
import type { AppBindings } from "../platform/bindings";
import { getShopForMember } from "../tenants/store";

const IDEMPOTENCY_TTL_MS = 24 * 60 * 60_000;
const NOTE_BODY_MAX = 4_000;

type ExistingIdempotency = { request_hash: string; response_json: string };
type OrderRow = { id: string; orderPublicId: string };
type NoteRow = {
  authorDisplayName: string;
  body: string;
  createdAt: string;
  id: string;
  redactedAt: string | null;
  status: "active" | "redacted";
  updatedAt: string;
  version: number;
};

function requireIdempotencyKey(value: string | null): string {
  if (value === null || !/^[A-Za-z0-9._:-]{8,128}$/u.test(value)) throw new AppError("validation_failed", 400, ["idempotency_key_required"]);
  return value;
}

function mapNote(row: NoteRow): SellerOrderNote {
  return {
    authorDisplayName: row.authorDisplayName,
    body: row.status === "redacted" ? "" : row.body,
    createdAt: row.createdAt,
    notePublicId: row.id,
    redactedAt: row.redactedAt,
    status: row.status,
    updatedAt: row.updatedAt,
    version: row.version,
  };
}

export type SellerOrderNote = {
  authorDisplayName: string;
  body: string;
  createdAt: string;
  notePublicId: string;
  redactedAt: string | null;
  status: "active" | "redacted";
  updatedAt: string;
  version: number;
};

async function resolveOrder(env: AppBindings, shopId: string, orderPublicId: string): Promise<OrderRow> {
  const row = await env.PLATFORM_DB.prepare("SELECT id, public_id AS orderPublicId FROM orders WHERE shop_id = ? AND public_id = ? LIMIT 1").bind(shopId, orderPublicId).first<OrderRow>();
  if (row === null) throw new AppError("order_not_found", 404);
  return row;
}

export async function listOrderNotes(input: {
  env: AppBindings;
  orderPublicId: string;
  shopPublicId: string;
  userId: string;
}): Promise<SellerOrderNote[]> {
  const actor = await getShopForMember({ capability: "fulfillment:manage", env: input.env, shopPublicId: input.shopPublicId, userId: input.userId });
  const order = await resolveOrder(input.env, actor.row.shop_id, input.orderPublicId);
  const rows = await input.env.PLATFORM_DB.prepare(`
    SELECT order_notes.id, order_notes.body, order_notes.status,
      order_notes.redacted_at AS redactedAt, order_notes.created_at AS createdAt,
      order_notes.updated_at AS updatedAt, order_notes.version,
      platform_users.display_name AS authorDisplayName
    FROM order_notes
    INNER JOIN platform_users ON platform_users.id = order_notes.author_user_id
    WHERE order_notes.shop_id = ? AND order_notes.order_id = ?
    ORDER BY order_notes.created_at DESC, order_notes.id DESC
    LIMIT 100
  `).bind(actor.row.shop_id, order.id).all<NoteRow>();
  return rows.results.map(mapNote);
}

export async function appendOrderNote(input: {
  body: string;
  env: AppBindings;
  idempotencyKey: string | null;
  orderPublicId: string;
  requestId: string;
  shopPublicId: string;
  userId: string;
  now?: Date;
}): Promise<SellerOrderNote> {
  const idempotencyKey = requireIdempotencyKey(input.idempotencyKey);
  const body = input.body.trim();
  if (body.length === 0 || body.length > NOTE_BODY_MAX) throw new AppError("validation_failed", 400, ["note_body_invalid"]);
  const actor = await getShopForMember({ capability: "fulfillment:manage", env: input.env, shopPublicId: input.shopPublicId, userId: input.userId });
  const order = await resolveOrder(input.env, actor.row.shop_id, input.orderPublicId);
  const now = input.now ?? new Date();
  const nowIso = now.toISOString();
  const namespace = `order-note.create.v1:${actor.row.shop_id}:${input.orderPublicId}`;
  const keyHash = await hmacToken(input.env.SESSION_SECRET, "order-note-idempotency:v1", idempotencyKey);
  const requestHash = await sha256Json({ body, orderPublicId: input.orderPublicId, shopId: actor.row.shop_id });
  const replay = await input.env.PLATFORM_DB.prepare("SELECT request_hash, response_json FROM idempotency_records WHERE actor_user_id = ? AND namespace = ? AND key_hash = ? AND expires_at > ? LIMIT 1").bind(input.userId, namespace, keyHash, nowIso).first<ExistingIdempotency>();
  if (replay !== null) {
    if (replay.request_hash !== requestHash) throw new AppError("idempotency_conflict", 409);
    const reference = JSON.parse(replay.response_json) as { notePublicId?: string };
    const note = await input.env.PLATFORM_DB.prepare("SELECT order_notes.id, order_notes.body, order_notes.status, order_notes.redacted_at AS redactedAt, order_notes.created_at AS createdAt, order_notes.updated_at AS updatedAt, order_notes.version, platform_users.display_name AS authorDisplayName FROM order_notes INNER JOIN platform_users ON platform_users.id = order_notes.author_user_id WHERE order_notes.shop_id = ? AND order_notes.order_id = ? AND order_notes.id = ? LIMIT 1").bind(actor.row.shop_id, order.id, reference.notePublicId).first<NoteRow>();
    if (note === null) throw new AppError("order_note_replay_invalid", 500);
    return mapNote(note);
  }
  const noteId = createId("ono");
  await input.env.PLATFORM_DB.batch([
    input.env.PLATFORM_DB.prepare("INSERT INTO order_notes (id, public_id, shop_id, order_id, author_user_id, body, status, created_at, updated_at, version) VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?, 1)").bind(noteId, noteId, actor.row.shop_id, order.id, input.userId, body, nowIso, nowIso),
    input.env.PLATFORM_DB.prepare("INSERT INTO audit_logs (id, shop_id, actor_type, actor_id, action, resource_type, resource_id, safe_metadata_json, request_id, source_kind, retention_class, created_at) VALUES (?, ?, 'user', ?, 'order.note_added', 'order_note', ?, ?, ?, 'http', 'security', ?)").bind(createId("aud"), actor.row.shop_id, input.userId, noteId, JSON.stringify({ orderPublicId: input.orderPublicId, length: body.length }), input.requestId, nowIso),
    input.env.PLATFORM_DB.prepare("INSERT INTO idempotency_records (actor_user_id, namespace, key_hash, request_hash, response_json, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)").bind(input.userId, namespace, keyHash, requestHash, JSON.stringify({ notePublicId: noteId }), nowIso, new Date(now.getTime() + IDEMPOTENCY_TTL_MS).toISOString()),
  ]);
  const note = await input.env.PLATFORM_DB.prepare("SELECT order_notes.id, order_notes.body, order_notes.status, order_notes.redacted_at AS redactedAt, order_notes.created_at AS createdAt, order_notes.updated_at AS updatedAt, order_notes.version, platform_users.display_name AS authorDisplayName FROM order_notes INNER JOIN platform_users ON platform_users.id = order_notes.author_user_id WHERE order_notes.shop_id = ? AND order_notes.order_id = ? AND order_notes.id = ? LIMIT 1").bind(actor.row.shop_id, order.id, noteId).first<NoteRow>();
  if (note === null) throw new AppError("order_note_create_failed", 500);
  return mapNote(note);
}

export async function redactOrderNote(input: {
  env: AppBindings;
  expectedVersion: number;
  idempotencyKey: string | null;
  notePublicId: string;
  orderPublicId: string;
  requestId: string;
  shopPublicId: string;
  userId: string;
  now?: Date;
}): Promise<SellerOrderNote> {
  if (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 1) throw new AppError("validation_failed", 400, ["expected_version_invalid"]);
  const idempotencyKey = requireIdempotencyKey(input.idempotencyKey);
  const actor = await getShopForMember({ capability: "fulfillment:manage", env: input.env, shopPublicId: input.shopPublicId, userId: input.userId });
  const order = await resolveOrder(input.env, actor.row.shop_id, input.orderPublicId);
  const now = input.now ?? new Date();
  const nowIso = now.toISOString();
  const namespace = `order-note.redact.v1:${actor.row.shop_id}:${input.orderPublicId}:${input.notePublicId}`;
  const keyHash = await hmacToken(input.env.SESSION_SECRET, "order-note-idempotency:v1", idempotencyKey);
  const requestHash = await sha256Json({ expectedVersion: input.expectedVersion, notePublicId: input.notePublicId, orderPublicId: input.orderPublicId, shopId: actor.row.shop_id });
  const replay = await input.env.PLATFORM_DB.prepare("SELECT request_hash, response_json FROM idempotency_records WHERE actor_user_id = ? AND namespace = ? AND key_hash = ? AND expires_at > ? LIMIT 1").bind(input.userId, namespace, keyHash, nowIso).first<ExistingIdempotency>();
  if (replay !== null) {
    if (replay.request_hash !== requestHash) throw new AppError("idempotency_conflict", 409);
    const note = await input.env.PLATFORM_DB.prepare("SELECT order_notes.id, order_notes.body, order_notes.status, order_notes.redacted_at AS redactedAt, order_notes.created_at AS createdAt, order_notes.updated_at AS updatedAt, order_notes.version, platform_users.display_name AS authorDisplayName FROM order_notes INNER JOIN platform_users ON platform_users.id = order_notes.author_user_id WHERE order_notes.shop_id = ? AND order_notes.order_id = ? AND order_notes.public_id = ? LIMIT 1").bind(actor.row.shop_id, order.id, input.notePublicId).first<NoteRow>();
    if (note === null) throw new AppError("order_note_replay_invalid", 500);
    return mapNote(note);
  }
  const mutation = await input.env.PLATFORM_DB.batch([
    input.env.PLATFORM_DB.prepare("UPDATE order_notes SET status = 'redacted', redacted_at = ?, updated_at = ?, version = version + 1 WHERE shop_id = ? AND order_id = ? AND public_id = ? AND status = 'active' AND version = ?").bind(nowIso, nowIso, actor.row.shop_id, order.id, input.notePublicId, input.expectedVersion),
    input.env.PLATFORM_DB.prepare("INSERT INTO audit_logs (id, shop_id, actor_type, actor_id, action, resource_type, resource_id, safe_metadata_json, request_id, source_kind, retention_class, created_at) SELECT ?, ?, 'user', ?, 'order.note_redacted', 'order_note', ?, '{}', ?, 'http', 'security', ? WHERE EXISTS (SELECT 1 FROM order_notes WHERE shop_id = ? AND order_id = ? AND public_id = ? AND status = 'redacted' AND version = ?)").bind(createId("aud"), actor.row.shop_id, input.userId, input.notePublicId, input.requestId, nowIso, actor.row.shop_id, order.id, input.notePublicId, input.expectedVersion + 1),
    input.env.PLATFORM_DB.prepare("INSERT INTO idempotency_records (actor_user_id, namespace, key_hash, request_hash, response_json, created_at, expires_at) SELECT ?, ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM order_notes WHERE shop_id = ? AND order_id = ? AND public_id = ? AND status = 'redacted' AND version = ?)").bind(input.userId, namespace, keyHash, requestHash, JSON.stringify({ notePublicId: input.notePublicId, orderPublicId: input.orderPublicId, shopId: actor.row.shop_id }), nowIso, new Date(now.getTime() + IDEMPOTENCY_TTL_MS).toISOString(), actor.row.shop_id, order.id, input.notePublicId, input.expectedVersion + 1),
  ]);
  if (mutation[0]?.meta.changes !== 1 || mutation[1]?.meta.changes !== 1 || mutation[2]?.meta.changes !== 1) throw new AppError("version_conflict", 409);
  const note = await input.env.PLATFORM_DB.prepare("SELECT order_notes.id, order_notes.body, order_notes.status, order_notes.redacted_at AS redactedAt, order_notes.created_at AS createdAt, order_notes.updated_at AS updatedAt, order_notes.version, platform_users.display_name AS authorDisplayName FROM order_notes INNER JOIN platform_users ON platform_users.id = order_notes.author_user_id WHERE order_notes.shop_id = ? AND order_notes.order_id = ? AND order_notes.public_id = ? LIMIT 1").bind(actor.row.shop_id, order.id, input.notePublicId).first<NoteRow>();
  if (note === null) throw new AppError("order_note_redact_failed", 500);
  return mapNote(note);
}
