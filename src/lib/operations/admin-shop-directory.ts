import { AppError } from "../core/errors";
import type { AppBindings } from "../platform/bindings";
import { getPlatformAdminRole, type PlatformAdminRole } from "../tenants/store";

export type AdminShopStatus = "draft" | "active" | "suspended" | "archived";
export type AdminSubscriptionState = "trialing" | "active" | "past_due" | "grace_period" | "pending_payment" | "suspended" | "canceled";

export type AdminShopDirectoryItem = {
  activeMemberCount: number;
  activeOwnerCount: number;
  activeProductCount: number;
  currency: string;
  defaultLocale: string;
  degradedConnectionCount: number;
  createdAt: string;
  name: string;
  openConnectionCount: number;
  planCode: string | null;
  publicId: string;
  slug: string;
  status: AdminShopStatus;
  subscriptionState: AdminSubscriptionState | null;
  updatedAt: string;
};

export type AdminShopDirectoryFilters = {
  cursor: string | null;
  limit?: number;
  query: string | null;
  shopStatus: AdminShopStatus | null;
  subscriptionState: AdminSubscriptionState | null;
};

const SHOP_STATUSES: readonly AdminShopStatus[] = ["draft", "active", "suspended", "archived"];
const SUBSCRIPTION_STATES: readonly AdminSubscriptionState[] = [
  "trialing",
  "active",
  "past_due",
  "grace_period",
  "pending_payment",
  "suspended",
  "canceled",
];
const SAFE_PUBLIC_ID = /^[A-Za-z0-9_-]{1,128}$/u;
const MAX_QUERY_LENGTH = 64;
const MAX_LIMIT = 50;
const DEFAULT_LIMIT = 25;

type AdminShopDirectoryRow = AdminShopDirectoryItem;

export function parseAdminShopStatus(value: string | null): AdminShopStatus | null {
  if (value === null || value === "") return null;
  if (!SHOP_STATUSES.includes(value as AdminShopStatus)) {
    throw new AppError("validation_failed", 400, ["shop_status_invalid"]);
  }
  return value as AdminShopStatus;
}

export function parseAdminSubscriptionState(value: string | null): AdminSubscriptionState | null {
  if (value === null || value === "") return null;
  if (!SUBSCRIPTION_STATES.includes(value as AdminSubscriptionState)) {
    throw new AppError("validation_failed", 400, ["subscription_state_invalid"]);
  }
  return value as AdminSubscriptionState;
}

function parseCursor(value: string | null): { publicId: string; updatedAt: string } | null {
  if (value === null || value === "") return null;
  try {
    const normalized = value.replaceAll("-", "+").replaceAll("_", "/");
    const parsed = JSON.parse(atob(normalized)) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("invalid");
    const row = parsed as { publicId?: unknown; updatedAt?: unknown };
    if (typeof row.publicId !== "string" || !SAFE_PUBLIC_ID.test(row.publicId)
      || typeof row.updatedAt !== "string" || !Number.isFinite(Date.parse(row.updatedAt))) {
      throw new Error("invalid");
    }
    return { publicId: row.publicId, updatedAt: row.updatedAt };
  } catch {
    throw new AppError("validation_failed", 400, ["cursor_invalid"]);
  }
}

function encodeCursor(row: { publicId: string; updatedAt: string }): string {
  return btoa(JSON.stringify(row)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function normalizeQuery(value: string | null): string | null {
  if (value === null) return null;
  const query = value.trim();
  if (query.length === 0) return null;
  const hasControlCharacter = Array.from(query).some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 31 || codePoint === 127;
  });
  if (query.length > MAX_QUERY_LENGTH || hasControlCharacter) {
    throw new AppError("validation_failed", 400, ["query_invalid"]);
  }
  return query;
}

function escapeLike(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_");
}

function listLimit(value: number | undefined): number {
  if (value === undefined) return DEFAULT_LIMIT;
  if (!Number.isInteger(value) || value < 1 || value > MAX_LIMIT) {
    throw new AppError("validation_failed", 400, ["limit_invalid"]);
  }
  return value;
}

const SHOP_DIRECTORY_SELECT = `
  SELECT
    shops.public_id AS publicId,
    shops.slug,
    shops.name,
    shops.status,
    shops.default_locale AS defaultLocale,
    shops.currency,
    shops.created_at AS createdAt,
    shops.updated_at AS updatedAt,
    latest_subscription.state AS subscriptionState,
    plans.code AS planCode,
    (
      SELECT COUNT(*) FROM shop_members
      WHERE shop_members.shop_id = shops.id AND shop_members.status = 'active'
    ) AS activeMemberCount,
    (
      SELECT COUNT(*) FROM shop_members
      WHERE shop_members.shop_id = shops.id
        AND shop_members.status = 'active'
        AND shop_members.role = 'owner'
    ) AS activeOwnerCount,
    (
      SELECT COUNT(*) FROM products
      WHERE products.shop_id = shops.id AND products.status = 'active'
    ) AS activeProductCount,
    (
      SELECT COUNT(*) FROM channel_connections
      WHERE channel_connections.shop_id = shops.id
        AND channel_connections.status IN ('pending', 'active', 'degraded')
    ) AS openConnectionCount,
    (
      SELECT COUNT(*) FROM channel_connections
      WHERE channel_connections.shop_id = shops.id AND channel_connections.status = 'degraded'
    ) AS degradedConnectionCount
  FROM shops
  LEFT JOIN shop_subscriptions AS latest_subscription
    ON latest_subscription.id = (
      SELECT id FROM shop_subscriptions
      WHERE shop_subscriptions.shop_id = shops.id
      ORDER BY shop_subscriptions.created_at DESC, shop_subscriptions.id DESC
      LIMIT 1
    )
  LEFT JOIN plans ON plans.id = latest_subscription.plan_id
`;

function mapRow(row: AdminShopDirectoryRow): AdminShopDirectoryItem {
  return {
    activeMemberCount: row.activeMemberCount,
    activeOwnerCount: row.activeOwnerCount,
    activeProductCount: row.activeProductCount,
    currency: row.currency,
    defaultLocale: row.defaultLocale,
    degradedConnectionCount: row.degradedConnectionCount,
    createdAt: row.createdAt,
    name: row.name,
    openConnectionCount: row.openConnectionCount,
    planCode: row.planCode,
    publicId: row.publicId,
    slug: row.slug,
    status: row.status,
    subscriptionState: row.subscriptionState,
    updatedAt: row.updatedAt,
  };
}

export async function listAdminShopDirectory(input: {
  env: AppBindings;
  userId: string;
  filters: AdminShopDirectoryFilters;
}): Promise<{ nextCursor: string | null; shops: AdminShopDirectoryItem[]; role: PlatformAdminRole }> {
  const role = await getPlatformAdminRole({ env: input.env, userId: input.userId });
  if (role === null) throw new AppError("authorization_denied", 403);

  const cursor = parseCursor(input.filters.cursor);
  const limit = listLimit(input.filters.limit);
  const query = normalizeQuery(input.filters.query);
  const escapedQuery = query === null ? null : `%${escapeLike(query)}%`;

  const rows = await input.env.PLATFORM_DB.prepare(`${SHOP_DIRECTORY_SELECT}
    WHERE (? IS NULL OR shops.status = ?)
      AND (? IS NULL OR latest_subscription.state = ?)
      AND (
        ? IS NULL
        OR shops.public_id LIKE ? ESCAPE '\\'
        OR shops.slug LIKE ? ESCAPE '\\'
        OR shops.name LIKE ? ESCAPE '\\'
      )
      AND (
        ? IS NULL
        OR shops.updated_at < ?
        OR (shops.updated_at = ? AND shops.public_id < ?)
      )
    ORDER BY shops.updated_at DESC, shops.public_id DESC
    LIMIT ?
  `).bind(
    input.filters.shopStatus,
    input.filters.shopStatus,
    input.filters.subscriptionState,
    input.filters.subscriptionState,
    escapedQuery,
    escapedQuery,
    escapedQuery,
    escapedQuery,
    cursor?.updatedAt ?? null,
    cursor?.updatedAt ?? null,
    cursor?.updatedAt ?? null,
    cursor?.publicId ?? null,
    limit + 1,
  ).all<AdminShopDirectoryRow>();

  const page = rows.results.slice(0, limit);
  const last = page.at(-1);
  return {
    nextCursor: rows.results.length > limit && last !== undefined
      ? encodeCursor({ publicId: last.publicId, updatedAt: last.updatedAt })
      : null,
    role,
    shops: page.map(mapRow),
  };
}
