import type { APIRoute } from "astro";

import { getBindings } from "../lib/platform/bindings";
import { classifyPlatformHost } from "../lib/storefront/routing";
import { resolveStorefrontShop } from "../lib/storefront/store";
import { SITE_ORIGIN } from "../lib/seo";

const PRIVATE_PATHS = ["/app", "/app/", "/admin", "/admin/", "/api", "/api/", "/cart", "/checkout", "/login", "/onboarding", "/orders", "/orders/"];

function response(body: string, status = 200, indexable = false): Response {
  return new Response(body, {
    status,
    headers: {
      "Cache-Control": indexable ? "public, max-age=300" : "public, max-age=60",
      "Content-Type": "text/plain; charset=utf-8",
      ...(indexable ? {} : { "X-Robots-Tag": "noindex, nofollow" }),
    },
  });
}

export const GET: APIRoute = async ({ request }) => {
  const env = getBindings();
  // Never allow a local/staging surface to become discoverable by search engines.
  if (env.APP_ENV !== "production") return response("User-agent: *\nDisallow: /\n", 200, false);

  const hostKind = classifyPlatformHost(new URL(request.url).hostname, env);
  if (hostKind === "marketing") {
    return response([
      "User-agent: *",
      "Allow: /",
      ...PRIVATE_PATHS.map((path) => `Disallow: ${path}`),
      `Sitemap: ${SITE_ORIGIN}/sitemap.xml`,
      "",
    ].join("\n"), 200, true);
  }

  if (hostKind === "tenant-candidate") {
    try {
      const shop = await resolveStorefrontShop(request, env);
      if (shop.access === "live") {
        const origin = `https://${shop.canonicalHostname ?? shop.currentHostname}`;
        return response([
          "User-agent: *",
          "Allow: /",
          ...PRIVATE_PATHS.map((path) => `Disallow: ${path}`),
          `Sitemap: ${origin}/sitemap.xml`,
          "",
        ].join("\n"), 200, true);
      }
    } catch {
      // Unknown, suspended, and malformed tenant hosts are intentionally closed.
    }
  }

  return response("User-agent: *\nDisallow: /\n", 200, false);
};
