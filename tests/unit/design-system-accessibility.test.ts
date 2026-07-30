import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

function token(css: string, name: string): string {
  const match = css.match(new RegExp(`--${name}:\\s*([^;]+)`, "iu"));
  const value = match?.[1]?.trim();
  if (value === undefined) throw new Error(`Missing color token: ${name}`);
  const reference = value.match(/^var\(--([a-z0-9-]+)\)$/iu)?.[1];
  if (reference !== undefined) return token(css, reference);
  if (/^#[0-9a-f]{3}$/iu.test(value)) {
    return `#${value.slice(1).split("").map((character) => character.repeat(2)).join("")}`;
  }
  if (!/^#[0-9a-f]{6}$/iu.test(value)) throw new Error(`Token is not a solid color: ${name}`);
  return value;
}

function luminance(hex: string): number {
  const channels = [1, 3, 5].map((offset) => Number.parseInt(hex.slice(offset, offset + 2), 16) / 255)
    .map((channel) => channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4);
  return 0.2126 * (channels[0] ?? 0) + 0.7152 * (channels[1] ?? 0) + 0.0722 * (channels[2] ?? 0);
}

function contrast(first: string, second: string): number {
  const [dark, light] = [luminance(first), luminance(second)].sort((left, right) => left - right);
  return ((light ?? 0) + 0.05) / ((dark ?? 0) + 0.05);
}

describe("accessible design-system gate", () => {
  it("keeps semantic text and focus tokens above WCAG AA thresholds", async () => {
    const css = await readFile("src/styles/selinow-tokens.css", "utf8");
    const white = token(css, "selinow-white");
    const ink = token(css, "selinow-ink-950");

    for (const name of ["selinow-action-primary", "selinow-success-text", "selinow-warning-text", "selinow-danger-text", "selinow-info-text"]) {
      expect(contrast(token(css, name), white), name).toBeGreaterThanOrEqual(4.5);
    }
    expect(contrast(token(css, "selinow-focus-ring"), white)).toBeGreaterThanOrEqual(3);
    expect(contrast(token(css, "selinow-focus-ring"), ink)).toBeGreaterThanOrEqual(3);
  });

  it("provides shared skip links, focus targets, labeled step regions and atomic status updates", async () => {
    const [layout, onboardingPage, wizard, domainManager, controller, shellCss, tokens] = await Promise.all([
      readFile("src/layouts/AppLayout.astro", "utf8"),
      readFile("src/pages/onboarding.astro", "utf8"),
      readFile("src/components/dashboard/OnboardingWizard.astro", "utf8"),
      readFile("src/components/dashboard/DomainManager.astro", "utf8"),
      readFile("src/scripts/dashboard/onboarding.ts", "utf8"),
      readFile("src/styles/app-shell.css", "utf8"),
      readFile("src/styles/selinow-tokens.css", "utf8"),
    ]);

    expect(layout).toContain('class="app-main selinow-focus-target" tabindex="-1"');
    expect(layout).toContain('class="app-skip-link selinow-skip-link"');
    expect(onboardingPage).toContain("<AppLayout");
    expect(wizard).toContain('class="onboarding-shell"');
    expect(wizard).toContain('id="onboarding-global-feedback"');
    expect(wizard).toContain("--selinow-onboarding-accent: var(--sln-action-primary);");
    expect(contrast(token(tokens, "selinow-action-primary"), token(tokens, "selinow-white"))).toBeGreaterThanOrEqual(4.5);
    expect(wizard).toContain('role="region" aria-labelledby="onboarding-step-trigger-');
    expect(wizard).toContain('aria-atomic="true"');
    expect(domainManager).toContain('role="alert" aria-atomic="true"');
    expect(domainManager).toContain("2_500");
    expect(domainManager).toContain('setFeedback(message, "success")');
    expect(domainManager).toContain('addEventListener("cancel"');
    expect(domainManager).toContain("event.preventDefault()");
    expect(domainManager).toContain("overflow-wrap: anywhere");
    expect(controller).toContain('window.matchMedia("(prefers-reduced-motion: reduce)")');
    expect(controller).toContain('tone === "error" ? "alert" : "status"');
    expect(controller).toContain('check.required ? copy("onboarding.readiness.required", "Required") : copy("onboarding.readiness.optional", "Optional")');
    expect(controller).toContain('field.setAttribute("aria-invalid", "true")');
    expect(controller).toContain('field.setAttribute("aria-describedby", Array.from(describedBy).join(" "))');
    expect(controller).toContain('field.focus();');
    expect(shellCss).toContain("color: var(--selinow-warning-text);");
  });

  it("keeps dark surfaces semantic and storefront status text AA-safe", async () => {
    const [login, admin, operations, adminLayout, adminCss, storefront, tokens] = await Promise.all([
      readFile("src/pages/login.astro", "utf8"),
      readFile("src/pages/admin/index.astro", "utf8"),
      readFile("src/pages/admin/operations.astro", "utf8"),
      readFile("src/layouts/AdminLayout.astro", "utf8"),
      readFile("src/styles/admin.css", "utf8"),
      readFile("src/styles/storefront.css", "utf8"),
      readFile("src/styles/selinow-tokens.css", "utf8"),
    ]);

    expect(login).toContain("const locale = resolvePresentationLocale");
    expect(login).toContain("<html lang={locale} dir={directionForLocale(locale)}>");
    expect(login).not.toContain('data-theme="dark"');
    expect(login).toContain("background: var(--sln-bg-canvas);");
    expect(login).toContain("color: var(--sln-text-primary);");
    expect(login).not.toContain("background: var(--selinow-bg-inverse);");
    expect(admin).toContain('import AdminLayout from "../../layouts/AdminLayout.astro"');
    expect(operations).toContain('import AdminLayout from "../../layouts/AdminLayout.astro"');
    expect(adminLayout).toContain('<html lang={locale} dir={directionForLocale(locale)} data-theme="dark">');
    expect(adminCss).toContain("background: var(--selinow-bg-canvas);");
    expect(adminCss).toContain("color: var(--selinow-text-primary);");
    expect(adminCss).not.toContain("background: var(--selinow-bg-inverse);");
    expect(storefront).toContain("color: var(--selinow-success-text);");
    expect(storefront).toContain("color: var(--selinow-warning-text);");
    expect(tokens).toContain("--selinow-disabled-ink:");
    expect(tokens).toContain("--selinow-disabled-bg:");
    expect(tokens).toContain("linear-gradient(135deg, #7c3aed 0%, #5b5ceb 48%, #3b82f6 100%)");
  });

  it("guards control boundaries, focus indicators and disabled states", async () => {
    const [tokens, shell, storefront, platform, login, admin, operations, adminCss] = await Promise.all([
      readFile("src/styles/selinow-tokens.css", "utf8"),
      readFile("src/styles/app-shell.css", "utf8"),
      readFile("src/styles/storefront.css", "utf8"),
      readFile("src/styles/platform.css", "utf8"),
      readFile("src/pages/login.astro", "utf8"),
      readFile("src/pages/admin/index.astro", "utf8"),
      readFile("src/pages/admin/operations.astro", "utf8"),
      readFile("src/styles/admin.css", "utf8"),
    ]);
    const canvas = token(tokens, "selinow-cloud-50");
    const controlBorder = token(tokens, "selinow-border-control");
    const focusRing = token(tokens, "selinow-focus-ring");
    const disabledInk = token(tokens, "selinow-disabled-ink");
    const disabledBackground = token(tokens, "selinow-disabled-bg");

    expect(contrast(controlBorder, canvas)).toBeGreaterThanOrEqual(3);
    expect(contrast(focusRing, canvas)).toBeGreaterThanOrEqual(3);
    expect(contrast(disabledInk, disabledBackground)).toBeGreaterThanOrEqual(3);
    expect(contrast("#5b5ceb", "#ffffff")).toBeGreaterThanOrEqual(4.5);
    expect(shell).toContain(":focus-visible");
    expect(shell).toContain("button:disabled, [aria-disabled=\"true\"]");
    expect(shell).toContain("border-color: var(--selinow-border-control);");
    expect(storefront).toContain("border: 1px solid var(--selinow-border-control);");
    expect(storefront).toContain("background: var(--selinow-disabled-bg);");
    expect(login).toContain("border: 1px solid var(--selinow-border-control);");
    expect(admin).toContain('import AdminLayout from "../../layouts/AdminLayout.astro"');
    expect(operations).toContain('import AdminLayout from "../../layouts/AdminLayout.astro"');
    expect(adminCss).toContain("min-height: 44px;");
    expect(adminCss).toContain("border: 1px solid var(--selinow-border-control);");
    expect(adminCss).toContain("background: var(--selinow-disabled-bg);");
    expect(platform).not.toContain("rgb(255 255 255 / 82%)");
  });
});
