import { hmacToken, sha256Json } from "../core/crypto";
import { AppError } from "../core/errors";
import { createId } from "../core/ids";
import type { AppBindings } from "../platform/bindings";
import { getPlatformAdminRole } from "../tenants/store";
import { getShopForMember } from "../tenants/store";

const IDEMPOTENCY_TTL_MS = 24 * 60 * 60_000;
const SAFE_REASON_CODE = /^[a-z][a-z0-9._:-]{2,63}$/u;
const REQUEST_ID_PATTERN = /^[A-Za-z0-9._:-]{8,128}$/u;

type ExistingIdempotency = { request_hash: string; response_json: string };
type RequestRow = {
  amountMinor: number;
  createdAt: string;
  currency: string;
  exceptionId: string;
  failureCode: string | null;
  id: string;
  kind: "manual_review" | "partial_refund" | "refund";
  orderPublicId: string;
  reasonCode: string;
  reviewedAt: string | null;
  status: "canceled" | "completed" | "failed" | "provider_pending" | "rejected" | "requested";
  updatedAt: string;
  version: number;
};

export type PaymentRemediationRequest = RequestRow & { requestPublicId: string };

export type AdminPaymentRemediationRequest = PaymentRemediationRequest & {
  shopName: string;
  shopPublicId: string;
};

function requireIdempotencyKey(value: string | null): string {
  if (value === null || !/^[A-Za-z0-9._:-]{8,128}$/u.test(value)) throw new AppError("validation_failed", 400, ["idempotency_key_required"]);
  return value;
}

function requireReasonCode(value: unknown): string {
  if (typeof value !== "string" || !SAFE_REASON_CODE.test(value)) throw new AppError("validation_failed", 400, ["reason_code_invalid"]);
  return value;
}

function mapRequest(row: RequestRow): PaymentRemediationRequest {
  return { ...row, requestPublicId: row.id };
}

async function loadRequest(env: AppBindings, shopId: string, requestPublicId: string): Promise<RequestRow> {
  const row = await env.PLATFORM_DB.prepare(`
    SELECT requests.id, requests.payment_exception_id AS exceptionId,
      orders.public_id AS orderPublicId,
      requests.kind, requests.status, requests.amount_minor AS amountMinor,
      requests.currency, requests.reason_code AS reasonCode,
      requests.failure_code AS failureCode, requests.reviewed_at AS reviewedAt,
      requests.created_at AS createdAt, requests.updated_at AS updatedAt, requests.version
    FROM payment_remediation_requests AS requests
    INNER JOIN orders ON orders.id = requests.order_id AND orders.shop_id = requests.shop_id
    WHERE requests.shop_id = ? AND requests.public_id = ?
    LIMIT 1
  `).bind(shopId, requestPublicId).first<RequestRow>();
  if (row === null) throw new AppError("payment_remediation_not_found", 404);
  return row;
}

export async function listSellerPaymentRemediationRequests(input: {
  env: AppBindings;
  shopPublicId: string;
  userId: string;
}): Promise<PaymentRemediationRequest[]> {
  const actor = await getShopForMember({ capability: "payments:manage", env: input.env, shopPublicId: input.shopPublicId, userId: input.userId });
  const rows = await input.env.PLATFORM_DB.prepare(`
    SELECT requests.id, requests.payment_exception_id AS exceptionId,
      orders.public_id AS orderPublicId, requests.kind, requests.status,
      requests.amount_minor AS amountMinor, requests.currency,
      requests.reason_code AS reasonCode, requests.failure_code AS failureCode,
      requests.reviewed_at AS reviewedAt, requests.created_at AS createdAt,
      requests.updated_at AS updatedAt, requests.version
    FROM payment_remediation_requests AS requests
    INNER JOIN orders ON orders.id = requests.order_id AND orders.shop_id = requests.shop_id
    WHERE requests.shop_id = ?
    ORDER BY requests.created_at DESC, requests.id DESC
    LIMIT 100
  `).bind(actor.row.shop_id).all<RequestRow>();
  return rows.results.map(mapRequest);
}

export async function createPaymentRemediationRequest(input: {
  amountMinor: number;
  currency: string;
  env: AppBindings;
  exceptionPublicId: string;
  idempotencyKey: string | null;
  kind: "manual_review" | "partial_refund" | "refund";
  reasonCode: unknown;
  requestId: string;
  shopPublicId: string;
  userId: string;
  now?: Date;
}): Promise<PaymentRemediationRequest> {
  const idempotencyKey = requireIdempotencyKey(input.idempotencyKey);
  if (!REQUEST_ID_PATTERN.test(input.requestId)) throw new AppError("validation_failed", 400, ["request_id_invalid"]);
  if (!Number.isSafeInteger(input.amountMinor) || input.amountMinor < 0) throw new AppError("validation_failed", 400, ["amount_invalid"]);
  if (!/^[A-Z]{3}$/u.test(input.currency)) throw new AppError("validation_failed", 400, ["currency_invalid"]);
  if (!["manual_review", "partial_refund", "refund"].includes(input.kind)) throw new AppError("validation_failed", 400, ["remediation_kind_invalid"]);
  const reasonCode = requireReasonCode(input.reasonCode);
  const actor = await getShopForMember({ capability: "payments:manage", env: input.env, shopPublicId: input.shopPublicId, userId: input.userId });
  const exception = await input.env.PLATFORM_DB.prepare(`
    SELECT payment_exceptions.id, payment_exceptions.order_id AS orderId,
      payment_exceptions.status, orders.public_id AS orderPublicId,
      orders.total_minor AS totalMinor, orders.currency
    FROM payment_exceptions
    INNER JOIN orders ON orders.id = payment_exceptions.order_id AND orders.shop_id = payment_exceptions.shop_id
    WHERE payment_exceptions.shop_id = ? AND payment_exceptions.id = ?
    LIMIT 1
  `).bind(actor.row.shop_id, input.exceptionPublicId).first<{ currency: string; id: string; orderId: string; orderPublicId: string; status: string; totalMinor: number }>();
  if (exception === null) throw new AppError("payment_exception_not_found", 404);
  if (input.kind !== "manual_review" && (input.amountMinor < 1 || input.amountMinor > exception.totalMinor || input.currency !== exception.currency)) {
    throw new AppError("remediation_amount_invalid", 400);
  }
  if (input.kind === "manual_review" && (input.amountMinor !== 0 || input.currency !== exception.currency)) {
    throw new AppError("remediation_amount_invalid", 400);
  }
  const now = input.now ?? new Date();
  const nowIso = now.toISOString();
  const namespace = `payment-remediation.create.v1:${actor.row.shop_id}:${exception.id}`;
  const keyHash = await hmacToken(input.env.SESSION_SECRET, "payment-remediation-idempotency:v1", idempotencyKey);
  const requestHash = await sha256Json({ amountMinor: input.amountMinor, currency: input.currency, exceptionId: exception.id, kind: input.kind, reasonCode, shopId: actor.row.shop_id });
  const replay = await input.env.PLATFORM_DB.prepare("SELECT request_hash, response_json FROM idempotency_records WHERE actor_user_id = ? AND namespace = ? AND key_hash = ? AND expires_at > ? LIMIT 1").bind(input.userId, namespace, keyHash, nowIso).first<ExistingIdempotency>();
  if (replay !== null) {
    if (replay.request_hash !== requestHash) throw new AppError("idempotency_conflict", 409);
    const reference = JSON.parse(replay.response_json) as { requestPublicId?: string };
    if (typeof reference.requestPublicId !== "string") throw new AppError("payment_remediation_replay_invalid", 500);
    return mapRequest(await loadRequest(input.env, actor.row.shop_id, reference.requestPublicId));
  }
  if (exception.status !== "open") throw new AppError("payment_exception_not_open", 409);
  const active = await input.env.PLATFORM_DB.prepare("SELECT id FROM payment_remediation_requests WHERE shop_id = ? AND payment_exception_id = ? AND status IN ('requested', 'provider_pending') LIMIT 1").bind(actor.row.shop_id, exception.id).first<{ id: string }>();
  if (active !== null) throw new AppError("payment_remediation_pending", 409);
  const requestId = createId("prem");
  await input.env.PLATFORM_DB.batch([
    input.env.PLATFORM_DB.prepare(`
      INSERT INTO payment_remediation_requests (
        id, public_id, shop_id, order_id, payment_exception_id,
        requested_by_user_id, kind, status, amount_minor, currency,
        reason_code, idempotency_key_hash, request_hash, created_at, updated_at, version
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'requested', ?, ?, ?, ?, ?, ?, ?, 1)
    `).bind(requestId, requestId, actor.row.shop_id, exception.orderId, exception.id, input.userId, input.kind, input.amountMinor, input.currency, reasonCode, keyHash, requestHash, nowIso, nowIso),
    input.env.PLATFORM_DB.prepare(`
      INSERT INTO audit_logs (
        id, shop_id, actor_type, actor_id, action, resource_type, resource_id,
        safe_metadata_json, request_id, source_kind, retention_class, created_at
      ) VALUES (?, ?, 'user', ?, 'payment.remediation_requested', 'payment_remediation', ?, ?, ?, 'http', 'financial', ?)
    `).bind(createId("aud"), actor.row.shop_id, input.userId, requestId, JSON.stringify({ amountMinor: input.amountMinor, currency: input.currency, kind: input.kind, reasonCode }), input.requestId, nowIso),
    input.env.PLATFORM_DB.prepare(`
      INSERT INTO idempotency_records (
        actor_user_id, namespace, key_hash, request_hash, response_json,
        created_at, expires_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).bind(input.userId, namespace, keyHash, requestHash, JSON.stringify({ requestPublicId: requestId }), nowIso, new Date(now.getTime() + IDEMPOTENCY_TTL_MS).toISOString()),
  ]);
  return mapRequest(await loadRequest(input.env, actor.row.shop_id, requestId));
}

export async function listAdminPaymentRemediationRequests(input: {
  env: AppBindings;
  status?: string | null;
  userId: string;
}): Promise<AdminPaymentRemediationRequest[]> {
  if (await getPlatformAdminRole({ env: input.env, userId: input.userId }) === null) throw new AppError("authorization_denied", 403);
  const status = input.status?.trim() ?? "";
  if (status !== "" && !/^[a-z_]{3,32}$/u.test(status)) throw new AppError("validation_failed", 400, ["status_invalid"]);
  const rows = await input.env.PLATFORM_DB.prepare(`
    SELECT requests.id, requests.payment_exception_id AS exceptionId,
      orders.public_id AS orderPublicId, requests.kind, requests.status,
      requests.amount_minor AS amountMinor, requests.currency,
      requests.reason_code AS reasonCode, requests.failure_code AS failureCode,
      requests.reviewed_at AS reviewedAt, requests.created_at AS createdAt,
      requests.updated_at AS updatedAt, requests.version,
      shops.public_id AS shopPublicId, shops.name AS shopName
    FROM payment_remediation_requests AS requests
    INNER JOIN orders ON orders.id = requests.order_id AND orders.shop_id = requests.shop_id
    INNER JOIN shops ON shops.id = requests.shop_id
    WHERE (? = '' OR requests.status = ?)
    ORDER BY requests.created_at DESC, requests.id DESC
    LIMIT 100
  `).bind(status, status).all<RequestRow & { shopName: string; shopPublicId: string }>();
  return rows.results.map((row) => ({ ...mapRequest(row), shopName: row.shopName, shopPublicId: row.shopPublicId }));
}

export async function reviewPaymentRemediationRequest(input: {
  decision: "provider_pending" | "rejected";
  env: AppBindings;
  expectedVersion: number;
  idempotencyKey: string | null;
  requestPublicId: string;
  requestId: string;
  userId: string;
  now?: Date;
}): Promise<AdminPaymentRemediationRequest> {
  const adminRole = await getPlatformAdminRole({ env: input.env, userId: input.userId });
  if (adminRole !== "owner" && adminRole !== "risk") throw new AppError("authorization_denied", 403);
  // Keep this runtime guard because route payloads are narrowed with a cast.
  const decision: string = input.decision;
  if (decision !== "provider_pending" && decision !== "rejected") {
    throw new AppError("validation_failed", 400, ["remediation_decision_invalid"]);
  }
  if (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 1) throw new AppError("validation_failed", 400, ["expected_version_invalid"]);
  const idempotencyKey = requireIdempotencyKey(input.idempotencyKey);
  const current = await input.env.PLATFORM_DB.prepare("SELECT status FROM payment_remediation_requests WHERE public_id = ? LIMIT 1").bind(input.requestPublicId).first<{ status: string }>();
  if (current === null) throw new AppError("payment_remediation_not_found", 404);
  const now = input.now ?? new Date();
  const nowIso = now.toISOString();
  const namespace = `payment-remediation.review.v1:${input.requestPublicId}`;
  const keyHash = await hmacToken(input.env.SESSION_SECRET, "payment-remediation-review-idempotency:v1", idempotencyKey);
  const requestHash = await sha256Json({ decision, expectedVersion: input.expectedVersion, requestPublicId: input.requestPublicId });
  const replay = await input.env.PLATFORM_DB.prepare("SELECT request_hash FROM idempotency_records WHERE actor_user_id = ? AND namespace = ? AND key_hash = ? AND expires_at > ? LIMIT 1").bind(input.userId, namespace, keyHash, nowIso).first<{ request_hash: string }>();
  if (replay !== null) {
    if (replay.request_hash !== requestHash) throw new AppError("idempotency_conflict", 409);
    const row = await input.env.PLATFORM_DB.prepare(`SELECT requests.id, requests.payment_exception_id AS exceptionId, orders.public_id AS orderPublicId, requests.kind, requests.status, requests.amount_minor AS amountMinor, requests.currency, requests.reason_code AS reasonCode, requests.failure_code AS failureCode, requests.reviewed_at AS reviewedAt, requests.created_at AS createdAt, requests.updated_at AS updatedAt, requests.version, shops.public_id AS shopPublicId, shops.name AS shopName FROM payment_remediation_requests AS requests INNER JOIN orders ON orders.id = requests.order_id AND orders.shop_id = requests.shop_id INNER JOIN shops ON shops.id = requests.shop_id WHERE requests.public_id = ? LIMIT 1`).bind(input.requestPublicId).first<RequestRow & { shopName: string; shopPublicId: string }>();
    if (row === null) throw new AppError("payment_remediation_replay_invalid", 500);
    return { ...mapRequest(row), shopName: row.shopName, shopPublicId: row.shopPublicId };
  }
  if (current.status !== "requested") throw new AppError("payment_remediation_state_conflict", 409);
  const nextStatus = decision === "provider_pending" ? "provider_pending" : "rejected";
  const mutation = await input.env.PLATFORM_DB.batch([
    input.env.PLATFORM_DB.prepare(`
      UPDATE payment_remediation_requests
      SET status = ?, reviewed_by_user_id = ?, reviewed_at = ?, updated_at = ?, version = version + 1
      WHERE public_id = ? AND status = 'requested' AND version = ?
    `).bind(nextStatus, input.userId, nowIso, nowIso, input.requestPublicId, input.expectedVersion),
    input.env.PLATFORM_DB.prepare(`
      INSERT INTO audit_logs (
        id, shop_id, actor_type, actor_id, action, resource_type, resource_id,
        safe_metadata_json, request_id, source_kind, retention_class, created_at
      ) SELECT ?, shop_id, 'platform_admin', ?, ?, 'payment_remediation', ?, ?, ?, 'http', 'financial', ?
      FROM payment_remediation_requests
      WHERE public_id = ? AND status = ? AND version = ?
    `).bind(createId("aud"), input.userId, decision === "provider_pending" ? "payment.remediation_approved" : "payment.remediation_rejected", input.requestPublicId, JSON.stringify({ decision }), input.requestId, nowIso, input.requestPublicId, nextStatus, input.expectedVersion + 1),
    input.env.PLATFORM_DB.prepare(`
      INSERT INTO idempotency_records (
        actor_user_id, namespace, key_hash, request_hash, response_json, created_at, expires_at
      ) SELECT ?, ?, ?, ?, ?, ?, ?
      WHERE EXISTS (SELECT 1 FROM payment_remediation_requests WHERE public_id = ? AND status = ? AND version = ?)
    `).bind(input.userId, namespace, keyHash, requestHash, JSON.stringify({ requestPublicId: input.requestPublicId }), nowIso, new Date(now.getTime() + IDEMPOTENCY_TTL_MS).toISOString(), input.requestPublicId, nextStatus, input.expectedVersion + 1),
  ]);
  if (mutation[0]?.meta.changes !== 1 || mutation[1]?.meta.changes !== 1 || mutation[2]?.meta.changes !== 1) throw new AppError("version_conflict", 409);
  const row = await input.env.PLATFORM_DB.prepare(`SELECT requests.id, requests.payment_exception_id AS exceptionId, orders.public_id AS orderPublicId, requests.kind, requests.status, requests.amount_minor AS amountMinor, requests.currency, requests.reason_code AS reasonCode, requests.failure_code AS failureCode, requests.reviewed_at AS reviewedAt, requests.created_at AS createdAt, requests.updated_at AS updatedAt, requests.version, shops.public_id AS shopPublicId, shops.name AS shopName FROM payment_remediation_requests AS requests INNER JOIN orders ON orders.id = requests.order_id AND orders.shop_id = requests.shop_id INNER JOIN shops ON shops.id = requests.shop_id WHERE requests.public_id = ? LIMIT 1`).bind(input.requestPublicId).first<RequestRow & { shopName: string; shopPublicId: string }>();
  if (row === null) throw new AppError("payment_remediation_review_failed", 500);
  return { ...mapRequest(row), shopName: row.shopName, shopPublicId: row.shopPublicId };
}
