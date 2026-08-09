import { AppError } from "../core/errors";
import { createId } from "../core/ids";
import { encodePublicApiCursor, parsePublicApiPage, type PublicApiPage } from "../api/pagination";
import type { AppBindings } from "../platform/bindings";
import { getShopForMember } from "./store";
import type { ShopRole } from "./policy";

export type SellerCustomerView = {
  createdAt: string | null;
  displayName: string | null;
  emailMasked: string | null;
  lastOrderAt: string | null;
  locale: string | null;
  orderCount: number;
  publicId: string;
  status: string;
  version: number;
};

export type SellerCustomerPage = { customers: SellerCustomerView[]; nextCursor: string | null };

function sellerPage(input: { cursor?: string | null; limit?: number }): PublicApiPage {
  const url = new URL("https://seller.selinow.invalid/");
  if (input.cursor !== undefined && input.cursor !== null) url.searchParams.set("cursor", input.cursor);
  if (input.limit !== undefined) url.searchParams.set("limit", String(input.limit));
  return parsePublicApiPage(url);
}

export type SellerMemberView = {
  createdAt: string;
  displayName: string;
  emailMasked: string;
  memberPublicId: string;
  role: string;
  status: string;
  version: number;
};

export type SellerBillingView = {
  canceledAt: string | null;
  currentPeriodEnd: string | null;
  currentPeriodStart: string | null;
  currentPrice: {
    amountMinor: number;
    currency: string;
    interval: string;
    marketCode: string;
  } | null;
  features: Record<string, unknown>;
  graceEndsAt: string | null;
  limits: Record<string, unknown>;
  planCode: string;
  planName: string;
  planVersion: number;
  state: string;
  subscriptionVersion: number;
  trialEndsAt: string | null;
  usage: Array<{ metric: string; periodKey: string; updatedAt: string; value: number }>;
};

function maskEmail(value: string | null): string | null {
  if (value === null || value.length === 0) return null;
  const [local, domain] = value.split("@");
  if (local === undefined || local.length === 0 || domain === undefined) return "***";
  const visible = local.slice(0, Math.min(2, local.length));
  return `${visible}${"*".repeat(Math.max(1, local.length - visible.length))}@${domain}`;
}

function maskDisplayName(value: string | null): string | null {
  if (value === null || value.trim().length === 0) return null;
  const normalized = value.trim();
  return `${normalized.slice(0, 1)}${"*".repeat(Math.min(8, Math.max(1, normalized.length - 1)))}`;
}

function parseObject(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value) as unknown;
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

type CustomerVisibility = "full" | "masked" | "summary";

function customerVisibility(role: ShopRole): CustomerVisibility {
  if (role === "owner" || role === "manager") return "full";
  if (role === "support") return "masked";
  return "summary";
}

export async function listSellerCustomersPage(input: { cursor?: string | null; env: AppBindings; limit?: number; shopPublicId: string; userId: string }): Promise<SellerCustomerPage> {
  const member = await getShopForMember({ capability: "shop:read", env: input.env, shopPublicId: input.shopPublicId, userId: input.userId });
  const visibility = customerVisibility(member.row.role);
  const page = sellerPage(input);
  const rows = await input.env.PLATFORM_DB.prepare(`
    WITH customer_summary AS (
      SELECT shop_customers.id, shop_customers.id AS publicId, shop_customers.version,
      shop_customers.display_name AS displayName,
      shop_customers.email_normalized AS email,
      shop_customers.locale, shop_customers.status,
      shop_customers.created_at AS createdAt,
      COUNT(orders.id) AS orderCount,
      MAX(orders.created_at) AS lastOrderAt,
      COALESCE(MAX(orders.created_at), shop_customers.created_at) AS cursorCreatedAt
      FROM shop_customers
      LEFT JOIN orders
        ON orders.customer_id = shop_customers.id
        AND orders.shop_id = shop_customers.shop_id
      WHERE shop_customers.shop_id = ?
      GROUP BY shop_customers.id
    )
    SELECT *
    FROM customer_summary
    WHERE (? IS NULL OR cursorCreatedAt < ?
      OR (cursorCreatedAt = ? AND id < ?))
    ORDER BY cursorCreatedAt DESC, id DESC
    LIMIT ?
  `).bind(
    member.row.shop_id,
    page.cursor?.createdAt ?? null,
    page.cursor?.createdAt ?? null,
    page.cursor?.createdAt ?? null,
    page.cursor?.id ?? null,
    page.limit + 1,
  ).all<{ createdAt: string; cursorCreatedAt: string; displayName: string | null; email: string | null; id: string; lastOrderAt: string | null; locale: string; orderCount: number; publicId?: string; status: string; version?: number }>();
  const hasNext = rows.results.length > page.limit;
  const customers = rows.results.slice(0, page.limit).map((row) => {
    const version = Number.isSafeInteger(row.version) && (row.version ?? 0) > 0 ? (row.version ?? 1) : 1;
    if (visibility === "summary") {
      return {
        createdAt: null,
        displayName: null,
        emailMasked: null,
        lastOrderAt: row.lastOrderAt,
        locale: null,
        orderCount: row.orderCount,
        publicId: row.publicId ?? row.id,
        status: row.status,
        version,
      };
    }
    return {
      createdAt: row.createdAt,
      displayName: visibility === "masked" ? maskDisplayName(row.displayName) : row.displayName,
      emailMasked: maskEmail(row.email),
      lastOrderAt: row.lastOrderAt,
      locale: row.locale,
      orderCount: row.orderCount,
      publicId: row.publicId ?? row.id,
      status: row.status,
      version,
    };
  });
  const last = rows.results.slice(0, page.limit).at(-1);
  return {
    customers,
    nextCursor: hasNext && last !== undefined
      ? encodePublicApiCursor({ createdAt: last.cursorCreatedAt, id: last.id })
      : null,
  };
}

export async function listSellerCustomers(input: { env: AppBindings; shopPublicId: string; userId: string }): Promise<SellerCustomerView[]> {
  return (await listSellerCustomersPage({ ...input, limit: 100 })).customers;
}

export async function listSellerMembers(input: { env: AppBindings; shopPublicId: string; userId: string }): Promise<SellerMemberView[]> {
  const member = await getShopForMember({ capability: "team:manage", env: input.env, shopPublicId: input.shopPublicId, userId: input.userId });
  const missingRefs = await input.env.PLATFORM_DB.prepare("SELECT user_id AS userId FROM shop_members WHERE shop_id = ? AND member_public_id IS NULL").bind(member.row.shop_id).all<{ userId: string }>();
  if (missingRefs.results.length > 0) {
    await input.env.PLATFORM_DB.batch(missingRefs.results.map((row) => input.env.PLATFORM_DB.prepare("UPDATE shop_members SET member_public_id = ? WHERE shop_id = ? AND user_id = ? AND member_public_id IS NULL").bind(createId("mbr"), member.row.shop_id, row.userId)));
  }
  const rows = await input.env.PLATFORM_DB.prepare(`
    SELECT shop_members.user_id AS userId, platform_users.display_name AS displayName,
      platform_users.email_normalized AS email, shop_members.role, shop_members.status,
      shop_members.created_at AS createdAt, shop_members.member_public_id AS memberPublicId,
      shop_members.version
    FROM shop_members
    INNER JOIN platform_users ON platform_users.id = shop_members.user_id
    WHERE shop_members.shop_id = ?
    ORDER BY CASE shop_members.role WHEN 'owner' THEN 0 WHEN 'manager' THEN 1 WHEN 'support' THEN 2 ELSE 3 END,
      shop_members.created_at, shop_members.user_id
  `).bind(member.row.shop_id).all<{ createdAt: string; displayName: string; email: string; memberPublicId: string; role: string; status: string; userId: string; version: number }>();
  return rows.results.map((row) => ({
    createdAt: row.createdAt,
    displayName: row.displayName,
    emailMasked: maskEmail(row.email) ?? "***",
    memberPublicId: row.memberPublicId,
    role: row.role,
    status: row.status,
    version: row.version,
  }));
}

export async function getSellerBilling(input: { env: AppBindings; shopPublicId: string; userId: string }): Promise<SellerBillingView> {
  const member = await getShopForMember({ capability: "billing:manage", env: input.env, shopPublicId: input.shopPublicId, userId: input.userId });
  const row = await input.env.PLATFORM_DB.prepare(`
    SELECT plans.code AS planCode, plans.name AS planName, plans.version AS planVersion,
      plans.feature_flags_json AS featuresJson, plans.limits_json AS limitsJson,
      shop_subscriptions.state, shop_subscriptions.version AS subscriptionVersion, shop_subscriptions.trial_ends_at AS trialEndsAt,
      shop_subscriptions.current_period_start AS currentPeriodStart,
      shop_subscriptions.current_period_end AS currentPeriodEnd,
      shop_subscriptions.grace_ends_at AS graceEndsAt, shop_subscriptions.canceled_at AS canceledAt,
      shop_subscriptions.market_code AS marketCode,
      shop_subscriptions.price_currency AS priceCurrency,
      shop_subscriptions.price_amount_minor AS priceAmountMinor,
      shop_subscriptions.price_interval AS priceInterval
    FROM shop_subscriptions
    INNER JOIN plans ON plans.id = shop_subscriptions.plan_id
    WHERE shop_subscriptions.shop_id = ?
    ORDER BY shop_subscriptions.created_at DESC, shop_subscriptions.id DESC
    LIMIT 1
  `).bind(member.row.shop_id).first<{ canceledAt: string | null; currentPeriodEnd: string | null; currentPeriodStart: string | null; featuresJson: string; graceEndsAt: string | null; limitsJson: string; marketCode: string | null; planCode: string; planName: string; planVersion: number; priceAmountMinor: number | null; priceCurrency: string | null; priceInterval: string | null; state: string; subscriptionVersion?: number; trialEndsAt: string | null }>();
  if (row === null) throw new AppError("subscription_required", 409);
  const currentPrice = row.marketCode !== null
    && row.priceCurrency !== null
    && row.priceInterval !== null
    && typeof row.priceAmountMinor === "number"
    && Number.isSafeInteger(row.priceAmountMinor)
    && row.priceAmountMinor > 0
    ? {
      amountMinor: row.priceAmountMinor,
      currency: row.priceCurrency,
      interval: row.priceInterval,
      marketCode: row.marketCode,
    }
    : null;
  const usage = await input.env.PLATFORM_DB.prepare(`
    SELECT metric, period_key AS periodKey, value, updated_at AS updatedAt
    FROM usage_counters
    WHERE shop_id = ?
    ORDER BY updated_at DESC, metric, period_key
    LIMIT 100
  `).bind(member.row.shop_id).all<SellerBillingView["usage"][number]>();
  return {
    canceledAt: row.canceledAt,
    currentPeriodEnd: row.currentPeriodEnd,
    currentPeriodStart: row.currentPeriodStart,
    currentPrice,
    features: parseObject(row.featuresJson),
    graceEndsAt: row.graceEndsAt,
    limits: parseObject(row.limitsJson),
    planCode: row.planCode,
    planName: row.planName,
    planVersion: row.planVersion,
    state: row.state,
    subscriptionVersion: Number.isSafeInteger(row.subscriptionVersion) && (row.subscriptionVersion ?? 0) > 0 ? (row.subscriptionVersion ?? 1) : 1,
    trialEndsAt: row.trialEndsAt,
    usage: usage.results,
  };
}
