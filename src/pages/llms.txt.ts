import type { APIRoute } from "astro";

import { solutionSlugs } from "../lib/content/solutions";
import { getBindings } from "../lib/platform/bindings";
import { classifyPlatformHost } from "../lib/storefront/routing";

const BODY = [
  "# Selinow",
  "> Selinow is a bilingual commerce operating layer for selling digital products — automatic delivery of digital files and license keys after verified payment — starting with Website and Telegram and designed for additional customer channels.",
  "",
  "## Product facts",
  "- One catalog, order, payment, inventory, and fulfillment core for Website and Telegram.",
  "- English and Vietnamese marketing and storefront locale variants.",
  "- Payment confirmation and fulfillment remain separate states; browser redirects do not mark orders paid.",
  "- Tenant-scoped inventory and order workflows preserve shop isolation.",
  "- Digital files and license-related delivery are released only after the configured order and payment checks pass.",
  "- WhatsApp, Zalo OA, Discord, and API are planned or expanding channels, not represented as live product capabilities here.",
  "",
  "## Official pages",
  "- [Homepage](https://selinow.com/)",
  "- [Pricing](https://selinow.com/pricing)",
  "- [Solutions](https://selinow.com/solutions)",
  ...solutionSlugs.map((slug) => `- [${slug}](https://selinow.com/solutions/${slug})`),
  "",
  "## Locale policy",
  "- English is the default canonical locale.",
  "- Vietnamese is available with the `?lang=vi-VN` locale variant and reciprocal `hreflang` metadata.",
  "- Product claims on this page are limited to capabilities documented in the official pages above.",
  "",
].join("\n");

export const GET: APIRoute = ({ request }) => {
  const env = getBindings();
  const hostKind = classifyPlatformHost(new URL(request.url).hostname, env);
  if (env.APP_ENV !== "production" || hostKind !== "marketing") {
    return new Response("Not found\n", {
      status: 404,
      headers: {
        "Cache-Control": "private, no-store, max-age=0",
        "Content-Type": "text/plain; charset=utf-8",
        "X-Robots-Tag": "noindex, nofollow",
      },
    });
  }

  return new Response(BODY, {
    headers: {
      "Cache-Control": "public, max-age=300",
      "Content-Type": "text/plain; charset=utf-8",
    },
  });
};
