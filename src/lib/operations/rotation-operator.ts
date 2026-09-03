import { hmacToken, sha256Json } from "../core/crypto";
import { AppError } from "../core/errors";
import type { AppBindings } from "../platform/bindings";
import { describePlatformAdminAccess } from "../tenants/store";
import {
  createEncryptionRotation,
  processEncryptionRotation,
  type RotationKeyFamily,
  type RotationResult,
} from "./rotation";

const ROTATION_KEY_FAMILIES = [
  "generated_license_artifacts",
  "generated_license_credentials",
  "inventory",
  "payment_credentials",
  "telegram_credentials",
  "telegram_recipient_ids",
] as const;
const ROTATION_STATUSES = ["planned", "running", "paused", "completed", "failed", "canceled"] as const;
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9._:-]{8,128}$/u;
const RUN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/u;
const VERSION_PATTERN = /^v[1-9][0-9]{0,3}$/u;
const IDEMPOTENCY_TTL_MS = 24 * 60 * 60_000;
const PENDING_TTL_MS = 5 * 60_000;

type PlatformAdminRole = "owner" | "risk" | "support";
type RotationStatus = typeof ROTATION_STATUSES[number];
type StoredIdempotency = { requestHash: string; responseJson: string };

export type RotationRunView = {
  completedAt: string | null;
  createdAt: string;
  dryRun: boolean;
  failedItems: number;
  id: string;
  keyFamily: RotationKeyFamily;
  lastSafeErrorCode: string | null;
  processedItems: number;
  scope: "global" | "shop";
  shopPublicId: string | null;
  sourceKeyVersion: string;
  status: RotationStatus;
  targetKeyVersion: string;
  totalItems: number;
  updatedAt: string;
};

type RotationRunRow = Omit<RotationRunView, "dryRun" | "scope"> & {
  dryRun: number;
  shopId: string | null;
};

type CreateRotationInput = {
  actorUserId: string;
  dryRun: boolean;
  env: AppBindings;
  globalConfirmation: string | null;
  idempotencyKey: string | null;
  keyFamily: RotationKeyFamily;
  liveConfirmation: string | null;
  requestId: string;
  scope: "global" | "shop";
  shopPublicId: string | null;
  sourceKeyVersion: string;
  targetKeyVersion: string;
};

function isOneOf<T extends string>(value: unknown, allowed: readonly T[]): value is T {
  return typeof value === "string" && allowed.includes(value as T);
}

export function parseRotationKeyFamily(value: unknown): RotationKeyFamily {
  if (!isOneOf(value, ROTATION_KEY_FAMILIES)) {
    throw new AppError("rotation_validation_failed", 400, ["key_family_invalid"]);
  }
  return value;
}

export function parseRotationScope(value: unknown): "global" | "shop" {
  if (value !== "global" && value !== "shop") {
    throw new AppError("rotation_validation_failed", 400, ["scope_invalid"]);
  }
  return value;
}

export function parseRotationVersion(value: unknown): string {
  if (typeof value !== "string" || !VERSION_PATTERN.test(value)) {
    throw new AppError("rotation_validation_failed", 400, ["key_version_invalid"]);
  }
  return value;
}

export function parseRotationLimit(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > 100) {
    throw new AppError("rotation_validation_failed", 400, ["batch_limit_invalid"]);
  }
  return value;
}

function requireIdempotencyKey(value: string | null): string {
  if (value === null || !IDEMPOTENCY_KEY_PATTERN.test(value)) {
    throw new AppError("rotation_validation_failed", 400, ["idempotency_key_invalid"]);
  }
  return value;
}

function requireRunId(value: string): string {
  if (!RUN_ID_PATTERN.test(value)) {
    throw new AppError("rotation_validation_failed", 400, ["run_id_invalid"]);
  }
  return value;
}

async function requireAdminRole(input: {
  env: AppBindings;
  ownerOnly?: boolean;
  userId: string;
}): Promise<PlatformAdminRole> {
  // 2FA-aware lookup: un-enrolled admins never resolve a role on rotation surfaces.
  const access = await describePlatformAdminAccess({ env: input.env, userId: input.userId });
  if (access.kind === "two_factor_required") {
    throw new AppError("admin_two_factor_required", 403);
  }
  if (access.kind !== "authorized" || (input.ownerOnly === true && access.role !== "owner")) {
    throw new AppError("authorization_denied", 403);
  }
  return access.role;
}

function mapRun(row: RotationRunRow): RotationRunView {
  if (!isOneOf(row.keyFamily, ROTATION_KEY_FAMILIES) || !isOneOf(row.status, ROTATION_STATUSES)) {
    throw new AppError("internal_error", 500);
  }
  return {
    completedAt: row.completedAt,
    createdAt: row.createdAt,
    dryRun: row.dryRun === 1,
    failedItems: row.failedItems,
    id: row.id,
    keyFamily: row.keyFamily,
    lastSafeErrorCode: row.lastSafeErrorCode,
    processedItems: row.processedItems,
    scope: row.shopId === null ? "global" : "shop",
    shopPublicId: row.shopPublicId,
    sourceKeyVersion: row.sourceKeyVersion,
    status: row.status,
    targetKeyVersion: row.targetKeyVersion,
    totalItems: row.totalItems,
    updatedAt: row.updatedAt,
  };
}

const RUN_SELECT = `
  SELECT encryption_rotation_runs.id,
    encryption_rotation_runs.shop_id AS shopId,
    shops.public_id AS shopPublicId,
    encryption_rotation_runs.key_family AS keyFamily,
    encryption_rotation_runs.source_key_version AS sourceKeyVersion,
    encryption_rotation_runs.target_key_version AS targetKeyVersion,
    encryption_rotation_runs.status,
    encryption_rotation_runs.dry_run AS dryRun,
    encryption_rotation_runs.total_items AS totalItems,
    encryption_rotation_runs.processed_items AS processedItems,
    encryption_rotation_runs.failed_items AS failedItems,
    encryption_rotation_runs.last_safe_error_code AS lastSafeErrorCode,
    encryption_rotation_runs.completed_at AS completedAt,
    encryption_rotation_runs.created_at AS createdAt,
    encryption_rotation_runs.updated_at AS updatedAt
  FROM encryption_rotation_runs
  LEFT JOIN shops ON shops.id = encryption_rotation_runs.shop_id
`;

async function loadRun(env: AppBindings, runId: string): Promise<RotationRunView | null> {
  const row = await env.PLATFORM_DB.prepare(`${RUN_SELECT}
    WHERE encryption_rotation_runs.id = ?
    LIMIT 1
  `).bind(runId).first<RotationRunRow>();
  return row === null ? null : mapRun(row);
}

export async function listEncryptionRotationRuns(input: {
  env: AppBindings;
  limit?: number;
  userId: string;
}): Promise<{ canOperate: boolean; runs: RotationRunView[] }> {
  const role = await requireAdminRole({ env: input.env, userId: input.userId });
  const limit = Math.min(100, Math.max(1, input.limit ?? 30));
  const rows = await input.env.PLATFORM_DB.prepare(`${RUN_SELECT}
    ORDER BY encryption_rotation_runs.created_at DESC, encryption_rotation_runs.id DESC
    LIMIT ?
  `).bind(limit).all<RotationRunRow>();
  return { canOperate: role === "owner", runs: rows.results.map(mapRun) };
}

async function resolveShopId(input: {
  env: AppBindings;
  scope: "global" | "shop";
  shopPublicId: string | null;
}): Promise<string | null> {
  if (input.scope === "global") {
    if (input.shopPublicId !== null && input.shopPublicId !== "") {
      throw new AppError("rotation_validation_failed", 400, ["shop_scope_conflict"]);
    }
    return null;
  }
  if (input.shopPublicId === null || !RUN_ID_PATTERN.test(input.shopPublicId)) {
    throw new AppError("rotation_validation_failed", 400, ["shop_public_id_invalid"]);
  }
  const shop = await input.env.PLATFORM_DB.prepare(`
    SELECT id FROM shops WHERE public_id = ? LIMIT 1
  `).bind(input.shopPublicId).first<{ id: string }>();
  if (shop === null) throw new AppError("tenant_not_found", 404);
  return shop.id;
}

function parseStoredResult(value: string): RotationResult | "pending" {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch {
    throw new AppError("internal_error", 500);
  }
  if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
    && (parsed as { state?: unknown }).state === "pending") return "pending";
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new AppError("internal_error", 500);
  }
  const result = parsed as Partial<Record<keyof RotationResult, unknown>>;
  if (typeof result.completed !== "boolean"
    || typeof result.failedItems !== "number"
    || typeof result.oldVersionRows !== "number"
    || typeof result.processedItems !== "number"
    || typeof result.runId !== "string"
    || typeof result.status !== "string"
    || typeof result.totalItems !== "number") {
    throw new AppError("internal_error", 500);
  }
  return {
    completed: result.completed,
    failedItems: result.failedItems,
    oldVersionRows: result.oldVersionRows,
    processedItems: result.processedItems,
    runId: result.runId,
    status: result.status,
    totalItems: result.totalItems,
  };
}

async function findIdempotency(input: {
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

async function reserveIdempotency(input: {
  actorUserId: string;
  env: AppBindings;
  keyHash: string;
  namespace: string;
  now: Date;
  requestHash: string;
}): Promise<RotationResult | "reserved" | "pending"> {
  const nowIso = input.now.toISOString();
  const existing = await findIdempotency({ ...input, nowIso });
  if (existing !== null) {
    if (existing.requestHash !== input.requestHash) throw new AppError("idempotency_conflict", 409);
    const parsed = parseStoredResult(existing.responseJson);
    return parsed === "pending" ? "pending" : parsed;
  }
  await input.env.PLATFORM_DB.prepare(`
    DELETE FROM idempotency_records
    WHERE actor_user_id = ? AND namespace = ? AND key_hash = ? AND expires_at <= ?
  `).bind(input.actorUserId, input.namespace, input.keyHash, nowIso).run();
  try {
    await input.env.PLATFORM_DB.prepare(`
      INSERT INTO idempotency_records (
        actor_user_id, namespace, key_hash, request_hash, response_json, created_at, expires_at
      ) VALUES (?, ?, ?, ?, '{"state":"pending"}', ?, ?)
    `).bind(
      input.actorUserId,
      input.namespace,
      input.keyHash,
      input.requestHash,
      nowIso,
      new Date(input.now.getTime() + PENDING_TTL_MS).toISOString(),
    ).run();
    return "reserved";
  } catch {
    const raced = await findIdempotency({ ...input, nowIso });
    if (raced === null) throw new AppError("rotation_operation_busy", 409);
    if (raced.requestHash !== input.requestHash) throw new AppError("idempotency_conflict", 409);
    const parsed = parseStoredResult(raced.responseJson);
    return parsed === "pending" ? "pending" : parsed;
  }
}

async function finishIdempotency(input: {
  actorUserId: string;
  env: AppBindings;
  keyHash: string;
  namespace: string;
  now: Date;
  requestHash: string;
  result: RotationResult;
}): Promise<void> {
  await input.env.PLATFORM_DB.prepare(`
    UPDATE idempotency_records
    SET response_json = ?, expires_at = ?
    WHERE actor_user_id = ? AND namespace = ? AND key_hash = ?
      AND request_hash = ? AND response_json = '{"state":"pending"}'
  `).bind(
    JSON.stringify(input.result),
    new Date(input.now.getTime() + IDEMPOTENCY_TTL_MS).toISOString(),
    input.actorUserId,
    input.namespace,
    input.keyHash,
    input.requestHash,
  ).run();
}

async function releaseIdempotency(input: {
  actorUserId: string;
  env: AppBindings;
  keyHash: string;
  namespace: string;
  requestHash: string;
}): Promise<void> {
  await input.env.PLATFORM_DB.prepare(`
    DELETE FROM idempotency_records
    WHERE actor_user_id = ? AND namespace = ? AND key_hash = ?
      AND request_hash = ? AND response_json = '{"state":"pending"}'
  `).bind(input.actorUserId, input.namespace, input.keyHash, input.requestHash).run();
}

function resultFromRun(run: RotationRunView): RotationResult {
  return {
    completed: run.status === "completed",
    failedItems: run.failedItems,
    oldVersionRows: run.dryRun
      ? run.totalItems
      : run.status === "completed"
        ? 0
        : Math.max(0, run.totalItems - run.processedItems),
    processedItems: run.processedItems,
    runId: run.id,
    status: run.status,
    totalItems: run.totalItems,
  };
}

export async function createOperatorEncryptionRotation(input: CreateRotationInput): Promise<RotationResult> {
  await requireAdminRole({ env: input.env, ownerOnly: true, userId: input.actorUserId });
  const idempotencyKey = requireIdempotencyKey(input.idempotencyKey);
  if (input.sourceKeyVersion === input.targetKeyVersion) {
    throw new AppError("rotation_validation_failed", 400, ["key_versions_must_differ"]);
  }
  if (input.scope === "global" && input.globalConfirmation !== "ROTATE_GLOBAL") {
    throw new AppError("rotation_confirmation_required", 400, ["global_confirmation_invalid"]);
  }
  if (!input.dryRun && input.liveConfirmation !== "ROTATE_LIVE") {
    throw new AppError("rotation_confirmation_required", 400, ["live_confirmation_invalid"]);
  }
  const shopId = await resolveShopId(input);
  const namespace = "admin.encryption-rotation.create.v1";
  const keyHash = await hmacToken(input.env.SESSION_SECRET, "idempotency", idempotencyKey);
  const requestHash = await sha256Json({
    dryRun: input.dryRun,
    keyFamily: input.keyFamily,
    scope: input.scope,
    shopPublicId: input.shopPublicId,
    sourceKeyVersion: input.sourceKeyVersion,
    targetKeyVersion: input.targetKeyVersion,
  });
  const now = new Date();
  const reserved = await reserveIdempotency({
    actorUserId: input.actorUserId,
    env: input.env,
    keyHash,
    namespace,
    now,
    requestHash,
  });
  if (reserved !== "reserved" && reserved !== "pending") return reserved;
  const runId = `rot_${(await hmacToken(input.env.SESSION_SECRET, namespace, `${input.actorUserId}:${idempotencyKey}`)).slice(0, 48)}`;
  if (reserved === "pending") {
    const existingRun = await loadRun(input.env, runId);
    if (existingRun === null) throw new AppError("rotation_operation_busy", 409);
    const replay = resultFromRun(existingRun);
    await finishIdempotency({ actorUserId: input.actorUserId, env: input.env, keyHash, namespace, now, requestHash, result: replay });
    return replay;
  }
  try {
    const result = await createEncryptionRotation({
      dryRun: input.dryRun,
      env: input.env,
      keyFamily: input.keyFamily,
      requestId: input.requestId,
      requestedByUserId: input.actorUserId,
      runId,
      shopId,
      sourceKeyVersion: input.sourceKeyVersion,
      targetKeyVersion: input.targetKeyVersion,
    });
    await finishIdempotency({ actorUserId: input.actorUserId, env: input.env, keyHash, namespace, now, requestHash, result });
    return result;
  } catch (error) {
    const existingRun = await loadRun(input.env, runId);
    if (existingRun !== null) {
      const replay = resultFromRun(existingRun);
      await finishIdempotency({ actorUserId: input.actorUserId, env: input.env, keyHash, namespace, now, requestHash, result: replay });
      return replay;
    }
    await releaseIdempotency({ actorUserId: input.actorUserId, env: input.env, keyHash, namespace, requestHash });
    throw error;
  }
}

export async function processOperatorEncryptionRotation(input: {
  actorUserId: string;
  env: AppBindings;
  idempotencyKey: string | null;
  limit: number;
  requestId: string;
  runId: string;
}): Promise<RotationResult> {
  await requireAdminRole({ env: input.env, ownerOnly: true, userId: input.actorUserId });
  const idempotencyKey = requireIdempotencyKey(input.idempotencyKey);
  const runId = requireRunId(input.runId);
  const namespace = "admin.encryption-rotation.process.v1";
  const keyHash = await hmacToken(input.env.SESSION_SECRET, "idempotency", idempotencyKey);
  const requestHash = await sha256Json({ limit: input.limit, runId });
  const now = new Date();
  const reserved = await reserveIdempotency({
    actorUserId: input.actorUserId,
    env: input.env,
    keyHash,
    namespace,
    now,
    requestHash,
  });
  if (reserved !== "reserved") {
    if (reserved === "pending") throw new AppError("rotation_operation_busy", 409);
    return reserved;
  }
  try {
    const result = await processEncryptionRotation({ env: input.env, limit: input.limit, runId });
    await finishIdempotency({ actorUserId: input.actorUserId, env: input.env, keyHash, namespace, now, requestHash, result });
    return result;
  } catch (error) {
    await releaseIdempotency({ actorUserId: input.actorUserId, env: input.env, keyHash, namespace, requestHash });
    throw error;
  }
}
