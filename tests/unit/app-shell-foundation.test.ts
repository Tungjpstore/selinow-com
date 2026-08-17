import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

describe("seller app shell foundation", () => {
  it("keeps the dashboard light-first and routes domain management through the shared shell", async () => {
    const [layout, overview, domains, domainManager, deleteDialog] = await Promise.all([
      readFile("src/layouts/AppLayout.astro", "utf8"),
      readFile("src/pages/app/index.astro", "utf8"),
      readFile("src/pages/app/domains.astro", "utf8"),
      readFile("src/components/dashboard/DomainManager.astro", "utf8"),
      readFile("src/components/dashboard/domains/DomainDeleteDialog.astro", "utf8"),
    ]);

    expect(layout).toContain('content="#F8FAFC"');
    expect(layout).toContain('path: "/app/domains"');
    // Shell convergence (Console v2): the overview rides the single V2-ified
    // AppLayout; ConsoleLayout is retired.
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

  it("uses the PromptOS mobile groups and links channel/settings aliases to implemented contracts", async () => {
    const [layout, css, telegramAlias, storeSettingsAlias, integrations, store] = await Promise.all([
      readFile("src/layouts/AppLayout.astro", "utf8"),
      readFile("src/styles/app-shell.css", "utf8"),
      readFile("src/pages/app/telegram.astro", "utf8"),
      readFile("src/pages/app/store/settings.astro", "utf8"),
      readFile("src/pages/app/integrations.astro", "utf8"),
      readFile("src/pages/app/store.astro", "utf8"),
    ]);

    for (const key of ["dashboard.console.nav.overview", "dashboard.console.nav.orders", "dashboard.console.nav.products", "dashboard.console.nav.channels"]) {
      expect(layout).toContain(`t("${key}")`);
    }
    expect(layout).toContain('key: "channels"');
    expect(layout).toContain('t("dashboard.console.nav.more")');
    expect(layout).toContain('const mobilePrimaryThird = visibleItem("/app/products") ?? visibleItem("/app/customers");');
    expect(layout).toContain("<span>{mobilePrimaryThird.label}</span>");
    expect(layout).toContain("item.roles.includes(selectedShopRole)");
    expect(layout).toContain("const mobileMoreGroups");
    expect(layout).toContain("href={withSelectedShop(mobilePrimaryThird.path)}");
    for (const availablePath of ["/app/integrations", "/app/payments", "/app/store/settings", "/app/customers", "/app/automation", "/app/members", "/app/billing", "/app/developer", "/app/security", "/app/inventory", "/app/domains"]) {
      expect(layout).toContain(`path: "${availablePath}"`);
    }
    expect(telegramAlias).toContain('new URL("/app/integrations?focus=telegram", Astro.url)');
    expect(telegramAlias).toContain('destination.searchParams.set("shop", shopPublicId)');
    expect(telegramAlias).toContain("#telegram");
    expect(storeSettingsAlias).toContain('new URL("/app/store?focus=settings", Astro.url)');
    expect(storeSettingsAlias).toContain('destination.searchParams.set("shop", shopPublicId)');
    expect(storeSettingsAlias).toContain("#store-settings");
    expect(integrations).toContain('id="telegram"');
    expect(store).toContain('id="store-settings"');
    expect(layout).toContain('path: "/app/data"');
    // Shop switching stays server-rendered: the topbar/sheet selects navigate
    // to shopSwitchHref targets (filters cleared), never client param edits.
    expect(layout).toContain("data-app-shop-select");
    expect(layout).toContain("data-shop-href={shop.href}");
    expect(layout).toContain("href: shopSelectionHref(shop.publicId)");
    expect(layout).toContain("shopSwitchHref(Astro.url, shopPublicId)");
    expect(layout).not.toContain("url.searchParams.set(\"shop\"");
    expect(layout).toContain('withSelectedShop("/app#actions-title")');
    expect(css).toContain(".app-tabbar {");
    expect(css).toContain("grid-template-columns: var(--sln-console-sidebar-w) minmax(0, 1fr);");
    expect(css).toContain("height: var(--sln-console-topbar-h);");
    expect(css).toContain("scroll-padding-block-end: calc(120px + env(safe-area-inset-bottom));");
    expect(css).toContain("padding-bottom: calc(120px + env(safe-area-inset-bottom));");
    expect(layout).toContain("data-nav-group={group.key}");
    expect(layout).toContain("app-nav-channel-group");
  });

  it("keeps the mobile workspace sheet truthful and preserves role gating", async () => {
    const [layout, css] = await Promise.all([
      readFile("src/layouts/AppLayout.astro", "utf8"),
      readFile("src/styles/app-shell.css", "utf8"),
    ]);

    // V2 chrome: text brand mark instead of the SVG logo, tab bar + sheet
    // instead of the 3-panel dialog, shop context moved to the topbar.
    expect(layout).toContain('class="app-brand__mark" aria-hidden="true">S</span>');
    expect(layout).toContain('<span class="app-brand__name">Selinow</span>');
    expect(layout).not.toContain("selinow-logo-reversed.svg");
    expect(layout).toContain('class="app-sheet"');
    expect(layout).toContain("app-tab--more");
    expect(layout).not.toContain("app-mobile-menu");
    expect(layout).not.toContain("app-sidebar-footer");
    expect(layout).toContain('selectedShopRole === "owner" || selectedShopRole === "manager"');
    expect(layout).toContain('t("dashboard.shell.mobile.permission")');
    expect(layout).toContain('t("dashboard.shell.mobile.setup")');
    // Logout stays on the double-submit CSRF flow with decoded cookie value.
    expect(layout).toContain('headers: { "X-CSRF-Token": decodeURIComponent(csrf) }');
    expect(css).toContain(".app-sheet {");
    expect(css).toContain(".app-sheet-link {");
    expect(css).toContain(".app-tab--more summary");
    expect(css).not.toContain(".app-live-dot");
  });

  it("gives the redesigned sales-channel IA distinct tenant-bound workspace entries", async () => {
    const [layout, css] = await Promise.all([
      readFile("src/layouts/AppLayout.astro", "utf8"),
      readFile("src/styles/app-shell.css", "utf8"),
    ]);

    for (const navKey of ["dashboard.console.nav.channels", "dashboard.console.nav.website", "dashboard.console.nav.telegram", "dashboard.console.nav.payments", "dashboard.console.nav.developer"]) {
      expect(layout).toContain(`t("${navKey}")`);
    }
    for (const entryPath of ["/app/store", "/app/integrations", "/app/payments", "/app/developer"]) {
      expect(layout).toContain(`path: "${entryPath}"`);
    }
    expect(layout).toContain('key: "channels"');
    expect(layout).toContain('key: "settings"');
    expect(layout).toContain("data-nav-group={group.key}");
    expect(layout).toContain("app-nav-channel-group");
    expect(layout).toContain("withSelectedShop(itemPath(item))");
    expect(css).toContain(".app-nav-channel-group");
    expect(css).toContain(".app-sheet-link");
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
