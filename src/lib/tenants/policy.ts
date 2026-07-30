import { AppError } from "../core/errors";

export const SHOP_ROLES = ["owner", "manager", "support", "viewer"] as const;
export type ShopRole = typeof SHOP_ROLES[number];

export type ShopCapability =
  | "shop:read"
  | "shop:update"
  | "team:manage"
  | "billing:manage"
  | "catalog:manage"
  | "checkout:create"
  | "automation:manage"
  | "domains:manage"
  | "fulfillment:manage"
  | "integrations:manage"
  | "payments:manage";

const ROLE_CAPABILITIES: Record<ShopRole, ReadonlySet<ShopCapability>> = {
  manager: new Set(["shop:read", "shop:update", "automation:manage", "catalog:manage", "checkout:create", "fulfillment:manage", "integrations:manage", "payments:manage"]),
  owner: new Set(["shop:read", "shop:update", "automation:manage", "team:manage", "billing:manage", "catalog:manage", "checkout:create", "domains:manage", "fulfillment:manage", "integrations:manage", "payments:manage"]),
  support: new Set(["shop:read"]),
  viewer: new Set(["shop:read"]),
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
  if (!ROLE_CAPABILITIES[role].has(capability)) {
    throw new AppError("authorization_denied", 403);
  }
}

export function assertCheckoutAllowed(input: {
  shopStatus: string;
  subscriptionState: string;
}): void {
  if (input.shopStatus === "suspended" || input.shopStatus === "archived") {
    throw new AppError("tenant_suspended", 403);
  }
  if (input.shopStatus !== "active") {
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
