import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { DEFAULT_LOCALE, resolveLocaleWithSource } from "../../src/lib/i18n/locale";

describe("middleware locale fallback contract", () => {
  it("sets a request locale only from supported request hints", async () => {
    const source = await readFile("src/middleware.ts", "utf8");

    expect(source).toContain("resolveLocaleWithSource({");
    expect(source).toContain("if (locale !== undefined) context.locals.locale = locale");
    expect(source).not.toContain("fallback: env.DEFAULT_LOCALE");
  });

  it("persists only an explicit supported locale preference", async () => {
    const source = await readFile("src/middleware.ts", "utf8");

    expect(source).toContain('localeResolution.source === "explicit"');
    expect(source).toContain("serializeCookie(LOCALE_COOKIE_NAME, localeResolution.locale");
    expect(source).toContain('response.headers.append("Set-Cookie", localePreferenceCookie)');
    expect(source).toContain('hit.headers.append("Set-Cookie", localePreferenceCookie)');
    expect(source).toContain("secure: requestUrl.protocol === \"https:\"");
  });

  it("keeps tenant rendering and commerce APIs on the shop default fallback", async () => {
    const [layout, cartRoute, checkoutRoute, homepage] = await Promise.all([
      readFile("src/layouts/StorefrontLayout.astro", "utf8"),
      readFile("src/pages/api/store/cart.ts", "utf8"),
      readFile("src/pages/api/store/checkout.ts", "utf8"),
      readFile("src/pages/index.astro", "utf8"),
    ]);

    expect(layout).toContain("Astro.locals.locale ?? normalizeSupportedLocale(shop.defaultLocale)");
    expect(cartRoute).toContain("normalizeLocale(body.locale ?? locals.locale, shop.defaultLocale)");
    expect(checkoutRoute).toContain("locals.locale ?? normalizeSupportedLocale(shop.defaultLocale)");
    expect(homepage).toContain("if (Astro.locals.locale === undefined)");
    expect(homepage).toContain("locale = normalizeSupportedLocale(shop.defaultLocale)");
  });

  it("uses English for no-hint platform requests while preserving the tenant default", () => {
    expect(DEFAULT_LOCALE).toBe("en");
    expect(resolveLocaleWithSource()).toEqual({ locale: "en", source: "default" });
    expect(resolveLocaleWithSource({ fallback: "vi-VN" })).toEqual({ locale: "vi-VN", source: "fallback" });
  });

  it("keeps local, staging, production and login on the centralized English platform default", async () => {
    const [login, source] = await Promise.all([
      readFile("src/pages/login.astro", "utf8"),
      readFile("wrangler.jsonc", "utf8"),
    ]);
    const wrangler = JSON.parse(source) as {
      env: {
        production: { vars: { DEFAULT_LOCALE: string } };
        staging: { vars: { DEFAULT_LOCALE: string } };
      };
      vars: { DEFAULT_LOCALE: string };
    };

    expect([
      wrangler.vars.DEFAULT_LOCALE,
      wrangler.env.staging.vars.DEFAULT_LOCALE,
      wrangler.env.production.vars.DEFAULT_LOCALE,
    ]).toEqual(["en", "en", "en"]);
    expect(login).toContain("Astro.locals.locale ?? DEFAULT_LOCALE");
    expect(login).not.toContain('Astro.locals.locale ?? "vi-VN"');
  });
});
