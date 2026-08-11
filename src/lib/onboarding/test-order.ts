import { requireResourceId } from "../catalog/policy";
import { AppError } from "../core/errors";
import { hasFreshExactTurnstileAdmission } from "../domains/readiness";
import type { AppBindings } from "../platform/bindings";
import { getShopForMember } from "../tenants/store";

type ReadinessStatus = "fail" | "pass" | "warning";

export type TestOrderReadinessCheck = {
  actionUrl?: string;
  checkedAt: string;
  code: string;
  messageKey: string;
  required: boolean;
  status: ReadinessStatus;
};

export type TestOrderReadiness = {
  checkedAt: string;
  checks: readonly TestOrderReadinessCheck[];
  readinessVersion: number;
  ready: boolean;
  runId: string | null;
};

export type RunTestReadiness = (input: {
  env: AppBindings;
  requestId: string;
  shopPublicId: string;
  trigger: "test";
  userId: string;
}) => Promise<TestOrderReadiness>;

type TestVariantRow = {
  available_count: number;
  currency: string;
  fulfillment_type: "license_key" | "manual";
  max_per_order: number;
  min_per_order: number;
  price_minor: number;
  product_id: string;
  product_title: string;
  variant_id: string;
  variant_title: string;
};

type PaymentHealthRow = {
  active_credential_id: string | null;
  last_checked_at: string | null;
  last_safe_error_code: string | null;
  last_webhook_verified_at: string | null;
  status: string;
  webhook_status: string;
};

type TelegramHealthRow = {
  active_credential_id: string | null;
  last_health_update_at: string | null;
  last_safe_error_code: string | null;
  status: string;
  webhook_status: string;
};

type DomainHealthRow = {
  delete_requested_at: string | null;
  deleted_at: string | null;
  dns_status: string | null;
  hostname_normalized: string;
  hostname_status: string | null;
  ownership_verified_at: string | null;
  ssl_status: string | null;
  status: string;
  type: "custom" | "platform_subdomain";
  validation_metadata_json: string;
};

export type InventoryDryRun = {
  availableCount: number | null;
  code:
    | "test_currency_mismatch"
    | "test_inventory_available"
    | "test_inventory_unavailable"
    | "test_manual_fulfillment_ready"
    | "test_quantity_out_of_range"
    | "test_variant_unavailable";
  currency: string | null;
  fulfillmentType: "license_key" | "manual" | null;
  productId: string | null;
  productTitle: string | null;
  quantity: number;
  requiredCount: number;
  sufficient: boolean;
  totalMinor: number | null;
  unitPriceMinor: number | null;
  variantId: string | null;
  variantTitle: string | null;
};

export type ProviderHealth = {
  payos: {
    configured: boolean;
    lastCheckedAt: string | null;
    lastSafeErrorCode: string | null;
    lastWebhookVerifiedAt: string | null;
    ready: boolean;
    status: string | null;
    webhookStatus: string | null;
  };
  telegram: {
    configured: boolean;
    lastHealthUpdateAt: string | null;
    lastSafeErrorCode: string | null;
    ready: boolean;
    status: string | null;
    webhookStatus: string | null;
  };
};

export type DomainHealth = {
  hostname: string | null;
  ready: boolean;
  status: string | null;
  type: "custom" | "platform_subdomain" | null;
};

export type ControlledTestOrderResult = {
  checkedAt: string;
  domainHealth: DomainHealth;
  inventoryDryRun: InventoryDryRun;
  passed: boolean;
  providerHealth: ProviderHealth;
  readiness: TestOrderReadiness;
};

export type ControlledTestOrderInput = {
  body: Record<string, unknown>;
  env: AppBindings;
  emitSafeTestPassed?: (shopId: string) => Promise<void>;
  requestId: string;
  runReadiness: RunTestReadiness;
  shopPublicId: string;
  userId: string;
};

function normalizeQuantity(value: unknown): number {
  if (value === undefined) return 1;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > 100) {
    throw new AppError("validation_failed", 400, ["quantity_invalid"]);
  }
  return value;
}

function normalizeVariantId(value: unknown): string | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string") {
    throw new AppError("validation_failed", 400, ["variant_id_invalid"]);
  }
  return requireResourceId(value, "var");
}

async function loadTestVariant(
  env: AppBindings,
  shopId: string,
  variantId: string | null,
): Promise<TestVariantRow | null> {
  const baseQuery = `
    SELECT
      product_variants.id AS variant_id,
      product_variants.product_id,
      products.title AS product_title,
      product_variants.title AS variant_title,
      products.fulfillment_type,
      product_variants.price_minor,
      product_variants.currency,
      product_variants.min_per_order,
      product_variants.max_per_order,
      (
        SELECT COUNT(*)
        FROM inventory_keys
        WHERE inventory_keys.shop_id = product_variants.shop_id
          AND inventory_keys.variant_id = product_variants.id
          AND inventory_keys.status = 'available'
      ) AS available_count
    FROM product_variants
    INNER JOIN products
      ON products.id = product_variants.product_id
      AND products.shop_id = product_variants.shop_id
      AND products.status = 'active'
    WHERE product_variants.shop_id = ?
      AND product_variants.status = 'active'
  `;

  if (variantId !== null) {
    return env.PLATFORM_DB.prepare(`${baseQuery}
      AND product_variants.id = ?
      LIMIT 1
    `).bind(shopId, variantId).first<TestVariantRow>();
  }

  return env.PLATFORM_DB.prepare(`${baseQuery}
    ORDER BY
      CASE
        WHEN products.fulfillment_type = 'license_key' AND EXISTS (
          SELECT 1
          FROM inventory_keys AS available_inventory
          WHERE available_inventory.shop_id = product_variants.shop_id
            AND available_inventory.variant_id = product_variants.id
            AND available_inventory.status = 'available'
        ) THEN 0
        WHEN products.fulfillment_type = 'manual' THEN 1
        ELSE 2
      END,
      products.created_at,
      products.id,
      product_variants.id
    LIMIT 1
  `).bind(shopId).first<TestVariantRow>();
}

export function evaluateInventoryDryRun(input: {
  currency: string;
  quantity: number;
  variant: TestVariantRow | null;
}): InventoryDryRun {
  if (input.variant === null) {
    return {
      availableCount: null,
      code: "test_variant_unavailable",
      currency: null,
      fulfillmentType: null,
      productId: null,
      productTitle: null,
      quantity: input.quantity,
      requiredCount: input.quantity,
      sufficient: false,
      totalMinor: null,
      unitPriceMinor: null,
      variantId: null,
      variantTitle: null,
    };
  }

  const variant = input.variant;
  const totalMinor = variant.price_minor * input.quantity;
  if (!Number.isSafeInteger(totalMinor) || totalMinor < 0) {
    throw new AppError("validation_failed", 409, ["quote_amount_invalid"]);
  }

  let code: InventoryDryRun["code"];
  let sufficient: boolean;
  if (input.quantity < variant.min_per_order || input.quantity > variant.max_per_order) {
    code = "test_quantity_out_of_range";
    sufficient = false;
  } else if (variant.currency !== input.currency) {
    code = "test_currency_mismatch";
    sufficient = false;
  } else if (variant.fulfillment_type === "manual") {
    code = "test_manual_fulfillment_ready";
    sufficient = true;
  } else if (variant.available_count >= input.quantity) {
    code = "test_inventory_available";
    sufficient = true;
  } else {
    code = "test_inventory_unavailable";
    sufficient = false;
  }

  return {
    availableCount: variant.fulfillment_type === "license_key" ? variant.available_count : null,
    code,
    currency: variant.currency,
    fulfillmentType: variant.fulfillment_type,
    productId: variant.product_id,
    productTitle: variant.product_title,
    quantity: input.quantity,
    requiredCount: variant.fulfillment_type === "license_key" ? input.quantity : 0,
    sufficient,
    totalMinor,
    unitPriceMinor: variant.price_minor,
    variantId: variant.variant_id,
    variantTitle: variant.variant_title,
  };
}

async function loadProviderHealth(env: AppBindings, shopId: string): Promise<ProviderHealth> {
  const [payos, telegram] = await Promise.all([
    env.PLATFORM_DB.prepare(`
      SELECT
        status, webhook_status, active_credential_id, last_safe_error_code,
        last_checked_at, last_webhook_verified_at
      FROM payment_integrations
      WHERE shop_id = ? AND provider = 'payos'
      LIMIT 1
    `).bind(shopId).first<PaymentHealthRow>(),
    env.PLATFORM_DB.prepare(`
      SELECT
        status, webhook_status, active_credential_id, last_safe_error_code,
        last_health_update_at
      FROM telegram_integrations
      WHERE shop_id = ?
      LIMIT 1
    `).bind(shopId).first<TelegramHealthRow>(),
  ]);

  return {
    payos: {
      configured: payos !== null,
      lastCheckedAt: payos?.last_checked_at ?? null,
      lastSafeErrorCode: payos?.last_safe_error_code ?? null,
      lastWebhookVerifiedAt: payos?.last_webhook_verified_at ?? null,
      ready: payos?.status === "active"
        && payos.webhook_status === "verified"
        && payos.active_credential_id !== null
        && payos.last_checked_at !== null
        && payos.last_webhook_verified_at !== null,
      status: payos?.status ?? null,
      webhookStatus: payos?.webhook_status ?? null,
    },
    telegram: {
      configured: telegram !== null,
      lastHealthUpdateAt: telegram?.last_health_update_at ?? null,
      lastSafeErrorCode: telegram?.last_safe_error_code ?? null,
      ready: telegram?.status === "active"
        && telegram.webhook_status === "verified"
        && telegram.active_credential_id !== null
        && telegram.last_health_update_at !== null,
      status: telegram?.status ?? null,
      webhookStatus: telegram?.webhook_status ?? null,
    },
  };
}

function applyAuthoritativeProviderReadiness(
  health: ProviderHealth,
  readiness: TestOrderReadiness,
): ProviderHealth {
  const passed = (code: string) => readiness.checks.some(
    (item) => item.code === code && item.status === "pass",
  );
  return {
    payos: {
      ...health.payos,
      ready: health.payos.configured && passed("payos_ready"),
    },
    telegram: {
      ...health.telegram,
      ready: health.telegram.configured && passed("telegram_ready"),
    },
  };
}

function isDomainReady(domain: DomainHealthRow | null): boolean {
  if (domain === null
    || domain.status !== "active"
    || domain.deleted_at !== null
    || domain.delete_requested_at !== null) {
    return false;
  }
  return domain.type === "platform_subdomain"
    || (domain.ownership_verified_at !== null
      && domain.hostname_status === "active"
      && domain.ssl_status === "active"
      && domain.dns_status === "active"
      && hasFreshExactTurnstileAdmission({
        hostname: domain.hostname_normalized,
        validationMetadataJson: domain.validation_metadata_json,
      }));
}

async function loadDomainHealth(env: AppBindings, shopId: string): Promise<DomainHealth> {
  const domain = await env.PLATFORM_DB.prepare(`
    SELECT
      shop_domains.hostname_normalized,
      shop_domains.type,
      shop_domains.status,
      shop_domains.ownership_verified_at,
      shop_domains.hostname_status,
      shop_domains.ssl_status,
      shop_domains.dns_status,
      shop_domains.validation_metadata_json,
      shop_domains.deleted_at,
      shop_domains.delete_requested_at
    FROM shops
    INNER JOIN shop_domains
      ON shop_domains.id = shops.canonical_domain_id
      AND shop_domains.shop_id = shops.id
    WHERE shops.id = ?
    LIMIT 1
  `).bind(shopId).first<DomainHealthRow>();

  return {
    hostname: domain?.hostname_normalized ?? null,
    ready: isDomainReady(domain),
    status: domain?.status ?? null,
    type: domain?.type ?? null,
  };
}

export async function runControlledTestOrder(
  input: ControlledTestOrderInput,
): Promise<ControlledTestOrderResult> {
  const membership = await getShopForMember({
    capability: "shop:read",
    env: input.env,
    shopPublicId: input.shopPublicId,
    userId: input.userId,
  });
  if (membership.shop.role !== "owner") {
    throw new AppError("authorization_denied", 403);
  }
  const variantId = normalizeVariantId(input.body.variantId);
  const quantity = normalizeQuantity(input.body.quantity);

  const [readiness, variant, providerHealth, domainHealth] = await Promise.all([
    input.runReadiness({
      env: input.env,
      requestId: input.requestId,
      shopPublicId: input.shopPublicId,
      trigger: "test",
      userId: input.userId,
    }),
    loadTestVariant(input.env, membership.row.shop_id, variantId),
    loadProviderHealth(input.env, membership.row.shop_id),
    loadDomainHealth(input.env, membership.row.shop_id),
  ]);
  const inventoryDryRun = evaluateInventoryDryRun({
    currency: membership.shop.currency,
    quantity,
    variant,
  });
  const authoritativeProviderHealth = applyAuthoritativeProviderReadiness(
    providerHealth,
    readiness,
  );
  const passed = readiness.ready && inventoryDryRun.sufficient && domainHealth.ready;
  if (passed && input.emitSafeTestPassed !== undefined) {
    await input.emitSafeTestPassed(membership.row.shop_id);
  }

  return {
    checkedAt: readiness.checkedAt,
    domainHealth,
    inventoryDryRun,
    passed,
    providerHealth: authoritativeProviderHealth,
    readiness,
  };
}
