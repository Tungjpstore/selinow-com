import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

describe("document direction contract", () => {
  it("applies centralized locale direction to every shared HTML root", async () => {
    const [platform, admin, storefront, app, login] = await Promise.all([
      readFile("src/layouts/PlatformLayout.astro", "utf8"),
      readFile("src/layouts/AdminLayout.astro", "utf8"),
      readFile("src/layouts/StorefrontLayout.astro", "utf8"),
      readFile("src/layouts/AppLayout.astro", "utf8"),
      readFile("src/pages/login.astro", "utf8"),
    ]);

    expect(platform).toContain('<html lang={locale} dir={directionForLocale(locale)}>');
    expect(admin).toContain('<html lang={locale} dir={directionForLocale(locale)} data-theme="dark">');
    expect(storefront).toContain(
      '<html lang={documentLocale} dir={directionForLocale(documentLocale)} style={style} data-storefront-template={shop.template.id} data-storefront-vertical={shop.template.vertical} data-template-scheme={shop.template.scheme}>',
    );
    expect(app).toContain('<html lang={locale ?? "en"} dir={directionForLocale(locale)}>');
    expect(login).toContain('<html lang={locale} dir={directionForLocale(locale)}>');
  });

  it("keeps shared shell and primitive directional rules logical", async () => {
    const [shell, primitives, storefront, admin, platform, a11y] = await Promise.all([
      readFile("src/styles/app-shell.css", "utf8"),
      readFile("src/styles/primitives.css", "utf8"),
      readFile("src/styles/storefront.css", "utf8"),
      readFile("src/styles/admin.css", "utf8"),
      readFile("src/styles/platform.css", "utf8"),
      readFile("src/styles/selinow-a11y.css", "utf8"),
    ]);

    expect(shell).toContain("inset-inline-start: 12px");
    expect(shell).toContain("inset-inline-start: -14px");
    expect(shell).toContain("margin-inline-start: auto");
    expect(shell).toContain("text-align: start");
    expect(shell).toContain("inset-inline: 10px");
    expect(shell).not.toMatch(/\bleft:\s*-?\d/iu);
    expect(shell).not.toMatch(/\bright:\s*-?\d/iu);
    expect(shell).not.toContain("margin-left");

    expect(primitives).toContain("border-inline-start-width: 3px");
    expect(primitives).toContain("border-inline-start-color");
    expect(primitives).toContain("inset-inline-end: var(--sln-space-4)");
    expect(primitives).toContain("margin-inline: auto 12px");
    expect(primitives).not.toContain("border-left-width");
    expect(primitives).not.toContain("border-left-color");
    expect(primitives).not.toContain("margin-left");
    expect(primitives).not.toMatch(/\bright:\s*var\(--sln-space-4\)/u);

    expect(storefront).toContain("inset-inline-start: 12px");
    expect(storefront).toContain("inset-inline-start: 28px");
    expect(storefront).toContain("margin-inline-start: 8px");
    expect(storefront).toContain("border-inline-start: 4px");
    expect(storefront).toContain("padding-inline-start: 16px");
    expect(storefront).toContain("inset-inline-end: 14px");
    expect(storefront).toContain("margin-inline-start: auto");
    expect(storefront).toContain("inset-inline: 0");
    expect(storefront).not.toMatch(/(?:^|;)\s*(?:margin|padding|border|inset)-(?:left|right)\s*:/imu);
    expect(storefront).toMatch(/\.store-hero::after\s*\{[^}]*\bright:/u);
    expect(storefront).toMatch(/\.product-visual::after\s*\{[^}]*\bright:/u);
    const storefrontWithoutDecorativeOffsets = storefront
      .replaceAll(/\.store-hero::after\s*\{[^}]*\}/gu, "")
      .replaceAll(/\.product-visual::after\s*\{[^}]*\}/gu, "");
    expect(storefrontWithoutDecorativeOffsets).not.toMatch(/\b(?:left|right):\s*-?\d/iu);

    expect(admin).toContain("inset-inline-start: 12px");
    expect(admin).toContain("border-inline-end: 1px");
    expect(admin).toContain("padding-inline-start: 12px");
    expect(admin).toContain("border-inline-start: 1px");
    expect(admin).toContain("border-inline-start: 3px");
    expect(admin).toContain("margin-inline-start: auto");
    expect(admin).toContain("inset-inline-start: 0");
    expect(admin).not.toMatch(/(?:^|;)\s*(?:margin|padding|border|inset)-(?:left|right)\s*:/imu);
    expect(admin).not.toMatch(/\b(?:left|right):\s*-?\d/iu);
    expect(admin).not.toContain("box-shadow: inset 3px 0");

    expect(platform).toContain("inset-inline-start: 12px");
    expect(platform).toContain("margin-inline-start: auto");
    expect(platform).toContain("margin-inline-end: var(--sln-space-2)");
    expect(platform).toContain("border-inline-end: 1px");
    expect(platform).toContain("inset-inline-end: var(--sln-space-3)");
    expect(platform).toContain("text-align: start");
    expect(platform).toContain("padding-inline-end: var(--sln-space-8)");
    expect(platform).not.toMatch(/(?:^|;)\s*(?:margin|padding|border|inset)-(?:left|right)\s*:/imu);
    expect(platform).not.toMatch(/\b(?:left|right):\s*-?\d/iu);

    expect(a11y).toContain("inset-inline-start: 12px");
    expect(a11y).not.toMatch(/\bleft:\s*-?\d/iu);
  });
});
