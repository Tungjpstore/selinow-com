import { hmacToken, sha256Json } from "../core/crypto";
import { AppError } from "../core/errors";
import { createId } from "../core/ids";
import { matchSupportedLocale } from "../i18n/locale";
import type { AppBindings } from "../platform/bindings";
import { getShopForMember } from "./store";
import { normalizeShopName } from "./policy";

const IDEMPOTENCY_TTL_MS = 24 * 60 * 60_000;
const NOTE_BODY_MAX = 4_000;

type ExistingIdempotency = { request_hash: string; response_json: string };
type CustomerRow = {
  createdAt: string;
  displayName: string | null;
  email: string | null;
  id: string;
  locale: string;
  status: "active" | "blocked";
  updatedAt: string;
  version: number;
};
type NoteRow = {
  authorDisplayName: string;
  authorUserId: string;
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

function maskEmail(value: string | null): string | null {
  if (value === null || value.length === 0) return null;
  const [local, domain] = value.split("@", 2);
  if (local === undefined || domain === undefined || local.length === 0) return "***";
  const visible = local.slice(0, Math.min(2, local.length));
  return `${visible}${"*".repeat(Math.max(1, local.length - visible.length))}@${domain}`;
}

function normalizeCustomerName(value: unknown): string | null {
  if (value === null || value === "") return null;
  return normalizeShopName(value);
}

function normalizeCustomerLocale(value: unknown, fallback: string): string {
  if (value === undefined) return fallback;
  if (typeof value !== "string") throw new AppError("validation_failed", 400, ["locale_invalid"]);
  const locale = matchSupportedLocale(value);
  if (locale === null) throw new AppError("validation_failed", 400, ["locale_invalid"]);
  return locale;
}

function mapNote(row: NoteRow): SellerCustomerNote {
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

export type SellerCustomerNote = {
  authorDisplayName: string;
  body: string;
  createdAt: string;
  notePublicId: string;
  redactedAt: string | null;
  status: "active" | "redacted";
  updatedAt: string;
  version: number;
};

export type SellerCustomerOrder = {
  createdAt: string;
  orderNumber: string;
  orderPublicId: string;
  paymentStatus: string;
  status: string;
  totalMinor: number;
  currency: string;
};

export type SellerCustomerDetail = {
  createdAt: string;
  displayName: string | null;
  emailMasked: string | null;
  lastOrderAt: string | null;
  locale: string;
  notes: SellerCustomerNote[];
  orderCount: number;
  orders: SellerCustomerOrder[];
  publicId: string;
  status: "active" | "blocked";
  updatedAt: string;
  version: number;
};

async function loadCustomer(env: AppBindings, shopId: string, customerPublicId: string): Promise<CustomerRow> {
  const row = await env.PLATFORM_DB.prepare(`
    SELECT id, display_name AS displayName, email_normalized AS email, locale, status,
      created_at AS createdAt, updated_at AS updatedAt, version
    FROM shop_customers
    WHERE shop_id = ? AND id = ?
    LIMIT 1
  `).bind(shopId, customerPublicId).first<CustomerRow>();
  if (row === null) throw new AppError("customer_not_found", 404);
  return row;
}

export async function getSellerCustomer(input: {
  env: AppBindings;
  customerPublicId: string;
  shopPublicId: string;
  userId: string;
}): Promise<SellerCustomerDetail> {
  const actor = await getShopForMember({ capability: "shop:read", env: input.env, shopPublicId: input.shopPublicId, userId: input.userId });
  const customer = await loadCustomer(input.env, actor.row.shop_id, input.customerPublicId);
  const canReadNotes = actor.row.role === "owner" || actor.row.role === "manager";
  const [orders, notes, count] = await Promise.all([
    input.env.PLATFORM_DB.prepare(`
      SELECT public_id AS orderPublicId, order_number AS orderNumber, status,
        payment_status AS paymentStatus, total_minor AS totalMinor, currency, created_at AS createdAt
      FROM orders
      WHERE shop_id = ? AND customer_id = ?
      ORDER BY created_at DESC, id DESC
      LIMIT 100
    `).bind(actor.row.shop_id, customer.id).all<SellerCustomerOrder>(),
    canReadNotes ? input.env.PLATFORM_DB.prepare(`
      SELECT customer_notes.id, customer_notes.body, customer_notes.status,
        customer_notes.redacted_at AS redactedAt, customer_notes.created_at AS createdAt,
        customer_notes.updated_at AS updatedAt, customer_notes.version,
        platform_users.display_name AS authorDisplayName, customer_notes.author_user_id AS authorUserId
      FROM customer_notes
      INNER JOIN platform_users ON platform_users.id = customer_notes.author_user_id
      WHERE customer_notes.shop_id = ? AND customer_notes.customer_id = ?
      ORDER BY customer_notes.created_at DESC, customer_notes.id DESC
      LIMIT 100
    `).bind(actor.row.shop_id, customer.id).all<NoteRow>() : Promise.resolve({ results: [] as NoteRow[] }),
    input.env.PLATFORM_DB.prepare("SELECT COUNT(*) AS orderCount FROM orders WHERE shop_id = ? AND customer_id = ?").bind(actor.row.shop_id, customer.id).first<{ orderCount: number }>(),
  ]);
  return {
    createdAt: customer.createdAt,
    displayName: customer.displayName,
    emailMasked: maskEmail(customer.email),
    lastOrderAt: orders.results[0]?.createdAt ?? null,
    locale: customer.locale,
    notes: notes.results.map(mapNote),
    orderCount: count?.orderCount ?? orders.results.length,
    orders: orders.results,
    publicId: customer.id,
    status: customer.status,
    updatedAt: customer.updatedAt,
    version: customer.version,
  };
}

export async function updateSellerCustomer(input: {
  customerPublicId: string;
  displayName?: unknown;
  env: AppBindings;
  expectedVersion: number;
  idempotencyKey: string | null;
  locale?: unknown;
  requestId: string;
  shopPublicId: string;
  status?: unknown;
  userId: string;
  now?: Date;
}): Promise<SellerCustomerDetail> {
  if (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 1) throw new AppError("validation_failed", 400, ["expected_version_invalid"]);
  const idempotencyKey = requireIdempotencyKey(input.idempotencyKey);
  const actor = await getShopForMember({ capability: "customers:manage", env: input.env, shopPublicId: input.shopPublicId, userId: input.userId });
  const existing = await loadCustomer(input.env, actor.row.shop_id, input.customerPublicId);
  const displayName = input.displayName === undefined ? existing.displayName : normalizeCustomerName(input.displayName);
  const locale = normalizeCustomerLocale(input.locale, existing.locale);
  const status = input.status === undefined ? existing.status : input.status;
  if (status !== "active" && status !== "blocked") throw new AppError("validation_failed", 400, ["customer_status_invalid"]);
  const now = input.now ?? new Date();
  const nowIso = now.toISOString();
  const namespace = `customer.update.v1:${actor.row.shop_id}:${input.customerPublicId}`;
  const keyHash = await hmacToken(input.env.SESSION_SECRET, "customer-idempotency:v1", idempotencyKey);
  const requestHash = await sha256Json({ customerPublicId: input.customerPublicId, displayName, locale, status, shopId: actor.row.shop_id });
  const replay = await input.env.PLATFORM_DB.prepare("SELECT request_hash, response_json FROM idempotency_records WHERE actor_user_id = ? AND namespace = ? AND key_hash = ? AND expires_at > ? LIMIT 1").bind(input.userId, namespace, keyHash, nowIso).first<ExistingIdempotency>();
  if (replay !== null) {
    if (replay.request_hash !== requestHash) throw new AppError("idempotency_conflict", 409);
    return getSellerCustomer({ env: input.env, customerPublicId: input.customerPublicId, shopPublicId: input.shopPublicId, userId: input.userId });
  }
  const mutation = await input.env.PLATFORM_DB.batch([
    input.env.PLATFORM_DB.prepare("UPDATE shop_customers SET display_name = ?, locale = ?, status = ?, version = version + 1, updated_at = ? WHERE shop_id = ? AND id = ? AND version = ?").bind(displayName, locale, status, nowIso, actor.row.shop_id, input.customerPublicId, input.expectedVersion),
    input.env.PLATFORM_DB.prepare("INSERT INTO audit_logs (id, shop_id, actor_type, actor_id, action, resource_type, resource_id, safe_metadata_json, request_id, source_kind, retention_class, created_at) SELECT ?, ?, 'user', ?, 'customer.updated', 'customer', ?, ?, ?, 'http', 'security', ? WHERE EXISTS (SELECT 1 FROM shop_customers WHERE shop_id = ? AND id = ? AND version = ?)").bind(createId("aud"), actor.row.shop_id, input.userId, input.customerPublicId, JSON.stringify({ locale, status, displayNameChanged: displayName !== existing.displayName }), input.requestId, nowIso, actor.row.shop_id, input.customerPublicId, input.expectedVersion + 1),
    input.env.PLATFORM_DB.prepare("INSERT INTO idempotency_records (actor_user_id, namespace, key_hash, request_hash, response_json, created_at, expires_at) SELECT ?, ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM shop_customers WHERE shop_id = ? AND id = ? AND version = ?)").bind(input.userId, namespace, keyHash, requestHash, JSON.stringify({ customerPublicId: input.customerPublicId, shopId: actor.row.shop_id }), nowIso, new Date(now.getTime() + IDEMPOTENCY_TTL_MS).toISOString(), actor.row.shop_id, input.customerPublicId, input.expectedVersion + 1),
  ]);
  if (mutation[0]?.meta.changes !== 1 || mutation[1]?.meta.changes !== 1 || mutation[2]?.meta.changes !== 1) throw new AppError("version_conflict", 409);
  return getSellerCustomer({ env: input.env, customerPublicId: input.customerPublicId, shopPublicId: input.shopPublicId, userId: input.userId });
}

export async function appendCustomerNote(input: {
  body: string;
  customerPublicId: string;
  env: AppBindings;
  idempotencyKey: string | null;
  requestId: string;
  shopPublicId: string;
  userId: string;
  now?: Date;
}): Promise<SellerCustomerNote> {
  const idempotencyKey = requireIdempotencyKey(input.idempotencyKey);
  if (input.body.trim().length === 0 || input.body.length > NOTE_BODY_MAX) throw new AppError("validation_failed", 400, ["note_body_invalid"]);
  const actor = await getShopForMember({ capability: "customers:manage", env: input.env, shopPublicId: input.shopPublicId, userId: input.userId });
  await loadCustomer(input.env, actor.row.shop_id, input.customerPublicId);
  const now = input.now ?? new Date();
  const nowIso = now.toISOString();
  const namespace = `customer-note.create.v1:${actor.row.shop_id}:${input.customerPublicId}`;
  const keyHash = await hmacToken(input.env.SESSION_SECRET, "customer-note-idempotency:v1", idempotencyKey);
  const requestHash = await sha256Json({ body: input.body, customerPublicId: input.customerPublicId, shopId: actor.row.shop_id });
  const replay = await input.env.PLATFORM_DB.prepare("SELECT request_hash, response_json FROM idempotency_records WHERE actor_user_id = ? AND namespace = ? AND key_hash = ? AND expires_at > ? LIMIT 1").bind(input.userId, namespace, keyHash, nowIso).first<ExistingIdempotency>();
  if (replay !== null) {
    if (replay.request_hash !== requestHash) throw new AppError("idempotency_conflict", 409);
    const reference = JSON.parse(replay.response_json) as { notePublicId?: string };
    const note = await input.env.PLATFORM_DB.prepare("SELECT customer_notes.id, customer_notes.body, customer_notes.status, customer_notes.redacted_at AS redactedAt, customer_notes.created_at AS createdAt, customer_notes.updated_at AS updatedAt, customer_notes.version, platform_users.display_name AS authorDisplayName, customer_notes.author_user_id AS authorUserId FROM customer_notes INNER JOIN platform_users ON platform_users.id = customer_notes.author_user_id WHERE customer_notes.shop_id = ? AND customer_notes.customer_id = ? AND customer_notes.id = ? LIMIT 1").bind(actor.row.shop_id, input.customerPublicId, reference.notePublicId).first<NoteRow>();
    if (note === null) throw new AppError("customer_note_replay_invalid", 500);
    return mapNote(note);
  }
  const noteId = createId("cno");
  await input.env.PLATFORM_DB.batch([
    input.env.PLATFORM_DB.prepare("INSERT INTO customer_notes (id, public_id, shop_id, customer_id, author_user_id, body, status, created_at, updated_at, version) VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?, 1)").bind(noteId, noteId, actor.row.shop_id, input.customerPublicId, input.userId, input.body.trim(), nowIso, nowIso),
    input.env.PLATFORM_DB.prepare("INSERT INTO audit_logs (id, shop_id, actor_type, actor_id, action, resource_type, resource_id, safe_metadata_json, request_id, source_kind, retention_class, created_at) VALUES (?, ?, 'user', ?, 'customer.note_added', 'customer_note', ?, ?, ?, 'http', 'security', ?)").bind(createId("aud"), actor.row.shop_id, input.userId, noteId, JSON.stringify({ length: input.body.trim().length }), input.requestId, nowIso),
    input.env.PLATFORM_DB.prepare("INSERT INTO idempotency_records (actor_user_id, namespace, key_hash, request_hash, response_json, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)").bind(input.userId, namespace, keyHash, requestHash, JSON.stringify({ notePublicId: noteId }), nowIso, new Date(now.getTime() + IDEMPOTENCY_TTL_MS).toISOString()),
  ]);
  const note = await input.env.PLATFORM_DB.prepare("SELECT customer_notes.id, customer_notes.body, customer_notes.status, customer_notes.redacted_at AS redactedAt, customer_notes.created_at AS createdAt, customer_notes.updated_at AS updatedAt, customer_notes.version, platform_users.display_name AS authorDisplayName, customer_notes.author_user_id AS authorUserId FROM customer_notes INNER JOIN platform_users ON platform_users.id = customer_notes.author_user_id WHERE customer_notes.shop_id = ? AND customer_notes.customer_id = ? AND customer_notes.id = ? LIMIT 1").bind(actor.row.shop_id, input.customerPublicId, noteId).first<NoteRow>();
  if (note === null) throw new AppError("customer_note_create_failed", 500);
  return mapNote(note);
}

export async function redactCustomerNote(input: {
  customerPublicId: string;
  env: AppBindings;
  expectedVersion: number;
  idempotencyKey: string | null;
  notePublicId: string;
  requestId: string;
  shopPublicId: string;
  userId: string;
  now?: Date;
}): Promise<SellerCustomerNote> {
  if (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 1) throw new AppError("validation_failed", 400, ["expected_version_invalid"]);
  const idempotencyKey = requireIdempotencyKey(input.idempotencyKey);
  const actor = await getShopForMember({ capability: "customers:manage", env: input.env, shopPublicId: input.shopPublicId, userId: input.userId });
  const now = input.now ?? new Date();
  const nowIso = now.toISOString();
  const namespace = `customer-note.redact.v1:${actor.row.shop_id}:${input.customerPublicId}:${input.notePublicId}`;
  const keyHash = await hmacToken(input.env.SESSION_SECRET, "customer-note-idempotency:v1", idempotencyKey);
  const requestHash = await sha256Json({ customerPublicId: input.customerPublicId, expectedVersion: input.expectedVersion, notePublicId: input.notePublicId, shopId: actor.row.shop_id });
  const replay = await input.env.PLATFORM_DB.prepare("SELECT request_hash, response_json FROM idempotency_records WHERE actor_user_id = ? AND namespace = ? AND key_hash = ? AND expires_at > ? LIMIT 1").bind(input.userId, namespace, keyHash, nowIso).first<ExistingIdempotency>();
  if (replay !== null) {
    if (replay.request_hash !== requestHash) throw new AppError("idempotency_conflict", 409);
    const note = await input.env.PLATFORM_DB.prepare("SELECT customer_notes.id, customer_notes.body, customer_notes.status, customer_notes.redacted_at AS redactedAt, customer_notes.created_at AS createdAt, customer_notes.updated_at AS updatedAt, customer_notes.version, platform_users.display_name AS authorDisplayName, customer_notes.author_user_id AS authorUserId FROM customer_notes INNER JOIN platform_users ON platform_users.id = customer_notes.author_user_id WHERE customer_notes.shop_id = ? AND customer_notes.customer_id = ? AND customer_notes.public_id = ? LIMIT 1").bind(actor.row.shop_id, input.customerPublicId, input.notePublicId).first<NoteRow>();
    if (note === null) throw new AppError("customer_note_replay_invalid", 500);
    return mapNote(note);
  }
  const mutation = await input.env.PLATFORM_DB.batch([
    input.env.PLATFORM_DB.prepare("UPDATE customer_notes SET status = 'redacted', redacted_at = ?, updated_at = ?, version = version + 1 WHERE shop_id = ? AND customer_id = ? AND public_id = ? AND status = 'active' AND version = ?").bind(nowIso, nowIso, actor.row.shop_id, input.customerPublicId, input.notePublicId, input.expectedVersion),
    input.env.PLATFORM_DB.prepare("INSERT INTO audit_logs (id, shop_id, actor_type, actor_id, action, resource_type, resource_id, safe_metadata_json, request_id, source_kind, retention_class, created_at) SELECT ?, ?, 'user', ?, 'customer.note_redacted', 'customer_note', ?, '{}', ?, 'http', 'security', ? WHERE EXISTS (SELECT 1 FROM customer_notes WHERE shop_id = ? AND customer_id = ? AND public_id = ? AND status = 'redacted' AND version = ?)").bind(createId("aud"), actor.row.shop_id, input.userId, input.notePublicId, input.requestId, nowIso, actor.row.shop_id, input.customerPublicId, input.notePublicId, input.expectedVersion + 1),
    input.env.PLATFORM_DB.prepare("INSERT INTO idempotency_records (actor_user_id, namespace, key_hash, request_hash, response_json, created_at, expires_at) SELECT ?, ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM customer_notes WHERE shop_id = ? AND customer_id = ? AND public_id = ? AND status = 'redacted' AND version = ?)").bind(input.userId, namespace, keyHash, requestHash, JSON.stringify({ customerPublicId: input.customerPublicId, notePublicId: input.notePublicId, shopId: actor.row.shop_id }), nowIso, new Date(now.getTime() + IDEMPOTENCY_TTL_MS).toISOString(), actor.row.shop_id, input.customerPublicId, input.notePublicId, input.expectedVersion + 1),
  ]);
  if (mutation[0]?.meta.changes !== 1 || mutation[1]?.meta.changes !== 1 || mutation[2]?.meta.changes !== 1) throw new AppError("version_conflict", 409);
  const note = await input.env.PLATFORM_DB.prepare("SELECT customer_notes.id, customer_notes.body, customer_notes.status, customer_notes.redacted_at AS redactedAt, customer_notes.created_at AS createdAt, customer_notes.updated_at AS updatedAt, customer_notes.version, platform_users.display_name AS authorDisplayName, customer_notes.author_user_id AS authorUserId FROM customer_notes INNER JOIN platform_users ON platform_users.id = customer_notes.author_user_id WHERE customer_notes.shop_id = ? AND customer_notes.customer_id = ? AND customer_notes.public_id = ? LIMIT 1").bind(actor.row.shop_id, input.customerPublicId, input.notePublicId).first<NoteRow>();
  if (note === null) throw new AppError("customer_note_redact_failed", 500);
  return mapNote(note);
}
