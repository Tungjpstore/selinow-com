import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

describe("seller app shell foundation", () => {
  it("keeps the dashboard light-first and routes domain management through the shared shell", async () => {
    const [layout, overview, domains, domainManager] = await Promise.all([
      readFile("src/layouts/AppLayout.astro", "utf8"),
      readFile("src/pages/app/index.astro", "utf8"),
      readFile("src/pages/app/domains.astro", "utf8"),
      readFile("src/components/dashboard/DomainManager.astro", "utf8"),
    ]);

    expect(layout).toContain('content="#F8FAFC"');
    expect(layout).toContain('path: "/app/domains"');
    expect(overview).toContain("<AppLayout");
    expect(overview).not.toContain('data-theme="dark"');
    expect(domains).toContain("<DomainManager");
    expect(domains).not.toContain('data-theme="dark"');
    expect(domainManager).toContain('t("dashboard.domains.section.description")');
    expect(domainManager).toContain('aria-describedby="delete-dialog-impact"');
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
    const [page, wizard, controller] = await Promise.all([
      readFile("src/pages/onboarding.astro", "utf8"),
      readFile("src/components/dashboard/OnboardingWizard.astro", "utf8"),
      readFile("src/scripts/dashboard/onboarding.ts", "utf8"),
    ]);

    expect(page).not.toContain('data-theme="dark"');
    expect(page).toContain("<AppLayout");
    expect(wizard).toContain('role="progressbar"');
    expect(wizard).toContain('aria-valuenow="0"');
    expect(wizard).toContain('t("onboarding.rail.note_copy")');
    expect(wizard).toContain('data-copy={JSON.stringify(clientCopy)}');
    expect(wizard).toContain("data-mobile-step-status");
    expect(wizard).toContain("data-mobile-progress-completed");
    expect(wizard).toContain(".step-rail { display: none; }");
    expect(wizard.lastIndexOf(".wizard-frame { grid-template-columns: 1fr; }")).toBeGreaterThan(
      wizard.lastIndexOf(".wizard-frame { grid-template-columns: minmax(248px, 280px) minmax(0, 1fr);")
    );
    expect(wizard.lastIndexOf(".onboarding-intro { grid-template-columns: 1fr; }")).toBeGreaterThan(
      wizard.lastIndexOf(".onboarding-intro { grid-template-columns: minmax(0, 1.45fr) minmax(260px, .55fr);")
    );
    expect(wizard).not.toContain(".step-rail ol { display: flex; overflow-x: auto;");
    expect(wizard).not.toContain("Readiness &amp; publish");
    expect(controller).toContain('poster.setAttribute("aria-valuenow", String(percent))');
    expect(wizard).toContain('t("onboarding.readiness.automation_title")');
    expect(wizard).toContain("data-automation-list");
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

    for (const key of ["dashboard.nav.overview", "dashboard.nav.orders", "dashboard.nav.products", "dashboard.nav.sales_channels"]) {
      expect(layout).toContain(`t("${key}")`);
    }
    expect(layout).toContain('key: "sales_channels"');
    expect(layout).toContain('t("dashboard.shell.mobile.more")');
    expect(layout).toContain('const mobilePrimaryThird = visibleItem("/app/products") ?? visibleItem("/app/customers");');
    expect(layout).toContain("<span>{mobilePrimaryThird.label}</span>");
    expect(layout).toContain("item.roles.includes(selectedShopRole)");
    expect(layout).toContain("const mobileMoreGroups");
    expect(layout).toContain("href={withSelectedShop(mobilePrimaryThird.path)}");
    for (const availablePath of ["/app/telegram", "/app/store/settings", "/app/customers", "/app/automation", "/app/members", "/app/billing"]) {
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
    expect(layout).toContain('data-mobile-menu-trigger="channels"');
    expect(layout).toContain('data-mobile-menu-trigger="more"');
    expect(layout).toContain("mobileMenu.showModal()");
    expect(layout).toContain('withSelectedShop("/app#actions-title")');
    expect(layout).toContain("shopSwitchHref(Astro.url, shopPublicId)");
    expect(css).toContain("grid-template-columns: repeat(5, 1fr);");
    expect(css).toContain("min-height: 52px;");
    expect(css).toContain("scroll-padding-block-end: calc(132px + env(safe-area-inset-bottom));");
    expect(css).toContain("padding-bottom: calc(140px + env(safe-area-inset-bottom));");
    expect(layout).toContain("data-channel={item.channel}");
    expect(layout).toContain("app-nav-channel-group");
  });

  it("keeps the mobile workspace menu truthful and exposes its dialog state", async () => {
    const [layout, css] = await Promise.all([
      readFile("src/layouts/AppLayout.astro", "utf8"),
      readFile("src/styles/app-shell.css", "utf8"),
    ]);

    expect(layout).toContain('id="app-mobile-menu"');
    expect(layout.match(/aria-controls="app-mobile-menu"/gu)).toHaveLength(4);
    expect(layout.match(/aria-expanded="false"/gu)).toHaveLength(4);
    expect(layout).toContain('menuTrigger.setAttribute("aria-expanded", menuTrigger === trigger ? "true" : "false")');
    expect(layout).toContain('mobileMenuOpener?.setAttribute("aria-expanded", "false")');
    expect(layout).toContain('selectedShopRole === "owner" || selectedShopRole === "manager"');
    expect(layout).toContain('t("dashboard.shell.mobile.permission")');
    expect(css).toContain('.app-icon-action[aria-expanded="true"]');
    expect(css).toContain(".app-context-mark {");
    expect(css).not.toContain(".app-live-dot");
  });

  it("gives every supported sales channel a distinct tenant-bound workspace entry", async () => {
    const [layout, css] = await Promise.all([
      readFile("src/layouts/AppLayout.astro", "utf8"),
      readFile("src/styles/app-shell.css", "utf8"),
    ]);

    for (const channel of ["telegram-mini-app", "zalo-mini-app", "zalo-oa", "whatsapp-cloud", "discord-bot"]) {
      expect(layout).toContain(`href: "/app/integrations#channel-${channel}"`);
      expect(layout).toContain(`channel: "${channel}"`);
      expect(css).toContain(`data-channel="${channel}"`);
    }
    expect(layout).toContain("syncChannelFocus");
    expect(layout).toContain('window.addEventListener("hashchange", syncChannelFocus)');
    expect(layout).toContain('window.addEventListener("popstate", syncChannelFocus)');
    expect(layout).toContain('window.addEventListener("pageshow", syncChannelFocus)');
    expect(css).toContain(".app-nav-channel-group");
    expect(css).toContain(".app-menu-link-channel");
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
    const [wizard, controller, readiness] = await Promise.all([
      readFile("src/components/dashboard/OnboardingWizard.astro", "utf8"),
      readFile("src/scripts/dashboard/onboarding.ts", "utf8"),
      readFile("src/lib/tenants/readiness.ts", "utf8"),
    ]);

    expect(wizard).toContain("data-domain-management-link");
    expect(wizard).toContain("encodeURIComponent(initialShop.publicId)");
    expect(readiness).toContain('actionUrl: "/app/domains"');
    expect(controller).toContain("payloadDigest");
    expect(controller).toContain("clearLegacyIntentPayloads");
    expect(controller).toContain("clearTenantBoundDrafts");
    expect(controller).toContain("shopSelectionEpoch");
    expect(controller).toContain("encodeURIComponent(shop.publicId)");
    expect(controller).not.toContain("JSON.stringify({ key, payload })");
  });
});
