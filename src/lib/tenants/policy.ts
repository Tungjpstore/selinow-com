import { AppError } from "../core/errors";

export const SHOP_ROLES = ["owner", "manager", "support", "viewer"] as const;
export type ShopRole = typeof SHOP_ROLES[number];

export type ShopCapability =
  | "shop:read"
  | "shop:update"
  | "catalog:read"
  | "orders:read"
  | "orders:read:masked"
  | "orders:read:summary"
  | "customers:read"
  | "customers:read:masked"
  | "customers:read:summary"
  | "fulfillment:read"
  | "automation:read"
  | "integrations:read"
  | "integrations:credentials"
  | "payments:read"
  | "domains:read"
  | "team:manage"
  | "billing:manage"
  | "customers:manage"
  | "catalog:manage"
  | "checkout:create"
  | "automation:manage"
  | "domains:manage"
  | "fulfillment:manage"
  | "integrations:manage"
  | "payments:manage";

const ROLE_CAPABILITIES: Record<ShopRole, ReadonlySet<ShopCapability>> = {
  manager: new Set([
    "shop:read", "shop:update", "catalog:read", "orders:read", "orders:read:masked", "orders:read:summary", "customers:read", "customers:read:masked", "customers:read:summary",
    "fulfillment:read", "automation:read", "integrations:read", "payments:read", "domains:read",
    "automation:manage", "catalog:manage", "checkout:create", "customers:manage", "fulfillment:manage", "integrations:manage",
  ]),
  owner: new Set([
    "shop:read", "shop:update", "catalog:read", "orders:read", "orders:read:masked", "orders:read:summary", "customers:read", "customers:read:masked", "customers:read:summary", "fulfillment:read", "automation:read",
    "integrations:read", "integrations:credentials", "payments:read", "domains:read",
    "automation:manage", "team:manage", "billing:manage", "catalog:manage", "checkout:create", "customers:manage", "domains:manage",
    "fulfillment:manage", "integrations:manage", "payments:manage",
  ]),
  support: new Set([
    "shop:read", "catalog:read", "orders:read:masked", "customers:read:masked", "fulfillment:read", "automation:read",
    "integrations:read", "payments:read",
  ]),
  viewer: new Set([
    "shop:read", "catalog:read", "orders:read:summary", "customers:read:summary", "fulfillment:read", "automation:read",
  ]),
};

const RESERVED_SLUG_FALLBACK = new Set([
  "admin", "api", "app", "assets", "auth", "billing", "cdn", "customers", "dashboard", "dev",
  "docs", "email", "help", "login", "mail", "media", "proxy-fallback", "signup", "static",
  "status", "support", "test", "www",
]);

export function normalizeSlug(value: unknown): string {
  if (typeof value !== "string") {
    throw new AppError("validation_failed", 400, ["slug_required"]);
  }

  const normalized = value.trim().toLowerCase();
  if (normalized.length < 3 || normalized.length > 48 || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])$/u.test(normalized)) {
    throw new AppError("validation_failed", 400, ["slug_invalid"]);
  }
  if (normalized.includes("--") || RESERVED_SLUG_FALLBACK.has(normalized)) {
    throw new AppError("validation_failed", 409, ["slug_reserved"]);
  }

  return normalized;
}

export function normalizeShopName(value: unknown): string {
  if (typeof value !== "string") {
    throw new AppError("validation_failed", 400, ["shop_name_required"]);
  }

  const normalized = value.trim().replace(/\s+/gu, " ");
  if (normalized.length < 2 || normalized.length > 80) {
    throw new AppError("validation_failed", 400, ["shop_name_invalid"]);
  }
  return normalized;
}

export function assertRoleCapability(role: ShopRole, capability: ShopCapability): void {
  if (!Object.hasOwn(ROLE_CAPABILITIES, role) || !ROLE_CAPABILITIES[role].has(capability)) {
    throw new AppError("authorization_denied", 403);
  }
}

/** Return a safe boolean for projections that need role-specific redaction. */
export function hasRoleCapability(role: ShopRole, capability: ShopCapability): boolean {
  return Object.hasOwn(ROLE_CAPABILITIES, role) && ROLE_CAPABILITIES[role].has(capability);
}

export function assertCheckoutAllowed(input: {
  shopStatus: string;
  subscriptionState: string;
}): void {
  if (input.shopStatus === "suspended" || input.shopStatus === "archived") {
    throw new AppError("tenant_suspended", 403);
  }
  if (input.shopStatus !== "active" && input.shopStatus !== "draft") {
    throw new AppError("tenant_not_ready", 409);
  }
  if (!new Set(["trialing", "active", "past_due"]).has(input.subscriptionState)) {
    throw new AppError("subscription_required", 402);
  }
}

export function hasFeature(featureFlagsJson: string, feature: string): boolean {
  try {
    const value = JSON.parse(featureFlagsJson) as unknown;
    return typeof value === "object"
      && value !== null
      && !Array.isArray(value)
      && (value as Record<string, unknown>)[feature] === true;
  } catch {
    return false;
  }
}

export function getPlanLimit(limitsJson: string, metric: string): number | null {
  try {
    const value = JSON.parse(limitsJson) as unknown;
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      return null;
    }
    const limit = (value as Record<string, unknown>)[metric];
    return typeof limit === "number" && Number.isSafeInteger(limit) && limit >= 0 ? limit : null;
  } catch {
    return null;
  }
}
