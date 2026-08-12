import { hmacToken, sha256Json } from "../core/crypto";
import { AppError } from "../core/errors";
import { createId, createOpaqueToken } from "../core/ids";
import { CloudflareProviderError, CloudflareSaaSClient } from "../domains/cloudflare";
import type { AppBindings } from "../platform/bindings";
import { TelegramClient, TelegramProviderError } from "../telegram/client";
import { loadActiveTelegramCredential } from "../telegram/credentials";
import {
  createOperationsAuditEvent,
  prepareOperationsAuditForDeletionRequestVersion,
} from "./audit";
import { dataExportObjectKey, exportBindings } from "./exports";

const DELETION_GRACE_MS = 30 * 24 * 60 * 60_000;
const FINANCIAL_RETENTION_MS = 7 * 365 * 24 * 60 * 60_000;
const STEP_LEASE_MS = 90_000;
const IDEMPOTENCY_TTL_MS = 24 * 60 * 60_000;
const ACTIVE_DELETION_STATUSES = ["processing", "blocked", "retention_hold", "failed"] as const;
const SAFE_REASON_CODE = /^[a-z][a-z0-9_]{2,63}$/u;
const SAFE_EVIDENCE_REFERENCE = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/u;
const CRYPTO_SHRED_DESTRUCTIVE_MARKER = "crypto_shred_destructive_in_flight";

export const SHOP_DELETION_REASON_CODES = [
  "seller_request",
  "business_closed",
  "platform_migration",
  "other",
] as const;

export type ShopDeletionReasonCode = typeof SHOP_DELETION_REASON_CODES[number];

export const SHOP_DELETION_STEPS = [
  "checkout_block",
  "routing_remove",
  "active_payment_drain",
  "grace_wait",
  "custom_domain_cleanup",
  "telegram_cleanup",
  "payment_cleanup",
  "crypto_shred",
  "finalize",
] as const;

export type ShopDeletionStepCode = typeof SHOP_DELETION_STEPS[number];

const HOLD_BLOCKED_STEPS: ReadonlySet<ShopDeletionStepCode> = new Set([
  "custom_domain_cleanup",
  "telegram_cleanup",
  "payment_cleanup",
  "crypto_shred",
  "finalize",
]);

const PROVIDER_CLEANUP_STEPS: ReadonlySet<ShopDeletionStepCode> = new Set([
  "custom_domain_cleanup",
  "telegram_cleanup",
  "payment_cleanup",
]);

type DeletionBindings = AppBindings & {
  CLOUDFLARE_API_TOKEN: string;
  CLOUDFLARE_ZONE_ID: string;
};

type OwnerShop = {
  publicId: string;
  role: string;
  shopId: string;
  slug: string;
  status: string;
};

type DeletionRequestRow = {
  checkoutBlockedAt: string;
  completedAt: string | null;
  createdAt: string;
  financialRecordsRetainUntil: string;
  graceEndsAt: string;
  id: string;
  lastSafeErrorCode: string | null;
  legalHoldUntil: string | null;
  providerCleanupCompletedAt: string | null;
  reasonCode: ShopDeletionReasonCode;
  routingRemovedAt: string;
  secretMaterialDestroyedAt: string | null;
  shopId: string;
  status: string;
  updatedAt: string;
  version: number;
};

type DeletionStepRow = {
  attemptCount: number;
  completedAt: string | null;
  id: string;
  lastSafeErrorCode: string | null;
  leaseExpiresAt: string | null;
  leaseToken: string | null;
  sequenceNo: number;
  startedAt: string | null;
  status: string;
  stepCode: ShopDeletionStepCode;
  updatedAt: string;
  version: number;
};

export type ShopDeletionView = {
  checkoutBlockedAt: string;
  completedAt: string | null;
  createdAt: string;
  financialRecordsRetainUntil: string;
  graceEndsAt: string;
  id: string;
  lastSafeErrorCode: string | null;
  legalHoldUntil: string | null;
  providerCleanupCompletedAt: string | null;
  reasonCode: ShopDeletionReasonCode;
  routingRemovedAt: string;
  secretMaterialDestroyedAt: string | null;
  status: string;
  steps: {
    attempts: number;
    completedAt: string | null;
    code: ShopDeletionStepCode;
    lastSafeErrorCode: string | null;
    status: string;
    updatedAt: string;
  }[];
  updatedAt: string;
  version: number;
};

export type DeletionLegalHoldView = {
  action: "release" | "set";
  actionId: string;
  deletionRequestId: string;
  holdUntil: string | null;
  status: "applied";
  version: number;
};

/** Safe platform projection used by the protected operations queue. */
export type ActiveDeletionRequestAdminView = {
  checkoutBlockedAt: string;
  createdAt: string;
  deletionRequestId: string;
  financialRecordsRetainUntil: string;
  graceEndsAt: string;
  lastSafeErrorCode: string | null;
  legalHoldUntil: string | null;
  reasonCode: ShopDeletionReasonCode;
  routingRemovedAt: string;
  shopName: string;
  shopPublicId: string;
  status: "processing" | "blocked" | "retention_hold" | "failed";
  updatedAt: string;
  version: number;
};

export type DeletionProviderRuntime = {
  beforeStep?: (input: {
    env: AppBindings;
    leaseToken: string;
    requestId: string;
    shopId: string;
    stepCode: ShopDeletionStepCode;
  }) => Promise<void>;
  cleanupCustomDomains?: (input: ProviderCleanupContext) => Promise<void>;
  cleanupPayment?: (input: ProviderCleanupContext) => Promise<void>;
  cleanupTelegram?: (input: ProviderCleanupContext) => Promise<void>;
  fetcher?: typeof fetch;
  now?: Date;
};

type ProviderCleanupContext = {
  env: AppBindings;
  leaseToken: string;
  now: Date;
  requestId: string;
  shopId: string;
};

const REQUEST_SELECT = `
  SELECT id, shop_id AS shopId, status, reason_code AS reasonCode,
    grace_ends_at AS graceEndsAt,
    financial_records_retain_until AS financialRecordsRetainUntil,
    legal_hold_until AS legalHoldUntil,
    checkout_blocked_at AS checkoutBlockedAt,
    routing_removed_at AS routingRemovedAt,
    provider_cleanup_completed_at AS providerCleanupCompletedAt,
    secret_material_destroyed_at AS secretMaterialDestroyedAt,
    completed_at AS completedAt, last_safe_error_code AS lastSafeErrorCode,
    version, created_at AS createdAt, updated_at AS updatedAt
  FROM shop_deletion_requests
`;

const STEP_SELECT = `
  SELECT id, step_code AS stepCode, sequence_no AS sequenceNo, status,
    attempt_count AS attemptCount, lease_token AS leaseToken,
    lease_expires_at AS leaseExpiresAt, last_safe_error_code AS lastSafeErrorCode,
    started_at AS startedAt, completed_at AS completedAt,
    version, updated_at AS updatedAt
  FROM shop_deletion_steps
`;

export function parseShopDeletionRequest(value: Record<string, unknown>): ShopDeletionReasonCode {
  if (value.confirmation !== "DELETE SHOP") {
    throw new AppError("validation_failed", 400, ["shop_deletion_confirmation_required"]);
  }
  const reasonCode = value.reasonCode ?? "seller_request";
  if (!SHOP_DELETION_REASON_CODES.includes(reasonCode as ShopDeletionReasonCode)) {
    throw new AppError("validation_failed", 400, ["shop_deletion_reason_invalid"]);
  }
  return reasonCode as ShopDeletionReasonCode;
}

async function requireOwnerShop(input: {
  env: AppBindings;
  shopPublicId: string;
  userId: string;
}): Promise<OwnerShop> {
  const row = await input.env.PLATFORM_DB.prepare(`
    SELECT shops.id AS shopId, shops.public_id AS publicId, shops.slug,
      shops.status, shop_members.role
    FROM shops
    INNER JOIN shop_members
      ON shop_members.shop_id = shops.id
      AND shop_members.user_id = ?
      AND shop_members.status = 'active'
    WHERE shops.public_id = ?
    LIMIT 1
  `).bind(input.userId, input.shopPublicId).first<OwnerShop>();
  if (row === null || row.role !== "owner") throw new AppError("authorization_denied", 403);
  return row;
}

async function loadRequest(env: AppBindings, shopId: string): Promise<DeletionRequestRow | null> {
  return env.PLATFORM_DB.prepare(`
    ${REQUEST_SELECT}
    WHERE shop_id = ?
    ORDER BY created_at DESC, id DESC
    LIMIT 1
  `).bind(shopId).first<DeletionRequestRow>();
}

async function loadSteps(env: AppBindings, requestId: string, shopId: string): Promise<DeletionStepRow[]> {
  return (await env.PLATFORM_DB.prepare(`
    ${STEP_SELECT}
    WHERE request_id = ? AND shop_id = ?
    ORDER BY sequence_no, id
  `).bind(requestId, shopId).all<DeletionStepRow>()).results;
}

async function mapDeletion(env: AppBindings, row: DeletionRequestRow): Promise<ShopDeletionView> {
  const steps = await loadSteps(env, row.id, row.shopId);
  return {
    checkoutBlockedAt: row.checkoutBlockedAt,
    completedAt: row.completedAt,
    createdAt: row.createdAt,
    financialRecordsRetainUntil: row.financialRecordsRetainUntil,
    graceEndsAt: row.graceEndsAt,
    id: row.id,
    lastSafeErrorCode: row.lastSafeErrorCode,
    legalHoldUntil: row.legalHoldUntil,
    providerCleanupCompletedAt: row.providerCleanupCompletedAt,
    reasonCode: row.reasonCode,
    routingRemovedAt: row.routingRemovedAt,
    secretMaterialDestroyedAt: row.secretMaterialDestroyedAt,
    status: row.status,
    steps: steps.map((step) => ({
      attempts: step.attemptCount,
      completedAt: step.completedAt,
      code: step.stepCode,
      lastSafeErrorCode: step.lastSafeErrorCode,
      status: step.status,
      updatedAt: step.updatedAt,
    })),
    updatedAt: row.updatedAt,
    version: row.version,
  };
}

async function loadRequestById(env: AppBindings, requestId: string, shopId: string): Promise<DeletionRequestRow | null> {
  return env.PLATFORM_DB.prepare(`
    ${REQUEST_SELECT}
    WHERE id = ? AND shop_id = ?
    LIMIT 1
  `).bind(requestId, shopId).first<DeletionRequestRow>();
}

const PROVIDER_CLEANUP_FENCE = `
  EXISTS (
    SELECT 1
    FROM shop_deletion_steps AS owned_step
    INNER JOIN shop_deletion_requests AS owned_request
      ON owned_request.id = owned_step.request_id
      AND owned_request.shop_id = owned_step.shop_id
    WHERE owned_step.request_id = ? AND owned_step.shop_id = ?
      AND owned_step.step_code = ?
      AND owned_step.status = 'processing'
      AND owned_step.lease_token = ?
      AND owned_step.lease_expires_at > ?
      AND owned_request.status IN ('processing', 'blocked', 'retention_hold', 'failed')
      AND owned_request.grace_ends_at <= ?
      AND (owned_request.legal_hold_until IS NULL OR owned_request.legal_hold_until <= ?)
  )
`;

function providerCleanupFenceValues(input: ProviderCleanupContext, stepCode: ShopDeletionStepCode): readonly string[] {
  return [input.requestId, input.shopId, stepCode, input.leaseToken, input.now.toISOString(), input.now.toISOString(), input.now.toISOString()];
}

async function assertProviderCleanupFence(input: ProviderCleanupContext, stepCode: ShopDeletionStepCode): Promise<void> {
  if (!PROVIDER_CLEANUP_STEPS.has(stepCode)) throw new AppError("shop_deletion_lease_lost", 409);
  const row = await input.env.PLATFORM_DB.prepare(`SELECT 1 AS eligible WHERE ${PROVIDER_CLEANUP_FENCE}`)
    .bind(...providerCleanupFenceValues(input, stepCode)).first<{ eligible: number }>();
  if (row === null) throw new AppError("shop_deletion_lease_lost", 409);
}

type ActiveDeletionAdminRow = Omit<ActiveDeletionRequestAdminView, "deletionRequestId" | "shopPublicId" | "status"> & {
  deletionRequestId: string;
  shopPublicId: string;
  status: string;
};

async function requirePlatformDeletionReader(input: {
  env: AppBindings;
  userId: string;
}): Promise<"owner" | "risk" | "support"> {
  const row = await input.env.PLATFORM_DB.prepare(`
    SELECT role
    FROM platform_admins
    WHERE user_id = ? AND status = 'active'
    LIMIT 1
  `).bind(input.userId).first<{ role: "owner" | "risk" | "support" }>();
  if (row === null || !["owner", "risk", "support"].includes(row.role)) {
    throw new AppError("authorization_denied", 403);
  }
  return row.role;
}

function mapActiveDeletionAdmin(row: ActiveDeletionAdminRow): ActiveDeletionRequestAdminView {
  if (!["processing", "blocked", "retention_hold", "failed"].includes(row.status)) {
    throw new AppError("internal_error", 500);
  }
  return {
    checkoutBlockedAt: row.checkoutBlockedAt,
    createdAt: row.createdAt,
    deletionRequestId: row.deletionRequestId,
    financialRecordsRetainUntil: row.financialRecordsRetainUntil,
    graceEndsAt: row.graceEndsAt,
    lastSafeErrorCode: row.lastSafeErrorCode,
    legalHoldUntil: row.legalHoldUntil,
    reasonCode: row.reasonCode,
    routingRemovedAt: row.routingRemovedAt,
    shopName: row.shopName,
    shopPublicId: row.shopPublicId,
    status: row.status as ActiveDeletionRequestAdminView["status"],
    updatedAt: row.updatedAt,
    version: row.version,
  };
}

export async function listActiveDeletionRequests(input: {
  env: AppBindings;
  limit?: number;
  userId: string;
}): Promise<{ canOperate: boolean; requests: ActiveDeletionRequestAdminView[] }> {
  const role = await requirePlatformDeletionReader({ env: input.env, userId: input.userId });
  const limit = input.limit ?? 100;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    throw new AppError("validation_failed", 400, ["limit_invalid"]);
  }
  const placeholders = ACTIVE_DELETION_STATUSES.map(() => "?").join(", ");
  const rows = await input.env.PLATFORM_DB.prepare(`
    SELECT requests.id AS deletionRequestId,
      shops.public_id AS shopPublicId,
      shops.name AS shopName,
      requests.status,
      requests.reason_code AS reasonCode,
      requests.grace_ends_at AS graceEndsAt,
      requests.financial_records_retain_until AS financialRecordsRetainUntil,
      requests.legal_hold_until AS legalHoldUntil,
      requests.checkout_blocked_at AS checkoutBlockedAt,
      requests.routing_removed_at AS routingRemovedAt,
      requests.last_safe_error_code AS lastSafeErrorCode,
      requests.version,
      requests.created_at AS createdAt,
      requests.updated_at AS updatedAt
    FROM shop_deletion_requests AS requests
    INNER JOIN shops ON shops.id = requests.shop_id
    WHERE requests.status IN (${placeholders})
    ORDER BY CASE requests.status
      WHEN 'failed' THEN 4
      WHEN 'retention_hold' THEN 3
      WHEN 'blocked' THEN 2
      ELSE 1
    END DESC, requests.updated_at DESC, requests.id DESC
    LIMIT ?
  `).bind(...ACTIVE_DELETION_STATUSES, limit).all<ActiveDeletionAdminRow>();
  return {
    canOperate: role === "owner" || role === "risk",
    requests: rows.results.map(mapActiveDeletionAdmin),
  };
}

export async function getShopDeletion(input: {
  env: AppBindings;
  shopPublicId: string;
  userId: string;
}): Promise<ShopDeletionView | null> {
  const shop = await requireOwnerShop(input);
  const request = await loadRequest(input.env, shop.shopId);
  return request === null ? null : mapDeletion(input.env, request);
}

function deletionStepInsert(input: {
  completed: boolean;
  env: AppBindings;
  nowIso: string;
  requestId: string;
  sequence: number;
  shopId: string;
  stepCode: ShopDeletionStepCode;
}): D1PreparedStatement {
  return input.env.PLATFORM_DB.prepare(`
    INSERT INTO shop_deletion_steps (
      id, request_id, shop_id, step_code, sequence_no, status,
      attempt_count, started_at, completed_at, version, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
  `).bind(
    createId("dst"),
    input.requestId,
    input.shopId,
    input.stepCode,
    input.sequence,
    input.completed ? "completed" : "pending",
    input.completed ? 1 : 0,
    input.completed ? input.nowIso : null,
    input.completed ? input.nowIso : null,
    input.nowIso,
    input.nowIso,
  );
}

export async function requestShopDeletion(input: {
  env: AppBindings;
  reasonCode: ShopDeletionReasonCode;
  requestId: string;
  runtime?: DeletionProviderRuntime;
  shopPublicId: string;
  userId: string;
}): Promise<ShopDeletionView> {
  const shop = await requireOwnerShop(input);
  const existing = await loadRequest(input.env, shop.shopId);
  if (existing !== null && existing.status !== "canceled") {
    if (existing.status === "completed") return mapDeletion(input.env, existing);
    return resumeShopDeletion(input);
  }
  if (shop.status === "archived") throw new AppError("shop_deletion_completed", 409);

  const now = input.runtime?.now ?? new Date();
  const nowIso = now.toISOString();
  const requestId = createId("del");
  const graceEndsAt = new Date(now.getTime() + DELETION_GRACE_MS).toISOString();
  const financialRetainUntil = new Date(now.getTime() + FINANCIAL_RETENTION_MS).toISOString();
  const stepStatements = SHOP_DELETION_STEPS.map((stepCode, index) => deletionStepInsert({
    completed: index < 2,
    env: input.env,
    nowIso,
    requestId,
    sequence: index + 1,
    shopId: shop.shopId,
    stepCode,
  }));

  try {
    const results = await input.env.PLATFORM_DB.batch([
      input.env.PLATFORM_DB.prepare(`
        INSERT INTO shop_deletion_requests (
          id, shop_id, status, reason_code, requested_by_user_id, request_id,
          grace_ends_at, financial_records_retain_until,
          checkout_blocked_at, routing_removed_at, created_at, updated_at
        ) VALUES (?, ?, 'processing', ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).bind(
        requestId,
        shop.shopId,
        input.reasonCode,
        input.userId,
        input.requestId,
        graceEndsAt,
        financialRetainUntil,
        nowIso,
        nowIso,
        nowIso,
        nowIso,
      ),
      input.env.PLATFORM_DB.prepare(`
        UPDATE shops
        SET status = 'suspended', canonical_domain_id = NULL,
          readiness_version = readiness_version + 1, updated_at = ?
        WHERE id = ? AND public_id = ? AND status != 'archived'
      `).bind(nowIso, shop.shopId, input.shopPublicId),
      input.env.PLATFORM_DB.prepare(`
        UPDATE shop_domains
        SET status = 'suspended', is_primary = 0, next_check_at = NULL,
          lease_token = NULL, lease_expires_at = NULL,
          delete_requested_at = CASE WHEN type = 'custom' THEN COALESCE(delete_requested_at, ?) ELSE delete_requested_at END,
          version = version + 1, updated_at = ?
        WHERE shop_id = ? AND deleted_at IS NULL
      `).bind(nowIso, nowIso, shop.shopId),
      ...stepStatements,
      input.env.PLATFORM_DB.prepare(`
        INSERT INTO audit_logs (
          id, shop_id, actor_type, actor_id, action, resource_type,
          resource_id, safe_metadata_json, request_id, source_kind,
          retention_class, created_at
        ) VALUES (?, ?, 'user', ?, 'shop.deletion_requested', 'shop_deletion_request', ?, ?, ?, 'http', 'legal', ?)
      `).bind(
        createId("aud"),
        shop.shopId,
        input.userId,
        requestId,
        JSON.stringify({ graceEndsAt, reasonCode: input.reasonCode }),
        input.requestId,
        nowIso,
      ),
    ]);
    if (results[0]?.meta.changes !== 1 || results[1]?.meta.changes !== 1) {
      throw new AppError("shop_deletion_conflict", 409);
    }
  } catch (error) {
    const replay = await loadRequest(input.env, shop.shopId);
    if (replay !== null && replay.status !== "canceled") return mapDeletion(input.env, replay);
    throw error instanceof AppError ? error : new AppError("shop_deletion_conflict", 409);
  }
  return resumeShopDeletion(input);
}

type DeletionControlReplay = {
  action: "cancel" | "legal_hold_release" | "legal_hold_set";
  actionId: string | null;
  deletionRequestId: string;
  version: number;
};

type StoredIdempotency = { requestHash: string; responseJson: string };

function requireExpectedVersion(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new AppError("validation_failed", 400, ["expected_version_invalid"]);
  }
  return value;
}

function requireIdempotencyKey(value: string | null): string {
  if (value === null || !/^[A-Za-z0-9._:-]{8,128}$/u.test(value)) {
    throw new AppError("validation_failed", 400, ["idempotency_key_invalid"]);
  }
  return value;
}

function requireControlReason(value: unknown): string {
  if (typeof value !== "string" || !SAFE_REASON_CODE.test(value)) {
    throw new AppError("validation_failed", 400, ["reason_code_invalid"]);
  }
  return value;
}

function optionalEvidenceReference(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || !SAFE_EVIDENCE_REFERENCE.test(value)) {
    throw new AppError("validation_failed", 400, ["evidence_reference_invalid"]);
  }
  return value;
}

function requireFutureHoldUntil(value: unknown, now: Date): string {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
    throw new AppError("validation_failed", 400, ["hold_until_invalid"]);
  }
  const normalized = new Date(value).toISOString();
  if (normalized <= now.toISOString()) {
    throw new AppError("validation_failed", 400, ["hold_until_must_be_future"]);
  }
  return normalized;
}

async function findControlIdempotency(input: {
  actorUserId: string;
  env: AppBindings;
  keyHash: string;
  namespace: string;
  nowIso: string;
}): Promise<StoredIdempotency | null> {
  return input.env.PLATFORM_DB.prepare(`
    SELECT request_hash AS requestHash, response_json AS responseJson
    FROM idempotency_records
    WHERE actor_user_id = ? AND namespace = ? AND key_hash = ? AND expires_at > ?
    LIMIT 1
  `).bind(input.actorUserId, input.namespace, input.keyHash, input.nowIso).first<StoredIdempotency>();
}

function parseControlReplay(stored: StoredIdempotency | null, requestHash: string): DeletionControlReplay | null {
  if (stored === null) return null;
  if (stored.requestHash !== requestHash) throw new AppError("idempotency_conflict", 409);
  try {
    const value = JSON.parse(stored.responseJson) as Partial<DeletionControlReplay>;
    if ((value.action !== "cancel" && value.action !== "legal_hold_release" && value.action !== "legal_hold_set")
      || (value.actionId !== null && typeof value.actionId !== "string")
      || typeof value.deletionRequestId !== "string"
      || typeof value.version !== "number") {
      throw new Error("invalid idempotency response");
    }
    return value as DeletionControlReplay;
  } catch {
    throw new AppError("internal_error", 500);
  }
}

async function requirePlatformDeletionOperator(input: {
  env: AppBindings;
  shopPublicId: string;
  userId: string;
}): Promise<{ shopId: string }> {
  const row = await input.env.PLATFORM_DB.prepare(`
    SELECT shops.id AS shopId, platform_admins.role
    FROM platform_admins
    INNER JOIN shops ON shops.public_id = ?
    WHERE platform_admins.user_id = ? AND platform_admins.status = 'active'
    LIMIT 1
  `).bind(input.shopPublicId, input.userId).first<{ role: string; shopId: string }>();
  if (row === null || !new Set(["owner", "risk"]).has(row.role)) {
    throw new AppError("authorization_denied", 403);
  }
  return { shopId: row.shopId };
}

export async function cancelShopDeletion(input: {
  deletionRequestId: string;
  env: AppBindings;
  expectedVersion: number;
  idempotencyKey: string | null;
  now?: Date;
  reasonCode: unknown;
  requestId: string;
  shopPublicId: string;
  userId: string;
}): Promise<ShopDeletionView> {
  const shop = await requireOwnerShop(input);
  const expectedVersion = requireExpectedVersion(input.expectedVersion);
  const reasonCode = requireControlReason(input.reasonCode);
  const idempotencyKey = requireIdempotencyKey(input.idempotencyKey);
  const now = input.now ?? new Date();
  const nowIso = now.toISOString();
  const namespace = "owner.shop-deletion.cancel.v1";
  const keyHash = await hmacToken(input.env.SESSION_SECRET, "idempotency", idempotencyKey);
  const requestHash = await sha256Json({
    deletionRequestId: input.deletionRequestId,
    expectedVersion,
    reasonCode,
    shopPublicId: input.shopPublicId,
  });
  const stored = parseControlReplay(
    await findControlIdempotency({ actorUserId: input.userId, env: input.env, keyHash, namespace, nowIso }),
    requestHash,
  );
  if (stored !== null) {
    const replay = await loadRequestById(input.env, stored.deletionRequestId, shop.shopId);
    if (replay === null) throw new AppError("shop_deletion_not_found", 404);
    return mapDeletion(input.env, replay);
  }
  const preflight = await loadRequestById(input.env, input.deletionRequestId, shop.shopId);
  if (preflight === null) {
    throw new AppError("shop_deletion_not_found", 404);
  }
  if (preflight.version !== expectedVersion) throw new AppError("shop_deletion_cancel_conflict", 409);
  if (preflight.legalHoldUntil !== null && preflight.legalHoldUntil > nowIso) {
    throw new AppError("shop_deletion_cancel_conflict", 409);
  }

  const response: DeletionControlReplay = {
    action: "cancel",
    actionId: null,
    deletionRequestId: input.deletionRequestId,
    version: expectedVersion + 1,
  };
  const controlMarker = `deletion_control_${createOpaqueToken(18)}`;
  const audit = createOperationsAuditEvent({
    action: "shop.deletion_canceled",
    actorId: input.userId,
    actorType: "user",
    metadata: { deletionRequestId: input.deletionRequestId, expectedVersion, reasonCode },
    now,
    operationId: input.deletionRequestId,
    requestId: input.requestId,
    resourceId: input.deletionRequestId,
    resourceType: "shop_deletion_request",
    retentionClass: "legal",
    shopId: shop.shopId,
    sourceKind: "http",
  });
  const results = await input.env.PLATFORM_DB.batch([
    input.env.PLATFORM_DB.prepare(`
      UPDATE shop_deletion_requests
      SET status = 'canceled', legal_hold_until = NULL, last_safe_error_code = ?,
        version = version + 1, updated_at = ?
      WHERE id = ? AND shop_id = ? AND version = ?
        AND status IN ('processing', 'blocked', 'retention_hold', 'failed')
        AND (legal_hold_until IS NULL OR legal_hold_until <= ?)
        AND provider_cleanup_completed_at IS NULL
        AND secret_material_destroyed_at IS NULL AND completed_at IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM shop_deletion_steps
          WHERE request_id = ? AND shop_id = ? AND status = 'processing'
        )
        AND NOT EXISTS (
          SELECT 1 FROM shop_deletion_steps
          WHERE request_id = ? AND shop_id = ?
            AND step_code IN (
              'custom_domain_cleanup', 'telegram_cleanup', 'payment_cleanup',
              'crypto_shred', 'finalize'
            )
            AND status IN ('processing', 'completed')
        )
    `).bind(
      controlMarker,
      nowIso,
      input.deletionRequestId,
      shop.shopId,
      expectedVersion,
      nowIso,
      input.deletionRequestId,
      shop.shopId,
      input.deletionRequestId,
      shop.shopId,
    ),
    input.env.PLATFORM_DB.prepare(`
      UPDATE shop_deletion_steps
      SET status = 'skipped', lease_token = NULL, lease_expires_at = NULL,
        last_safe_error_code = NULL, completed_at = COALESCE(completed_at, ?),
        version = version + 1, updated_at = ?
      WHERE request_id = ? AND shop_id = ? AND status IN ('pending', 'blocked', 'failed')
        AND EXISTS (
          SELECT 1 FROM shop_deletion_requests
          WHERE id = ? AND shop_id = ? AND status = 'canceled'
            AND version = ? AND updated_at = ? AND last_safe_error_code = ?
        )
    `).bind(
      nowIso,
      nowIso,
      input.deletionRequestId,
      shop.shopId,
      input.deletionRequestId,
      shop.shopId,
      response.version,
      nowIso,
      controlMarker,
    ),
    prepareOperationsAuditForDeletionRequestVersion(input.env, audit, {
      controlMarker,
      requestId: input.deletionRequestId,
      shopId: shop.shopId,
      updatedAt: nowIso,
      version: response.version,
    }),
    input.env.PLATFORM_DB.prepare(`
      INSERT INTO idempotency_records (
        actor_user_id, namespace, key_hash, request_hash, response_json, created_at, expires_at
      )
      SELECT ?, ?, ?, ?, ?, ?, ?
      WHERE EXISTS (
        SELECT 1 FROM shop_deletion_requests
        WHERE id = ? AND shop_id = ? AND status = 'canceled'
          AND version = ? AND updated_at = ? AND last_safe_error_code = ?
      )
    `).bind(
      input.userId,
      namespace,
      keyHash,
      requestHash,
      JSON.stringify(response),
      nowIso,
      new Date(now.getTime() + IDEMPOTENCY_TTL_MS).toISOString(),
      input.deletionRequestId,
      shop.shopId,
      response.version,
      nowIso,
      controlMarker,
    ),
    input.env.PLATFORM_DB.prepare(`
      UPDATE shop_deletion_requests
      SET last_safe_error_code = NULL
      WHERE id = ? AND shop_id = ? AND status = 'canceled'
        AND version = ? AND updated_at = ? AND last_safe_error_code = ?
    `).bind(
      input.deletionRequestId,
      shop.shopId,
      response.version,
      nowIso,
      controlMarker,
    ),
  ]);
  if (results[0]?.meta.changes !== 1 || results[2]?.meta.changes !== 1
    || results[3]?.meta.changes !== 1 || results[4]?.meta.changes !== 1) {
    const raced = parseControlReplay(
      await findControlIdempotency({ actorUserId: input.userId, env: input.env, keyHash, namespace, nowIso }),
      requestHash,
    );
    if (raced === null) throw new AppError("shop_deletion_cancel_conflict", 409);
  }
  const current = await loadRequestById(input.env, input.deletionRequestId, shop.shopId);
  if (current === null) throw new AppError("shop_deletion_not_found", 404);
  return mapDeletion(input.env, current);
}

export async function applyDeletionLegalHold(input: {
  action: "release" | "set";
  actorUserId: string;
  deletionRequestId: string;
  env: AppBindings;
  evidenceReference?: unknown;
  expectedVersion: number;
  holdUntil?: unknown;
  idempotencyKey: string | null;
  now?: Date;
  reasonCode: unknown;
  requestId: string;
  shopPublicId: string;
}): Promise<DeletionLegalHoldView> {
  const shop = await requirePlatformDeletionOperator({
    env: input.env,
    shopPublicId: input.shopPublicId,
    userId: input.actorUserId,
  });
  const expectedVersion = requireExpectedVersion(input.expectedVersion);
  const reasonCode = requireControlReason(input.reasonCode);
  const evidenceReference = optionalEvidenceReference(input.evidenceReference);
  const idempotencyKey = requireIdempotencyKey(input.idempotencyKey);
  const now = input.now ?? new Date();
  const nowIso = now.toISOString();
  const holdUntil = input.action === "set" ? requireFutureHoldUntil(input.holdUntil, now) : null;
  const namespace = "admin.shop-deletion.legal-hold.v1";
  const keyHash = await hmacToken(input.env.SESSION_SECRET, "idempotency", idempotencyKey);
  const requestHash = await sha256Json({
    action: input.action,
    deletionRequestId: input.deletionRequestId,
    evidenceReference,
    expectedVersion,
    holdUntil,
    reasonCode,
    shopPublicId: input.shopPublicId,
  });
  const replay = parseControlReplay(
    await findControlIdempotency({ actorUserId: input.actorUserId, env: input.env, keyHash, namespace, nowIso }),
    requestHash,
  );
  if (replay !== null) {
    return {
      action: replay.action === "legal_hold_set" ? "set" : "release",
      actionId: replay.actionId ?? "",
      deletionRequestId: replay.deletionRequestId,
      holdUntil,
      status: "applied",
      version: replay.version,
    };
  }
  const current = await loadRequestById(input.env, input.deletionRequestId, shop.shopId);
  if (current === null) {
    throw new AppError("shop_deletion_not_found", 404);
  }
  if (current.version !== expectedVersion) throw new AppError("shop_deletion_legal_hold_conflict", 409);

  const actionId = createId("mod");
  const controlMarker = `deletion_control_${createOpaqueToken(18)}`;
  const version = expectedVersion + 1;
  const response: DeletionLegalHoldView = {
    action: input.action,
    actionId,
    deletionRequestId: input.deletionRequestId,
    holdUntil,
    status: "applied",
    version,
  };
  const storedResponse: DeletionControlReplay = {
    action: input.action === "set" ? "legal_hold_set" : "legal_hold_release",
    actionId,
    deletionRequestId: input.deletionRequestId,
    version,
  };
  const audit = createOperationsAuditEvent({
    action: input.action === "set" ? "shop.deletion_legal_hold_set" : "shop.deletion_legal_hold_released",
    actorId: input.actorUserId,
    actorType: "platform_admin",
    metadata: {
      deletionRequestId: input.deletionRequestId,
      ...(evidenceReference === null ? {} : { evidenceReference }),
      expectedVersion,
      ...(holdUntil === null ? {} : { holdUntil }),
      reasonCode,
    },
    now,
    operationId: actionId,
    requestId: input.requestId,
    resourceId: input.deletionRequestId,
    resourceType: "shop_deletion_request",
    retentionClass: "legal",
    shopId: shop.shopId,
    sourceKind: "http",
  });
  const activeStatuses = ACTIVE_DELETION_STATUSES.map(() => "?").join(", ");
  const results = await input.env.PLATFORM_DB.batch([
    input.env.PLATFORM_DB.prepare(`
      UPDATE shop_deletion_requests
      SET legal_hold_until = ?,
        status = CASE WHEN ? IS NULL THEN 'processing' ELSE 'retention_hold' END,
        last_safe_error_code = ?,
        version = version + 1, updated_at = ?
      WHERE id = ? AND shop_id = ? AND version = ?
        AND status IN (${activeStatuses})
        AND secret_material_destroyed_at IS NULL AND completed_at IS NULL
        AND (
          ? = 'release'
          OR NOT EXISTS (
            SELECT 1 FROM shop_deletion_steps AS provider_step
            WHERE provider_step.request_id = shop_deletion_requests.id
              AND provider_step.shop_id = shop_deletion_requests.shop_id
              AND provider_step.step_code IN ('custom_domain_cleanup', 'telegram_cleanup', 'payment_cleanup')
              AND provider_step.status = 'processing'
              AND provider_step.lease_expires_at > ?
          )
          AND NOT EXISTS (
            SELECT 1 FROM shop_deletion_steps AS destructive_step
            WHERE destructive_step.request_id = shop_deletion_requests.id
              AND destructive_step.shop_id = shop_deletion_requests.shop_id
              AND destructive_step.step_code = 'crypto_shred'
              AND destructive_step.last_safe_error_code = ?
          )
        )
        AND (? IS NOT NULL OR legal_hold_until IS NOT NULL)
    `).bind(
      holdUntil,
      holdUntil,
      controlMarker,
      nowIso,
      input.deletionRequestId,
      shop.shopId,
      expectedVersion,
      ...ACTIVE_DELETION_STATUSES,
      input.action,
      nowIso,
      CRYPTO_SHRED_DESTRUCTIVE_MARKER,
      input.action === "release" ? null : holdUntil,
    ),
    input.env.PLATFORM_DB.prepare(`
      INSERT INTO moderation_actions (
        id, shop_id, action_kind, target_kind, target_ref, status,
        safe_reason_code, safe_metadata_json, actor_admin_user_id, request_id,
        retention_class, retain_until, applied_at, created_at, updated_at
      )
      SELECT ?, ?, ?, 'deletion_request', ?, 'applied', ?, ?, ?, ?,
        'legal', ?, ?, ?, ?
      WHERE EXISTS (
        SELECT 1 FROM shop_deletion_requests
        WHERE id = ? AND shop_id = ? AND version = ? AND updated_at = ?
          AND last_safe_error_code = ?
      )
    `).bind(
      actionId,
      shop.shopId,
      input.action === "set" ? "legal_hold_set" : "legal_hold_release",
      input.deletionRequestId,
      reasonCode,
      JSON.stringify({
        ...(evidenceReference === null ? {} : { evidenceReference }),
        ...(holdUntil === null ? {} : { holdUntil }),
      }),
      input.actorUserId,
      input.requestId,
      new Date(now.getTime() + FINANCIAL_RETENTION_MS).toISOString(),
      nowIso,
      nowIso,
      nowIso,
      input.deletionRequestId,
      shop.shopId,
      version,
      nowIso,
      controlMarker,
    ),
    prepareOperationsAuditForDeletionRequestVersion(input.env, audit, {
      controlMarker,
      requestId: input.deletionRequestId,
      shopId: shop.shopId,
      updatedAt: nowIso,
      version,
    }),
    input.env.PLATFORM_DB.prepare(`
      INSERT INTO idempotency_records (
        actor_user_id, namespace, key_hash, request_hash, response_json, created_at, expires_at
      )
      SELECT ?, ?, ?, ?, ?, ?, ?
      WHERE EXISTS (
        SELECT 1 FROM moderation_actions
        WHERE id = ? AND shop_id = ? AND status = 'applied'
      )
    `).bind(
      input.actorUserId,
      namespace,
      keyHash,
      requestHash,
      JSON.stringify(storedResponse),
      nowIso,
      new Date(now.getTime() + IDEMPOTENCY_TTL_MS).toISOString(),
      actionId,
      shop.shopId,
    ),
    input.env.PLATFORM_DB.prepare(`
      UPDATE shop_deletion_requests
      SET last_safe_error_code = ?
      WHERE id = ? AND shop_id = ? AND version = ? AND updated_at = ?
        AND last_safe_error_code = ?
        AND EXISTS (
          SELECT 1 FROM moderation_actions
          WHERE id = ? AND shop_id = ? AND status = 'applied'
        )
    `).bind(
      input.action === "set" ? "legal_hold_active" : null,
      input.deletionRequestId,
      shop.shopId,
      version,
      nowIso,
      controlMarker,
      actionId,
      shop.shopId,
    ),
  ]);
  if (results[0]?.meta.changes !== 1 || results[1]?.meta.changes !== 1
    || results[2]?.meta.changes !== 1 || results[3]?.meta.changes !== 1
    || results[4]?.meta.changes !== 1) {
    const raced = parseControlReplay(
      await findControlIdempotency({ actorUserId: input.actorUserId, env: input.env, keyHash, namespace, nowIso }),
      requestHash,
    );
    if (raced === null) throw new AppError("shop_deletion_legal_hold_conflict", 409);
  }
  return response;
}

async function claimStep(input: {
  env: AppBindings;
  now: Date;
  request: DeletionRequestRow;
  sequence: number;
  stepCode: ShopDeletionStepCode;
}): Promise<string | null> {
  const leaseToken = createOpaqueToken(18);
  const nowIso = input.now.toISOString();
  const result = await input.env.PLATFORM_DB.prepare(`
    UPDATE shop_deletion_steps
    SET status = 'processing', attempt_count = attempt_count + 1,
      lease_token = ?, lease_expires_at = ?, started_at = COALESCE(started_at, ?),
      last_safe_error_code = CASE
        WHEN step_code = 'crypto_shred' AND last_safe_error_code = ? THEN last_safe_error_code
        ELSE NULL
      END,
      version = version + 1, updated_at = ?
    WHERE request_id = ? AND shop_id = ? AND step_code = ? AND sequence_no = ?
      AND (
        status IN ('pending', 'blocked', 'failed')
        OR (status = 'processing' AND lease_expires_at <= ?)
      )
      AND NOT EXISTS (
        SELECT 1 FROM shop_deletion_steps AS prior
        WHERE prior.request_id = ? AND prior.shop_id = ?
          AND prior.sequence_no < ? AND prior.status NOT IN ('completed', 'skipped')
      )
      AND EXISTS (
        SELECT 1 FROM shop_deletion_requests AS active_request
        WHERE active_request.id = ? AND active_request.shop_id = ?
          AND active_request.status IN ('processing', 'blocked', 'retention_hold', 'failed')
          AND (
            ? NOT IN ('custom_domain_cleanup', 'telegram_cleanup', 'payment_cleanup', 'crypto_shred', 'finalize')
            OR active_request.legal_hold_until IS NULL
            OR active_request.legal_hold_until <= ?
          )
      )
  `).bind(
    leaseToken,
    new Date(input.now.getTime() + STEP_LEASE_MS).toISOString(),
    nowIso,
    CRYPTO_SHRED_DESTRUCTIVE_MARKER,
    nowIso,
    input.request.id,
    input.request.shopId,
    input.stepCode,
    input.sequence,
    nowIso,
    input.request.id,
    input.request.shopId,
    input.sequence,
    input.request.id,
    input.request.shopId,
    input.stepCode,
    nowIso,
  ).run();
  return result.meta.changes === 1 ? leaseToken : null;
}

async function completeStep(input: {
  env: AppBindings;
  leaseToken: string;
  now: Date;
  request: DeletionRequestRow;
  stepCode: ShopDeletionStepCode;
}): Promise<void> {
  const nowIso = input.now.toISOString();
  const result = await input.env.PLATFORM_DB.prepare(`
    UPDATE shop_deletion_steps
    SET status = 'completed', lease_token = NULL, lease_expires_at = NULL,
      last_safe_error_code = NULL, completed_at = ?, version = version + 1, updated_at = ?
    WHERE request_id = ? AND shop_id = ? AND step_code = ?
      AND status = 'processing' AND lease_token = ?
      AND (
        ? NOT IN ('custom_domain_cleanup', 'telegram_cleanup', 'payment_cleanup', 'crypto_shred', 'finalize')
        OR EXISTS (
          SELECT 1 FROM shop_deletion_requests AS hold_request
          WHERE hold_request.id = ? AND hold_request.shop_id = ?
            AND (hold_request.legal_hold_until IS NULL OR hold_request.legal_hold_until <= ?)
        )
      )
  `).bind(
    nowIso,
    nowIso,
    input.request.id,
    input.request.shopId,
    input.stepCode,
    input.leaseToken,
    input.stepCode,
    input.request.id,
    input.request.shopId,
    nowIso,
  ).run();
  if (result.meta.changes !== 1) throw new AppError("shop_deletion_lease_lost", 409);
  await input.env.PLATFORM_DB.prepare(`
    UPDATE shop_deletion_requests
    SET status = CASE
          WHEN legal_hold_until IS NOT NULL AND legal_hold_until > ? THEN 'retention_hold'
          ELSE 'processing'
        END,
      last_safe_error_code = CASE
          WHEN legal_hold_until IS NOT NULL AND legal_hold_until > ? THEN 'legal_hold_active'
          ELSE NULL
        END,
      version = version + 1, updated_at = ?
    WHERE id = ? AND shop_id = ?
      AND status IN ('processing', 'blocked', 'retention_hold', 'failed')
      AND EXISTS (
        SELECT 1 FROM shop_deletion_steps
        WHERE request_id = ? AND shop_id = ? AND step_code = ?
          AND status = 'completed' AND completed_at = ?
      )
  `).bind(
    nowIso,
    nowIso,
    nowIso,
    input.request.id,
    input.request.shopId,
    input.request.id,
    input.request.shopId,
    input.stepCode,
    nowIso,
  ).run();
}

async function blockStep(input: {
  code: string;
  env: AppBindings;
  leaseToken: string;
  now: Date;
  request: DeletionRequestRow;
  requestStatus: "blocked" | "retention_hold";
  stepCode: ShopDeletionStepCode;
}): Promise<void> {
  const nowIso = input.now.toISOString();
  await input.env.PLATFORM_DB.batch([
    input.env.PLATFORM_DB.prepare(`
      UPDATE shop_deletion_steps
      SET status = 'blocked', lease_token = NULL, lease_expires_at = NULL,
        last_safe_error_code = ?, version = version + 1, updated_at = ?
      WHERE request_id = ? AND shop_id = ? AND step_code = ?
        AND status = 'processing' AND lease_token = ?
    `).bind(input.code, nowIso, input.request.id, input.request.shopId, input.stepCode, input.leaseToken),
    input.env.PLATFORM_DB.prepare(`
      UPDATE shop_deletion_requests
      SET status = ?, last_safe_error_code = ?, version = version + 1, updated_at = ?
      WHERE id = ? AND shop_id = ?
        AND status IN ('processing', 'blocked', 'retention_hold', 'failed')
        AND EXISTS (
          SELECT 1 FROM shop_deletion_steps
          WHERE request_id = ? AND shop_id = ? AND step_code = ?
            AND status = 'blocked' AND last_safe_error_code = ? AND updated_at = ?
        )
    `).bind(
      input.requestStatus,
      input.code,
      nowIso,
      input.request.id,
      input.request.shopId,
      input.request.id,
      input.request.shopId,
      input.stepCode,
      input.code,
      nowIso,
    ),
  ]);
}

async function failStep(input: {
  code: string;
  env: AppBindings;
  leaseToken: string;
  now: Date;
  request: DeletionRequestRow;
  stepCode: ShopDeletionStepCode;
}): Promise<void> {
  const nowIso = input.now.toISOString();
  await input.env.PLATFORM_DB.batch([
    input.env.PLATFORM_DB.prepare(`
      UPDATE shop_deletion_steps
      SET status = 'failed', lease_token = NULL, lease_expires_at = NULL,
        last_safe_error_code = CASE
          WHEN step_code = 'crypto_shred' AND last_safe_error_code = ? THEN last_safe_error_code
          ELSE ?
        END,
        version = version + 1, updated_at = ?
      WHERE request_id = ? AND shop_id = ? AND step_code = ?
        AND status = 'processing' AND lease_token = ?
    `).bind(
      CRYPTO_SHRED_DESTRUCTIVE_MARKER,
      input.code,
      nowIso,
      input.request.id,
      input.request.shopId,
      input.stepCode,
      input.leaseToken,
    ),
    input.env.PLATFORM_DB.prepare(`
      UPDATE shop_deletion_requests
      SET status = 'failed', last_safe_error_code = ?, version = version + 1, updated_at = ?
      WHERE id = ? AND shop_id = ?
        AND status IN ('processing', 'blocked', 'retention_hold', 'failed')
        AND EXISTS (
          SELECT 1 FROM shop_deletion_steps
          WHERE request_id = ? AND shop_id = ? AND step_code = ?
            AND status = 'failed' AND updated_at = ?
            AND (
              last_safe_error_code = ?
              OR (? = 'crypto_shred' AND last_safe_error_code = ?)
            )
        )
    `).bind(
      input.code,
      nowIso,
      input.request.id,
      input.request.shopId,
      input.request.id,
      input.request.shopId,
      input.stepCode,
      nowIso,
      input.code,
      input.stepCode,
      CRYPTO_SHRED_DESTRUCTIVE_MARKER,
    ),
  ]);
}

async function hasActivePaymentState(env: AppBindings, shopId: string, nowIso: string): Promise<boolean> {
  const row = await env.PLATFORM_DB.prepare(`
    SELECT payment_attempts.id
    FROM payment_attempts
    WHERE payment_attempts.shop_id = ?
      AND (
        (payment_attempts.state IN ('creating', 'pending', 'error') AND payment_attempts.expires_at > ?)
        OR payment_attempts.state IN ('partial', 'overpaid', 'late', 'identity_mismatch', 'inconsistent')
      )
    UNION ALL
    SELECT orders.id
    FROM orders
    WHERE orders.shop_id = ?
      AND orders.status = 'pending_payment'
      AND orders.payment_status IN ('unpaid', 'pending')
      AND orders.expires_at > ?
    UNION ALL
    SELECT payment_exceptions.id
    FROM payment_exceptions
    WHERE payment_exceptions.shop_id = ? AND payment_exceptions.status = 'open'
    LIMIT 1
  `).bind(shopId, nowIso, shopId, nowIso, shopId).first<{ id: string }>();
  return row !== null;
}

function cloudflareProvider(env: AppBindings, fetcher?: typeof fetch): CloudflareSaaSClient {
  const bindings = env as Partial<DeletionBindings>;
  if (
    typeof bindings.CLOUDFLARE_API_TOKEN !== "string"
    || bindings.CLOUDFLARE_API_TOKEN.length === 0
    || typeof bindings.CLOUDFLARE_ZONE_ID !== "string"
    || bindings.CLOUDFLARE_ZONE_ID.length === 0
  ) {
    throw new AppError("cloudflare_config_invalid", 500);
  }
  return new CloudflareSaaSClient(bindings.CLOUDFLARE_API_TOKEN, bindings.CLOUDFLARE_ZONE_ID, fetcher);
}

async function cleanupCustomDomains(input: {
  env: AppBindings;
  fetcher?: typeof fetch;
  leaseToken: string;
  now: Date;
  requestId: string;
  shopId: string;
}): Promise<void> {
  const context: ProviderCleanupContext = {
    env: input.env,
    leaseToken: input.leaseToken,
    now: input.now,
    requestId: input.requestId,
    shopId: input.shopId,
  };
  await assertProviderCleanupFence(context, "custom_domain_cleanup");
  const rows = await input.env.PLATFORM_DB.prepare(`
    SELECT id, cloudflare_hostname_id AS cloudflareHostnameId
    FROM shop_domains
    WHERE shop_id = ? AND type = 'custom' AND deleted_at IS NULL
    ORDER BY created_at, id
  `).bind(input.shopId).all<{ cloudflareHostnameId: string | null; id: string }>();
  const provider = rows.results.some((row) => row.cloudflareHostnameId !== null)
    ? cloudflareProvider(input.env, input.fetcher)
    : null;
  for (const row of rows.results) {
    await assertProviderCleanupFence(context, "custom_domain_cleanup");
    if (row.cloudflareHostnameId !== null && provider !== null) {
      try {
        await provider.deleteCustomHostname(row.cloudflareHostnameId);
      } catch (error) {
        if (!(error instanceof CloudflareProviderError && error.code === "cloudflare_hostname_not_found")) {
          throw error;
        }
      }
    }
    const nowIso = input.now.toISOString();
    const updated = await input.env.PLATFORM_DB.prepare(`
      UPDATE shop_domains
      SET status = 'deleted', is_primary = 0, cloudflare_hostname_id = NULL,
        deleted_at = COALESCE(deleted_at, ?), next_check_at = NULL,
        lease_token = NULL, lease_expires_at = NULL, last_safe_error_code = NULL,
        version = version + 1, updated_at = ?
      WHERE id = ? AND shop_id = ? AND type = 'custom' AND deleted_at IS NULL
        AND ${PROVIDER_CLEANUP_FENCE}
    `).bind(
      nowIso,
      nowIso,
      row.id,
      input.shopId,
      ...providerCleanupFenceValues(context, "custom_domain_cleanup"),
    ).run();
    if (updated.meta.changes !== 1) throw new AppError("shop_deletion_lease_lost", 409);
  }
}

async function cleanupTelegram(input: {
  env: AppBindings;
  fetcher?: typeof fetch;
  leaseToken: string;
  now: Date;
  requestId: string;
  shopId: string;
}): Promise<void> {
  const context: ProviderCleanupContext = {
    env: input.env,
    leaseToken: input.leaseToken,
    now: input.now,
    requestId: input.requestId,
    shopId: input.shopId,
  };
  await assertProviderCleanupFence(context, "telegram_cleanup");
  const integration = await input.env.PLATFORM_DB.prepare(`
    SELECT id, active_credential_id AS activeCredentialId,
      generation_state AS generationState, integration_generation AS integrationGeneration,
      status
    FROM telegram_integrations WHERE shop_id = ? LIMIT 1
  `).bind(input.shopId).first<{
    activeCredentialId: string | null;
    generationState: "active" | "draining";
    id: string;
    integrationGeneration: number;
    status: string;
  }>();
  if (integration === null) return;
  const nowIso = input.now.toISOString();
  const fenceValues = providerCleanupFenceValues(context, "telegram_cleanup");
  if (integration.activeCredentialId !== null) {
    try {
      await assertProviderCleanupFence(context, "telegram_cleanup");
      const credential = await loadActiveTelegramCredential(input.env, integration.id, input.shopId);
      await assertProviderCleanupFence(context, "telegram_cleanup");
      await new TelegramClient(credential.credentials.botToken, input.fetcher).deleteWebhook(false);
    } catch (error) {
      // An unauthorized token is already unusable; transient/provider/config failures must retry.
      if (!(error instanceof TelegramProviderError && error.code === "telegram_unauthorized")) {
        throw error;
      }
    }
    if (integration.generationState !== "draining") {
      const drained = await input.env.PLATFORM_DB.prepare(`
        UPDATE telegram_integrations
        SET generation_state = 'draining', updated_at = ?
        WHERE id = ? AND shop_id = ?
          AND generation_state = 'active'
          AND integration_generation = ?
          AND active_credential_id IS ?
          AND NOT EXISTS (
            SELECT 1 FROM telegram_updates
            WHERE telegram_updates.integration_id = telegram_integrations.id
              AND telegram_updates.shop_id = telegram_integrations.shop_id
              AND telegram_updates.integration_generation = telegram_integrations.integration_generation
              AND telegram_updates.status = 'processing'
          )
          AND ${PROVIDER_CLEANUP_FENCE}
      `).bind(
        nowIso,
        integration.id,
        input.shopId,
        integration.integrationGeneration,
        integration.activeCredentialId,
        ...fenceValues,
      ).run();
      if (drained.meta.changes !== 1) throw new AppError("telegram_integration_busy", 409, ["retry"]);
    }
  }
  await input.env.PLATFORM_DB.batch([
    input.env.PLATFORM_DB.prepare(`
      UPDATE telegram_integrations
      SET status = 'disabled', webhook_status = 'disabled', active_credential_id = NULL,
        integration_generation = CASE
          WHEN active_credential_id IS NULL THEN integration_generation
          ELSE integration_generation + 1
        END,
        generation_state = 'active', last_safe_error_code = NULL, updated_at = ?
      WHERE id = ? AND shop_id = ?
        AND (
          (active_credential_id IS NULL AND generation_state = 'active')
          OR (
            generation_state = 'draining'
            AND integration_generation = ?
            AND active_credential_id IS ?
          )
        )
        AND ${PROVIDER_CLEANUP_FENCE}
    `).bind(
      nowIso,
      integration.id,
      input.shopId,
      integration.integrationGeneration,
      integration.activeCredentialId,
      ...fenceValues,
    ),
    input.env.PLATFORM_DB.prepare(`
      UPDATE telegram_credentials
      SET status = 'revoked', revoked_at = COALESCE(revoked_at, ?)
      WHERE integration_id = ? AND shop_id = ? AND status IN ('active', 'pending', 'error')
        AND ${PROVIDER_CLEANUP_FENCE}
    `).bind(nowIso, integration.id, input.shopId, ...fenceValues),
    input.env.PLATFORM_DB.prepare(`
      UPDATE telegram_updates
      SET status = 'rejected', safe_result_code = 'telegram_update_stale_generation',
        processed_at = COALESCE(processed_at, ?), updated_at = ?
      WHERE integration_id = ? AND shop_id = ? AND integration_generation = ?
        AND status IN ('accepted', 'failed', 'processing')
        AND ${PROVIDER_CLEANUP_FENCE}
    `).bind(nowIso, nowIso, integration.id, input.shopId, integration.integrationGeneration, ...fenceValues),
  ]);
  await assertProviderCleanupFence(context, "telegram_cleanup");
}

async function cleanupGenericChannels(input: {
  env: AppBindings;
  leaseToken: string;
  now: Date;
  request: DeletionRequestRow;
}): Promise<void> {
  const nowIso = input.now.toISOString();
  const eligibilityGuard = PROVIDER_CLEANUP_FENCE;
  const guardValues = providerCleanupFenceValues({
    env: input.env,
    leaseToken: input.leaseToken,
    now: input.now,
    requestId: input.request.id,
    shopId: input.request.shopId,
  }, "telegram_cleanup");
  await input.env.PLATFORM_DB.batch([
    input.env.PLATFORM_DB.prepare(`
      UPDATE channel_credentials
      SET status = 'revoked', grace_ends_at = NULL,
        revoked_at = COALESCE(revoked_at, ?)
      WHERE shop_id = ? AND status IN ('pending', 'active', 'grace', 'error')
        AND ${eligibilityGuard}
    `).bind(nowIso, input.request.shopId, ...guardValues),
    input.env.PLATFORM_DB.prepare(`
      UPDATE channel_connections
      SET status = 'disconnected', disconnected_at = COALESCE(disconnected_at, ?),
        last_safe_error_code = NULL, version = version + 1, updated_at = ?
      WHERE shop_id = ? AND status IN ('pending', 'active', 'degraded')
        AND ${eligibilityGuard}
    `).bind(nowIso, nowIso, input.request.shopId, ...guardValues),
    input.env.PLATFORM_DB.prepare(`
      UPDATE shop_channels
      SET status = 'disabled', version = version + 1, updated_at = ?
      WHERE shop_id = ? AND status != 'disabled' AND ${eligibilityGuard}
    `).bind(nowIso, input.request.shopId, ...guardValues),
  ]);
}

async function cleanupPayment(input: {
  env: AppBindings;
  leaseToken: string;
  now: Date;
  requestId: string;
  shopId: string;
}): Promise<void> {
  const context: ProviderCleanupContext = {
    env: input.env,
    leaseToken: input.leaseToken,
    now: input.now,
    requestId: input.requestId,
    shopId: input.shopId,
  };
  await assertProviderCleanupFence(context, "payment_cleanup");
  const nowIso = input.now.toISOString();
  await input.env.PLATFORM_DB.batch([
    input.env.PLATFORM_DB.prepare(`
      UPDATE payment_integrations
      SET status = 'disconnected', webhook_status = 'disconnected',
        active_credential_id = NULL, last_safe_error_code = NULL, updated_at = ?
      WHERE shop_id = ? AND ${PROVIDER_CLEANUP_FENCE}
    `).bind(nowIso, input.shopId, ...providerCleanupFenceValues(context, "payment_cleanup")),
    input.env.PLATFORM_DB.prepare(`
      UPDATE payment_credentials
      SET status = 'revoked', grace_ends_at = NULL, revoked_at = COALESCE(revoked_at, ?)
      WHERE shop_id = ? AND status IN ('active', 'pending', 'grace', 'error')
        AND ${PROVIDER_CLEANUP_FENCE}
    `).bind(nowIso, input.shopId, ...providerCleanupFenceValues(context, "payment_cleanup")),
    input.env.PLATFORM_DB.prepare(`
      UPDATE payment_provider_connection_capabilities
      SET provider_granted = 0, effective_enabled = 0,
        evidence_reference = NULL, revoked_at = COALESCE(revoked_at, ?),
        evaluated_at = ?
      WHERE shop_id = ?
        AND (
          provider_granted != 0 OR effective_enabled != 0
          OR evidence_reference IS NOT NULL OR revoked_at IS NULL
        )
        AND ${PROVIDER_CLEANUP_FENCE}
    `).bind(
      nowIso,
      nowIso,
      input.shopId,
      ...providerCleanupFenceValues(context, "payment_cleanup"),
    ),
    input.env.PLATFORM_DB.prepare(`
      UPDATE payment_provider_connection_currencies
      SET effective_enabled = 0,
        evidence_reference = NULL, evaluated_at = ?
      WHERE shop_id = ?
        AND (
          effective_enabled != 0
          OR evidence_reference IS NOT NULL
        )
        AND ${PROVIDER_CLEANUP_FENCE}
    `).bind(nowIso, input.shopId, ...providerCleanupFenceValues(context, "payment_cleanup")),
    input.env.PLATFORM_DB.prepare(`
      UPDATE payment_provider_connection_methods
      SET effective_enabled = 0,
        evidence_reference = NULL, evaluated_at = ?
      WHERE shop_id = ?
        AND (
          effective_enabled != 0
          OR evidence_reference IS NOT NULL
        )
        AND ${PROVIDER_CLEANUP_FENCE}
    `).bind(nowIso, input.shopId, ...providerCleanupFenceValues(context, "payment_cleanup")),
    input.env.PLATFORM_DB.prepare(`
      UPDATE payment_provider_connections
      SET status = 'disconnected', webhook_status = 'disconnected',
        last_safe_error_code = NULL,
        disconnected_at = COALESCE(disconnected_at, ?),
        version = version + 1, updated_at = ?
      WHERE shop_id = ?
        AND (
          status != 'disconnected' OR webhook_status != 'disconnected'
          OR last_safe_error_code IS NOT NULL OR disconnected_at IS NULL
        )
        AND ${PROVIDER_CLEANUP_FENCE}
    `).bind(
      nowIso,
      nowIso,
      input.shopId,
      ...providerCleanupFenceValues(context, "payment_cleanup"),
    ),
  ]);
  await assertProviderCleanupFence(context, "payment_cleanup");
}

async function cryptoShred(input: {
  env: AppBindings;
  leaseToken: string;
  now: Date;
  request: DeletionRequestRow;
}): Promise<void> {
  const nowIso = input.now.toISOString();
  const destructiveMarkerPresent = await input.env.PLATFORM_DB.prepare(`
    SELECT 1 AS present
    FROM shop_deletion_steps
    WHERE request_id = ? AND shop_id = ? AND step_code = 'crypto_shred'
      AND last_safe_error_code = ?
    LIMIT 1
  `).bind(
    input.request.id,
    input.request.shopId,
    CRYPTO_SHRED_DESTRUCTIVE_MARKER,
  ).first<{ present: number }>();
  if (destructiveMarkerPresent === null) {
    const activeGeneratedRequest = await input.env.PLATFORM_DB.prepare(`
      SELECT id
      FROM generated_license_requests
      WHERE shop_id = ? AND status = 'processing' AND lease_expires_at > ?
      LIMIT 1
    `).bind(input.request.shopId, nowIso).first<{ id: string }>();
    if (activeGeneratedRequest !== null) {
      throw new AppError("shop_deletion_generated_license_work_inflight", 409);
    }
  }
  const eligibilityGuard = `
    EXISTS (
      SELECT 1
      FROM shop_deletion_steps AS owned_step
      INNER JOIN shop_deletion_requests AS owned_request
        ON owned_request.id = owned_step.request_id
        AND owned_request.shop_id = owned_step.shop_id
      WHERE owned_step.request_id = ? AND owned_step.shop_id = ?
        AND owned_step.step_code = 'crypto_shred'
        AND owned_step.status = 'processing' AND owned_step.lease_token = ?
        AND owned_request.status IN ('processing', 'blocked', 'retention_hold', 'failed')
        AND owned_request.grace_ends_at <= ?
        AND (owned_request.legal_hold_until IS NULL OR owned_request.legal_hold_until <= ?)
        AND owned_request.provider_cleanup_completed_at IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM domain_events AS active_event
          WHERE active_event.shop_id = owned_request.shop_id
            AND active_event.status = 'processing'
            AND active_event.lease_expires_at > ?
        )
        AND NOT EXISTS (
          SELECT 1 FROM delivery_jobs AS active_job
          WHERE active_job.shop_id = owned_request.shop_id
            AND active_job.status = 'processing'
            AND active_job.lease_expires_at > ?
        )
        AND NOT EXISTS (
          SELECT 1 FROM generated_license_requests AS active_generated_request
          WHERE active_generated_request.shop_id = owned_request.shop_id
            AND active_generated_request.status = 'processing'
            AND active_generated_request.lease_expires_at > ?
        )
    )
  `;
  const guardValues = [
    input.request.id,
    input.request.shopId,
    input.leaseToken,
    nowIso,
    nowIso,
    nowIso,
    nowIso,
    nowIso,
  ] as const;
  const assertFence = async (): Promise<void> => {
    const eligible = await input.env.PLATFORM_DB.prepare(`
      SELECT 1 AS eligible WHERE ${eligibilityGuard}
    `).bind(...guardValues).first<{ eligible: number }>();
    if (eligible === null) throw new AppError("shop_deletion_lease_lost", 409);
  };
  await assertFence();
  const privateExports = exportBindings(input.env).PRIVATE_EXPORTS;

  const privateAssetVersions = (await input.env.PLATFORM_DB.prepare(`
    SELECT id, asset_id AS assetId, object_key AS objectKey
    FROM digital_asset_versions
    WHERE shop_id = ? AND status != 'deleted'
    ORDER BY created_at, id
  `).bind(input.request.shopId).all<{ assetId: string; id: string; objectKey: string }>()).results;
  const media = privateAssetVersions.length === 0
    ? null
    : (input.env as Partial<AppBindings>).MEDIA;
  if (privateAssetVersions.length > 0 && media === undefined) {
    throw new AppError("private_asset_configuration_invalid", 500);
  }

  const destructiveMarker = await input.env.PLATFORM_DB.prepare(`
    UPDATE shop_deletion_steps
    SET last_safe_error_code = ?,
      version = version + 1, updated_at = ?
    WHERE request_id = ? AND shop_id = ? AND step_code = 'crypto_shred'
      AND status = 'processing' AND lease_token = ? AND ${eligibilityGuard}
  `).bind(
    CRYPTO_SHRED_DESTRUCTIVE_MARKER,
    nowIso,
    input.request.id,
    input.request.shopId,
    input.leaseToken,
    ...guardValues,
  ).run();
  if (destructiveMarker.meta.changes !== 1) throw new AppError("shop_deletion_lease_lost", 409);
  await assertFence();

  const exportObjects = (await input.env.PLATFORM_DB.prepare(`
    SELECT id, object_key AS objectKey
    FROM data_export_jobs
    WHERE shop_id = ? AND object_deleted_at IS NULL
    ORDER BY created_at, id
  `).bind(input.request.shopId).all<{ id: string; objectKey: string }>()).results;
  await input.env.PLATFORM_DB.prepare(`
    UPDATE data_export_jobs
    SET status = CASE WHEN status = 'downloaded' THEN status ELSE 'canceled' END,
      download_token_hash = CASE WHEN status = 'downloaded' THEN download_token_hash ELSE NULL END,
      download_token_expires_at = CASE WHEN status = 'downloaded' THEN download_token_expires_at ELSE NULL END,
      last_safe_error_code = CASE WHEN status = 'downloaded' THEN last_safe_error_code ELSE 'shop_deleted' END,
      updated_at = ?
    WHERE shop_id = ? AND ${eligibilityGuard}
  `).bind(nowIso, input.request.shopId, ...guardValues).run();

  for (const exportObject of exportObjects) {
    await assertFence();
    if (exportObject.objectKey !== dataExportObjectKey(exportObject.id)) {
      throw new AppError("export_object_key_invalid", 409);
    }
    try {
      await privateExports.delete(exportObject.objectKey);
    } catch {
      throw new AppError("export_object_delete_failed", 503);
    }
    await assertFence();
    const deleted = await input.env.PLATFORM_DB.prepare(`
      UPDATE data_export_jobs
      SET object_deleted_at = COALESCE(object_deleted_at, ?), updated_at = ?
      WHERE id = ? AND shop_id = ? AND object_key = ?
        AND object_deleted_at IS NULL AND ${eligibilityGuard}
    `).bind(
      nowIso,
      nowIso,
      exportObject.id,
      input.request.shopId,
      exportObject.objectKey,
      ...guardValues,
    ).run();
    if (deleted.meta.changes !== 1) throw new AppError("shop_deletion_lease_lost", 409);
  }

  const remainingExportObject = await input.env.PLATFORM_DB.prepare(`
    SELECT 1 AS remaining
    FROM data_export_jobs
    WHERE shop_id = ? AND object_deleted_at IS NULL
    LIMIT 1
  `).bind(input.request.shopId).first<{ remaining: number }>();
  if (remainingExportObject !== null) throw new AppError("export_object_cleanup_incomplete", 409);

  // Revoke generic entitlements while the crypto-shred lease still owns the
  // tenant. Their immutable grant and transition evidence remains retained.
  const genericEntitlementTargets = (await input.env.PLATFORM_DB.prepare(`
    SELECT id, requirement_id AS requirementId, resource_id AS resourceId,
      status, version
    FROM entitlements
    WHERE shop_id = ? AND status IN ('pending', 'active', 'suspended')
      AND ${eligibilityGuard}
    ORDER BY created_at, id
  `).bind(input.request.shopId, ...guardValues).all<{
    id: string;
    requirementId: string;
    resourceId: string;
    status: "active" | "pending" | "suspended";
    version: number;
  }>()).results;
  const genericEntitlementStatements: D1PreparedStatement[] = [];
  for (const target of genericEntitlementTargets) {
    const nextVersion = target.version + 1;
    const idempotencyKeyHash = await hmacToken(
      input.env.SESSION_SECRET,
      "idempotency",
      `shop-deletion:${input.request.id}:entitlement-revoke:${target.id}:${String(nextVersion)}`,
    );
    const requestHash = await sha256Json({
      deletionRequestId: input.request.id,
      entitlementId: target.id,
      fromStatus: target.status,
      shopId: input.request.shopId,
      toStatus: "revoked",
      version: nextVersion,
    });
    genericEntitlementStatements.push(
      input.env.PLATFORM_DB.prepare(`
        UPDATE entitlements
        SET status = 'revoked', revoked_at = COALESCE(revoked_at, ?),
          suspended_at = NULL, version = version + 1, updated_at = ?
        WHERE id = ? AND shop_id = ? AND status IN ('pending', 'active', 'suspended')
          AND version = ? AND ${eligibilityGuard}
      `).bind(
        nowIso,
        nowIso,
        target.id,
        input.request.shopId,
        target.version,
        ...guardValues,
      ),
      input.env.PLATFORM_DB.prepare(`
        INSERT INTO entitlement_transitions (
          id, shop_id, entitlement_id, requirement_id, resource_id,
          entitlement_version, from_status, to_status, reason_code,
          idempotency_key_hash, request_hash, actor_kind, actor_user_id,
          occurred_at, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'revoked', 'shop_deleted', ?, ?, 'system', NULL, ?, ?)
      `).bind(
        createId("etr"),
        input.request.shopId,
        target.id,
        target.requirementId,
        target.resourceId,
        nextVersion,
        target.status,
        idempotencyKeyHash,
        requestHash,
        nowIso,
        nowIso,
      ),
    );
  }
  if (genericEntitlementStatements.length > 0) {
    await assertFence();
    const genericResults = await input.env.PLATFORM_DB.batch(genericEntitlementStatements);
    for (let index = 0; index < genericEntitlementTargets.length; index += 1) {
      if (genericResults[index * 2]?.meta.changes !== 1) {
        throw new AppError("shop_deletion_lease_lost", 409);
      }
    }
    await assertFence();
  }

  const destroyed = JSON.stringify({
    families: ["inventory", "payment_credentials", "payment_provider_identity", "telegram_credentials", "telegram_recipients", "channel_credentials", "channel_runtime", "private_delivery", "generated_license_credentials", "generated_license_artifacts", "data_exports", "security_rate_limits"],
    keyVersionsDestroyed: "all",
  });
  await input.env.PLATFORM_DB.batch([
    input.env.PLATFORM_DB.prepare(`
      UPDATE api_credentials
      SET status = 'revoked', revoked_at = COALESCE(revoked_at, ?),
        revocation_request_hash = COALESCE(revocation_request_hash, lower(hex(randomblob(32)))),
        revoke_reason = COALESCE(revoke_reason, 'shop_deleted'),
        version = version + 1, updated_at = ?
      WHERE shop_id = ? AND status = 'active' AND ${eligibilityGuard}
    `).bind(nowIso, nowIso, input.request.shopId, ...guardValues),
    input.env.PLATFORM_DB.prepare(`
      DELETE FROM security_rate_limits
      WHERE shop_id = ? AND ${eligibilityGuard}
    `).bind(input.request.shopId, ...guardValues),
    input.env.PLATFORM_DB.prepare(`
      UPDATE delivery_jobs
      SET status = 'canceled', next_attempt_at = NULL,
        lease_token = NULL, lease_expires_at = NULL,
        last_safe_error_code = 'shop_deleted', updated_at = ?, version = version + 1
      WHERE shop_id = ?
        AND (
          status IN ('pending', 'retryable')
          OR (status = 'processing' AND lease_expires_at <= ?)
        )
        AND ${eligibilityGuard}
    `).bind(nowIso, input.request.shopId, nowIso, ...guardValues),
    input.env.PLATFORM_DB.prepare(`
      UPDATE generated_license_requests
      SET status = 'canceled', lease_token = NULL, lease_expires_at = NULL,
        last_safe_error_code = 'shop_deleted',
        canceled_at = COALESCE(canceled_at, ?), version = version + 1, updated_at = ?
      WHERE shop_id = ?
        AND (
          status IN ('pending', 'retryable', 'reconcile_pending')
          OR (status = 'processing' AND lease_expires_at <= ?)
        )
        AND ${eligibilityGuard}
    `).bind(nowIso, nowIso, input.request.shopId, nowIso, ...guardValues),
    input.env.PLATFORM_DB.prepare(`
      UPDATE generated_license_dead_letters
      SET status = 'resolved', resolution_code = 'shop_deleted',
        resolved_at = COALESCE(resolved_at, ?), updated_at = ?
      WHERE shop_id = ? AND status != 'resolved' AND ${eligibilityGuard}
    `).bind(nowIso, nowIso, input.request.shopId, ...guardValues),
    input.env.PLATFORM_DB.prepare(`
      UPDATE generated_license_artifacts
      SET status = 'destroyed', ciphertext_b64 = 'destroyed',
        iv_b64 = 'destroyed', key_version = 'destroyed',
        artifact_fingerprint = 'destroyed', revoked_at = COALESCE(revoked_at, ?)
      WHERE shop_id = ? AND status IN ('active', 'revoked') AND ${eligibilityGuard}
    `).bind(nowIso, input.request.shopId, ...guardValues),
    input.env.PLATFORM_DB.prepare(`
      UPDATE generated_license_resource_bindings
      SET status = 'retired', retired_at = COALESCE(retired_at, ?),
        version = version + 1, updated_at = ?
      WHERE shop_id = ? AND status = 'active' AND ${eligibilityGuard}
    `).bind(nowIso, nowIso, input.request.shopId, ...guardValues),
    input.env.PLATFORM_DB.prepare(`
      UPDATE generated_license_provider_credentials
      SET status = 'destroyed', key_version = 'destroyed',
        endpoint_ciphertext_b64 = 'destroyed', endpoint_iv_b64 = 'destroyed',
        credential_ciphertext_b64 = 'destroyed', credential_iv_b64 = 'destroyed',
        endpoint_fingerprint = 'destroyed', credential_fingerprint = 'destroyed',
        revoked_at = COALESCE(revoked_at, ?), version = version + 1, updated_at = ?
      WHERE shop_id = ? AND key_version != 'destroyed' AND ${eligibilityGuard}
    `).bind(nowIso, nowIso, input.request.shopId, ...guardValues),
    input.env.PLATFORM_DB.prepare(`
      UPDATE generated_license_provider_connections
      SET status = 'retired', external_account_fingerprint = NULL,
        last_safe_error_code = 'shop_deleted', retired_at = COALESCE(retired_at, ?),
        version = version + 1, updated_at = ?
      WHERE shop_id = ?
        AND (status != 'retired' OR external_account_fingerprint IS NOT NULL)
        AND ${eligibilityGuard}
    `).bind(nowIso, nowIso, input.request.shopId, ...guardValues),
    input.env.PLATFORM_DB.prepare(`
      UPDATE domain_events
      SET status = 'failed', next_attempt_at = NULL,
        lease_token = NULL, lease_expires_at = NULL,
        last_safe_error_code = 'shop_deleted', updated_at = ?, version = version + 1
      WHERE shop_id = ?
        AND (
          status IN ('pending', 'retryable')
          OR (status = 'processing' AND lease_expires_at <= ?)
        )
        AND ${eligibilityGuard}
    `).bind(nowIso, input.request.shopId, nowIso, ...guardValues),
    input.env.PLATFORM_DB.prepare(`
      UPDATE inventory_keys
      SET status = 'revoked', ciphertext_b64 = 'destroyed', iv_b64 = 'destroyed',
        key_version = 'destroyed', key_fingerprint = 'destroyed:' || id,
        reservation_token = NULL, reserved_order_item_id = NULL, reserved_until = NULL,
        revoked_at = COALESCE(revoked_at, ?)
      WHERE shop_id = ? AND key_version != 'destroyed' AND ${eligibilityGuard}
    `).bind(nowIso, input.request.shopId, ...guardValues),
    input.env.PLATFORM_DB.prepare(`
      UPDATE payment_integrations
      SET provider_identity_fingerprint = NULL, updated_at = ?
      WHERE shop_id = ? AND provider_identity_fingerprint IS NOT NULL AND ${eligibilityGuard}
    `).bind(nowIso, input.request.shopId, ...guardValues),
    input.env.PLATFORM_DB.prepare(`
      UPDATE payment_provider_connections
      SET provider_attested_country_code = NULL,
        provider_country_attested_at = NULL,
        provider_account_fingerprint = NULL,
        provider_account_verified_at = NULL,
        updated_at = ?, version = version + 1
      WHERE shop_id = ?
        AND status = 'disconnected' AND webhook_status = 'disconnected'
        AND (
          provider_attested_country_code IS NOT NULL
          OR provider_country_attested_at IS NOT NULL
          OR provider_account_fingerprint IS NOT NULL
          OR provider_account_verified_at IS NOT NULL
        )
        AND ${eligibilityGuard}
    `).bind(nowIso, input.request.shopId, ...guardValues),
    input.env.PLATFORM_DB.prepare(`
      UPDATE payment_credentials
      SET status = 'revoked', key_version = 'destroyed',
        client_id_ciphertext_b64 = 'destroyed', client_id_iv_b64 = 'destroyed',
        api_key_ciphertext_b64 = 'destroyed', api_key_iv_b64 = 'destroyed',
        checksum_key_ciphertext_b64 = 'destroyed', checksum_key_iv_b64 = 'destroyed',
        credential_fingerprint = 'destroyed:' || id,
        provider_ownership_fingerprint = 'destroyed:' || id,
        grace_ends_at = NULL,
        revoked_at = COALESCE(revoked_at, ?)
      WHERE shop_id = ? AND key_version != 'destroyed' AND ${eligibilityGuard}
    `).bind(nowIso, input.request.shopId, ...guardValues),
    input.env.PLATFORM_DB.prepare(`
      UPDATE telegram_credentials
      SET status = 'revoked', key_version = 'destroyed',
        bot_token_ciphertext_b64 = 'destroyed', bot_token_iv_b64 = 'destroyed',
        webhook_secret_ciphertext_b64 = 'destroyed', webhook_secret_iv_b64 = 'destroyed',
        token_fingerprint = 'destroyed:' || id,
        webhook_secret_digest = 'destroyed:' || id,
        revoked_at = COALESCE(revoked_at, ?)
      WHERE shop_id = ? AND key_version != 'destroyed' AND ${eligibilityGuard}
    `).bind(nowIso, input.request.shopId, ...guardValues),
    input.env.PLATFORM_DB.prepare(`
      UPDATE telegram_recipients
      SET key_version = 'destroyed', chat_id_ciphertext_b64 = 'destroyed',
        chat_id_iv_b64 = 'destroyed', status = 'unavailable',
        last_safe_error_code = 'secret_destroyed', updated_at = ?
      WHERE shop_id = ? AND key_version != 'destroyed' AND ${eligibilityGuard}
    `).bind(nowIso, input.request.shopId, ...guardValues),
    input.env.PLATFORM_DB.prepare(`
      UPDATE channel_credentials
      SET status = 'revoked', key_version = 'destroyed',
        credential_envelope_ciphertext_b64 = 'destroyed:00000000',
        credential_envelope_iv_b64 = 'destroyed:iv0',
        credential_fingerprint = lower(hex(randomblob(32))),
        grace_ends_at = NULL,
        revoked_at = COALESCE(revoked_at, ?)
      WHERE shop_id = ? AND key_version != 'destroyed' AND ${eligibilityGuard}
    `).bind(nowIso, input.request.shopId, ...guardValues),
    input.env.PLATFORM_DB.prepare(`
      UPDATE delivery_grants
      SET status = 'revoked', revoked_at = COALESCE(revoked_at, ?),
        version = version + 1, updated_at = ?
      WHERE shop_id = ? AND status = 'active' AND ${eligibilityGuard}
    `).bind(nowIso, nowIso, input.request.shopId, ...guardValues),
    input.env.PLATFORM_DB.prepare(`
      UPDATE digital_entitlements
      SET status = 'revoked', revoked_at = COALESCE(revoked_at, ?),
        version = version + 1, updated_at = ?
      WHERE shop_id = ? AND status IN ('active', 'suspended') AND ${eligibilityGuard}
    `).bind(nowIso, nowIso, input.request.shopId, ...guardValues),
    input.env.PLATFORM_DB.prepare(`
      UPDATE product_fulfillment_policies
      SET status = 'retired', retired_at = COALESCE(retired_at, ?), updated_at = ?
      WHERE shop_id = ? AND capability = 'private_file' AND status = 'active'
        AND ${eligibilityGuard}
    `).bind(nowIso, nowIso, input.request.shopId, ...guardValues),
    input.env.PLATFORM_DB.prepare(`
      UPDATE product_entitlement_policies
      SET status = 'retired', retired_at = COALESCE(retired_at, ?), updated_at = ?
      WHERE shop_id = ? AND status = 'active' AND ${eligibilityGuard}
    `).bind(nowIso, nowIso, input.request.shopId, ...guardValues),
    input.env.PLATFORM_DB.prepare(`
      UPDATE entitlement_resources
      SET status = 'retired', retired_at = COALESCE(retired_at, ?),
        version = version + 1, updated_at = ?
      WHERE shop_id = ? AND status = 'active' AND ${eligibilityGuard}
    `).bind(nowIso, nowIso, input.request.shopId, ...guardValues),
    input.env.PLATFORM_DB.prepare(`
      UPDATE digital_asset_versions
      SET status = 'revoked', updated_at = ?
      WHERE shop_id = ? AND status = 'active' AND ${eligibilityGuard}
    `).bind(nowIso, input.request.shopId, ...guardValues),
    input.env.PLATFORM_DB.prepare(`
      UPDATE digital_assets
      SET status = 'revoked', updated_at = ?
      WHERE shop_id = ? AND status = 'active' AND ${eligibilityGuard}
    `).bind(nowIso, input.request.shopId, ...guardValues),
  ]);

  for (const version of privateAssetVersions) {
    await assertFence();
    try {
      await media?.delete(version.objectKey);
    } catch {
      throw new AppError("private_asset_delete_failed", 503);
    }
    await assertFence();
    const deleted = await input.env.PLATFORM_DB.prepare(`
      UPDATE digital_asset_versions
      SET status = 'deleted', deleted_at = COALESCE(deleted_at, ?), updated_at = ?
      WHERE id = ? AND shop_id = ? AND status != 'deleted' AND ${eligibilityGuard}
    `).bind(
      nowIso,
      nowIso,
      version.id,
      input.request.shopId,
      ...guardValues,
    ).run();
    if (deleted.meta.changes !== 1) throw new AppError("shop_deletion_lease_lost", 409);
  }

  await assertFence();
  await input.env.PLATFORM_DB.prepare(`
    UPDATE digital_assets
    SET status = 'deleted', deleted_at = COALESCE(deleted_at, ?), updated_at = ?
    WHERE shop_id = ? AND status != 'deleted'
      AND NOT EXISTS (
        SELECT 1 FROM digital_asset_versions
        WHERE digital_asset_versions.shop_id = digital_assets.shop_id
          AND digital_asset_versions.asset_id = digital_assets.id
          AND digital_asset_versions.status != 'deleted'
      )
      AND ${eligibilityGuard}
  `).bind(nowIso, nowIso, input.request.shopId, ...guardValues).run();
  const remainingPrivateAsset = await input.env.PLATFORM_DB.prepare(`
    SELECT 1 AS remaining
    FROM digital_asset_versions
    WHERE shop_id = ? AND status != 'deleted'
    LIMIT 1
  `).bind(input.request.shopId).first<{ remaining: number }>();
  if (remainingPrivateAsset !== null) throw new AppError("private_asset_cleanup_incomplete", 409);

  const marked = await input.env.PLATFORM_DB.prepare(`
    UPDATE shop_deletion_requests
    SET secret_material_destroyed_at = COALESCE(secret_material_destroyed_at, ?),
      secret_material_destroyed_json = ?, version = version + 1, updated_at = ?
    WHERE id = ? AND shop_id = ? AND provider_cleanup_completed_at IS NOT NULL
      AND grace_ends_at <= ?
      AND (legal_hold_until IS NULL OR legal_hold_until <= ?)
      AND status IN ('processing', 'blocked', 'retention_hold', 'failed')
      AND ${eligibilityGuard}
  `).bind(
    nowIso,
    destroyed,
    nowIso,
    input.request.id,
    input.request.shopId,
    nowIso,
    nowIso,
    ...guardValues,
  ).run();
  if (marked.meta.changes !== 1) {
    const active = await input.env.PLATFORM_DB.prepare(`
      SELECT 1 AS active
      FROM (
        SELECT lease_expires_at FROM domain_events
        WHERE shop_id = ? AND status = 'processing'
        UNION ALL
        SELECT lease_expires_at FROM delivery_jobs
        WHERE shop_id = ? AND status = 'processing'
      )
      WHERE lease_expires_at > ?
      LIMIT 1
    `).bind(input.request.shopId, input.request.shopId, nowIso).first<{ active: number }>();
    if (active !== null) throw new AppError("shop_deletion_channel_work_inflight", 409);
    throw new AppError("shop_deletion_lease_lost", 409);
  }
}

async function finalizeDeletion(input: {
  env: AppBindings;
  leaseToken: string;
  now: Date;
  request: DeletionRequestRow;
  requestId: string;
  userId: string;
}): Promise<void> {
  const nowIso = input.now.toISOString();
  const finalizationGuard = `
    EXISTS (
      SELECT 1
      FROM shop_deletion_steps AS owned_step
      INNER JOIN shop_deletion_requests AS owned_request
        ON owned_request.id = owned_step.request_id
        AND owned_request.shop_id = owned_step.shop_id
      WHERE owned_step.request_id = ? AND owned_step.shop_id = ?
        AND owned_step.step_code = 'finalize'
        AND owned_step.status = 'processing' AND owned_step.lease_token = ?
        AND owned_request.status IN ('processing', 'blocked', 'retention_hold', 'failed')
        AND owned_request.secret_material_destroyed_at IS NOT NULL
        AND owned_request.grace_ends_at <= ?
        AND (owned_request.legal_hold_until IS NULL OR owned_request.legal_hold_until <= ?)
    )
  `;
  const guardValues = [
    input.request.id,
    input.request.shopId,
    input.leaseToken,
    nowIso,
    nowIso,
  ] as const;
  const results = await input.env.PLATFORM_DB.batch([
    input.env.PLATFORM_DB.prepare(`
      UPDATE shop_domains
      SET status = 'deleted', is_primary = 0, deleted_at = COALESCE(deleted_at, ?),
        next_check_at = NULL, lease_token = NULL, lease_expires_at = NULL,
        version = version + 1, updated_at = ?
      WHERE shop_id = ? AND deleted_at IS NULL AND ${finalizationGuard}
    `).bind(nowIso, nowIso, input.request.shopId, ...guardValues),
    input.env.PLATFORM_DB.prepare(`
      UPDATE shop_subscriptions
      SET state = 'canceled', canceled_at = COALESCE(canceled_at, ?), updated_at = ?
      WHERE shop_id = ? AND state != 'canceled' AND ${finalizationGuard}
    `).bind(nowIso, nowIso, input.request.shopId, ...guardValues),
    input.env.PLATFORM_DB.prepare(`
      UPDATE shops
      SET status = 'archived', canonical_domain_id = NULL,
        readiness_version = readiness_version + 1, updated_at = ?
      WHERE id = ? AND status = 'suspended' AND ${finalizationGuard}
    `).bind(nowIso, input.request.shopId, ...guardValues),
    input.env.PLATFORM_DB.prepare(`
      UPDATE shop_deletion_steps
      SET status = 'completed', lease_token = NULL, lease_expires_at = NULL,
        last_safe_error_code = NULL, completed_at = ?, version = version + 1, updated_at = ?
      WHERE request_id = ? AND shop_id = ? AND step_code = 'finalize'
        AND status = 'processing' AND lease_token = ?
        AND EXISTS (
          SELECT 1 FROM shop_deletion_requests
          WHERE id = ? AND shop_id = ? AND status IN ('processing', 'blocked', 'retention_hold', 'failed')
            AND secret_material_destroyed_at IS NOT NULL
            AND grace_ends_at <= ?
            AND (legal_hold_until IS NULL OR legal_hold_until <= ?)
        )
    `).bind(
      nowIso,
      nowIso,
      input.request.id,
      input.request.shopId,
      input.leaseToken,
      input.request.id,
      input.request.shopId,
      nowIso,
      nowIso,
    ),
    input.env.PLATFORM_DB.prepare(`
      UPDATE shop_deletion_requests
      SET status = 'completed', completed_at = ?, last_safe_error_code = NULL,
        version = version + 1, updated_at = ?
      WHERE id = ? AND shop_id = ? AND secret_material_destroyed_at IS NOT NULL
        AND status IN ('processing', 'blocked', 'retention_hold', 'failed')
        AND EXISTS (
          SELECT 1 FROM shop_deletion_steps
          WHERE request_id = ? AND shop_id = ? AND step_code = 'finalize'
            AND status = 'completed' AND completed_at = ?
        )
    `).bind(
      nowIso,
      nowIso,
      input.request.id,
      input.request.shopId,
      input.request.id,
      input.request.shopId,
      nowIso,
    ),
    input.env.PLATFORM_DB.prepare(`
      INSERT INTO audit_logs (
        id, shop_id, actor_type, actor_id, action, resource_type,
        resource_id, safe_metadata_json, request_id, source_kind,
        retention_class, created_at
      )
      SELECT ?, ?, 'user', ?, 'shop.deletion_completed', 'shop_deletion_request', ?, ?, ?, 'application', 'legal', ?
      WHERE EXISTS (
        SELECT 1 FROM shop_deletion_requests
        WHERE id = ? AND shop_id = ? AND status = 'completed' AND completed_at = ?
      )
    `).bind(
      createId("aud"),
      input.request.shopId,
      input.userId,
      input.request.id,
      JSON.stringify({ financialRecordsRetainUntil: input.request.financialRecordsRetainUntil }),
      input.requestId,
      nowIso,
      input.request.id,
      input.request.shopId,
      nowIso,
    ),
  ]);
  if (results[2]?.meta.changes !== 1 || results[3]?.meta.changes !== 1 || results[4]?.meta.changes !== 1) {
    throw new AppError("shop_deletion_conflict", 409);
  }
}

function safeDeletionError(error: unknown): string {
  if (error instanceof AppError && /^[a-z0-9_]{1,64}$/u.test(error.code)) return error.code;
  return "provider_cleanup_failed";
}

export async function resumeShopDeletion(input: {
  env: AppBindings;
  requestId: string;
  runtime?: DeletionProviderRuntime;
  shopPublicId: string;
  userId: string;
}): Promise<ShopDeletionView> {
  const shop = await requireOwnerShop(input);
  let request = await loadRequest(input.env, shop.shopId);
  if (request === null) throw new AppError("shop_deletion_not_found", 404);
  if (request.status === "completed" || request.status === "canceled") return mapDeletion(input.env, request);
  const now = input.runtime?.now ?? new Date();
  const steps = await loadSteps(input.env, request.id, shop.shopId);

  for (const step of steps) {
    if (step.status === "completed" || step.status === "skipped") continue;
    const leaseToken = await claimStep({
      env: input.env,
      now,
      request,
      sequence: step.sequenceNo,
      stepCode: step.stepCode,
    });
    if (leaseToken === null) break;
    try {
      await input.runtime?.beforeStep?.({
        env: input.env,
        leaseToken,
        requestId: request.id,
        shopId: request.shopId,
        stepCode: step.stepCode,
      });
      if (HOLD_BLOCKED_STEPS.has(step.stepCode)) {
        const currentRequest = await loadRequestById(input.env, request.id, request.shopId);
        if (currentRequest === null) throw new AppError("shop_deletion_not_found", 404);
        if (currentRequest.legalHoldUntil !== null && currentRequest.legalHoldUntil > now.toISOString()) {
          await blockStep({
            code: "legal_hold_active",
            env: input.env,
            leaseToken,
            now,
            request: currentRequest,
            requestStatus: "retention_hold",
            stepCode: step.stepCode,
          });
          break;
        }
      }
      if (step.stepCode === "active_payment_drain") {
        if (await hasActivePaymentState(input.env, request.shopId, now.toISOString())) {
          await blockStep({
            code: "active_payment_retention",
            env: input.env,
            leaseToken,
            now,
            request,
            requestStatus: "blocked",
            stepCode: step.stepCode,
          });
          break;
        }
        await completeStep({ env: input.env, leaseToken, now, request, stepCode: step.stepCode });
      } else if (step.stepCode === "grace_wait") {
        if (request.legalHoldUntil !== null && request.legalHoldUntil > now.toISOString()) {
          await blockStep({
            code: "legal_hold_active",
            env: input.env,
            leaseToken,
            now,
            request,
            requestStatus: "retention_hold",
            stepCode: step.stepCode,
          });
          break;
        }
        if (request.graceEndsAt > now.toISOString()) {
          await blockStep({
            code: "deletion_grace_active",
            env: input.env,
            leaseToken,
            now,
            request,
            requestStatus: "retention_hold",
            stepCode: step.stepCode,
          });
          break;
        }
        await completeStep({ env: input.env, leaseToken, now, request, stepCode: step.stepCode });
      } else if (step.stepCode === "custom_domain_cleanup") {
        const cleanup = input.runtime?.cleanupCustomDomains ?? ((context: ProviderCleanupContext) => cleanupCustomDomains({
          ...context,
          ...(input.runtime?.fetcher === undefined ? {} : { fetcher: input.runtime.fetcher }),
        }));
        await cleanup({ env: input.env, leaseToken, now, requestId: request.id, shopId: request.shopId });
        await completeStep({ env: input.env, leaseToken, now, request, stepCode: step.stepCode });
      } else if (step.stepCode === "telegram_cleanup") {
        const cleanup = input.runtime?.cleanupTelegram ?? ((context: ProviderCleanupContext) => cleanupTelegram({
          ...context,
          ...(input.runtime?.fetcher === undefined ? {} : { fetcher: input.runtime.fetcher }),
        }));
        await cleanup({ env: input.env, leaseToken, now, requestId: request.id, shopId: request.shopId });
        await cleanupGenericChannels({ env: input.env, leaseToken, now, request });
        await completeStep({ env: input.env, leaseToken, now, request, stepCode: step.stepCode });
      } else if (step.stepCode === "payment_cleanup") {
        const cleanup = input.runtime?.cleanupPayment ?? cleanupPayment;
        await cleanup({ env: input.env, leaseToken, now, requestId: request.id, shopId: request.shopId });
        await completeStep({ env: input.env, leaseToken, now, request, stepCode: step.stepCode });
        const nowIso = now.toISOString();
        await input.env.PLATFORM_DB.prepare(`
          UPDATE shop_deletion_requests
          SET provider_cleanup_completed_at = COALESCE(provider_cleanup_completed_at, ?),
            version = version + 1, updated_at = ?
          WHERE id = ? AND shop_id = ?
            AND status IN ('processing', 'blocked', 'retention_hold', 'failed')
        `).bind(nowIso, nowIso, request.id, request.shopId).run();
      } else if (step.stepCode === "crypto_shred") {
        const currentRequest = await loadRequest(input.env, request.shopId);
        if (currentRequest === null) throw new AppError("shop_deletion_not_found", 404);
        if (currentRequest.legalHoldUntil !== null && currentRequest.legalHoldUntil > now.toISOString()) {
          await blockStep({
            code: "legal_hold_active",
            env: input.env,
            leaseToken,
            now,
            request: currentRequest,
            requestStatus: "retention_hold",
            stepCode: step.stepCode,
          });
          break;
        }
        await cryptoShred({ env: input.env, leaseToken, now, request: currentRequest });
        await completeStep({ env: input.env, leaseToken, now, request, stepCode: step.stepCode });
      } else if (step.stepCode === "finalize") {
        await finalizeDeletion({
          env: input.env,
          leaseToken,
          now,
          request,
          requestId: input.requestId,
          userId: input.userId,
        });
      } else {
        await completeStep({ env: input.env, leaseToken, now, request, stepCode: step.stepCode });
      }
    } catch (error) {
      const currentRequest = await loadRequestById(input.env, request.id, request.shopId);
      if (error instanceof AppError && error.code === "shop_deletion_generated_license_work_inflight") {
        await blockStep({
          code: error.code,
          env: input.env,
          leaseToken,
          now,
          request: currentRequest ?? request,
          requestStatus: "blocked",
          stepCode: step.stepCode,
        });
        break;
      }
      if (HOLD_BLOCKED_STEPS.has(step.stepCode)
        && currentRequest !== null
        && currentRequest.legalHoldUntil !== null
        && currentRequest.legalHoldUntil > now.toISOString()) {
        await blockStep({
          code: "legal_hold_active",
          env: input.env,
          leaseToken,
          now,
          request: currentRequest,
          requestStatus: "retention_hold",
          stepCode: step.stepCode,
        });
        break;
      }
      await failStep({
        code: safeDeletionError(error),
        env: input.env,
        leaseToken,
        now,
        request,
        stepCode: step.stepCode,
      });
      break;
    }
    request = await loadRequest(input.env, shop.shopId) ?? request;
  }

  const current = await loadRequest(input.env, shop.shopId);
  if (current === null) throw new AppError("shop_deletion_not_found", 404);
  return mapDeletion(input.env, current);
}
