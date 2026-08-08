import { hmacToken, sha256Json } from "../core/crypto";
import { AppError } from "../core/errors";
import { createId } from "../core/ids";
import { matchSupportedLocale } from "../i18n/locale";
import type { AppBindings } from "../platform/bindings";
import { getShopForMember } from "./store";
import { assertRoleCapability, normalizeShopName } from "./policy";

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

function maskDisplayName(value: string | null): string | null {
  if (value === null || value.trim().length === 0) return null;
  const normalized = value.trim();
  return `${normalized.slice(0, 1)}${"*".repeat(Math.min(8, Math.max(1, normalized.length - 1)))}`;
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

export type BuyerPrivacyProjection = {
  customer: {
    createdAt: string;
    displayName: string | null;
    email: string | null;
    locale: string;
    status: "active" | "blocked";
    updatedAt: string;
  };
  orders: Array<{
    createdAt: string;
    currency: string;
    fulfillmentStatus: string;
    orderNumber: string;
    orderPublicId: string;
    paymentStatus: string;
    status: string;
    totalMinor: number;
  }>;
  providerIdentities: Array<{ provider: string; verifiedAt: string }>;
};

export type BuyerPrivacyResult = {
  privacyRequestPublicId: string;
  projection?: BuyerPrivacyProjection;
  safeResultCode: "active_records_blocked" | "anonymized_financial_audit_retained" | "export_ready";
  status: "blocked" | "completed";
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
  if (actor.row.role === "owner" || actor.row.role === "manager") {
    assertRoleCapability(actor.row.role, "customers:read");
  } else if (actor.row.role === "support") {
    assertRoleCapability(actor.row.role, "customers:read:masked");
  } else {
    // Viewers may see aggregate customer activity only; never return detail
    // records, order/payment evidence or internal notes to this role.
    throw new AppError("authorization_denied", 403);
  }
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
    displayName: actor.row.role === "support" ? maskDisplayName(customer.displayName) : customer.displayName,
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

async function buildBuyerPrivacyProjection(env: AppBindings, shopId: string, customerId: string): Promise<BuyerPrivacyProjection> {
  const customer = await loadCustomer(env, shopId, customerId);
  const [orders, telegramIdentities, channelIdentities] = await Promise.all([
    env.PLATFORM_DB.prepare(`
      SELECT public_id AS orderPublicId, order_number AS orderNumber, status,
        payment_status AS paymentStatus, fulfillment_status AS fulfillmentStatus,
        total_minor AS totalMinor, currency, created_at AS createdAt
      FROM orders WHERE shop_id = ? AND customer_id = ? ORDER BY created_at, id
    `).bind(shopId, customerId).all<BuyerPrivacyProjection["orders"][number]>(),
    env.PLATFORM_DB.prepare(`
      SELECT provider, verified_at AS verifiedAt
      FROM customer_identities WHERE shop_id = ? AND customer_id = ? ORDER BY verified_at, id
    `).bind(shopId, customerId).all<{ provider: string; verifiedAt: string }>(),
    env.PLATFORM_DB.prepare(`
      SELECT provider_code AS provider, verified_at AS verifiedAt
      FROM channel_customer_identities WHERE shop_id = ? AND customer_id = ? ORDER BY verified_at, id
    `).bind(shopId, customerId).all<{ provider: string; verifiedAt: string }>(),
  ]);
  return {
    customer: {
      createdAt: customer.createdAt,
      displayName: customer.displayName,
      email: customer.email,
      locale: customer.locale,
      status: customer.status,
      updatedAt: customer.updatedAt,
    },
    orders: orders.results,
    providerIdentities: [...telegramIdentities.results, ...channelIdentities.results],
  };
}

export async function executeBuyerPrivacyRequest(input: {
  customerPublicId: string;
  env: AppBindings;
  idempotencyKey: string | null;
  kind: "anonymize" | "export";
  requestId: string;
  shopPublicId: string;
  userId: string;
  now?: Date;
}): Promise<BuyerPrivacyResult> {
  const idempotencyKey = requireIdempotencyKey(input.idempotencyKey);
  const actor = await getShopForMember({ capability: "customers:manage", env: input.env, shopPublicId: input.shopPublicId, userId: input.userId });
  await loadCustomer(input.env, actor.row.shop_id, input.customerPublicId);
  const now = input.now ?? new Date();
  const nowIso = now.toISOString();
  const keyHash = await hmacToken(input.env.SESSION_SECRET, "buyer-privacy-idempotency:v1", idempotencyKey);
  const requestHash = await sha256Json({ customerId: input.customerPublicId, kind: input.kind, shopId: actor.row.shop_id });
  const replay = await input.env.PLATFORM_DB.prepare(`
    SELECT public_id AS publicId, kind, status, request_hash AS requestHash,
      projection_hash AS projectionHash,
      safe_result_code AS safeResultCode
    FROM buyer_privacy_requests
    WHERE shop_id = ? AND requested_by_user_id = ? AND idempotency_key_hash = ? LIMIT 1
  `).bind(actor.row.shop_id, input.userId, keyHash).first<{
    kind: "anonymize" | "export";
    publicId: string;
    projectionHash: string | null;
    requestHash: string;
    safeResultCode: BuyerPrivacyResult["safeResultCode"];
    status: "blocked" | "completed";
  }>();
  if (replay !== null) {
    if (replay.requestHash !== requestHash || replay.kind !== input.kind) throw new AppError("idempotency_conflict", 409);
    const projection = input.kind === "export"
      ? await buildBuyerPrivacyProjection(input.env, actor.row.shop_id, input.customerPublicId)
      : undefined;
    if (projection !== undefined && replay.projectionHash !== await sha256Json(projection)) {
      throw new AppError("privacy_projection_changed", 409);
    }
    return {
      privacyRequestPublicId: replay.publicId,
      ...(projection === undefined ? {} : { projection }),
      safeResultCode: replay.safeResultCode,
      status: replay.status,
    };
  }

  const privacyRequestId = createId("pvr");
  if (input.kind === "export") {
    const projection = await buildBuyerPrivacyProjection(input.env, actor.row.shop_id, input.customerPublicId);
    const projectionHash = await sha256Json(projection);
    await input.env.PLATFORM_DB.batch([
      input.env.PLATFORM_DB.prepare(`
        INSERT INTO buyer_privacy_requests (
          id, public_id, shop_id, customer_id, kind, status, requested_by_user_id,
          idempotency_key_hash, request_hash, projection_hash, safe_result_code,
          retained_records_json, request_id, completed_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, 'export', 'completed', ?, ?, ?, ?, 'export_ready', '{}', ?, ?, ?, ?)
      `).bind(privacyRequestId, privacyRequestId, actor.row.shop_id, input.customerPublicId, input.userId, keyHash, requestHash, projectionHash, input.requestId, nowIso, nowIso, nowIso),
      input.env.PLATFORM_DB.prepare(`
        INSERT INTO audit_logs (id, shop_id, actor_type, actor_id, action, resource_type,
          resource_id, safe_metadata_json, request_id, source_kind, retention_class, created_at)
        VALUES (?, ?, 'user', ?, 'customer.privacy_exported', 'customer', ?, '{}', ?, 'http', 'security', ?)
      `).bind(createId("aud"), actor.row.shop_id, input.userId, input.customerPublicId, input.requestId, nowIso),
    ]);
    return { privacyRequestPublicId: privacyRequestId, projection, safeResultCode: "export_ready", status: "completed" };
  }

  const blockers = await input.env.PLATFORM_DB.prepare(`
    SELECT COUNT(*) AS count FROM orders
    WHERE shop_id = ? AND customer_id = ? AND (
      status NOT IN ('completed', 'canceled', 'expired')
      OR payment_status IN ('pending', 'partial', 'overpaid')
      OR fulfillment_status = 'reserved'
    )
  `).bind(actor.row.shop_id, input.customerPublicId).first<{ count: number }>();
  if ((blockers?.count ?? 0) > 0) {
    await input.env.PLATFORM_DB.prepare(`
      INSERT INTO buyer_privacy_requests (
        id, public_id, shop_id, customer_id, kind, status, requested_by_user_id,
        idempotency_key_hash, request_hash, safe_result_code, retained_records_json,
        request_id, created_at, updated_at
      ) VALUES (?, ?, ?, ?, 'anonymize', 'blocked', ?, ?, ?, 'active_records_blocked', ?, ?, ?, ?)
    `).bind(privacyRequestId, privacyRequestId, actor.row.shop_id, input.customerPublicId, input.userId, keyHash, requestHash, JSON.stringify({ activeOrderCount: blockers?.count ?? 0 }), input.requestId, nowIso, nowIso).run();
    return { privacyRequestPublicId: privacyRequestId, safeResultCode: "active_records_blocked", status: "blocked" };
  }

  const retained = await input.env.PLATFORM_DB.prepare(`
    SELECT
      (SELECT COUNT(*) FROM orders WHERE shop_id = ? AND customer_id = ?) AS orderCount,
      (SELECT COUNT(*) FROM audit_logs WHERE shop_id = ? AND resource_type = 'customer' AND resource_id = ?) AS auditCount
  `).bind(actor.row.shop_id, input.customerPublicId, actor.row.shop_id, input.customerPublicId).first<{ auditCount: number; orderCount: number }>();
  const mutation = await input.env.PLATFORM_DB.batch([
    input.env.PLATFORM_DB.prepare(`
      UPDATE shop_customers SET email_normalized = NULL, display_name = NULL, status = 'blocked',
        anonymized_at = ?, updated_at = ?, version = version + 1
      WHERE shop_id = ? AND id = ? AND anonymized_at IS NULL
    `).bind(nowIso, nowIso, actor.row.shop_id, input.customerPublicId),
    input.env.PLATFORM_DB.prepare(`
      UPDATE orders SET customer_email_masked = NULL, updated_at = ?
      WHERE shop_id = ? AND customer_id = ?
    `).bind(nowIso, actor.row.shop_id, input.customerPublicId),
    input.env.PLATFORM_DB.prepare(`
      UPDATE customer_notes SET body = '[redacted]', status = 'redacted', redacted_at = ?, updated_at = ?, version = version + 1
      WHERE shop_id = ? AND customer_id = ? AND status = 'active'
    `).bind(nowIso, nowIso, actor.row.shop_id, input.customerPublicId),
    input.env.PLATFORM_DB.prepare("DELETE FROM customer_identities WHERE shop_id = ? AND customer_id = ?").bind(actor.row.shop_id, input.customerPublicId),
    input.env.PLATFORM_DB.prepare("DELETE FROM channel_customer_identities WHERE shop_id = ? AND customer_id = ?").bind(actor.row.shop_id, input.customerPublicId),
    input.env.PLATFORM_DB.prepare(`
      INSERT INTO buyer_privacy_requests (
        id, public_id, shop_id, customer_id, kind, status, requested_by_user_id,
        idempotency_key_hash, request_hash, safe_result_code, retained_records_json,
        request_id, completed_at, created_at, updated_at
      ) SELECT ?, ?, ?, ?, 'anonymize', 'completed', ?, ?, ?,
        'anonymized_financial_audit_retained', ?, ?, ?, ?, ?
      WHERE EXISTS (SELECT 1 FROM shop_customers WHERE shop_id = ? AND id = ? AND anonymized_at = ?)
    `).bind(privacyRequestId, privacyRequestId, actor.row.shop_id, input.customerPublicId, input.userId, keyHash, requestHash, JSON.stringify(retained ?? { auditCount: 0, orderCount: 0 }), input.requestId, nowIso, nowIso, nowIso, actor.row.shop_id, input.customerPublicId, nowIso),
    input.env.PLATFORM_DB.prepare(`
      INSERT INTO audit_logs (id, shop_id, actor_type, actor_id, action, resource_type,
        resource_id, safe_metadata_json, request_id, source_kind, retention_class, created_at)
      SELECT ?, ?, 'user', ?, 'customer.anonymized', 'customer', ?, ?, ?, 'http', 'security', ?
      WHERE EXISTS (SELECT 1 FROM buyer_privacy_requests WHERE id = ? AND shop_id = ? AND status = 'completed')
    `).bind(createId("aud"), actor.row.shop_id, input.userId, input.customerPublicId, JSON.stringify({ retainedAuditRecords: retained?.auditCount ?? 0, retainedOrderRecords: retained?.orderCount ?? 0 }), input.requestId, nowIso, privacyRequestId, actor.row.shop_id),
  ]);
  if (mutation[0]?.meta.changes !== 1 || mutation[5]?.meta.changes !== 1 || mutation[6]?.meta.changes !== 1) {
    throw new AppError("privacy_request_conflict", 409);
  }
  return { privacyRequestPublicId: privacyRequestId, safeResultCode: "anonymized_financial_audit_retained", status: "completed" };
}
