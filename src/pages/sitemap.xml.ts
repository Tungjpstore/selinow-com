import type { APIRoute } from "astro";

import { getBindings } from "../lib/platform/bindings";
import { solutionSlugs } from "../lib/content/solutions";
import { SUPPORTED_LOCALES } from "../lib/i18n/locale";
import { absoluteSeoUrl, alternateLocaleUrl, SITE_ORIGIN } from "../lib/seo";
import { classifyPlatformHost } from "../lib/storefront/routing";
import { getStorefrontCatalog, resolveStorefrontShop } from "../lib/storefront/store";

const XML_CONTENT_TYPE = "application/xml; charset=utf-8";

function escapeXml(value: string): string {
  return value.replace(/[<>&'"]/gu, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "'": "&apos;",
    "\"": "&quot;",
  })[character] ?? character);
}

function urlEntry(pathname: string, origin: string, includeAlternates = true): string {
  const loc = absoluteSeoUrl(pathname, origin);
  const alternates = includeAlternates
    ? SUPPORTED_LOCALES.map((locale) => `<xhtml:link rel="alternate" hreflang="${escapeXml(locale)}" href="${escapeXml(alternateLocaleUrl(pathname, locale, origin))}" />`).join("")
      + `<xhtml:link rel="alternate" hreflang="x-default" href="${escapeXml(alternateLocaleUrl(pathname, "en", origin))}" />`
    : "";
  return `<url><loc>${escapeXml(loc)}</loc>${alternates}</url>`;
}

function sitemapResponse(entries: readonly string[]): Response {
  return new Response([
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">`,
    ...entries,
    "</urlset>",
  ].join(""), {
    headers: {
      "Cache-Control": "public, max-age=300",
      "Content-Type": XML_CONTENT_TYPE,
    },
  });
}

export const GET: APIRoute = async ({ request }) => {
  const env = getBindings();
  if (env.APP_ENV !== "production") return sitemapResponse([]);

  const requestUrl = new URL(request.url);
  const hostKind = classifyPlatformHost(requestUrl.hostname, env);
  if (hostKind === "marketing") {
    return sitemapResponse([
      urlEntry("/", SITE_ORIGIN),
      urlEntry("/pricing", SITE_ORIGIN),
      ...["/solutions", ...solutionSlugs.map((slug) => `/solutions/${slug}`)].map((pathname) => urlEntry(pathname, SITE_ORIGIN)),
    ]);
  }

  if (hostKind === "tenant-candidate") {
    try {
      const shop = await resolveStorefrontShop(request, env);
      if (shop.access !== "live") return sitemapResponse([]);
      const catalog = await getStorefrontCatalog(env, shop);
      const origin = `https://${shop.canonicalHostname ?? shop.currentHostname}`;
      return sitemapResponse([
        urlEntry("/", origin),
        ...catalog.products.map((product) => urlEntry(`/products/${encodeURIComponent(product.slug)}`, origin)),
      ]);
    } catch {
      return sitemapResponse([]);
    }
  }

  return sitemapResponse([]);
};
