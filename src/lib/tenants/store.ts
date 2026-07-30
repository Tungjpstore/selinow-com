import { AppError } from "../core/errors";
import { hmacToken, sha256Json } from "../core/crypto";
import { createId } from "../core/ids";
import { normalizeCurrencyCode } from "../i18n/currency";
import { DEFAULT_LOCALE, matchSupportedLocale } from "../i18n/locale";
import { ONBOARDING_STEP_CODES } from "../onboarding/policy";
import type { AppBindings } from "../platform/bindings";
import { normalizeOptionalCountryCode } from "./country";
import { assertRoleCapability, type ShopCapability, type ShopRole } from "./policy";

type ExistingIdempotency = {
  request_hash: string;
  response_json: string;
};

type MembershipShopRow = {
  business_country_code: string | null;
  currency: string;
  default_locale: string;
  feature_flags_json: string;
  limits_json: string;
  name: string;
  plan_code: string;
  public_id: string;
  role: ShopRole;
  merchant_country_code: string | null;
  shop_id: string;
  shop_status: string;
  slug: string;
  subscription_state: string;
  timezone: string;
};

export type ShopView = {
  businessCountry: string | null;
  currency: string;
  defaultLocale: string;
  featureFlags: Record<string, unknown>;
  limits: Record<string, unknown>;
  merchantCountry: string | null;
  name: string;
  planCode: string;
  publicId: string;
  role: ShopRole;
  slug: string;
  status: string;
  subscriptionState: string;
  timezone: string;
};

function safeJsonObject(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value) as unknown;
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function mapShop(row: MembershipShopRow): ShopView {
  return {
    businessCountry: row.business_country_code ?? null,
    currency: row.currency,
    defaultLocale: matchSupportedLocale(row.default_locale) ?? DEFAULT_LOCALE,
    featureFlags: safeJsonObject(row.feature_flags_json),
    limits: safeJsonObject(row.limits_json),
    merchantCountry: row.merchant_country_code ?? null,
    name: row.name,
    planCode: row.plan_code,
    publicId: row.public_id,
    role: row.role,
    slug: row.slug,
    status: row.shop_status,
    subscriptionState: row.subscription_state,
    timezone: row.timezone,
  };
}

function parseStoredShop(value: string): ShopView {
  const parsed = JSON.parse(value) as Partial<ShopView>;
  // Idempotency records created before migration 0031 do not have country
  // fields. Normalize those durable responses without invalidating replay.
  return {
    ...parsed,
    businessCountry: parsed.businessCountry ?? null,
    defaultLocale: matchSupportedLocale(parsed.defaultLocale) ?? DEFAULT_LOCALE,
    merchantCountry: parsed.merchantCountry ?? null,
  } as ShopView;
}

function isPreCountrySchemaError(error: unknown): boolean {
  return error instanceof Error && /no such column: shops\.(?:merchant|business)_country_code/u.test(error.message);
}

export async function createShop(input: {
  businessCountry?: string | null;
  currency?: unknown;
  defaultLocale?: unknown;
  env: AppBindings;
  idempotencyKey: string;
  merchantCountry?: string | null;
  name: string;
  planCode: string;
  requestId: string;
  slug: string;
  userId: string;
}): Promise<{ created: boolean; shop: ShopView }> {
  if (!/^[A-Za-z0-9._:-]{8,128}$/u.test(input.idempotencyKey)) {
    throw new AppError("validation_failed", 400, ["idempotency_key_invalid"]);
  }

  const businessCountry = normalizeOptionalCountryCode(input.businessCountry, "business_country_invalid") ?? null;
  const merchantCountry = normalizeOptionalCountryCode(input.merchantCountry, "merchant_country_invalid") ?? null;
  const currency = normalizeCurrencyCode(input.currency ?? input.env.DEFAULT_CURRENCY);
  if (currency === null) throw new AppError("validation_failed", 400, ["currency_invalid"]);
  const defaultLocale = matchSupportedLocale(input.defaultLocale ?? input.env.DEFAULT_LOCALE);
  if (defaultLocale === null) throw new AppError("validation_failed", 400, ["locale_invalid"]);
  const namespace = "shop.create.v1";
  const keyHash = await hmacToken(input.env.SESSION_SECRET, "idempotency", input.idempotencyKey);
  const requestHash = await sha256Json(
    input.businessCountry === undefined && input.currency === undefined
      && input.defaultLocale === undefined && input.merchantCountry === undefined
      ? { name: input.name, planCode: input.planCode, slug: input.slug }
      : { businessCountry, currency, defaultLocale, merchantCountry, name: input.name, planCode: input.planCode, slug: input.slug },
  );
  const existing = await input.env.PLATFORM_DB.prepare(`
    SELECT request_hash, response_json
    FROM idempotency_records
    WHERE actor_user_id = ? AND namespace = ? AND key_hash = ? AND expires_at > ?
    LIMIT 1
  `).bind(input.userId, namespace, keyHash, new Date().toISOString()).first<ExistingIdempotency>();

  if (existing !== null) {
    if (existing.request_hash !== requestHash) {
      throw new AppError("idempotency_conflict", 409);
    }
    return { created: false, shop: parseStoredShop(existing.response_json) };
  }

  const reserved = await input.env.PLATFORM_DB.prepare(
    "SELECT slug FROM reserved_slugs WHERE slug = ? LIMIT 1",
  ).bind(input.slug).first<{ slug: string }>();
  if (reserved !== null) {
    throw new AppError("validation_failed", 409, ["slug_reserved"]);
  }

  const plan = await input.env.PLATFORM_DB.prepare(`
    SELECT id, code, feature_flags_json, limits_json
    FROM plans
    WHERE code = ? AND is_active = 1
    LIMIT 1
  `).bind(input.planCode).first<{
    code: string;
    feature_flags_json: string;
    id: string;
    limits_json: string;
  }>();
  if (plan === null) {
    throw new AppError("validation_failed", 400, ["plan_invalid"]);
  }

  const now = new Date();
  const nowIso = now.toISOString();
  const shopId = createId("shp");
  const shopPublicId = createId("shop");
  const subscriptionId = createId("sub");
  const domainId = createId("dom");
  const trialEndsAt = new Date(now.getTime() + 14 * 24 * 60 * 60_000).toISOString();
  const hostname = `${input.slug}.${input.env.PLATFORM_BASE_DOMAIN}`;
  const shop: ShopView = {
    businessCountry,
    currency,
    defaultLocale,
    featureFlags: safeJsonObject(plan.feature_flags_json),
    limits: safeJsonObject(plan.limits_json),
    merchantCountry,
    name: input.name,
    planCode: plan.code,
    publicId: shopPublicId,
    role: "owner",
    slug: input.slug,
    status: "draft",
    subscriptionState: "trialing",
    timezone: input.env.DEFAULT_TIMEZONE,
  };
  const responseJson = JSON.stringify(shop);
  const expiresAt = new Date(now.getTime() + 24 * 60 * 60_000).toISOString();

  try {
    await input.env.PLATFORM_DB.batch([
      input.env.PLATFORM_DB.prepare(`
        INSERT INTO shops (
          id, public_id, slug, name, status, default_locale, currency, timezone,
          canonical_domain_id, readiness_version, merchant_country_code, business_country_code,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, 'draft', ?, ?, ?, ?, 1, ?, ?, ?, ?)
      `).bind(
        shopId, shopPublicId, input.slug, input.name, defaultLocale,
        currency, input.env.DEFAULT_TIMEZONE, domainId, merchantCountry, businessCountry, nowIso, nowIso,
      ),
      input.env.PLATFORM_DB.prepare(`
        INSERT INTO shop_members (shop_id, user_id, role, status, created_at, updated_at)
        VALUES (?, ?, 'owner', 'active', ?, ?)
      `).bind(shopId, input.userId, nowIso, nowIso),
      input.env.PLATFORM_DB.prepare(`
        INSERT INTO shop_settings (
          shop_id, branding_json, storefront_json, order_expiry_minutes,
          low_stock_threshold, version, updated_at
        ) VALUES (?, '{}', '{}', 30, 5, 1, ?)
      `).bind(shopId, nowIso),
      input.env.PLATFORM_DB.prepare(`
        INSERT INTO shop_onboarding_profiles (
          shop_id, website_enabled, telegram_enabled, custom_domain_preference,
          current_step, version, created_at, updated_at
        ) VALUES (?, 0, 0, 'later', 'channel_selected', 1, ?, ?)
      `).bind(shopId, nowIso, nowIso),
      ...ONBOARDING_STEP_CODES.map((stepCode) => {
        const complete = stepCode === "account_ready" || stepCode === "shop_created";
        const inProgress = stepCode === "channel_selected";
        return input.env.PLATFORM_DB.prepare(`
          INSERT INTO shop_onboarding_steps (
            shop_id, step_code, status, version, started_at, completed_at,
            last_checked_at, blocking_code, audit_log_id, created_at, updated_at
          ) VALUES (?, ?, ?, 1, ?, ?, NULL, NULL, NULL, ?, ?)
        `).bind(
          shopId,
          stepCode,
          complete ? "complete" : inProgress ? "in_progress" : "pending",
          complete || inProgress ? nowIso : null,
          complete ? nowIso : null,
          nowIso,
          nowIso,
        );
      }),
      input.env.PLATFORM_DB.prepare(`
        INSERT INTO shop_subscriptions (
          id, shop_id, plan_id, state, trial_ends_at, created_at, updated_at
        ) VALUES (?, ?, ?, 'trialing', ?, ?, ?)
      `).bind(subscriptionId, shopId, plan.id, trialEndsAt, nowIso, nowIso),
      input.env.PLATFORM_DB.prepare(`
        INSERT INTO shop_domains (
          id, shop_id, hostname_normalized, type, status, is_primary,
          validation_metadata_json, activated_at, created_at, updated_at
        ) VALUES (?, ?, ?, 'platform_subdomain', 'active', 1, '{}', ?, ?, ?)
      `).bind(domainId, shopId, hostname, nowIso, nowIso, nowIso),
      input.env.PLATFORM_DB.prepare(`
        INSERT INTO idempotency_records (
          actor_user_id, namespace, key_hash, request_hash, response_json, created_at, expires_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `).bind(input.userId, namespace, keyHash, requestHash, responseJson, nowIso, expiresAt),
      input.env.PLATFORM_DB.prepare(`
        INSERT INTO audit_logs (
          id, shop_id, actor_type, actor_id, action, resource_type,
          resource_id, safe_metadata_json, request_id, created_at
        ) VALUES (?, ?, 'user', ?, 'shop.created', 'shop', ?, ?, ?, ?)
      `).bind(
        createId("aud"), shopId, input.userId, shopId,
        JSON.stringify({ planCode: plan.code, slug: input.slug }), input.requestId, nowIso,
      ),
    ]);
  } catch {
    const replay = await input.env.PLATFORM_DB.prepare(`
      SELECT request_hash, response_json
      FROM idempotency_records
      WHERE actor_user_id = ? AND namespace = ? AND key_hash = ?
      LIMIT 1
    `).bind(input.userId, namespace, keyHash).first<ExistingIdempotency>();
    if (replay !== null && replay.request_hash === requestHash) {
      return { created: false, shop: parseStoredShop(replay.response_json) };
    }
    throw new AppError("validation_failed", 409, ["slug_unavailable"]);
  }

  return { created: true, shop };
}

export async function getShopForMember(input: {
  capability: ShopCapability;
  env: AppBindings;
  shopPublicId: string;
  userId: string;
}): Promise<{ row: MembershipShopRow; shop: ShopView }> {
  let row: MembershipShopRow | null;
  try {
    row = await input.env.PLATFORM_DB.prepare(`
    SELECT
      shops.id AS shop_id,
      shops.public_id,
      shops.slug,
      shops.name,
      shops.status AS shop_status,
      shops.default_locale,
      shops.currency,
      shops.timezone,
      shops.merchant_country_code,
      shops.business_country_code,
      shop_members.role,
      shop_subscriptions.state AS subscription_state,
      plans.code AS plan_code,
      plans.feature_flags_json,
      plans.limits_json
    FROM shops
    INNER JOIN shop_members
      ON shop_members.shop_id = shops.id
      AND shop_members.user_id = ?
      AND shop_members.status = 'active'
    INNER JOIN shop_subscriptions
      ON shop_subscriptions.shop_id = shops.id
      AND shop_subscriptions.state != 'canceled'
    INNER JOIN plans ON plans.id = shop_subscriptions.plan_id
    WHERE shops.public_id = ?
    LIMIT 1
    `).bind(input.userId, input.shopPublicId).first<MembershipShopRow>();
  } catch (error) {
    if (!isPreCountrySchemaError(error)) throw error;
    row = await input.env.PLATFORM_DB.prepare(`
      SELECT
        shops.id AS shop_id,
        shops.public_id,
        shops.slug,
        shops.name,
        shops.status AS shop_status,
        shops.default_locale,
        shops.currency,
        shops.timezone,
        NULL AS merchant_country_code,
        NULL AS business_country_code,
        shop_members.role,
        shop_subscriptions.state AS subscription_state,
        plans.code AS plan_code,
        plans.feature_flags_json,
        plans.limits_json
      FROM shops
      INNER JOIN shop_members
        ON shop_members.shop_id = shops.id
        AND shop_members.user_id = ?
        AND shop_members.status = 'active'
      INNER JOIN shop_subscriptions
        ON shop_subscriptions.shop_id = shops.id
        AND shop_subscriptions.state != 'canceled'
      INNER JOIN plans ON plans.id = shop_subscriptions.plan_id
      WHERE shops.public_id = ?
      LIMIT 1
    `).bind(input.userId, input.shopPublicId).first<MembershipShopRow>();
  }

  if (row === null) {
    throw new AppError("authorization_denied", 403);
  }
  assertRoleCapability(row.role, input.capability);
  return { row, shop: mapShop(row) };
}

export async function listShopsForMember(input: {
  env: AppBindings;
  userId: string;
}): Promise<ShopView[]> {
  let result: { results: MembershipShopRow[] };
  try {
    result = await input.env.PLATFORM_DB.prepare(`
    SELECT
      shops.id AS shop_id,
      shops.public_id,
      shops.slug,
      shops.name,
      shops.status AS shop_status,
      shops.default_locale,
      shops.currency,
      shops.timezone,
      shops.merchant_country_code,
      shops.business_country_code,
      shop_members.role,
      shop_subscriptions.state AS subscription_state,
      plans.code AS plan_code,
      plans.feature_flags_json,
      plans.limits_json
    FROM shop_members
    INNER JOIN shops ON shops.id = shop_members.shop_id
    INNER JOIN shop_subscriptions
      ON shop_subscriptions.shop_id = shops.id
      AND shop_subscriptions.state != 'canceled'
    INNER JOIN plans ON plans.id = shop_subscriptions.plan_id
    WHERE shop_members.user_id = ? AND shop_members.status = 'active'
    ORDER BY shops.created_at ASC, shops.id ASC
    LIMIT 100
    `).bind(input.userId).all<MembershipShopRow>();
  } catch (error) {
    if (!isPreCountrySchemaError(error)) throw error;
    result = await input.env.PLATFORM_DB.prepare(`
      SELECT
        shops.id AS shop_id,
        shops.public_id,
        shops.slug,
        shops.name,
        shops.status AS shop_status,
        shops.default_locale,
        shops.currency,
        shops.timezone,
        NULL AS merchant_country_code,
        NULL AS business_country_code,
        shop_members.role,
        shop_subscriptions.state AS subscription_state,
        plans.code AS plan_code,
        plans.feature_flags_json,
        plans.limits_json
      FROM shop_members
      INNER JOIN shops ON shops.id = shop_members.shop_id
      INNER JOIN shop_subscriptions
        ON shop_subscriptions.shop_id = shops.id
        AND shop_subscriptions.state != 'canceled'
      INNER JOIN plans ON plans.id = shop_subscriptions.plan_id
      WHERE shop_members.user_id = ? AND shop_members.status = 'active'
      ORDER BY shops.created_at ASC, shops.id ASC
      LIMIT 100
    `).bind(input.userId).all<MembershipShopRow>();
  }

  return result.results.map(mapShop);
}

/** Select only from the already-authorized membership projection. */
export function selectShopForMember(shops: readonly ShopView[], requestedPublicId: string | null): ShopView | undefined {
  if (requestedPublicId === null || requestedPublicId.length === 0) return shops[0];
  return shops.find((shop) => shop.publicId === requestedPublicId) ?? shops[0];
}

export type PlatformAdminRole = "owner" | "risk" | "support";

export async function getPlatformAdminRole(input: {
  env: AppBindings;
  userId: string;
}): Promise<PlatformAdminRole | null> {
  const admin = await input.env.PLATFORM_DB.prepare(`
    SELECT role
    FROM platform_admins
    WHERE user_id = ? AND status = 'active'
    LIMIT 1
  `).bind(input.userId).first<{ role: PlatformAdminRole }>();
  return admin?.role ?? null;
}

export async function isPlatformAdmin(input: {
  env: AppBindings;
  userId: string;
}): Promise<boolean> {
  return (await getPlatformAdminRole(input)) !== null;
}

export async function updateShopProfile(input: {
  businessCountry?: string | null;
  currency?: unknown;
  defaultLocale?: unknown;
  env: AppBindings;
  merchantCountry?: string | null;
  name?: string;
  requestId: string;
  shopPublicId: string;
  userId: string;
}): Promise<ShopView> {
  const hasName = input.name !== undefined;
  const hasBusinessCountry = input.businessCountry !== undefined;
  const hasCurrency = input.currency !== undefined;
  const hasDefaultLocale = input.defaultLocale !== undefined;
  const hasMerchantCountry = input.merchantCountry !== undefined;
  if (!hasName && !hasBusinessCountry && !hasCurrency && !hasDefaultLocale && !hasMerchantCountry) {
    throw new AppError("validation_failed", 400, ["shop_profile_update_empty"]);
  }
  const name = hasName ? input.name : null;
  const businessCountry = normalizeOptionalCountryCode(input.businessCountry, "business_country_invalid");
  const currency = hasCurrency ? normalizeCurrencyCode(input.currency) : null;
  if (hasCurrency && currency === null) throw new AppError("validation_failed", 400, ["currency_invalid"]);
  const defaultLocale = hasDefaultLocale ? matchSupportedLocale(input.defaultLocale) : null;
  if (hasDefaultLocale && defaultLocale === null) throw new AppError("validation_failed", 400, ["locale_invalid"]);
  const merchantCountry = normalizeOptionalCountryCode(input.merchantCountry, "merchant_country_invalid");
  const current = await getShopForMember({
    capability: "shop:update",
    env: input.env,
    shopPublicId: input.shopPublicId,
    userId: input.userId,
  });
  if (hasCurrency && currency !== null) {
    const mismatch = await input.env.PLATFORM_DB.prepare(`
      SELECT COUNT(*) AS count
      FROM product_variants
      WHERE shop_id = ? AND currency != ?
    `).bind(current.row.shop_id, currency).first<{ count: number }>();
    if ((mismatch?.count ?? 0) > 0) {
      throw new AppError("validation_failed", 409, ["currency_mismatch"]);
    }
  }
  const now = new Date().toISOString();
  let result: { meta: { changes: number } };
  try {
    result = hasName && !hasBusinessCountry && !hasCurrency && !hasDefaultLocale && !hasMerchantCountry
      ? await input.env.PLATFORM_DB.prepare(`
          UPDATE shops SET name = ?, updated_at = ? WHERE id = ? AND public_id = ?
        `).bind(name, now, current.row.shop_id, input.shopPublicId).run()
      : await input.env.PLATFORM_DB.prepare(`
          UPDATE shops
          SET name = CASE WHEN ? = 1 THEN ? ELSE name END,
              business_country_code = CASE WHEN ? = 1 THEN ? ELSE business_country_code END,
              currency = CASE WHEN ? = 1 THEN ? ELSE currency END,
              default_locale = CASE WHEN ? = 1 THEN ? ELSE default_locale END,
              merchant_country_code = CASE WHEN ? = 1 THEN ? ELSE merchant_country_code END,
              readiness_version = readiness_version + 1,
              updated_at = ?
          WHERE id = ? AND public_id = ?
            AND (
              ? = 0 OR NOT EXISTS (
                SELECT 1 FROM product_variants
                WHERE product_variants.shop_id = shops.id
                  AND product_variants.currency <> ?
              )
            )
        `).bind(
          hasName ? 1 : 0, name,
          hasBusinessCountry ? 1 : 0, businessCountry ?? null,
          hasCurrency ? 1 : 0, currency,
          hasDefaultLocale ? 1 : 0, defaultLocale,
          hasMerchantCountry ? 1 : 0, merchantCountry ?? null,
          now, current.row.shop_id, input.shopPublicId,
          hasCurrency ? 1 : 0, currency,
        ).run();
  } catch (error) {
    if (error instanceof AppError) throw error;
    if (error instanceof Error && error.message.includes("shop_currency_variant_mismatch")) {
      throw new AppError("validation_failed", 409, ["currency_mismatch"]);
    }
    throw error;
  }
  if (result.meta.changes !== 1) {
    if (hasCurrency) throw new AppError("validation_failed", 409, ["currency_mismatch"]);
    throw new AppError("authorization_denied", 403);
  }

  const changedFields = [
    ...(hasName ? ["name"] : []),
    ...(hasBusinessCountry ? ["businessCountry"] : []),
    ...(hasCurrency ? ["currency"] : []),
    ...(hasDefaultLocale ? ["defaultLocale"] : []),
    ...(hasMerchantCountry ? ["merchantCountry"] : []),
  ];
  await input.env.PLATFORM_DB.prepare(`
    INSERT INTO audit_logs (
      id, shop_id, actor_type, actor_id, action, resource_type,
      resource_id, safe_metadata_json, request_id, created_at
    ) VALUES (?, ?, 'user', ?, 'shop.updated', 'shop', ?, ?, ?, ?)
  `).bind(
    createId("aud"), current.row.shop_id, input.userId, current.row.shop_id,
    JSON.stringify({ changedFields }), input.requestId, now,
  ).run();

  return {
    ...current.shop,
    businessCountry: hasBusinessCountry ? businessCountry ?? null : current.shop.businessCountry,
    currency: hasCurrency ? currency ?? current.shop.currency : current.shop.currency,
    defaultLocale: hasDefaultLocale ? defaultLocale ?? current.shop.defaultLocale : current.shop.defaultLocale,
    merchantCountry: hasMerchantCountry ? merchantCountry ?? null : current.shop.merchantCountry,
    name: hasName ? name as string : current.shop.name,
  };
}

export async function updateShopName(input: {
  env: AppBindings;
  name: string;
  requestId: string;
  shopPublicId: string;
  userId: string;
}): Promise<ShopView> {
  return updateShopProfile(input);
}

export async function suspendShop(input: {
  adminUserId: string;
  env: AppBindings;
  reason: string;
  requestId: string;
  shopPublicId: string;
}): Promise<void> {
  const admin = await input.env.PLATFORM_DB.prepare(`
    SELECT role
    FROM platform_admins
    WHERE user_id = ? AND status = 'active'
    LIMIT 1
  `).bind(input.adminUserId).first<{ role: string }>();
  if (admin === null || !new Set(["owner", "risk"]).has(admin.role)) {
    throw new AppError("authorization_denied", 403);
  }

  const shop = await input.env.PLATFORM_DB.prepare(`
    SELECT id, status
    FROM shops
    WHERE public_id = ?
    LIMIT 1
  `).bind(input.shopPublicId).first<{ id: string; status: string }>();
  if (shop === null) {
    throw new AppError("tenant_not_found", 404);
  }
  if (shop.status === "archived") {
    throw new AppError("validation_failed", 409, ["shop_archived"]);
  }

  const now = new Date().toISOString();
  await input.env.PLATFORM_DB.batch([
    input.env.PLATFORM_DB.prepare(`
      UPDATE shops
      SET status = 'suspended', updated_at = ?
      WHERE id = ? AND public_id = ? AND status != 'archived'
    `).bind(now, shop.id, input.shopPublicId),
    input.env.PLATFORM_DB.prepare(`
      INSERT INTO audit_logs (
        id, shop_id, actor_type, actor_id, action, resource_type,
        resource_id, safe_metadata_json, request_id, created_at
      ) VALUES (?, ?, 'platform_admin', ?, 'shop.suspended', 'shop', ?, ?, ?, ?)
    `).bind(
      createId("aud"), shop.id, input.adminUserId, shop.id,
      JSON.stringify({ reason: input.reason }), input.requestId, now,
    ),
  ]);
}
