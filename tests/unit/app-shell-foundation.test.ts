import { glob, readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

/**
 * Single-shell contract (Console v2): after shell convergence there is exactly
 * one seller chrome — src/layouts/AppLayout.astro. ConsoleLayout is deleted
 * and must never be re-imported. Every workspace page (including onboarding)
 * renders inside AppLayout; only the redirect aliases stay layout-less.
 */

// Redirect-only routes: they forward to a real workspace page and never render chrome.
const REDIRECT_ALIASES = new Set([
  "src/pages/app/telegram.astro",
  "src/pages/app/store/settings.astro",
]);

describe("single shell contract", () => {
  it("renders every workspace page inside the single AppLayout", async () => {
    const pages = [
      ...(await Array.fromAsync(glob("src/pages/app/**/*.astro"))),
      "src/pages/onboarding.astro",
    ].filter((file) => !REDIRECT_ALIASES.has(file));

    expect(pages.length).toBeGreaterThanOrEqual(18);
    for (const file of pages) {
      const source = await readFile(file, "utf8");
      expect(source, `${file} must import AppLayout`).toContain("import AppLayout from");
      expect(source, `${file} must render <AppLayout`).toContain("<AppLayout");
    }
  });

  it("keeps ConsoleLayout deleted — no file may import or reference it", async () => {
    await expect(readFile("src/layouts/ConsoleLayout.astro", "utf8")).rejects.toThrow();
    const files = await Array.fromAsync(glob("src/**/*.astro"));
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const source = await readFile(file, "utf8");
      expect(source, `${file} references the retired ConsoleLayout`).not.toContain("ConsoleLayout");
    }
  });

  it("keeps redirect aliases as layout-less forwarders to implemented contracts", async () => {
    const [telegramAlias, storeSettingsAlias, integrations, store] = await Promise.all([
      readFile("src/pages/app/telegram.astro", "utf8"),
      readFile("src/pages/app/store/settings.astro", "utf8"),
      readFile("src/pages/app/integrations.astro", "utf8"),
      readFile("src/pages/app/store.astro", "utf8"),
    ]);

    for (const alias of [telegramAlias, storeSettingsAlias]) {
      expect(alias).not.toContain("import AppLayout from");
      expect(alias).toContain('destination.searchParams.set("shop", shopPublicId)');
    }
    expect(telegramAlias).toContain('new URL("/app/integrations?focus=telegram", Astro.url)');
    expect(telegramAlias).toContain("#telegram");
    expect(storeSettingsAlias).toContain('new URL("/app/store?focus=settings", Astro.url)');
    expect(storeSettingsAlias).toContain("#store-settings");
    expect(integrations).toContain('id="telegram"');
    expect(store).toContain('id="store-settings"');
  });

  it("gates nav by role and covers every IA group (Sell/Catalog/Channels/Operations/Configuration)", async () => {
    const layout = await readFile("src/layouts/AppLayout.astro", "utf8");

    // Role gating: items are filtered server-side per the selected shop role,
    // and readiness stays reachable before any shop exists.
    expect(layout).toContain("const isVisibleForRole = (item: NavItem): boolean => item.roles === undefined");
    expect(layout).toContain("item.roles.includes(selectedShopRole)");
    expect(layout).toContain("(shops.length === 0 && item.visibleWithoutShop === true)");
    expect(layout).toContain('selectedShopRole === "owner" || selectedShopRole === "manager"');

    for (const groupKey of ["sell", "catalog", "automation", "channels", "settings"]) {
      expect(layout, `nav group ${groupKey} must exist`).toContain(`key: "${groupKey}"`);
    }
    // Sell
    for (const path of ["/app", "/app/orders", "/app/bookings", "/app/customers"]) {
      expect(layout, `nav path ${path} must exist`).toContain(`path: "${path}"`);
    }
    // Catalog + operations
    for (const path of ["/app/products", "/app/inventory", "/app/automation"]) {
      expect(layout, `nav path ${path} must exist`).toContain(`path: "${path}"`);
    }
    // Channels
    for (const path of ["/app/store", "/app/integrations", "/app/payments", "/app/domains"]) {
      expect(layout, `nav path ${path} must exist`).toContain(`path: "${path}"`);
    }
    // Configuration (+ readiness entry that doubles as the onboarding nav item)
    for (const path of ["/app/store/settings", "/app/members", "/app/security", "/app/billing", "/app/developer", "/app/data", "/onboarding"]) {
      expect(layout, `nav path ${path} must exist`).toContain(`path: "${path}"`);
    }
    expect(layout).toContain('icon: "check", label: t("dashboard.console.nav.readiness"), path: "/onboarding"');
    expect(layout).toContain("visibleWithoutShop: true");
  });

  it("keeps shop switching server-rendered, logout CSRF-decoded and locale direction", async () => {
    const layout = await readFile("src/layouts/AppLayout.astro", "utf8");

    expect(layout).toContain("shopSwitchHref(Astro.url, shopPublicId)");
    expect(layout).toContain("data-app-shop-select");
    expect(layout).toContain("data-shop-href={shop.href}");
    expect(layout).toContain("href: shopSelectionHref(shop.publicId)");
    expect(layout).not.toContain("url.searchParams.set(\"shop\"");
    // Logout stays on the double-submit CSRF flow with decoded cookie value.
    expect(layout).toContain('headers: { "X-CSRF-Token": decodeURIComponent(csrf) }');
    expect(layout).toContain("dir={directionForLocale(locale)}");
  });

  it("exposes the V2 chrome hooks (data-app-shell, PromptOS tab bar, mobile sheet)", async () => {
    const [layout, css] = await Promise.all([
      readFile("src/layouts/AppLayout.astro", "utf8"),
      readFile("src/styles/app-shell.css", "utf8"),
    ]);

    expect(layout).toContain("data-app-shell");
    // PromptOS mobile groups: one primary third + a sheet of remaining groups.
    expect(layout).toContain('const mobilePrimaryThird = visibleItem("/app/products") ?? visibleItem("/app/customers");');
    expect(layout).toContain("const mobileMoreGroups");
    expect(layout).toContain("href={withSelectedShop(mobilePrimaryThird.path)}");
    expect(layout).toContain("data-nav-group={group.key}");
    expect(layout).toContain("app-nav-channel-group");
    expect(layout).toContain('t("dashboard.console.nav.more")');
    // V2 chrome: text brand mark, tab bar + sheet, no legacy menu/sidebar footer.
    expect(layout).toContain('class="app-brand__mark" aria-hidden="true">S</span>');
    expect(layout).toContain('<span class="app-brand__name">Selinow</span>');
    expect(layout).not.toContain("selinow-logo-reversed.svg");
    expect(layout).toContain('class="app-sheet"');
    expect(layout).toContain("app-tab--more");
    expect(layout).not.toContain("app-mobile-menu");
    expect(layout).not.toContain("app-sidebar-footer");
    expect(layout).toContain('t("dashboard.shell.mobile.permission")');
    expect(layout).toContain('t("dashboard.shell.mobile.setup")');
    expect(css).toContain(".app-tabbar {");
    expect(css).toContain(".app-sheet {");
    expect(css).toContain(".app-sheet-link {");
    expect(css).toContain(".app-tab--more summary");
    expect(css).not.toContain(".app-live-dot");
    expect(css).toContain("grid-template-columns: var(--sln-console-sidebar-w) minmax(0, 1fr);");
    expect(css).toContain("height: var(--sln-console-topbar-h);");
    expect(css).toContain("scroll-padding-block-end: calc(120px + env(safe-area-inset-bottom));");
    expect(css).toContain("padding-bottom: calc(120px + env(safe-area-inset-bottom));");
  });

  it("keeps the dashboard light-first and routes domain management through the shared shell", async () => {
    const [layout, overview, domains, domainManager, deleteDialog] = await Promise.all([
      readFile("src/layouts/AppLayout.astro", "utf8"),
      readFile("src/pages/app/index.astro", "utf8"),
      readFile("src/pages/app/domains.astro", "utf8"),
      readFile("src/components/dashboard/DomainManager.astro", "utf8"),
      readFile("src/components/dashboard/domains/DomainDeleteDialog.astro", "utf8"),
    ]);

    expect(layout).toContain('path: "/app/domains"');
    expect(overview).toContain("<AppLayout");
    expect(overview).not.toContain('data-theme="dark"');
    expect(domains).toContain("<DomainManager");
    expect(domains).not.toContain('data-theme="dark"');
    expect(domains).toContain('t("dashboard.domains.section.description")');
    expect(domainManager).toContain("data-domain-workspace");
    expect(deleteDialog).toContain('aria-describedby="delete-dialog-impact"');
  });

  it("uses a solid accessible primary action instead of the brand gradient for routine app controls", async () => {
    const css = await readFile("src/styles/app-shell.css", "utf8");

    expect(css).toContain(".app-shell .app-button-primary { background: var(--sln-action-primary);");
    expect(css).not.toContain(".app-shell .app-button-primary { background: var(--sln-brand-gradient);");
    expect(css).toContain("min-height: 46px;");
  });

  it("scopes shell line-height so global body typography cannot stretch legacy dashboard rows", async () => {
    const [baseCss, shellCss] = await Promise.all([
      readFile("src/styles/base.css", "utf8"),
      readFile("src/styles/app-shell.css", "utf8"),
    ]);

    expect(baseCss).toContain("font: var(--sln-font-body);");
    expect(shellCss).toMatch(/\.app-shell\s*\{[^}]*line-height:\s*normal;/u);
  });

  it("keeps onboarding understandable and exposes progress to assistive technology", async () => {
    const [page, shell] = await Promise.all([
      readFile("src/pages/onboarding.astro", "utf8"),
      readFile("src/components/dashboard/onboarding/OnboardingShell.astro", "utf8"),
    ]);
    const controller = await readFile("src/scripts/dashboard/onboarding.ts", "utf8");

    expect(page).not.toContain('data-theme="dark"');
    expect(page).toContain("<OnboardingShell");
    expect(shell).toContain('role="progressbar"');
    expect(shell).toContain('aria-valuenow="0"');
    expect(controller).toContain('poster.setAttribute("aria-valuenow", String(percent))');
    expect(controller).toContain("/automation?limit=20");
    expect(controller).toContain("automation_provider_evidence_pending");
    expect(controller).toContain("seller_onboarding_cancel");
    expect(controller).not.toContain("evidenceToken");
  });

  it("keeps shared page headings within the 320px workspace canvas", async () => {
    const header = await readFile("src/components/workspace/PageHeader.astro", "utf8");

    expect(header).toContain('const hasActions = Astro.slots.has("actions")');
    expect(header).toContain("{hasActions && <div class=\"actions\">");
    expect(header).toContain("h1 { margin: 0; overflow-wrap: anywhere;");
    expect(header).toContain(".description { margin-top: var(--sln-space-4); overflow-wrap: anywhere;");
    expect(header).toContain(".actions :global(*) { min-width: 0; max-width: 100%; }");
  });

  it("does not persist inventory secrets and resets tenant-bound drafts when switching shops", async () => {
    const [controller, readiness] = await Promise.all([
      readFile("src/scripts/dashboard/onboarding.ts", "utf8"),
      readFile("src/lib/tenants/readiness.ts", "utf8"),
    ]);

    expect(readiness).toContain('actionUrl: "/app/domains"');
    expect(controller).toContain("payloadDigest");
    expect(controller).toContain("clearLegacyIntentPayloads");
    expect(controller).toContain("clearTenantBoundDrafts");
    expect(controller).toContain("shopSelectionEpoch");
    expect(controller).toContain("tenantHydrating");
    expect(controller).toContain("setShopMutationFence(root, true)");
    expect(controller).toContain("selectedMutationShop(state, shops)");
    expect(controller).toContain("state.onboarding.profile?.currentStep");
    expect(controller).toContain("serverStep ?? storedStep");
    const hydrationStart = controller.indexOf("async function loadShopState");
    const hydrationEnd = controller.indexOf("function readSettingsForm", hydrationStart);
    const hydrationController = controller.slice(hydrationStart, hydrationEnd);
    expect(hydrationController).toContain("try {");
    expect(hydrationController).toContain("finally {");
    expect(hydrationController).toContain("state.selectedShopId === selectionShopId");
    expect(controller).toContain("encodeURIComponent(shop.publicId)");
    expect(controller).not.toContain("JSON.stringify({ key, payload })");
  });
});
