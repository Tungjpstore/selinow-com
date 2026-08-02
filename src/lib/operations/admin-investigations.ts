import { AppError } from "../core/errors";
import type { AppBindings } from "../platform/bindings";
import { getPlatformAdminRole } from "../tenants/store";

const MAX_LIMIT = 50;
const DEFAULT_LIMIT = 25;
const CURSOR_PATTERN = /^[A-Za-z0-9_-]{20,512}$/u;

type OrderCursor = { orderPublicId: string; updatedAt: string };
type AuditCursor = { auditId: string; createdAt: string };

export type AdminOrderInvestigation = {
  createdAt: string;
  currency: string;
  customerEmailMasked: string | null;
  fulfillmentStatus: string;
  orderNumber: string;
  orderPublicId: string;
  paymentEvidence: { expectedAmountMinor: number; lastSafeErrorCode: string | null; provider: string; state: string; updatedAt: string } | null;
  paymentStatus: string;
  shopName: string;
  shopPublicId: string;
  status: string;
  totalMinor: number;
  updatedAt: string;
};

export type AdminAuditEntry = {
  action: string;
  actorType: string;
  createdAt: string;
  metadata: Record<string, string | number | boolean | null>;
  requestId: string;
  resourceId: string | null;
  resourceType: string;
  shopName: string | null;
  shopPublicId: string | null;
};

function listLimit(value: number | undefined): number {
  if (value === undefined) return DEFAULT_LIMIT;
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_LIMIT) throw new AppError("validation_failed", 400, ["limit_invalid"]);
  return value;
}

function decodeCursor(value: string | null, kind: "audit" | "order"): Record<string, unknown> | null {
  if (value === null || value === "") return null;
  if (!CURSOR_PATTERN.test(value)) throw new AppError("validation_failed", 400, [`${kind}_cursor_invalid`]);
  try {
    const decoded = atob(value.replaceAll("-", "+").replaceAll("_", "/"));
    const parsed = JSON.parse(decoded) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("invalid");
    return parsed as Record<string, unknown>;
  } catch {
    throw new AppError("validation_failed", 400, [`${kind}_cursor_invalid`]);
  }
}

function encodeCursor(value: object): string {
  return btoa(JSON.stringify(value)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function maskEmail(value: string | null): string | null {
  if (value === null || value.length === 0) return null;
  const [local, domain] = value.split("@", 2);
  if (local === undefined || domain === undefined || local.length === 0) return "***";
  const visible = local.slice(0, Math.min(2, local.length));
  return `${visible}${"*".repeat(Math.max(1, local.length - visible.length))}@${domain}`;
}

function safeMetadata(value: string): Record<string, string | number | boolean | null> {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
    const result: Record<string, string | number | boolean | null> = {};
    for (const [key, item] of Object.entries(parsed as Record<string, unknown>)) {
      if (/(token|secret|password|credential|cipher|plaintext|payload|hash|key)/iu.test(key)) continue;
      if (item === null || typeof item === "string" || typeof item === "number" || typeof item === "boolean") result[key] = item;
    }
    return result;
  } catch {
    return {};
  }
}

async function requireAdmin(env: AppBindings, userId: string): Promise<void> {
  if (await getPlatformAdminRole({ env, userId }) === null) throw new AppError("authorization_denied", 403);
}

export async function listAdminOrderInvestigations(input: {
  env: AppBindings;
  filters: { cursor: string | null; limit?: number; paymentStatus?: string | null; query?: string | null; shopPublicId?: string | null };
  userId: string;
}): Promise<{ nextCursor: string | null; orders: AdminOrderInvestigation[] }> {
  await requireAdmin(input.env, input.userId);
  const limit = listLimit(input.filters.limit);
  const cursor = decodeCursor(input.filters.cursor, "order") as OrderCursor | null;
  const conditions = ["1 = 1"];
  const values: unknown[] = [];
  if (input.filters.shopPublicId !== undefined && input.filters.shopPublicId !== null && input.filters.shopPublicId !== "") {
    conditions.push("shops.public_id = ?");
    values.push(input.filters.shopPublicId);
  }
  if (input.filters.paymentStatus !== undefined && input.filters.paymentStatus !== null && input.filters.paymentStatus !== "") {
    if (!/^[a-z_]{2,32}$/u.test(input.filters.paymentStatus)) throw new AppError("validation_failed", 400, ["payment_status_invalid"]);
    conditions.push("orders.payment_status = ?");
    values.push(input.filters.paymentStatus);
  }
  const query = input.filters.query?.trim();
  if (query !== undefined && query !== "") {
    const hasControlCharacter = Array.from(query).some((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint <= 31 || codePoint === 127;
    });
    if (query.length > 64 || hasControlCharacter) throw new AppError("validation_failed", 400, ["query_invalid"]);
    conditions.push("(orders.public_id LIKE ? ESCAPE '\\' OR orders.order_number LIKE ? ESCAPE '\\')");
    const escaped = query.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_");
    values.push(`%${escaped}%`, `%${escaped}%`);
  }
  if (cursor !== null) {
    if (typeof cursor.updatedAt !== "string" || typeof cursor.orderPublicId !== "string") throw new AppError("validation_failed", 400, ["order_cursor_invalid"]);
    conditions.push("(orders.updated_at < ? OR (orders.updated_at = ? AND orders.public_id < ?))");
    values.push(cursor.updatedAt, cursor.updatedAt, cursor.orderPublicId);
  }
  const rows = await input.env.PLATFORM_DB.prepare(`
    SELECT orders.public_id AS orderPublicId, orders.order_number AS orderNumber,
      orders.status, orders.payment_status AS paymentStatus,
      orders.fulfillment_status AS fulfillmentStatus, orders.total_minor AS totalMinor,
      orders.currency, orders.customer_email_masked AS customerEmailMasked,
      orders.created_at AS createdAt, orders.updated_at AS updatedAt,
      shops.public_id AS shopPublicId, shops.name AS shopName,
      payment_attempts.provider, payment_attempts.state,
      payment_attempts.expected_amount_minor AS expectedAmountMinor,
      payment_attempts.last_safe_error_code AS lastSafeErrorCode,
      payment_attempts.updated_at AS paymentUpdatedAt
    FROM orders
    INNER JOIN shops ON shops.id = orders.shop_id
    LEFT JOIN payment_attempts ON payment_attempts.id = (
      SELECT id FROM payment_attempts AS latest_payment_attempt
      WHERE latest_payment_attempt.shop_id = orders.shop_id
        AND latest_payment_attempt.order_id = orders.id
      ORDER BY latest_payment_attempt.updated_at DESC, latest_payment_attempt.id DESC
      LIMIT 1
    )
    WHERE ${conditions.join(" AND ")}
    ORDER BY orders.updated_at DESC, orders.public_id DESC
    LIMIT ?
  `).bind(...values, limit + 1).all<{
    createdAt: string; currency: string; customerEmailMasked: string | null;
    fulfillmentStatus: string; lastSafeErrorCode: string | null; orderNumber: string;
    orderPublicId: string; paymentStatus: string; paymentUpdatedAt: string | null;
    provider: string | null; shopName: string; shopPublicId: string; state: string | null;
    status: string; totalMinor: number; updatedAt: string; expectedAmountMinor: number | null;
  }>();
  const page = rows.results.slice(0, limit);
  const next = rows.results.length > limit ? page.at(-1) : undefined;
  return {
    nextCursor: next === undefined ? null : encodeCursor({ orderPublicId: next.orderPublicId, updatedAt: next.updatedAt }),
    orders: page.map((row) => ({
      createdAt: row.createdAt,
      currency: row.currency,
      customerEmailMasked: maskEmail(row.customerEmailMasked),
      fulfillmentStatus: row.fulfillmentStatus,
      orderNumber: row.orderNumber,
      orderPublicId: row.orderPublicId,
      paymentEvidence: row.provider === null || row.expectedAmountMinor === null || row.paymentUpdatedAt === null
        ? null
        : {
          expectedAmountMinor: row.expectedAmountMinor,
          lastSafeErrorCode: row.lastSafeErrorCode,
          provider: row.provider,
          state: row.state ?? "unknown",
          updatedAt: row.paymentUpdatedAt,
        },
      paymentStatus: row.paymentStatus,
      shopName: row.shopName,
      shopPublicId: row.shopPublicId,
      status: row.status,
      totalMinor: row.totalMinor,
      updatedAt: row.updatedAt,
    })),
  };
}

export async function listAdminAuditEntries(input: {
  env: AppBindings;
  filters: { action?: string | null; cursor: string | null; limit?: number; resourceType?: string | null; shopPublicId?: string | null };
  userId: string;
}): Promise<{ entries: AdminAuditEntry[]; nextCursor: string | null }> {
  await requireAdmin(input.env, input.userId);
  const limit = listLimit(input.filters.limit);
  const cursor = decodeCursor(input.filters.cursor, "audit") as AuditCursor | null;
  const conditions = ["1 = 1"];
  const values: unknown[] = [];
  for (const [field, value] of [["audit_logs.action", input.filters.action], ["audit_logs.resource_type", input.filters.resourceType]] as const) {
    if (value !== undefined && value !== null && value !== "") {
      if (!/^[a-z0-9_.:-]{2,64}$/u.test(value)) throw new AppError("validation_failed", 400, ["audit_filter_invalid"]);
      conditions.push(`${field} = ?`);
      values.push(value);
    }
  }
  if (input.filters.shopPublicId !== undefined && input.filters.shopPublicId !== null && input.filters.shopPublicId !== "") {
    conditions.push("shops.public_id = ?");
    values.push(input.filters.shopPublicId);
  }
  if (cursor !== null) {
    if (typeof cursor.createdAt !== "string" || typeof cursor.auditId !== "string") throw new AppError("validation_failed", 400, ["audit_cursor_invalid"]);
    conditions.push("(audit_logs.created_at < ? OR (audit_logs.created_at = ? AND audit_logs.id < ?))");
    values.push(cursor.createdAt, cursor.createdAt, cursor.auditId);
  }
  const rows = await input.env.PLATFORM_DB.prepare(`
    SELECT audit_logs.id, audit_logs.action, audit_logs.actor_type AS actorType,
      audit_logs.created_at AS createdAt, audit_logs.request_id AS requestId,
      audit_logs.resource_id AS resourceId, audit_logs.resource_type AS resourceType,
      audit_logs.safe_metadata_json AS metadataJson,
      shops.public_id AS shopPublicId, shops.name AS shopName
    FROM audit_logs
    LEFT JOIN shops ON shops.id = audit_logs.shop_id
    WHERE ${conditions.join(" AND ")}
    ORDER BY audit_logs.created_at DESC, audit_logs.id DESC
    LIMIT ?
  `).bind(...values, limit + 1).all<{ action: string; actorType: string; createdAt: string; id: string; metadataJson: string; requestId: string; resourceId: string | null; resourceType: string; shopName: string | null; shopPublicId: string | null }>();
  const page = rows.results.slice(0, limit);
  const next = rows.results.length > limit ? page.at(-1) : undefined;
  return {
    entries: page.map((row) => ({ action: row.action, actorType: row.actorType, createdAt: row.createdAt, metadata: safeMetadata(row.metadataJson), requestId: row.requestId, resourceId: row.resourceId, resourceType: row.resourceType, shopName: row.shopName, shopPublicId: row.shopPublicId })),
    nextCursor: next === undefined ? null : encodeCursor({ auditId: next.id, createdAt: next.createdAt }),
  };
}
