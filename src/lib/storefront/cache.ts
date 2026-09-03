import type { AppBindings } from "../platform/bindings";
import { subscriptionAllows } from "../billing/entitlements";
import { customDomainTurnstileAdmissionSql, hasFreshExactTurnstileAdmission } from "../domains/readiness";
import { normalizeSupportedLocale } from "../i18n/locale";
import { hasFeature } from "../tenants/policy";
import { buildStorefrontCacheKey, isPrivateStorefrontPath, isPublicStorefrontPath, normalizeHostname, type PlatformHostKind } from "./routing";

// The KV tier caches only *positive* resolver resolutions (the version-fenced
// cache key parts) for a bounded TTL. It is never authoritative: any mutation
// that can invalidate a resolution purges these entries, and the TTL backstop
// bounds staleness for everything else. A missing or failing binding falls
// back to the D1 resolver on every request.
const STOREFRONT_RESOLVER_KV_PREFIX = "storefront-resolver:";
const STOREFRONT_RESOLVER_TTL_SECONDS = 30;

type StorefrontResolverKeyParts = { defaultLocale: string; domainId: string; version: string };

/** Resolver environment: the KV tier is optional and D1 is always authoritative. */
export type StorefrontResolverEnv = Pick<AppBindings, "PLATFORM_DB"> & { PLATFORM_CACHE?: KVNamespace };

function isSafeResolverKeyParts(value: unknown): value is StorefrontResolverKeyParts {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as { defaultLocale?: unknown; domainId?: unknown; version?: unknown };
  return typeof candidate.defaultLocale === "string"
    && candidate.defaultLocale.length > 0
    && candidate.defaultLocale.length <= 16
    && typeof candidate.domainId === "string"
    && /^[a-z0-9][a-z0-9_-]{0,127}$/iu.test(candidate.domainId)
    && typeof candidate.version === "string"
    && /^[1-9][0-9]*(?:-[1-9][0-9]*)?$/u.test(candidate.version);
}

async function readResolverKeyParts(env: StorefrontResolverEnv, hostname: string): Promise<StorefrontResolverKeyParts | null> {
  const kv = env.PLATFORM_CACHE;
  if (kv === undefined) return null;
  try {
    const raw = await kv.get(`${STOREFRONT_RESOLVER_KV_PREFIX}${hostname}`);
    if (raw === null) return null;
    const parsed: unknown = JSON.parse(raw);
    return isSafeResolverKeyParts(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

async function writeResolverKeyParts(env: StorefrontResolverEnv, hostname: string, parts: StorefrontResolverKeyParts): Promise<void> {
  const kv = env.PLATFORM_CACHE;
  if (kv === undefined) return;
  try {
    await kv.put(
      `${STOREFRONT_RESOLVER_KV_PREFIX}${hostname}`,
      JSON.stringify({ ...parts, storedAt: new Date().toISOString() }),
      { expirationTtl: STOREFRONT_RESOLVER_TTL_SECONDS },
    );
  } catch {
    // A KV outage must never break storefront resolution; D1 stays authoritative.
  }
}

export async function purgeStorefrontResolverCache(env: StorefrontResolverEnv, hostnames: readonly string[]): Promise<void> {
  const kv = env.PLATFORM_CACHE;
  if (kv === undefined) return;
  for (const hostname of hostnames) {
    const normalized = normalizeHostname(hostname);
    if (normalized === "") continue;
    try {
      await kv.delete(`${STOREFRONT_RESOLVER_KV_PREFIX}${normalized}`);
    } catch {
      // TTL bounds staleness when KV deletion is unavailable.
    }
  }
}

/** Purges the resolver entries of every hostname currently mapped to the shop. */
export async function purgeStorefrontResolverCacheForShop(env: StorefrontResolverEnv, shopId: string): Promise<void> {
  try {
    const rows = await env.PLATFORM_DB.prepare("SELECT hostname_normalized AS hostname FROM shop_domains WHERE shop_id = ? AND deleted_at IS NULL").bind(shopId).all<{ hostname: string }>();
    await purgeStorefrontResolverCache(env, rows.results.map((row) => row.hostname));
  } catch {
    // D1 unavailability must not turn a purge into a request failure.
  }
}

type ActiveDomainRow = {
  domainId: string;
  domainType: string;
  domainValidationMetadataJson: string;
  domainVersion: number;
  defaultLocale: string;
  hostnameNormalized: string;
  publishedVersion: number;
  shopStatus: string;
  status: string;
  currentPeriodEnd: string | null;
  trialEndsAt: string | null;
  graceEndsAt: string | null;
  featureFlagsJson: string;
  subscriptionState: string | null;
};

export function isStorefrontCacheCandidate(input: {
  appEnv: AppBindings["APP_ENV"];
  hostKind: PlatformHostKind;
  method: string;
  pathname: string;
}): boolean {
  return input.appEnv !== "local"
    && input.method === "GET"
    && input.hostKind === "tenant-candidate"
    && isPublicStorefrontPath(input.pathname)
    && !isPrivateStorefrontPath(input.pathname);
}

export async function resolveActiveStorefrontCacheKey(input: {
  env: StorefrontResolverEnv;
  hostname: string;
  locale?: string;
  pathname: string;
  search?: string;
}): Promise<string | null> {
  const hostname = normalizeHostname(input.hostname);
  if (hostname === "") return null;

  // Bounded KV shortcut: a cached positive resolution rebuilds the same
  // version-fenced key without the D1 round-trip. Miss/failure → D1 below.
  const cachedParts = await readResolverKeyParts(input.env, hostname);
  if (cachedParts !== null) {
    return buildStorefrontCacheKey({
      hostname,
      incarnation: cachedParts.domainId,
      locale: normalizeSupportedLocale(input.locale ?? cachedParts.defaultLocale),
      pathname: input.pathname,
      version: cachedParts.version,
      ...(input.search === undefined ? {} : { search: input.search }),
    });
  }

  const row = await input.env.PLATFORM_DB.prepare(`
    SELECT shop_domains.id AS domainId,
      shop_domains.hostname_normalized AS hostnameNormalized, shop_domains.status,
      shop_domains.type AS domainType,
      shop_domains.validation_metadata_json AS domainValidationMetadataJson,
      shop_domains.version AS domainVersion,
      shop_settings.published_version AS publishedVersion,
      shops.default_locale AS defaultLocale, shops.status AS shopStatus,
      (
        SELECT state
        FROM shop_subscriptions
        WHERE shop_id = shops.id
        ORDER BY created_at DESC, id DESC
        LIMIT 1
      ) AS subscriptionState
      ,(
        SELECT current_period_end
        FROM shop_subscriptions
        WHERE shop_id = shops.id
        ORDER BY created_at DESC, id DESC
        LIMIT 1
      ) AS currentPeriodEnd
      ,(
        SELECT trial_ends_at
        FROM shop_subscriptions
        WHERE shop_id = shops.id
        ORDER BY created_at DESC, id DESC
        LIMIT 1
      ) AS trialEndsAt
      ,(
        SELECT grace_ends_at
        FROM shop_subscriptions
        WHERE shop_id = shops.id
        ORDER BY created_at DESC, id DESC
        LIMIT 1
      ) AS graceEndsAt
      ,(
        SELECT plans.feature_flags_json
        FROM shop_subscriptions AS entitlement_subscription
        INNER JOIN plans ON plans.id = entitlement_subscription.plan_id
        WHERE entitlement_subscription.shop_id = shops.id
        ORDER BY entitlement_subscription.created_at DESC, entitlement_subscription.id DESC
        LIMIT 1
      ) AS featureFlagsJson
    FROM shop_domains
    INNER JOIN shops ON shops.id = shop_domains.shop_id AND shops.status = 'active'
    INNER JOIN shop_settings ON shop_settings.shop_id = shops.id
    WHERE shop_domains.hostname_normalized = ?
      AND shop_domains.status = 'active'
      AND shop_domains.deleted_at IS NULL
      AND (
        shop_domains.type = 'platform_subdomain'
        OR (
          shop_domains.ownership_verified_at IS NOT NULL
          AND shop_domains.hostname_status = 'active'
          AND shop_domains.ssl_status = 'active'
          AND shop_domains.dns_status = 'active'
          AND ${customDomainTurnstileAdmissionSql("shop_domains")}
          AND EXISTS (
            SELECT 1
            FROM shop_subscriptions AS current_domain_subscription
            INNER JOIN plans ON plans.id = current_domain_subscription.plan_id
            WHERE current_domain_subscription.id = (
              SELECT latest_subscription.id
              FROM shop_subscriptions AS latest_subscription
              WHERE latest_subscription.shop_id = shops.id
              ORDER BY latest_subscription.created_at DESC, latest_subscription.id DESC
              LIMIT 1
            )
              AND json_extract(plans.feature_flags_json, '$.customDomain') = 1
          )
        )
      )
    LIMIT 1
  `).bind(hostname).first<ActiveDomainRow>();

  if (row === null
    || row.status !== "active"
    || row.shopStatus !== "active"
    || (row.domainType === "custom" && !hasFreshExactTurnstileAdmission({
      hostname,
      validationMetadataJson: row.domainValidationMetadataJson,
    }))
    || (row.domainType === "custom" && !hasFeature(row.featureFlagsJson, "customDomain"))
    || (row.domainType !== "custom" && row.domainType !== "platform_subdomain")
    || row.subscriptionState === null
    || !subscriptionAllows({ currentPeriodEnd: row.currentPeriodEnd, graceEndsAt: row.graceEndsAt, subscriptionState: row.subscriptionState, trialEndsAt: row.trialEndsAt })
    || !/^[a-z0-9][a-z0-9_-]{0,127}$/iu.test(row.domainId)
    || normalizeHostname(row.hostnameNormalized) !== hostname
    || !Number.isSafeInteger(row.domainVersion)
    || row.domainVersion < 1
    || !Number.isSafeInteger(row.publishedVersion)
    || row.publishedVersion < 1) return null;

  const version = `${String(row.domainVersion)}-${String(row.publishedVersion)}`;
  const key = buildStorefrontCacheKey({
    hostname,
    incarnation: row.domainId,
    locale: normalizeSupportedLocale(input.locale ?? row.defaultLocale),
    pathname: input.pathname,
    version,
    ...(input.search === undefined ? {} : { search: input.search }),
  });
  await writeResolverKeyParts(input.env, hostname, { defaultLocale: row.defaultLocale, domainId: row.domainId, version });
  return key;
}
