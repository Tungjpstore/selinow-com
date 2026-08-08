import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  deriveFallbackProgress,
  mergeServerProgress,
  parseOnboardingSnapshot,
  progressPercent,
} from "../../src/lib/dashboard/onboarding-ui";
import { requireResourceId } from "../../src/lib/catalog/policy";
import {
  assertIsolatedWranglerSecrets,
  assertOwnedDevServerStart,
  buildLocalCommandEnvironment,
  localBrowserSecretNames,
  resolveLocalBrowserPort,
  validateLocalBrowserBaseUrl,
  validatePlaywrightArguments,
  writeIsolatedDevVars,
  writeIsolatedWranglerConfig,
} from "../../scripts/lib/local-auth-browser-gate.mjs";
import { redactPlaywrightFailure } from "../../scripts/playwright-safe-failure-reporter.mjs";

function applyMigrations(database: DatabaseSync): void {
  const directory = join(process.cwd(), "migrations");
  for (const filename of readdirSync(directory).filter((name) => /^\d{4}_.+\.sql$/u.test(name)).sort()) {
    database.exec(readFileSync(join(directory, filename), "utf8"));
  }
}

describe("deterministic local authenticated browser gate", () => {
  let database: DatabaseSync;

  beforeEach(() => {
    database = new DatabaseSync(":memory:");
    applyMigrations(database);
    database.exec(readFileSync("seeds/0001_platform_defaults.sql", "utf8"));
    database.exec(readFileSync("seeds/0004_local_authenticated_browser.sql", "utf8"));
  });

  afterEach(() => {
    database.close();
  });

  it("seeds isolated desktop and mobile sellers at exactly one of eight completed UI groups", () => {
    const sellers = database.prepare(`
      SELECT
        platform_users.email_normalized AS email,
        shops.id AS shop_id,
        shops.public_id AS shop_public_id,
        shop_domains.status AS domain_status,
        shop_subscriptions.state AS subscription_state,
        shop_onboarding_profiles.current_step AS current_step,
        shop_onboarding_profiles.telegram_enabled AS telegram_enabled,
        shop_onboarding_profiles.website_enabled AS website_enabled
      FROM platform_users
      INNER JOIN shop_members ON shop_members.user_id = platform_users.id
      INNER JOIN shops ON shops.id = shop_members.shop_id
      INNER JOIN shop_domains ON shop_domains.id = shops.canonical_domain_id
      INNER JOIN shop_subscriptions ON shop_subscriptions.shop_id = shops.id
      INNER JOIN shop_onboarding_profiles ON shop_onboarding_profiles.shop_id = shops.id
      WHERE platform_users.email_normalized IN (
        'browser-gate-desktop@selinow.invalid',
        'browser-gate-mobile@selinow.invalid'
      )
      ORDER BY platform_users.email_normalized
    `).all() as Array<{
      domain_status: string;
      email: string;
      current_step: string;
      shop_id: string;
      shop_public_id: string;
      subscription_state: string;
      telegram_enabled: number;
      website_enabled: number;
    }>;

    expect(sellers).toHaveLength(2);
    expect(sellers.map((seller) => seller.email)).toEqual([
      "browser-gate-desktop@selinow.invalid",
      "browser-gate-mobile@selinow.invalid",
    ]);

    for (const seller of sellers) {
      expect(requireResourceId(seller.shop_public_id, "shop")).toBe(seller.shop_public_id);
      expect(seller).toMatchObject({
        current_step: "channel_selected",
        domain_status: "active",
        subscription_state: "trialing",
        telegram_enabled: 1,
        website_enabled: 0,
      });
      const steps = database.prepare(`
        SELECT step_code AS stepCode, status
        FROM shop_onboarding_steps
        WHERE shop_id = ?
        ORDER BY step_code
      `).all(seller.shop_id) as Array<{ status: string; stepCode: string }>;
      expect(steps).toHaveLength(10);
      expect(steps).toEqual(expect.arrayContaining([
        { status: "in_progress", stepCode: "channel_selected" },
        { status: "complete", stepCode: "shop_created" },
      ]));

      const snapshot = parseOnboardingSnapshot({
        profile: {
          customDomainPreference: "later",
          telegramEnabled: true,
          websiteEnabled: false,
        },
        steps,
      });
      const progress = mergeServerProgress(deriveFallbackProgress({
        activeProductCount: 0,
        availableInventoryCount: 0,
        hasManualProduct: false,
        payosReady: false,
        profile: snapshot.profile,
        readinessReady: false,
        settingsReady: false,
        shopExists: true,
        shopPublished: false,
        telegramHealthReady: false,
        telegramReady: false,
      }), snapshot.steps);

      expect(progressPercent(progress)).toBe(13);
      expect(Object.values(progress).filter((status) => status === "ready" || status === "warning")).toHaveLength(1);
    }
  });

  it("seeds deterministic order-detail states and isolated viewport identities", () => {
    const orderStates = database.prepare(`
      SELECT status, payment_status AS paymentStatus, fulfillment_status AS fulfillmentStatus, COUNT(*) AS count
      FROM orders
      WHERE shop_id IN ('shp_browser_desktop', 'shp_browser_mobile')
      GROUP BY status, payment_status, fulfillment_status
      ORDER BY status
    `).all() as Array<{ count: number; fulfillmentStatus: string; paymentStatus: string; status: string }>;
    expect(orderStates).toEqual(expect.arrayContaining([
      { count: 2, fulfillmentStatus: "fulfilled", paymentStatus: "paid", status: "completed" },
      { count: 2, fulfillmentStatus: "failed", paymentStatus: "failed", status: "exception" },
      { count: 2, fulfillmentStatus: "unfulfilled", paymentStatus: "unpaid", status: "pending_payment" },
      { count: 2, fulfillmentStatus: "reserved", paymentStatus: "paid", status: "processing" },
    ]));

    const matrixMembers = database.prepare(`
      SELECT COUNT(*) AS count
      FROM shop_members
      WHERE shop_id = 'shp_browser_matrix' AND status = 'active'
    `).get() as { count: number };
    expect(matrixMembers.count).toBe(5);
  });

  it("keeps the runner local-only and the Playwright flow free of credential export", () => {
    const dashboard = readFileSync("src/pages/app/index.astro", "utf8");
    const runner = readFileSync("scripts/local-auth-browser-gate.mjs", "utf8");
    const runnerLibrary = readFileSync("scripts/lib/local-auth-browser-gate.mjs", "utf8");
    const config = readFileSync("playwright.auth.config.ts", "utf8");
    const spec = readFileSync("tests/authenticated/local-authenticated.spec.ts", "utf8");

    expect(runner).toContain("mkdtempSync");
    expect(runner).toContain('"--local"');
    expect(runner).not.toContain('"--remote"');
    expect(runner).toContain('"--config", wranglerConfigPath');
    expect(runner).toContain("assertIsolatedWranglerSecrets");
    expect(runner).toContain("rmSync(stateDirectory, { recursive: true, force: true })");
    expect(runnerLibrary).toContain('CLOUDFLARE_VITE_FORCE_LOCAL: "true"');
    expect(runnerLibrary).toContain('CLOUDFLARE_INCLUDE_PROCESS_ENV: "false"');
    expect(config).toContain("validateLocalBrowserBaseUrl");
    expect(config).toContain("--host-resolver-rules=MAP app.localhost 127.0.0.1");
    expect(config).toContain('trace: "off"');
    expect(config).toContain('video: "off"');
    expect(config).toContain('["list"]');
    expect(config).toContain("playwright-safe-failure-reporter.mjs");
    expect(config).toMatch(/name: "desktop",[\s\S]*?local-authenticated\\\.spec\\\.ts\$[\s\S]*?height: 1024, width: 1440/iu);
    expect(config).toMatch(/name: "mobile",[\s\S]*?local-authenticated\\\.spec\\\.ts\$[\s\S]*?height: 844, width: 390/iu);
    expect(dashboard).toContain('descriptionId={shop === undefined ? undefined : "dashboard-overview-date"}');
    expect(dashboard).toContain("data-visual-dynamic");
    expect(spec).toContain('page.locator("#dashboard-overview-date")');
    expect(spec).toContain('page.locator("[data-visual-dynamic]")');
    expect(spec).toContain('maskColor: "#E2E8F0"');
    expect(spec).toContain("fullPage: false");
    expect(spec).not.toContain("fullPage: true");
    expect(spec).not.toContain('getByRole("link"');
    expect(spec).not.toMatch(/storageState|context\.cookies|getAttribute\(["']href|\.href\b/u);
    for (const path of [
      "/app/products",
      "/app/inventory",
      "/app/orders",
      "/app/automation",
      "/app/customers",
      "/app/integrations",
      "/app/store",
      "/app/data",
      "/app/members",
      "/app/billing",
      "/admin/shops",
    ]) {
      expect(spec).toContain(`path: "${path}"`);
    }
    for (const suffix of ["000000000101", "000000000102", "000000000103", "000000000104", "000000000201", "000000000202", "000000000203", "000000000204"]) {
      expect(spec).toContain(`"${suffix}"`);
    }
    for (const screenshot of [
      "authenticated-order-pending.png",
      "authenticated-order-paid-processing.png",
      "authenticated-order-fulfilled.png",
      "authenticated-order-failed.png",
      "authenticated-order-forbidden.png",
    ]) {
      expect(spec).toContain(`screenshot: "${screenshot}"`);
    }
    expect(spec).toContain("expectedStatus: 403");
  });

  it("covers authenticated representative surfaces at the PromptOS viewport matrix without new baselines", () => {
    const config = readFileSync("playwright.auth.config.ts", "utf8");
    const matrixSpec = readFileSync(
      "tests/authenticated/local-authenticated-viewport-matrix.spec.ts",
      "utf8",
    );

    for (const [name, height, width] of [
      ["kit-auth-desktop-1440", 1024, 1440],
      ["kit-auth-tablet-768", 1024, 768],
      ["kit-auth-mobile-390", 844, 390],
      ["kit-auth-minimum-320", 844, 320],
    ] as const) {
      expect(config).toContain(`name: "${name}"`);
      expect(config).toContain(`use: { viewport: { height: ${String(height)}, width: ${String(width)} } }`);
    }
    expect(config).toContain('name: "kit-auth-zoom-200"');
    expect(config).toContain("use: { viewport: { height: 512, width: 720 } }");
    expect(config).not.toContain("deviceScaleFactor: 2");

    expect(config).toContain("local-authenticated-viewport-matrix\\.spec\\.ts");
    expect(matrixSpec).toContain("browser-gate-${projectName}@selinow.invalid");
    expect(matrixSpec).toContain('request.method() === "GET" || request.method() === "HEAD"');
    expect(matrixSpec).toContain('route.abort("blockedbyclient")');
    expect(matrixSpec).toContain("expect(nonReadOnlyRequests).toEqual([])");
    expect(matrixSpec).toContain("geometry.scrollWidth");
    expect(matrixSpec).not.toContain("toHaveScreenshot");
    expect(matrixSpec).not.toMatch(/storageState|context\.cookies|getAttribute\(["']href|\.href\b/u);
  });
});

describe("authenticated browser gate isolation", () => {
  it("loads only disposable secrets beside the temporary Wrangler config", () => {
    const fakeRepository = mkdtempSync(join(tmpdir(), "selinow-auth-browser-repository-test-"));
    const stateDirectory = mkdtempSync(join(tmpdir(), "selinow-auth-browser-state-test-"));
    try {
      const sourceConfig = readFileSync("wrangler.jsonc", "utf8");
      writeFileSync(join(fakeRepository, "wrangler.jsonc"), sourceConfig, "utf8");
      writeFileSync(
        join(fakeRepository, ".dev.vars"),
        "SESSION_SECRET=repository-poison\nCLOUDFLARE_API_TOKEN=remote-poison\n",
        "utf8",
      );

      const configPath = writeIsolatedWranglerConfig(
        fakeRepository,
        stateDirectory,
        "http://app.localhost:4321",
      );
      let sequence = 0;
      const { devVarsPath, secrets } = writeIsolatedDevVars(
        stateDirectory,
        () => `disposable-secret-${String(sequence += 1)}`,
      );

      expect(() => {
        assertIsolatedWranglerSecrets(configPath, secrets);
      }).not.toThrow();
      expect(statSync(configPath).mode & 0o777).toBe(0o600);
      expect(statSync(devVarsPath).mode & 0o777).toBe(0o600);

      const isolatedConfig = JSON.parse(readFileSync(configPath, "utf8")) as {
        env?: unknown;
        secrets: { required: string[] };
        vars: { APP_ENV: string; DASHBOARD_ORIGIN: string };
      };
      expect(isolatedConfig.env).toBeUndefined();
      expect(isolatedConfig.secrets.required).toEqual(localBrowserSecretNames);
      expect(isolatedConfig.vars).toMatchObject({
        APP_ENV: "local",
        DASHBOARD_ORIGIN: "http://app.localhost:4321",
      });
      const serializedConfig = readFileSync(configPath, "utf8");
      expect(serializedConfig).not.toContain("selinow-staging");
      expect(serializedConfig).not.toMatch(/"remote"\s*:\s*true/u);
    } finally {
      rmSync(fakeRepository, { force: true, recursive: true });
      rmSync(stateDirectory, { force: true, recursive: true });
    }
  });

  it("passes only an explicit local process environment to child commands", () => {
    const environment = buildLocalCommandEnvironment({
      baseUrl: "http://app.localhost:4321",
      sourceEnvironment: {
        PATH: "/usr/bin:/bin",
        HOME: "/tmp/local-home",
        CLOUDFLARE_API_TOKEN: "remote-token",
        DATABASE_URL: "postgres://remote.invalid/database",
        SELINOW_AUTH_BROWSER_BASE_URL: "https://app.selinow.com",
      },
      stateDirectory: "/tmp/selinow-auth-browser-state",
      wranglerConfigPath: "/tmp/selinow-auth-browser-state/wrangler.auth-browser.json",
    });

    expect(environment).toMatchObject({
      APP_ENV: "local",
      CLOUDFLARE_INCLUDE_PROCESS_ENV: "false",
      CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV: "false",
      CLOUDFLARE_VITE_FORCE_LOCAL: "true",
      SELINOW_AUTH_BROWSER_BASE_URL: "http://app.localhost:4321",
    });
    expect(environment).not.toHaveProperty("CLOUDFLARE_API_TOKEN");
    expect(environment).not.toHaveProperty("DATABASE_URL");
  });

  it("rejects remote origins, unsafe ports and Playwright config overrides", () => {
    expect(validateLocalBrowserBaseUrl("http://app.localhost:4321")).toBe("http://app.localhost:4321");
    expect(() => validateLocalBrowserBaseUrl("https://app-staging.selinow.com"))
      .toThrow("local_auth_browser_gate_base_url_invalid");
    expect(() => validateLocalBrowserBaseUrl("http://app.localhost:4321/login?token=unsafe"))
      .toThrow("local_auth_browser_gate_base_url_invalid");
    expect(() => resolveLocalBrowserPort("443")).toThrow("local_auth_browser_gate_port_invalid");
    expect(validatePlaywrightArguments([])).toEqual([]);
    expect(validatePlaywrightArguments(["--update-snapshots"])).toEqual(["--update-snapshots"]);
    expect(validatePlaywrightArguments(["--project=kit-auth-desktop-1440", "--project=kit-auth-minimum-320"]))
      .toEqual(["--project=kit-auth-desktop-1440", "--project=kit-auth-minimum-320"]);
    expect(validatePlaywrightArguments(["--project=kit-auth-zoom-200"]))
      .toEqual(["--project=kit-auth-zoom-200"]);
    expect(() => validatePlaywrightArguments(["--config", "playwright.config.ts"]))
      .toThrow("local_auth_browser_gate_arguments_invalid");
    expect(() => validatePlaywrightArguments(["--project=desktop"]))
      .toThrow("local_auth_browser_gate_arguments_invalid");
  });

  it("stops only a dev server that the current gate successfully started", () => {
    expect(() => {
      assertOwnedDevServerStart("Dev server running at http://localhost:4321 (pid 123)", "4321");
    }).not.toThrow();
    expect(() => {
      assertOwnedDevServerStart("Dev server already running at http://localhost:4321 (pid 456)", "4321");
    }).toThrow("local_auth_browser_gate_concurrent_run");
    expect(() => {
      assertOwnedDevServerStart("unexpected background output", "4321");
    }).toThrow("local_auth_browser_gate_dev_server_ownership_unknown");
    expect(() => {
      assertOwnedDevServerStart("Dev server running at http://localhost:4322 (pid 789)", "4321");
    }).toThrow("local_auth_browser_gate_port_mismatch");
  });

  it("persists only redacted Playwright failure diagnostics", () => {
    const diagnostic = redactPlaywrightFailure(
      'href="/api/auth/magic-link/consume?token=opaque-token-value-that-is-longer-than-thirty-two-bytes" Cookie: selinow_session=private-value SESSION_SECRET=private-secret DODO_PAYMENTS_API_KEY=short-dodo-key DODO_PAYMENTS_WEBHOOK_KEY=short-webhook-key PAYOS_STAGING_CHANNEL_IDENTITY_FINGERPRINT=short-fingerprint PAYOS_CONTROLLED_STAGING_CLIENT_ID=short-client CLOUDFLARE_PLATFORM_API_TOKEN=short-platform-token CLOUDFLARE_ROUTE_AUDIT_API_TOKEN=short-route-token',
    );
    expect(diagnostic).toContain("/api/auth/magic-link/consume?[redacted]");
    expect(diagnostic).toContain("Cookie: [redacted]");
    expect(diagnostic).not.toContain("opaque-token-value");
    expect(diagnostic).not.toContain("private-value");
    expect(diagnostic).not.toContain("private-secret");
    expect(diagnostic).not.toContain("short-dodo-key");
    expect(diagnostic).not.toContain("short-webhook-key");
    expect(diagnostic).not.toContain("short-fingerprint");
    expect(diagnostic).not.toContain("short-client");
    const operatorTokens = redactPlaywrightFailure(
      "CLOUDFLARE_D1_API_TOKEN=d1-secret CLOUDFLARE_WORKER_DEPLOY_API_TOKEN=worker-secret",
    );
    expect(operatorTokens).toContain("CLOUDFLARE_D1_API_TOKEN=[redacted]");
    expect(operatorTokens).not.toContain("worker-secret");
    expect(diagnostic).not.toContain("short-platform-token");
    expect(diagnostic).not.toContain("short-route-token");
  });
});
