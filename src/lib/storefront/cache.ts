import type { AppBindings } from "../platform/bindings";
import { normalizeSupportedLocale } from "../i18n/locale";
import { buildStorefrontCacheKey, isPrivateStorefrontPath, isPublicStorefrontPath, normalizeHostname, type PlatformHostKind } from "./routing";

type ActiveDomainRow = {
  domainId: string;
  domainVersion: number;
  defaultLocale: string;
  hostnameNormalized: string;
  publishedVersion: number;
  shopStatus: string;
  status: string;
  subscriptionState: string | null;
};

const CACHEABLE_SUBSCRIPTION_STATES = new Set(["trialing", "active", "past_due"]);

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
  env: Pick<AppBindings, "PLATFORM_DB">;
  hostname: string;
  locale?: string;
  pathname: string;
  search?: string;
}): Promise<string | null> {
  const hostname = normalizeHostname(input.hostname);
  if (hostname === "") return null;

  const row = await input.env.PLATFORM_DB.prepare(`
    SELECT shop_domains.id AS domainId,
      shop_domains.hostname_normalized AS hostnameNormalized, shop_domains.status,
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
    FROM shop_domains
    INNER JOIN shops ON shops.id = shop_domains.shop_id AND shops.status = 'active'
    INNER JOIN shop_settings ON shop_settings.shop_id = shops.id
    WHERE shop_domains.hostname_normalized = ?
      AND shop_domains.status = 'active'
      AND shop_domains.deleted_at IS NULL
      AND (
        shop_domains.type = 'platform_subdomain'
        OR shop_domains.ownership_verified_at IS NOT NULL
      )
      AND (
        SELECT state
        FROM shop_subscriptions
        WHERE shop_id = shops.id
        ORDER BY created_at DESC, id DESC
        LIMIT 1
      ) IN ('trialing', 'active', 'past_due')
    LIMIT 1
  `).bind(hostname).first<ActiveDomainRow>();

  if (row === null
    || row.status !== "active"
    || row.shopStatus !== "active"
    || row.subscriptionState === null
    || !CACHEABLE_SUBSCRIPTION_STATES.has(row.subscriptionState)
    || !/^[a-z0-9][a-z0-9_-]{0,127}$/iu.test(row.domainId)
    || normalizeHostname(row.hostnameNormalized) !== hostname
    || !Number.isSafeInteger(row.domainVersion)
    || row.domainVersion < 1
    || !Number.isSafeInteger(row.publishedVersion)
    || row.publishedVersion < 1) return null;

  return buildStorefrontCacheKey({
    hostname,
    incarnation: row.domainId,
    locale: normalizeSupportedLocale(input.locale ?? row.defaultLocale),
    pathname: input.pathname,
    version: `${String(row.domainVersion)}-${String(row.publishedVersion)}`,
    ...(input.search === undefined ? {} : { search: input.search }),
  });
}
