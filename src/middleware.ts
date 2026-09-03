import { defineMiddleware } from "astro:middleware";

import {
  applyPrivatePageHeaders,
  applySecurityHeaders,
  isPrivatePagePath,
  resolveRequestId,
} from "./lib/http/security";
import { shouldEnforceHttps, toHttpsRedirect } from "./lib/http/https";
import { loggerFor } from "./lib/operations/logger";
import { getBindings } from "./lib/platform/bindings";
import { parseCookies, serializeCookie } from "./lib/http/cookies";
import { LOCALE_COOKIE_NAME, resolveLocaleWithSource } from "./lib/i18n/locale";
import { isStorefrontCacheCandidate, resolveActiveStorefrontCacheKey } from "./lib/storefront/cache";
import { classifyPlatformHost } from "./lib/storefront/routing";

export const onRequest = defineMiddleware(async (context, next) => {
  const startedAt = Date.now();
  const requestId = resolveRequestId(context.request.headers.get("X-Request-Id"));
  context.locals.requestId = requestId;

  const env = getBindings();
  const logger = loggerFor(env);
  let responseStatus = 500;
  try {
    const requestUrl = new URL(context.request.url);
    // BUG-001: universal HTTP→HTTPS canonicalization before any other work so
    // no platform, API, dashboard or tenant route is ever served over
    // plaintext. Local/loopback hosts are exempt for `wrangler dev`.
    if (shouldEnforceHttps(context.request, env.APP_ENV)) {
      const redirect = toHttpsRedirect(context.request);
      if (redirect !== null) {
        responseStatus = redirect.status;
        return redirect;
      }
    }
    const hostKind = classifyPlatformHost(requestUrl.hostname, env);
    const localeResolution = resolveLocaleWithSource({
      acceptLanguage: context.request.headers.get("Accept-Language"),
      cookie: parseCookies(context.request.headers.get("Cookie")).get(LOCALE_COOKIE_NAME),
      explicit: requestUrl.searchParams.get("lang"),
    });
    const locale = localeResolution.source === "default" ? undefined : localeResolution.locale;
    // Locale persistence (project-wide): an explicit `?lang=` switch and the
    // first-touch Accept-Language detection both persist a one-year cookie so
    // navigation is stable without `?lang` spam in internal links. On the
    // platform domain the cookie is shared across app./storefront subdomains;
    // dev localhost keeps host-only cookies.
    const persistsLocale = localeResolution.source === "explicit" || localeResolution.source === "accept-language";
    const localeCookieDomain = requestUrl.hostname.endsWith(`.${env.PLATFORM_BASE_DOMAIN}`)
      ? `.${env.PLATFORM_BASE_DOMAIN}`
      : undefined;
    const localePreferenceCookie = persistsLocale
      ? serializeCookie(LOCALE_COOKIE_NAME, localeResolution.locale, {
        httpOnly: false,
        maxAge: 31_536_000,
        sameSite: "Lax",
        secure: requestUrl.protocol === "https:",
        ...(localeCookieDomain === undefined ? {} : { domain: localeCookieDomain }),
      })
      : null;
    // Leave locale unset when the request has no supported browser hint. Tenant
    // routes can then use the authoritative shop default; platform pages keep
    // their own environment fallback.
    if (locale !== undefined) context.locals.locale = locale;
    const canUseTenantCache = isStorefrontCacheCandidate({
      appEnv: env.APP_ENV,
      hostKind,
      method: context.request.method,
      pathname: requestUrl.pathname,
    });
    const cacheKeyUrl = canUseTenantCache
      ? await resolveActiveStorefrontCacheKey({
        env,
        hostname: requestUrl.hostname,
        pathname: requestUrl.pathname,
        search: requestUrl.search,
        ...(locale === undefined ? {} : { locale }),
      })
      : null;
    const cacheKey = cacheKeyUrl === null ? null : new Request(cacheKeyUrl, { method: "GET" });

    if (cacheKey !== null) {
      const cloudflareCache = (caches as CacheStorage & { default: Cache }).default;
      const cached = await cloudflareCache.match(cacheKey);
      if (cached !== undefined) {
        const hit = new Response(cached.body, cached);
        hit.headers.set("X-Storefront-Cache", "HIT");
        if (localePreferenceCookie !== null) hit.headers.append("Set-Cookie", localePreferenceCookie);
        applySecurityHeaders(hit.headers, requestId);
        responseStatus = hit.status;
        return hit;
      }
    }

    const response = await next();
    applySecurityHeaders(response.headers, requestId);
    if (isPrivatePagePath(requestUrl.pathname)) {
      applyPrivatePageHeaders(response.headers);
    }

    if (cacheKey !== null && response.ok && response.headers.get("X-Storefront-Cacheable") === "1") {
      response.headers.delete("X-Storefront-Cacheable");
      response.headers.set("Cache-Control", "public, max-age=0, s-maxage=60, stale-while-revalidate=300");
      response.headers.set("Vary", "Accept-Language, Cookie, Host");
      response.headers.set("X-Storefront-Cache", "MISS");
      const cloudflareCache = (caches as CacheStorage & { default: Cache }).default;
      await cloudflareCache.put(cacheKey, response.clone());
    } else {
      response.headers.delete("X-Storefront-Cacheable");
    }
    if (localePreferenceCookie !== null) response.headers.append("Set-Cookie", localePreferenceCookie);

    responseStatus = response.status;
    return response;
  } finally {
    logger.info({
      durationMs: Date.now() - startedAt,
      event: "http.request_completed",
      requestId,
      source: "http",
      status: responseStatus,
    });
  }
});
