import { hmacToken, sha256Json } from "../core/crypto";
import { AppError } from "../core/errors";
import { createId } from "../core/ids";
import { normalizeEmail } from "../auth/policy";
import type { AppBindings } from "../platform/bindings";
import type { StorefrontShop } from "../storefront/store";
import { resolveTurnstileConfiguration } from "../storefront/turnstile";
import {
  createOperationsAuditEvent,
  prepareOperationsAuditForAppliedModeration,
  prepareOperationsAuditForReportTransition,
  prepareOperationsAuditInsert,
} from "./audit";

const ABUSE_CATEGORIES = ["copyright", "fraud", "malware", "other", "privacy", "prohibited_content"] as const;
const ABUSE_REPORT_STATUSES = ["actioned", "closed", "dismissed", "investigating", "received", "triaged"] as const;
const PUBLIC_TARGET_KINDS = ["domain", "product", "shop"] as const;
const ADMIN_ACTION_KINDS = ["product_restore", "product_suspend", "shop_restore", "shop_suspend"] as const;
const SAFE_REASON_CODE = /^[a-z][a-z0-9_]{2,63}$/u;
const SAFE_PRODUCT_SLUG = /^[a-z0-9](?:[a-z0-9-]{0,78}[a-z0-9])?$/u;
const SAFE_CURSOR_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const REPORT_RETENTION_DAYS = 730;
const MODERATION_RETENTION_DAYS = 1_825;
const IDEMPOTENCY_TTL_MS = 24 * 60 * 60_000;
const REPORT_RATE_WINDOW_SECONDS = 60 * 60;
const REPORT_RATE_LIMIT = 5;

export type AbuseCategory = typeof ABUSE_CATEGORIES[number];
export type AbuseReportStatus = typeof ABUSE_REPORT_STATUSES[number];
export type PublicAbuseTargetKind = typeof PUBLIC_TARGET_KINDS[number];
export type ModerationActionKind = typeof ADMIN_ACTION_KINDS[number];
export type PlatformAdminRole = "owner" | "risk" | "support";

type AbuseReportRow = {
  assignedAdminUserId: string | null;
  category: AbuseCategory;
  createdAt: string;
  id: string;
  ownerRestoreEligible: number;
  publicId: string;
  shopId: string | null;
  shopName: string | null;
  shopPublicId: string | null;
  status: AbuseReportStatus;
  summarySanitized: string;
  targetKind: "domain" | "order" | "other" | "product" | "shop";
  targetRef: string;
  targetStatus: string | null;
  updatedAt: string;
};

type StoredIdempotency = { request_hash: string; response_json: string };
type TargetStatus = { id: string; status: string };

export type AbuseReportView = {
  assigned: boolean;
  category: AbuseCategory;
  createdAt: string;
  ownerRestoreEligible: boolean;
  publicId: string;
  shopName: string | null;
  shopPublicId: string | null;
  status: AbuseReportStatus;
  summary: string;
  targetKind: AbuseReportRow["targetKind"];
  targetRef: string;
  targetStatus: string | null;
  updatedAt: string;
};

export type ModerationActionView = {
  actionKind: ModerationActionKind;
  appliedAt: string;
  id: string;
  newStatus: string;
  shopPublicId: string;
  status: "applied";
  targetKind: "product" | "shop";
  targetRef: string;
};

export type ModerationActionListItem = {
  actionKind: string;
  actorAdminUserId: string | null;
  createdAt: string;
  id: string;
  reasonCode: string;
  shopName: string | null;
  shopPublicId: string | null;
  status: string;
  targetKind: string;
  targetRef: string;
};

function isOneOf<T extends string>(value: unknown, allowed: readonly T[]): value is T {
  return typeof value === "string" && allowed.includes(value as T);
}

function requireIdempotencyKey(value: string | null): string {
  if (value === null || !/^[A-Za-z0-9._:-]{8,128}$/u.test(value)) {
    throw new AppError("validation_failed", 400, ["idempotency_key_invalid"]);
  }
  return value;
}

function requireReasonCode(value: unknown): string {
  if (typeof value !== "string" || !SAFE_REASON_CODE.test(value)) {
    throw new AppError("validation_failed", 400, ["reason_code_invalid"]);
  }
  return value;
}

export function parseAbuseCategory(value: unknown): AbuseCategory {
  if (!isOneOf(value, ABUSE_CATEGORIES)) throw new AppError("validation_failed", 400, ["category_invalid"]);
  return value;
}

export function parsePublicAbuseTargetKind(value: unknown): PublicAbuseTargetKind {
  if (!isOneOf(value, PUBLIC_TARGET_KINDS)) throw new AppError("validation_failed", 400, ["target_kind_invalid"]);
  return value;
}

export function parseAbuseReportStatus(value: unknown): AbuseReportStatus {
  if (!isOneOf(value, ABUSE_REPORT_STATUSES)) throw new AppError("validation_failed", 400, ["status_invalid"]);
  return value;
}

export function parseModerationActionKind(value: unknown): ModerationActionKind {
  if (!isOneOf(value, ADMIN_ACTION_KINDS)) throw new AppError("validation_failed", 400, ["action_kind_invalid"]);
  return value;
}

function stripUnsafeControls(value: string): string {
  let output = "";
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if ((code >= 0 && code <= 8) || code === 11 || code === 12 || (code >= 14 && code <= 31) || code === 127) continue;
    output += character;
  }
  return output;
}

export function sanitizeAbuseSummary(value: unknown): string {
  if (typeof value !== "string") throw new AppError("validation_failed", 400, ["summary_required"]);
  const summary = stripUnsafeControls(value)
    .replaceAll("\r\n", "\n")
    .replaceAll("\r", "\n")
    .replace(/-----BEGIN [^-]{1,80}-----[\s\S]*?-----END [^-]{1,80}-----/gu, "[redacted-key-material]")
    .replace(/\b\d{5,16}:[A-Za-z0-9_-]{20,}\b/gu, "[redacted-provider-token]")
    .replace(/((?:api[ _-]?key|checksum[ _-]?key|license[ _-]?key|password|secret|token)\s*[:=]\s*)[^\s,;]+/giu, "$1[redacted]")
    .replace(/https?:\/\/[^\s]+/giu, (candidate) => {
      try {
        const url = new URL(candidate);
        url.username = "";
        url.password = "";
        url.search = "";
        url.hash = "";
        return url.toString();
      } catch {
        return "[redacted-url]";
      }
    })
    .replace(/[ \t]+/gu, " ")
    .replace(/\n{3,}/gu, "\n\n")
    .trim();
  if (summary.length < 20 || summary.length > 2_000) {
    throw new AppError("validation_failed", 400, ["summary_invalid"]);
  }
  return summary;
}

function mapReport(row: AbuseReportRow): AbuseReportView {
  return {
    assigned: row.assignedAdminUserId !== null,
    category: row.category,
    createdAt: row.createdAt,
    ownerRestoreEligible: row.ownerRestoreEligible === 1,
    publicId: row.publicId,
    shopName: row.shopName,
    shopPublicId: row.shopPublicId,
    status: row.status,
    summary: row.summarySanitized,
    targetKind: row.targetKind,
    targetRef: row.targetRef,
    targetStatus: row.targetStatus,
    updatedAt: row.updatedAt,
  };
}

const REPORT_SELECT = `
  SELECT abuse_reports.id, abuse_reports.public_id AS publicId,
    abuse_reports.shop_id AS shopId, abuse_reports.target_kind AS targetKind,
    abuse_reports.target_ref AS targetRef, abuse_reports.category,
    abuse_reports.status, abuse_reports.summary_sanitized AS summarySanitized,
    abuse_reports.assigned_admin_user_id AS assignedAdminUserId,
    abuse_reports.created_at AS createdAt, abuse_reports.updated_at AS updatedAt,
    shops.public_id AS shopPublicId, shops.name AS shopName,
    CASE WHEN abuse_reports.target_kind = 'product' THEN (
      SELECT products.status FROM products
      WHERE products.id = abuse_reports.target_ref
        AND products.shop_id = abuse_reports.shop_id
      LIMIT 1
    ) ELSE NULL END AS targetStatus,
    CASE WHEN abuse_reports.target_kind = 'product'
      AND EXISTS (
        SELECT 1 FROM products
        WHERE products.id = abuse_reports.target_ref
          AND products.shop_id = abuse_reports.shop_id
          AND products.status = 'suspended'
      )
      AND COALESCE((
        SELECT CASE
          WHEN latest.action_kind = 'product_suspend'
            AND latest.abuse_report_id = abuse_reports.id
            AND json_extract(latest.safe_metadata_json, '$.actorScope') = 'shop_owner'
          THEN 1 ELSE 0
        END
        FROM moderation_actions AS latest
        WHERE latest.shop_id = abuse_reports.shop_id
          AND latest.target_kind = 'product'
          AND latest.target_ref = abuse_reports.target_ref
          AND latest.status = 'applied'
        ORDER BY latest.created_at DESC, latest.rowid DESC
        LIMIT 1
      ), 0) = 1
    THEN 1 ELSE 0 END AS ownerRestoreEligible
  FROM abuse_reports
  LEFT JOIN shops ON shops.id = abuse_reports.shop_id
`;

function clientAddress(request: Request): string {
  return request.headers.get("CF-Connecting-IP")?.trim() || "local";
}

async function verifyReportTurnstile(input: {
  env: AppBindings;
  request: Request;
  token: unknown;
}): Promise<void> {
  const configuration = resolveTurnstileConfiguration(input.env);
  if (configuration === null) {
    if (input.env.APP_ENV !== "local") throw new AppError("turnstile_unavailable", 503);
    return;
  }
  if (typeof input.token !== "string" || input.token.length < 10 || input.token.length > 2_048) {
    throw new AppError("turnstile_required", 403);
  }
  const body = new FormData();
  body.set("secret", configuration.secretKey);
  body.set("response", input.token);
  body.set("remoteip", clientAddress(input.request));
  body.set("idempotency_key", crypto.randomUUID());
  let response: Response;
  try {
    response = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
      body,
      method: "POST",
      signal: AbortSignal.timeout(5_000),
    });
  } catch {
    throw new AppError("turnstile_unavailable", 503);
  }
  const text = await response.text();
  if (new TextEncoder().encode(text).byteLength > 16_384) throw new AppError("turnstile_unavailable", 503);
  let result: unknown;
  try {
    result = JSON.parse(text) as unknown;
  } catch {
    throw new AppError("turnstile_unavailable", 503);
  }
  const envelope = typeof result === "object" && result !== null && !Array.isArray(result)
    ? result as { action?: unknown; hostname?: unknown; success?: unknown }
    : {};
  const hostname = new URL(input.request.url).hostname.toLowerCase();
  if (!response.ok || envelope.success !== true || envelope.action !== "report_abuse"
    || typeof envelope.hostname !== "string" || envelope.hostname.toLowerCase() !== hostname) {
    throw new AppError("turnstile_invalid", 403);
  }
}

async function guardAbuseReportRate(input: {
  env: AppBindings;
  request: Request;
  shopId: string;
  now: Date;
}): Promise<void> {
  const windowStartMs = Math.floor(input.now.getTime() / (REPORT_RATE_WINDOW_SECONDS * 1_000))
    * REPORT_RATE_WINDOW_SECONDS * 1_000;
  const windowStartedAt = new Date(windowStartMs).toISOString();
  const windowEndsAt = new Date(windowStartMs + REPORT_RATE_WINDOW_SECONDS * 1_000).toISOString();
  const subjectHash = await hmacToken(
    input.env.IDENTIFIER_HMAC_SECRET,
    `abuse-report-rate:v2:${input.shopId}`,
    clientAddress(input.request),
  );
  const row = await input.env.PLATFORM_DB.prepare(`
    INSERT INTO security_rate_limits (
      id, shop_id, scope_key, action, subject_hash, window_started_at,
      window_ends_at, request_count, blocked_count, blocked_until,
      version, created_at, updated_at
    ) VALUES (?, ?, ?, 'abuse_report', ?, ?, ?, 1, 0, NULL, 1, ?, ?)
    ON CONFLICT(scope_key, action, subject_hash, window_started_at)
    DO UPDATE SET
      request_count = security_rate_limits.request_count + 1,
      blocked_count = security_rate_limits.blocked_count + CASE
        WHEN security_rate_limits.request_count + 1 > ? THEN 1 ELSE 0 END,
      blocked_until = CASE
        WHEN security_rate_limits.request_count + 1 > ? THEN excluded.window_ends_at
        ELSE security_rate_limits.blocked_until END,
      version = security_rate_limits.version + 1,
      updated_at = excluded.updated_at
    RETURNING request_count AS requestCount
  `).bind(
    createId("lim"),
    input.shopId,
    `shop:${input.shopId}`,
    subjectHash,
    windowStartedAt,
    windowEndsAt,
    input.now.toISOString(),
    input.now.toISOString(),
    REPORT_RATE_LIMIT,
    REPORT_RATE_LIMIT,
  ).first<{ requestCount: number }>();
  if ((row?.requestCount ?? 1) > REPORT_RATE_LIMIT) throw new AppError("rate_limited", 429);
}

async function resolvePublicTarget(input: {
  env: AppBindings;
  productSlug?: unknown;
  shop: StorefrontShop;
  targetKind: PublicAbuseTargetKind;
}): Promise<{ targetRef: string }> {
  if (input.targetKind === "shop") return { targetRef: input.shop.id };
  if (input.targetKind === "domain") {
    const domain = await input.env.PLATFORM_DB.prepare(`
      SELECT id FROM shop_domains
      WHERE shop_id = ? AND hostname_normalized = ? AND status != 'deleted'
      LIMIT 1
    `).bind(input.shop.id, input.shop.currentHostname).first<{ id: string }>();
    if (domain === null) throw new AppError("resource_not_found", 404);
    return { targetRef: domain.id };
  }
  if (typeof input.productSlug !== "string" || !SAFE_PRODUCT_SLUG.test(input.productSlug)) {
    throw new AppError("validation_failed", 400, ["product_slug_invalid"]);
  }
  const product = await input.env.PLATFORM_DB.prepare(`
    SELECT id FROM products
    WHERE shop_id = ? AND slug = ? AND status != 'archived'
    LIMIT 1
  `).bind(input.shop.id, input.productSlug).first<{ id: string }>();
  if (product === null) throw new AppError("resource_not_found", 404);
  return { targetRef: product.id };
}

async function hashReporterContact(env: AppBindings, shopId: string, value: unknown): Promise<string | null> {
  if (value === undefined || value === null || value === "") return null;
  const email = normalizeEmail(value);
  return hmacToken(env.IDENTIFIER_HMAC_SECRET, `abuse-reporter-contact:${shopId}`, email);
}

export async function createPublicAbuseReport(input: {
  category: AbuseCategory;
  env: AppBindings;
  idempotencyKey: string | null;
  now?: Date;
  productSlug?: unknown;
  reporterContact?: unknown;
  request: Request;
  requestId: string;
  shop: StorefrontShop;
  summary: unknown;
  targetKind: PublicAbuseTargetKind;
  turnstileToken?: unknown;
}): Promise<{ created: boolean; report: Pick<AbuseReportView, "publicId" | "status"> }> {
  const idempotencyKey = requireIdempotencyKey(input.idempotencyKey);
  const summary = sanitizeAbuseSummary(input.summary);
  const reporterContactHash = await hashReporterContact(input.env, input.shop.id, input.reporterContact);
  const target = await resolvePublicTarget(input);
  const now = input.now ?? new Date();
  const publicDigest = await hmacToken(
    input.env.IDENTIFIER_HMAC_SECRET,
    `abuse-report-id:${input.shop.id}`,
    idempotencyKey,
  );
  const publicId = `abr_${publicDigest.slice(0, 40)}`;
  const requestHash = await sha256Json({
    category: input.category,
    reporterContactHash,
    shopId: input.shop.id,
    summary,
    targetKind: input.targetKind,
    targetRef: target.targetRef,
  });
  const evidenceReference = `request:${requestHash}`;
  const existing = await input.env.PLATFORM_DB.prepare(`
    SELECT public_id AS publicId, status, evidence_reference AS evidenceReference
    FROM abuse_reports WHERE public_id = ? LIMIT 1
  `).bind(publicId).first<{ evidenceReference: string | null; publicId: string; status: AbuseReportStatus }>();
  if (existing !== null) {
    if (existing.evidenceReference !== evidenceReference) throw new AppError("idempotency_conflict", 409);
    return { created: false, report: { publicId: existing.publicId, status: existing.status } };
  }
  await verifyReportTurnstile({ env: input.env, request: input.request, token: input.turnstileToken });
  await guardAbuseReportRate({ env: input.env, now, request: input.request, shopId: input.shop.id });

  const id = createId("abr");
  const nowIso = now.toISOString();
  const retainUntil = new Date(now.getTime() + REPORT_RETENTION_DAYS * 24 * 60 * 60_000).toISOString();
  const audit = createOperationsAuditEvent({
    action: "abuse.report_received",
    actorId: null,
    actorType: "system",
    metadata: { category: input.category, targetKind: input.targetKind },
    now,
    operationId: id,
    requestId: input.requestId,
    resourceId: id,
    resourceType: "abuse_report",
    retentionClass: "legal",
    shopId: input.shop.id,
    sourceKind: "http",
  });
  try {
    await input.env.PLATFORM_DB.batch([
      input.env.PLATFORM_DB.prepare(`
        INSERT INTO abuse_reports (
          id, public_id, shop_id, target_kind, target_ref, category, status,
          reporter_contact_hash, summary_sanitized, evidence_reference,
          retention_class, retain_until, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, 'received', ?, ?, ?, 'legal', ?, ?, ?)
      `).bind(
        id,
        publicId,
        input.shop.id,
        input.targetKind,
        target.targetRef,
        input.category,
        reporterContactHash,
        summary,
        evidenceReference,
        retainUntil,
        nowIso,
        nowIso,
      ),
      prepareOperationsAuditInsert(input.env, audit),
    ]);
  } catch {
    const replay = await input.env.PLATFORM_DB.prepare(`
      SELECT public_id AS publicId, status, evidence_reference AS evidenceReference
      FROM abuse_reports WHERE public_id = ? LIMIT 1
    `).bind(publicId).first<{ evidenceReference: string | null; publicId: string; status: AbuseReportStatus }>();
    if (replay !== null && replay.evidenceReference === evidenceReference) {
      return { created: false, report: { publicId: replay.publicId, status: replay.status } };
    }
    throw new AppError("abuse_report_conflict", 409);
  }
  return { created: true, report: { publicId, status: "received" } };
}

async function requirePlatformAdmin(input: {
  allowedRoles?: readonly PlatformAdminRole[];
  env: AppBindings;
  userId: string;
}): Promise<PlatformAdminRole> {
  const row = await input.env.PLATFORM_DB.prepare(`
    SELECT role FROM platform_admins
    WHERE user_id = ? AND status = 'active'
    LIMIT 1
  `).bind(input.userId).first<{ role: PlatformAdminRole }>();
  if (row === null || (input.allowedRoles !== undefined && !input.allowedRoles.includes(row.role))) {
    throw new AppError("authorization_denied", 403);
  }
  return row.role;
}

async function requireOwnerShop(input: {
  env: AppBindings;
  shopPublicId: string;
  userId: string;
}): Promise<{ id: string; name: string; publicId: string; status: string }> {
  const row = await input.env.PLATFORM_DB.prepare(`
    SELECT shops.id, shops.name, shops.public_id AS publicId, shops.status
    FROM shops
    INNER JOIN shop_members
      ON shop_members.shop_id = shops.id
      AND shop_members.user_id = ?
      AND shop_members.role = 'owner'
      AND shop_members.status = 'active'
    WHERE shops.public_id = ?
    LIMIT 1
  `).bind(input.userId, input.shopPublicId).first<{ id: string; name: string; publicId: string; status: string }>();
  if (row === null) throw new AppError("authorization_denied", 403);
  return row;
}

function parseCursor(value: string | null): { createdAt: string; id: string } | null {
  if (value === null || value === "") return null;
  try {
    const parsed = JSON.parse(atob(value.replaceAll("-", "+").replaceAll("_", "/"))) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("invalid");
    const row = parsed as { createdAt?: unknown; id?: unknown };
    if (typeof row.createdAt !== "string" || !Number.isFinite(Date.parse(row.createdAt))
      || typeof row.id !== "string" || !SAFE_CURSOR_ID.test(row.id)) throw new Error("invalid");
    return { createdAt: row.createdAt, id: row.id };
  } catch {
    throw new AppError("validation_failed", 400, ["cursor_invalid"]);
  }
}

function encodeCursor(row: { createdAt: string; id: string }): string {
  return btoa(JSON.stringify(row)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function listLimit(value: number | undefined): number {
  return value === undefined ? 30 : Math.min(Math.max(value, 1), 50);
}

async function listReports(input: {
  cursor: string | null;
  env: AppBindings;
  limit?: number;
  shopId: string | null;
  status: AbuseReportStatus | null;
}): Promise<{ nextCursor: string | null; reports: AbuseReportView[] }> {
  const cursor = parseCursor(input.cursor);
  const limit = listLimit(input.limit);
  const rows = await input.env.PLATFORM_DB.prepare(`${REPORT_SELECT}
    WHERE (? IS NULL OR abuse_reports.shop_id = ?)
      AND (? IS NULL OR abuse_reports.status = ?)
      AND (
        ? IS NULL OR abuse_reports.created_at < ?
        OR (abuse_reports.created_at = ? AND abuse_reports.id < ?)
      )
    ORDER BY abuse_reports.created_at DESC, abuse_reports.id DESC
    LIMIT ?
  `).bind(
    input.shopId,
    input.shopId,
    input.status,
    input.status,
    cursor?.createdAt ?? null,
    cursor?.createdAt ?? null,
    cursor?.createdAt ?? null,
    cursor?.id ?? null,
    limit + 1,
  ).all<AbuseReportRow>();
  const page = rows.results.slice(0, limit);
  const last = page.at(-1);
  return {
    nextCursor: rows.results.length > limit && last !== undefined
      ? encodeCursor({ createdAt: last.createdAt, id: last.id })
      : null,
    reports: page.map(mapReport),
  };
}

export async function listAdminAbuseReports(input: {
  cursor: string | null;
  env: AppBindings;
  limit?: number;
  status: AbuseReportStatus | null;
  userId: string;
}): Promise<{ nextCursor: string | null; reports: AbuseReportView[] }> {
  await requirePlatformAdmin({ env: input.env, userId: input.userId });
  return listReports({
    cursor: input.cursor,
    env: input.env,
    ...(input.limit === undefined ? {} : { limit: input.limit }),
    shopId: null,
    status: input.status,
  });
}

export async function listOwnerAbuseReports(input: {
  cursor: string | null;
  env: AppBindings;
  limit?: number;
  shopPublicId: string;
  status: AbuseReportStatus | null;
  userId: string;
}): Promise<{ nextCursor: string | null; reports: AbuseReportView[] }> {
  const shop = await requireOwnerShop(input);
  return listReports({
    cursor: input.cursor,
    env: input.env,
    ...(input.limit === undefined ? {} : { limit: input.limit }),
    shopId: shop.id,
    status: input.status,
  });
}

export async function listRecentModerationActions(input: {
  env: AppBindings;
  limit?: number;
  userId: string;
}): Promise<ModerationActionListItem[]> {
  await requirePlatformAdmin({ env: input.env, userId: input.userId });
  const limit = listLimit(input.limit);
  const rows = await input.env.PLATFORM_DB.prepare(`
    SELECT moderation_actions.id, moderation_actions.action_kind AS actionKind,
      moderation_actions.target_kind AS targetKind,
      moderation_actions.target_ref AS targetRef, moderation_actions.status,
      moderation_actions.safe_reason_code AS reasonCode,
      moderation_actions.actor_admin_user_id AS actorAdminUserId,
      moderation_actions.created_at AS createdAt,
      shops.public_id AS shopPublicId, shops.name AS shopName
    FROM moderation_actions
    LEFT JOIN shops ON shops.id = moderation_actions.shop_id
    ORDER BY moderation_actions.created_at DESC, moderation_actions.id DESC
    LIMIT ?
  `).bind(limit).all<ModerationActionListItem>();
  return rows.results;
}

async function findIdempotency(input: {
  actorUserId: string;
  env: AppBindings;
  keyHash: string;
  namespace: string;
  nowIso: string;
}): Promise<StoredIdempotency | null> {
  return input.env.PLATFORM_DB.prepare(`
    SELECT request_hash, response_json FROM idempotency_records
    WHERE actor_user_id = ? AND namespace = ? AND key_hash = ? AND expires_at > ?
    LIMIT 1
  `).bind(input.actorUserId, input.namespace, input.keyHash, input.nowIso).first<StoredIdempotency>();
}

function parseStored(stored: StoredIdempotency | null, requestHash: string): unknown {
  if (stored === null) return null;
  if (stored.request_hash !== requestHash) throw new AppError("idempotency_conflict", 409);
  try {
    return JSON.parse(stored.response_json) as unknown;
  } catch {
    throw new AppError("internal_error", 500);
  }
}

function parseStoredReportTransition(stored: StoredIdempotency | null, requestHash: string): {
  publicId: string;
  status: AbuseReportStatus;
} | null {
  const parsed = parseStored(stored, requestHash);
  if (parsed === null) return null;
  if (typeof parsed !== "object" || Array.isArray(parsed)) throw new AppError("internal_error", 500);
  const row = parsed as { publicId?: unknown; status?: unknown };
  if (typeof row.publicId !== "string" || !isOneOf(row.status, ABUSE_REPORT_STATUSES)) {
    throw new AppError("internal_error", 500);
  }
  return { publicId: row.publicId, status: row.status };
}

function parseStoredModerationAction(stored: StoredIdempotency | null, requestHash: string): ModerationActionView | null {
  const parsed = parseStored(stored, requestHash);
  if (parsed === null) return null;
  if (typeof parsed !== "object" || Array.isArray(parsed)) throw new AppError("internal_error", 500);
  const row = parsed as Partial<Record<keyof ModerationActionView, unknown>>;
  if (!isOneOf(row.actionKind, ADMIN_ACTION_KINDS)
    || typeof row.appliedAt !== "string"
    || typeof row.id !== "string"
    || typeof row.newStatus !== "string"
    || typeof row.shopPublicId !== "string"
    || row.status !== "applied"
    || (row.targetKind !== "product" && row.targetKind !== "shop")
    || typeof row.targetRef !== "string") {
    throw new AppError("internal_error", 500);
  }
  return {
    actionKind: row.actionKind,
    appliedAt: row.appliedAt,
    id: row.id,
    newStatus: row.newStatus,
    shopPublicId: row.shopPublicId,
    status: row.status,
    targetKind: row.targetKind,
    targetRef: row.targetRef,
  };
}

const REPORT_TRANSITIONS: Readonly<Record<AbuseReportStatus, ReadonlySet<AbuseReportStatus>>> = {
  actioned: new Set(["closed", "investigating"]),
  closed: new Set(),
  dismissed: new Set(["closed", "investigating"]),
  investigating: new Set(["actioned", "closed", "dismissed"]),
  received: new Set(["dismissed", "investigating", "triaged"]),
  triaged: new Set(["closed", "dismissed", "investigating"]),
};

export async function transitionAbuseReport(input: {
  adminUserId: string;
  env: AppBindings;
  idempotencyKey: string | null;
  now?: Date;
  reportPublicId: string;
  requestId: string;
  status: AbuseReportStatus;
}): Promise<{ publicId: string; status: AbuseReportStatus }> {
  const role = await requirePlatformAdmin({ env: input.env, userId: input.adminUserId });
  const idempotencyKey = requireIdempotencyKey(input.idempotencyKey);
  const now = input.now ?? new Date();
  const nowIso = now.toISOString();
  const report = await input.env.PLATFORM_DB.prepare(`${REPORT_SELECT}
    WHERE abuse_reports.public_id = ? LIMIT 1
  `).bind(input.reportPublicId).first<AbuseReportRow>();
  if (report === null) throw new AppError("abuse_report_not_found", 404);
  const namespace = "admin.abuse-report.transition.v1";
  const keyHash = await hmacToken(input.env.SESSION_SECRET, "idempotency", idempotencyKey);
  const requestHash = await sha256Json({ reportPublicId: input.reportPublicId, status: input.status });
  const replay = parseStoredReportTransition(
    await findIdempotency({ actorUserId: input.adminUserId, env: input.env, keyHash, namespace, nowIso }),
    requestHash,
  );
  if (replay !== null) return replay;
  const supportMayTriage = report.status === "received" && input.status === "triaged";
  if (role === "support" && !supportMayTriage) throw new AppError("authorization_denied", 403);
  if (!REPORT_TRANSITIONS[report.status].has(input.status)) {
    throw new AppError("abuse_report_transition_conflict", 409);
  }
  const response = { publicId: report.publicId, status: input.status };
  const audit = createOperationsAuditEvent({
    action: "abuse.report_status_changed",
    actorId: input.adminUserId,
    actorType: "platform_admin",
    metadata: {
      newStatus: input.status,
      previousStatus: report.status,
      reportPublicId: report.publicId,
      targetKind: report.targetKind,
    },
    now,
    operationId: report.id,
    requestId: input.requestId,
    resourceId: report.id,
    resourceType: "abuse_report",
    retentionClass: "legal",
    shopId: report.shopId,
  });
  const expiresAt = new Date(now.getTime() + IDEMPOTENCY_TTL_MS).toISOString();
  try {
    const results = await input.env.PLATFORM_DB.batch([
      input.env.PLATFORM_DB.prepare(`
        UPDATE abuse_reports
        SET status = ?, assigned_admin_user_id = ?, updated_at = ?
        WHERE id = ? AND status = ?
      `).bind(input.status, input.adminUserId, nowIso, report.id, report.status),
      prepareOperationsAuditForReportTransition(input.env, audit, {
        reportId: report.id,
        status: input.status,
        updatedAt: nowIso,
      }),
      input.env.PLATFORM_DB.prepare(`
        INSERT INTO idempotency_records (
          actor_user_id, namespace, key_hash, request_hash, response_json, created_at, expires_at
        )
        SELECT ?, ?, ?, ?, ?, ?, ?
        WHERE EXISTS (
          SELECT 1 FROM abuse_reports WHERE id = ? AND status = ? AND updated_at = ?
        )
      `).bind(
        input.adminUserId,
        namespace,
        keyHash,
        requestHash,
        JSON.stringify(response),
        nowIso,
        expiresAt,
        report.id,
        input.status,
        nowIso,
      ),
    ]);
    if ((results[0]?.meta.changes ?? 0) !== 1 || (results[1]?.meta.changes ?? 0) !== 1) {
      throw new AppError("abuse_report_transition_conflict", 409);
    }
  } catch (error) {
    const stored = parseStoredReportTransition(
      await findIdempotency({ actorUserId: input.adminUserId, env: input.env, keyHash, namespace, nowIso }),
      requestHash,
    );
    if (stored !== null) return stored;
    if (error instanceof AppError) throw error;
    throw new AppError("abuse_report_transition_conflict", 409);
  }
  return response;
}

async function previousModeratedStatus(input: {
  actionKind: "product_suspend" | "shop_suspend";
  env: AppBindings;
  shopId: string;
  targetKind: "product" | "shop";
  targetRef: string;
}): Promise<{ actorScope: "platform_admin" | "shop_owner"; previousStatus: "active" | "draft" }> {
  const row = await input.env.PLATFORM_DB.prepare(`
    SELECT action_kind AS actionKind, status,
      json_extract(safe_metadata_json, '$.actorScope') AS actorScope,
      json_extract(safe_metadata_json, '$.previousStatus') AS previousStatus
    FROM moderation_actions
    WHERE shop_id = ? AND target_kind = ? AND target_ref = ?
    ORDER BY created_at DESC, rowid DESC
    LIMIT 1
  `).bind(input.shopId, input.targetKind, input.targetRef).first<{
    actionKind: string;
    actorScope: string | null;
    previousStatus: string | null;
    status: string;
  }>();
  if (row?.actionKind === input.actionKind && row.status === "applied"
    && (row.actorScope === "platform_admin" || row.actorScope === "shop_owner")
    && (row.previousStatus === "active" || row.previousStatus === "draft")) {
    return { actorScope: row.actorScope, previousStatus: row.previousStatus };
  }
  throw new AppError("moderation_restore_unavailable", 409);
}

async function resolveModerationTarget(input: {
  actionKind: ModerationActionKind;
  env: AppBindings;
  shop: { id: string; publicId: string; status: string };
  targetId?: string;
}): Promise<{
  currentStatus: string;
  newStatus: string;
  suspensionActorScope?: "platform_admin" | "shop_owner";
  targetKind: "product" | "shop";
  targetRef: string;
}> {
  if (input.actionKind.startsWith("shop_")) {
    if (input.actionKind === "shop_suspend") {
      return { currentStatus: input.shop.status, newStatus: "suspended", targetKind: "shop", targetRef: input.shop.id };
    }
    const previous = await previousModeratedStatus({
      actionKind: "shop_suspend",
      env: input.env,
      shopId: input.shop.id,
      targetKind: "shop",
      targetRef: input.shop.id,
    });
    return {
      currentStatus: input.shop.status,
      newStatus: previous.previousStatus,
      suspensionActorScope: previous.actorScope,
      targetKind: "shop",
      targetRef: input.shop.id,
    };
  }
  if (input.targetId === undefined || !/^prd_[0-9a-f-]{36}$/u.test(input.targetId)) {
    throw new AppError("resource_not_found", 404);
  }
  const product = await input.env.PLATFORM_DB.prepare(`
    SELECT id, status FROM products WHERE id = ? AND shop_id = ? LIMIT 1
  `).bind(input.targetId, input.shop.id).first<TargetStatus>();
  if (product === null) throw new AppError("resource_not_found", 404);
  if (input.actionKind === "product_suspend") {
    return { currentStatus: product.status, newStatus: "suspended", targetKind: "product", targetRef: product.id };
  }
  const previous = await previousModeratedStatus({
    actionKind: "product_suspend",
    env: input.env,
    shopId: input.shop.id,
    targetKind: "product",
    targetRef: product.id,
  });
  return {
    currentStatus: product.status,
    newStatus: previous.previousStatus,
    suspensionActorScope: previous.actorScope,
    targetKind: "product",
    targetRef: product.id,
  };
}

async function resolveAdminShop(input: {
  env: AppBindings;
  shopPublicId: string;
}): Promise<{ id: string; name: string; publicId: string; status: string }> {
  const shop = await input.env.PLATFORM_DB.prepare(`
    SELECT id, name, public_id AS publicId, status
    FROM shops WHERE public_id = ? LIMIT 1
  `).bind(input.shopPublicId).first<{ id: string; name: string; publicId: string; status: string }>();
  if (shop === null) throw new AppError("tenant_not_found", 404);
  return shop;
}

async function resolveLinkedReport(input: {
  env: AppBindings;
  reportPublicId: string | null;
  shopId: string;
  targetKind: "product" | "shop";
  targetRef: string;
}): Promise<{ id: string; publicId: string } | null> {
  if (input.reportPublicId === null) return null;
  const report = await input.env.PLATFORM_DB.prepare(`
    SELECT id, public_id AS publicId FROM abuse_reports
    WHERE public_id = ? AND shop_id = ? AND target_kind = ? AND target_ref = ?
      AND status NOT IN ('closed', 'dismissed')
    LIMIT 1
  `).bind(input.reportPublicId, input.shopId, input.targetKind, input.targetRef)
    .first<{ id: string; publicId: string }>();
  if (report === null) throw new AppError("abuse_report_not_found", 404);
  return report;
}

export async function applyModerationAction(input: {
  actionKind: ModerationActionKind;
  actorScope: "platform_admin" | "shop_owner";
  actorUserId: string;
  env: AppBindings;
  idempotencyKey: string | null;
  now?: Date;
  reasonCode: unknown;
  reportPublicId?: string | null;
  requestId: string;
  shopPublicId: string;
  targetId?: string;
}): Promise<ModerationActionView> {
  const reasonCode = requireReasonCode(input.reasonCode);
  const idempotencyKey = requireIdempotencyKey(input.idempotencyKey);
  const shop = input.actorScope === "platform_admin"
    ? await (async () => {
      await requirePlatformAdmin({ allowedRoles: ["owner", "risk"], env: input.env, userId: input.actorUserId });
      return resolveAdminShop(input);
    })()
    : await requireOwnerShop({ env: input.env, shopPublicId: input.shopPublicId, userId: input.actorUserId });
  if (input.actorScope === "shop_owner" && !input.actionKind.startsWith("product_")) {
    throw new AppError("authorization_denied", 403);
  }
  const target = await resolveModerationTarget({
    actionKind: input.actionKind,
    env: input.env,
    shop,
    ...(input.targetId === undefined ? {} : { targetId: input.targetId }),
  });
  if (input.actorScope === "shop_owner" && input.actionKind.endsWith("_restore")
    && target.suspensionActorScope !== "shop_owner") {
    throw new AppError("moderation_restore_unavailable", 409);
  }
  const now = input.now ?? new Date();
  const nowIso = now.toISOString();
  const namespace = `${input.actorScope}.moderation-action.v1`;
  const keyHash = await hmacToken(input.env.SESSION_SECRET, "idempotency", idempotencyKey);
  const requestHash = await sha256Json({
    actionKind: input.actionKind,
    reasonCode,
    reportPublicId: input.reportPublicId ?? null,
    shopPublicId: shop.publicId,
    targetRef: target.targetRef,
  });
  const replay = parseStoredModerationAction(
    await findIdempotency({ actorUserId: input.actorUserId, env: input.env, keyHash, namespace, nowIso }),
    requestHash,
  );
  if (replay !== null) return replay;
  const linkedReport = await resolveLinkedReport({
    env: input.env,
    reportPublicId: input.reportPublicId ?? null,
    shopId: shop.id,
    targetKind: target.targetKind,
    targetRef: target.targetRef,
  });
  if (target.currentStatus === "archived") throw new AppError("moderation_state_conflict", 409);
  if (input.actionKind.endsWith("_suspend") && target.currentStatus === "suspended") {
    throw new AppError("moderation_state_conflict", 409);
  }
  if (input.actionKind.endsWith("_restore") && target.currentStatus !== "suspended") {
    throw new AppError("moderation_state_conflict", 409);
  }

  const actionId = createId("mod");
  const response: ModerationActionView = {
    actionKind: input.actionKind,
    appliedAt: nowIso,
    id: actionId,
    newStatus: target.newStatus,
    shopPublicId: shop.publicId,
    status: "applied",
    targetKind: target.targetKind,
    targetRef: target.targetRef,
  };
  const safeMetadata = {
    actorScope: input.actorScope,
    newStatus: target.newStatus,
    previousStatus: target.currentStatus,
    ...(linkedReport === null ? {} : { reportPublicId: linkedReport.publicId }),
  };
  const retainUntil = new Date(now.getTime() + MODERATION_RETENTION_DAYS * 24 * 60 * 60_000).toISOString();
  const expiresAt = new Date(now.getTime() + IDEMPOTENCY_TTL_MS).toISOString();
  const audit = createOperationsAuditEvent({
    action: `moderation.${input.actionKind}`,
    actorId: input.actorUserId,
    actorType: input.actorScope === "platform_admin" ? "platform_admin" : "user",
    metadata: { ...safeMetadata, reasonCode, targetKind: target.targetKind },
    now,
    operationId: actionId,
    requestId: input.requestId,
    resourceId: target.targetRef,
    resourceType: target.targetKind,
    retentionClass: "legal",
    shopId: shop.id,
  });

  const statements: D1PreparedStatement[] = [];
  if (target.targetKind === "shop") {
    statements.push(input.env.PLATFORM_DB.prepare(`
      UPDATE shops
      SET status = ?, readiness_version = readiness_version + 1, updated_at = ?
      WHERE id = ? AND public_id = ? AND status = ?
    `).bind(target.newStatus, nowIso, shop.id, shop.publicId, target.currentStatus));
    statements.push(input.env.PLATFORM_DB.prepare(`
      UPDATE shop_domains SET version = version + 1, updated_at = ?
      WHERE shop_id = ? AND EXISTS (
        SELECT 1 FROM shops WHERE id = ? AND status = ? AND updated_at = ?
      )
    `).bind(nowIso, shop.id, shop.id, target.newStatus, nowIso));
  } else {
    statements.push(input.env.PLATFORM_DB.prepare(`
      UPDATE products
      SET status = ?, version = version + 1, updated_at = ?
      WHERE id = ? AND shop_id = ? AND status = ?
    `).bind(target.newStatus, nowIso, target.targetRef, shop.id, target.currentStatus));
    statements.push(input.env.PLATFORM_DB.prepare(`
      UPDATE shops SET readiness_version = readiness_version + 1, updated_at = ?
      WHERE id = ? AND EXISTS (
        SELECT 1 FROM products
        WHERE id = ? AND shop_id = ? AND status = ? AND updated_at = ?
      )
    `).bind(nowIso, shop.id, target.targetRef, shop.id, target.newStatus, nowIso));
    statements.push(input.env.PLATFORM_DB.prepare(`
      UPDATE shop_domains SET version = version + 1, updated_at = ?
      WHERE shop_id = ? AND EXISTS (
        SELECT 1 FROM products
        WHERE id = ? AND shop_id = ? AND status = ? AND updated_at = ?
      )
    `).bind(nowIso, shop.id, target.targetRef, shop.id, target.newStatus, nowIso));
  }
  const actionInsertIndex = statements.length;
  statements.push(input.env.PLATFORM_DB.prepare(`
    INSERT INTO moderation_actions (
      id, shop_id, abuse_report_id, action_kind, target_kind, target_ref,
      status, safe_reason_code, safe_metadata_json, actor_admin_user_id,
      request_id, retention_class, retain_until, applied_at, created_at, updated_at
    )
    SELECT ?, ?, ?, ?, ?, ?, 'applied', ?, ?, ?, ?, 'legal', ?, ?, ?, ?
    WHERE EXISTS (
      SELECT 1 FROM ${target.targetKind === "shop" ? "shops" : "products"}
      WHERE id = ? AND status = ? AND updated_at = ?
      ${target.targetKind === "product" ? "AND shop_id = ?" : ""}
    )
  `).bind(
    actionId,
    shop.id,
    linkedReport?.id ?? null,
    input.actionKind,
    target.targetKind,
    target.targetRef,
    reasonCode,
    JSON.stringify(safeMetadata),
    input.actorUserId,
    input.requestId,
    retainUntil,
    nowIso,
    nowIso,
    nowIso,
    target.targetRef,
    target.newStatus,
    nowIso,
    ...(target.targetKind === "product" ? [shop.id] : []),
  ));
  if (linkedReport !== null) {
    statements.push(input.env.PLATFORM_DB.prepare(`
      UPDATE abuse_reports
      SET status = 'actioned', assigned_admin_user_id = ?, updated_at = ?
      WHERE id = ? AND EXISTS (
        SELECT 1 FROM moderation_actions WHERE id = ? AND status = 'applied'
      )
    `).bind(input.actorUserId, nowIso, linkedReport.id, actionId));
  }
  statements.push(prepareOperationsAuditForAppliedModeration(input.env, audit, actionId));
  statements.push(input.env.PLATFORM_DB.prepare(`
    INSERT INTO idempotency_records (
      actor_user_id, namespace, key_hash, request_hash, response_json, created_at, expires_at
    )
    SELECT ?, ?, ?, ?, ?, ?, ?
    WHERE EXISTS (SELECT 1 FROM moderation_actions WHERE id = ? AND status = 'applied')
  `).bind(
    input.actorUserId,
    namespace,
    keyHash,
    requestHash,
    JSON.stringify(response),
    nowIso,
    expiresAt,
    actionId,
  ));

  try {
    const results = await input.env.PLATFORM_DB.batch(statements);
    if ((results[0]?.meta.changes ?? 0) !== 1
      || (results[actionInsertIndex]?.meta.changes ?? 0) !== 1) {
      throw new AppError("moderation_state_conflict", 409);
    }
  } catch (error) {
    const stored = parseStoredModerationAction(
      await findIdempotency({ actorUserId: input.actorUserId, env: input.env, keyHash, namespace, nowIso }),
      requestHash,
    );
    if (stored !== null) return stored;
    if (error instanceof AppError) throw error;
    throw new AppError("moderation_state_conflict", 409);
  }
  return response;
}
