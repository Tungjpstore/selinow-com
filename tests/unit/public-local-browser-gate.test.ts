import { readFileSync, readdirSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  buildLocalPublicCommandEnvironment,
  localPublicOrigins,
  validateLocalPublicBrowserBaseUrl,
  validatePublicPlaywrightArguments,
} from "../../scripts/lib/local-public-browser-gate.mjs";

describe("deterministic local public PromptOS browser gate", () => {
  it("derives only the isolated marketing, dashboard, storefront and API origins", () => {
    expect(localPublicOrigins("4399")).toEqual({
      api: "http://api.localhost:4399",
      dashboard: "http://app.localhost:4399",
      marketing: "http://localhost:4399",
      storefront: "http://signal.localhost:4399",
    });
    expect(() => validateLocalPublicBrowserBaseUrl("https://selinow.com/")).toThrow("local_public_browser_gate_base_url_invalid");
    expect(() => validateLocalPublicBrowserBaseUrl("http://app.localhost:4399/")).toThrow("local_public_browser_gate_base_url_invalid");
  });

  it("accepts only the three exact public PromptOS screenshot projects", () => {
    expect(validatePublicPlaywrightArguments([])).toEqual([]);
    expect(validatePublicPlaywrightArguments(["--project=public-desktop-1440"])).toEqual(["--project=public-desktop-1440"]);
    expect(validatePublicPlaywrightArguments(["--project=public-mobile-390"])).toEqual(["--project=public-mobile-390"]);
    expect(validatePublicPlaywrightArguments(["--update-snapshots"])).toEqual(["--update-snapshots"]);
    expect(validatePublicPlaywrightArguments(["--project=public-desktop-1440", "--update-snapshots"])).toEqual(["--project=public-desktop-1440", "--update-snapshots"]);
    expect(validatePublicPlaywrightArguments(["--project=public-zoom-200"])).toEqual(["--project=public-zoom-200"]);
    expect(() => validatePublicPlaywrightArguments(["--project=desktop"])).toThrow("local_public_browser_gate_arguments_invalid");
  });

  it("keeps the runner local-only and the public spec GET-only", () => {
    const runner = readFileSync("scripts/local-public-browser-gate.mjs", "utf8");
    const helper = readFileSync("scripts/lib/local-public-browser-gate.mjs", "utf8");
    const config = readFileSync("playwright.public-local.config.ts", "utf8");
    const spec = readFileSync("tests/visual/local-public.spec.ts", "utf8");
    const storefrontLayout = readFileSync("src/layouts/StorefrontLayout.astro", "utf8");
    const storefrontHome = readFileSync("src/pages/index.astro", "utf8");
    const platformCss = readFileSync("src/styles/platform.css", "utf8");
    expect(runner).toContain('"--local"');
    expect(runner).not.toContain('"--remote"');
    expect(runner).toContain("local_public_browser_gate_port_busy");
    expect(runner).toContain("4_399");
    expect(runner).toContain('"--file", "./seeds/0003_phase6_demo.sql"');
    expect(runner).toContain('{ quiet: true }');
    expect(runner).not.toContain('"--persist-to", stateDirectory], { capture: true }');
    expect(runner).toContain("rmSync(stateDirectory, { recursive: true, force: true })");
    expect(helper).toContain("buildLocalCommandEnvironment");
    expect(buildLocalPublicCommandEnvironment({
      baseUrl: "http://localhost:4399",
      sourceEnvironment: {},
      stateDirectory: "/tmp/selinow-public-browser-test",
      wranglerConfigPath: "/tmp/selinow-public-browser-test/wrangler.json",
    })).toMatchObject({
      APP_ENV: "local",
      CLOUDFLARE_INCLUDE_PROCESS_ENV: "false",
      CLOUDFLARE_VITE_FORCE_LOCAL: "true",
      SELINOW_PUBLIC_BROWSER_BASE_URL: "http://localhost:4399",
    });
    expect(config).toContain("public-desktop-1440");
    expect(config).toContain("height: 1024, width: 1440");
    expect(config).toContain("public-mobile-390");
    expect(config).toContain("height: 844, width: 390");
    expect(config).toContain("public-zoom-200");
    expect(config).toContain('name: "public-zoom-200"');
    expect(config).toContain("use: { viewport: { height: 512, width: 720 } }");
    expect(config).not.toContain("deviceScaleFactor: 2");
    expect(config).toContain('outputPath: "test-results/public-local-safe-failures.json"');
    expect(spec).toContain('request.method() !== "GET" && request.method() !== "HEAD"');
    expect(spec).toContain('routeHandle.abort("blockedbyclient")');
    expect(spec).toContain("expect(externalRequests, externalRequests.join");
    expect(spec).not.toContain("checkout-submit");
    expect(spec).not.toContain("POST /api/store/checkout");
    expect(spec).not.toContain("payment-submit");
    expect(spec).toContain("marketing-home");
    expect(spec).toContain("public-pricing.png");
    expect(spec).toContain("public-login.png");
    expect(spec).toContain("public-storefront-home.png");
    expect(storefrontLayout).toContain('<script src="../scripts/storefront/cart-count.ts"></script>');
    expect(storefrontLayout).not.toContain("const cartKey = `selinow-cart:v1:");
    expect(storefrontHome).toContain('<script src="../scripts/storefront/store-search.ts"></script>');
    expect(storefrontHome).not.toContain("<script is:inline>");
    expect(platformCss).toMatch(/\.trust-panel h2,[\s\S]*?\.final-cta h2 \{[\s\S]*?color: var\(--sln-white\);/u);
  });

  it("keeps one deterministic baseline for every public route and viewport", () => {
    const snapshots = readdirSync("tests/visual/local-public.spec.ts-snapshots", { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".png"))
      .map((entry) => entry.name);
    expect(snapshots).toHaveLength(16);
    for (const stem of [
      "public-marketing-home",
      "public-pricing",
      "public-login",
      "public-storefront-home",
      "public-storefront-product-detail",
      "public-storefront-cart",
      "public-storefront-checkout",
      "public-storefront-order-status",
    ]) {
      expect(snapshots.filter((filename) => filename.startsWith(`${stem}-`))).toHaveLength(2);
      expect(snapshots.some((filename) => filename.startsWith(`${stem}-public-desktop-1440-`))).toBe(true);
      expect(snapshots.some((filename) => filename.startsWith(`${stem}-public-mobile-390-`))).toBe(true);
    }
  });

  it("keeps contract-accurate transaction state baselines without a server mutation sink", () => {
    const spec = readFileSync("tests/visual/local-public-states.spec.ts", "utf8");
    const snapshots = readdirSync("tests/visual/local-public-states.spec.ts-snapshots", { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".png"))
      .map((entry) => entry.name);

    expect(spec).toContain('"POST /api/store/cart"');
    expect(spec).toContain('"POST /api/store/quote"');
    expect(spec).toContain("route.fulfill");
    expect(spec).toContain("unmockedMutations");
    expect(spec).toContain("price_changed");
    expect(spec).toContain("provider_unavailable");
    expect(spec).toContain("pending_payment");
    expect(spec).toContain("fulfilled");
    expect(snapshots).toHaveLength(10);
  });
});
