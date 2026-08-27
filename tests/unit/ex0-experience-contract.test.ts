import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { consoleCatalogs } from "../../src/lib/i18n/catalogs/console";

/**
 * EX0 experience contracts (plan §3/§4): one Soft token spine, motion through
 * tokens on EX-owned files, vi/en parity for the console catalog, no
 * hardcoded Vietnamese left in the palette/shell surfaces EX0 converted, and
 * the shared mutation scheme actually consumed.
 */

const SPINE_HEX = /#(7C6AF0|6957DE|8B7BFF|EBE6F8|F5F2FB|DAD2EE|C9BDE4|EDE8FB|6552E8|6552e8)/iu;

const SPINE_HEX_ALLOWLIST = new Set([
  // Token definition files — the single source of Soft values.
  "src/styles/selinow-tokens.css",
  "src/styles/auth-soft.css",
  "src/styles/console.css",
  "src/styles/marketing/tokens.css",
  // Storefront template theme data (CD program contract, not console surface).
  "src/styles/dashboard/store-builder-preview-skins.css",
  // Canvas fallbacks when the CSS var cannot be read (getComputedStyle).
  "src/scripts/dashboard/overview-charts.ts",
  "src/scripts/marketing/hero-canvas.ts",
]);

function listSourceFiles(): string[] {
  const args = ["src", "-type", "f", "(", "-name", "*.astro", "-o", "-name", "*.ts", "-o", "-name", "*.css", ")"] as const;
  const output: string = execFileSync("find", [...args], { encoding: "utf8" });
  const lines = output.split("\n");
  return lines.filter((line: string) => line.length > 0);
}

describe("EX0 token spine", () => {
  it("keeps Selinow Soft hex values inside token files only", () => {
    const offenders: string[] = [];
    for (const path of listSourceFiles()) {
      if (SPINE_HEX_ALLOWLIST.has(path)) continue;
      if (SPINE_HEX.test(readFileSync(path, "utf8"))) offenders.push(path);
    }
    expect(offenders).toEqual([]);
  });

  it("declares the Soft spine with fill-safe contrast roles in the shared tokens", () => {
    const tokens = readFileSync("src/styles/selinow-tokens.css", "utf8");
    for (const token of ["--sln-soft-accent:", "--sln-soft-accent-strong:", "--sln-soft-canvas:", "--sln-soft-border:", "--sln-soft-tint:", "--sln-ease-spring:"]) {
      expect(tokens).toContain(token);
    }
    // auth-soft is an alias layer: no hex, only spine references.
    const authSoft = readFileSync("src/styles/auth-soft.css", "utf8");
    expect(SPINE_HEX.test(authSoft)).toBe(false);
    expect(authSoft).toContain("var(--sln-soft-");
  });
});

describe("EX0 motion tokens on EX-owned files", () => {
  const guardedFiles = [
    "src/scripts/lib/toast.ts",
    "src/scripts/lib/reveal.ts",
    "src/scripts/lib/poll.ts",
    "src/scripts/lib/countup.ts",
    "src/scripts/lib/mutation.ts",
    "src/scripts/dashboard/toast-boot.ts",
    "src/scripts/marketing/reveal-boot.ts",
  ];
  const durationLiteral = /(?:transition|animation)[^;]*?\b\d+(?:\.\d+)?m?s\b/iu;

  it("uses --sln-duration-*/--sln-ease-* instead of literal timings", () => {
    for (const path of guardedFiles) {
      const source = readFileSync(path, "utf8");
      expect(source.match(durationLiteral), path).toBeNull();
    }
  });

  it("ships the shared toast/reveal CSS on token timings with a reduced-motion branch", () => {
    const primitives = readFileSync("src/styles/primitives.css", "utf8");
    expect(primitives).toContain("sln-toast-in var(--sln-duration-default) var(--sln-ease-standard)");
    expect(primitives).toContain("[data-reveal-state=\"hidden\"]");
    expect(primitives).toMatch(/@media \(prefers-reduced-motion: reduce\)[\s\S]*?\.sln-toast \{ animation: none; \}/u);
  });
});

describe("EX0 console catalog parity", () => {
  it("keeps vi and en key sets identical with no empty values", () => {
    const en = Object.keys(consoleCatalogs.en).sort();
    const vi = Object.keys(consoleCatalogs["vi-VN"]).sort();
    expect(vi).toEqual(en);
    expect(en.length).toBeGreaterThan(30);
    for (const [key, value] of Object.entries(consoleCatalogs["vi-VN"] as Record<string, string>)) {
      expect(value.length, key).toBeGreaterThan(0);
    }
  });
});

describe("EX0 palette and shell de-hardcoding", () => {
  const vietnamese = /[\u{1EA0}-\u{1EF9}]/iu;

  it("command palette reads copy from the console catalog and renders via DOM APIs", () => {
    const controller = readFileSync("src/scripts/dashboard/command-palette.ts", "utf8");
    expect(vietnamese.test(controller)).toBe(false);
    expect(controller).toContain("dataset.copy");
    expect(controller).toContain("replaceChildren()");
    expect(controller.match(/innerHTML/gu) ?? []).toHaveLength(1); // doc comment only
    const component = readFileSync("src/components/workspace/CommandPalette.astro", "utf8");
    expect(component).toContain("getConsoleClientCopy");
    expect(vietnamese.test(component.replace(/getConsoleClientCopy[\s\S]*$/, ""))).toBe(false);
  });

  it("AppLayout mounts the toast region and passes locale into the palette", () => {
    const layout = readFileSync("src/layouts/AppLayout.astro", "utf8");
    expect(layout).toContain("<ToastRegion");
    expect(layout).toContain("toast-boot.ts");
    expect(layout).toContain("<CommandPalette locale=");
    expect(layout).not.toContain('label="Hệ thống trực tuyến"');
    expect(layout).not.toContain('aria-label="Tìm kiếm"');
  });

  it("marketing reveal hooks exist and the boot script is loaded by PlatformLayout", () => {
    const layout = readFileSync("src/layouts/PlatformLayout.astro", "utf8");
    expect(layout).toContain("reveal-boot.ts");
    const index = readFileSync("src/pages/index.astro", "utf8");
    expect((index.match(/data-reveal\b/gu) ?? []).length).toBeGreaterThanOrEqual(7);
    const pricing = readFileSync("src/pages/pricing.astro", "utf8");
    expect(pricing).toContain("data-reveal-stagger");
  });
});

describe("EX5 marketing/onboarding/auth wiring", () => {
  it("onboarding persists vertical, template and channels in one create request (OB-B1)", () => {
    const quickstart = readFileSync("src/scripts/dashboard/onboarding-quickstart.ts", "utf8");
    expect(quickstart).toContain("vertical: currentVertical");
    expect(quickstart).toContain("templateId: selectedTemplateValue() ?? undefined");
    expect(quickstart).toContain("telegramEnabled: selectedChannel !== \"website\"");
    const route = readFileSync("src/pages/api/app/shops/index.ts", "utf8");
    expect(route).toContain('"templateId", "vertical"');
    expect(route).toContain("vertical_invalid");
    expect(route).toContain("channels_invalid");
    const store = readFileSync("src/lib/tenants/store.ts", "utf8");
    expect(store).toContain('input.vertical ?? "digital"');
    // The storefront draft is seeded with the vertical's template in the same
    // transaction instead of a follow-up PATCH.
    expect(store).toContain("JSON.stringify({ templateId })");
    expect(store).toContain("storefront_template_vertical_mismatch");
  });

  it("ships the staged HeroFlowSim trace on token timings without looping", () => {
    const landing = readFileSync("src/styles/marketing/landing.css", "utf8");
    expect(landing).toContain("@keyframes mk-flow-step");
    expect(landing).toContain("@keyframes mk-flow-draw");
    expect(landing.match(/animation: mk-flow-step[^;]*infinite/iu)).toBeNull();
    expect(landing).toContain("var(--sln-duration-marketing) var(--sln-ease-standard) both");
  });

  it("passes locale-aware money labels into the dashboard chart tooltip", () => {
    const overview = readFileSync("src/pages/app/index.astro", "utf8");
    const chart = readFileSync("src/scripts/dashboard/overview-charts.ts", "utf8");
    expect(overview).toContain("formattedValue: formatMoney(point.totalMinor");
    expect(chart).toContain("item.formattedValue ?? item.value.toLocaleString()");
    expect(chart).not.toContain('toLocaleString("vi-VN")');
  });

  it("starts count-ups on reveal and gives login the register enter motion", () => {
    const boot = readFileSync("src/scripts/marketing/reveal-boot.ts", "utf8");
    expect(boot).toContain("[data-count-to]");
    expect(boot).toContain("countUp");
    const login = readFileSync("src/pages/login.astro", "utf8");
    expect(login).toContain("fadeInEnter var(--sln-duration-panel) var(--sln-ease-spring)");
  });
});

describe("EX0 mutation scheme consumption", () => {
  it("converts a real moderation mutation to mutate() without reload", () => {
    const script = readFileSync("src/scripts/dashboard/data-lifecycle.ts", "utf8");
    expect(script).toContain("mutate<{ action");
    expect(script).toContain("showToast(");
    // The moderation handler updates the button in place; reloads may remain
    // only in the export/deletion flows scheduled for later EX phases.
    expect((script.match(/window\.location\.reload\(\)/gu) ?? []).length).toBeLessThanOrEqual(5);
  });

  it("exposes the orders table contract on the API (EX3.7)", () => {
    const route = readFileSync("src/pages/api/app/shops/[shopPublicId]/orders/index.ts", "utf8");
    expect(route).toContain("parseSellerOrderSort");
    expect(route).toContain("parseSellerOrderStatusFilter");
    expect(route).toContain('url.searchParams.get("q")');
  });
});
