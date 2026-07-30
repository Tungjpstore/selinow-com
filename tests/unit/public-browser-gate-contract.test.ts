import { readFileSync, readdirSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { publicVisualScreenshots, signalVisualProduct } from "../visual/staging-contract";

describe("deterministic public browser gate contract", () => {
  it("mocks the complete authoritative quote for the real Signal variant", () => {
    const seed = readFileSync("seeds/0003_phase6_demo.sql", "utf8");

    expect(signalVisualProduct.quoteItem).toEqual({
      productTitle: "Signal Editor Lifetime",
      quantity: 1,
      unitPriceMinor: 249_000,
      variantId: "var_61000000-0000-4000-8000-000000000001",
      variantTitle: "Lifetime",
      variantVersion: 1,
    });
    expect(seed).toContain(`('${signalVisualProduct.quoteItem.variantId}',`);
    expect(seed).toContain(`'${signalVisualProduct.quoteItem.variantTitle}', '{}', ${String(signalVisualProduct.quoteItem.unitPriceMinor)}`);
  });

  it("keeps ten reviewed screenshot baselines and never submits checkout", () => {
    const spec = readFileSync("tests/visual/staging-public.spec.ts", "utf8");
    const snapshots = readdirSync("tests/visual/staging-public.spec.ts-snapshots")
      .filter((filename) => filename.endsWith(".png"));

    expect(publicVisualScreenshots).toHaveLength(5);
    expect(snapshots).toHaveLength(10);
    for (const screenshot of publicVisualScreenshots) {
      const stem = screenshot.slice(0, -4);
      expect(snapshots.filter((filename) => filename.startsWith(`${stem}-`))).toHaveLength(2);
      expect(snapshots.some((filename) => filename.startsWith(`${stem}-desktop-`))).toBe(true);
      expect(snapshots.some((filename) => filename.startsWith(`${stem}-mobile-`))).toBe(true);
    }

    expect(spec).toContain('page.route("**/api/store/checkout"');
    expect(spec).toContain('page.locator("[data-cart-variant-id]")');
    expect(spec).toContain('page.locator("#cart-empty")).toBeHidden()');
    expect(spec).toContain('page.locator("#checkout-link")).toBeVisible()');
    expect(spec).toContain("expect(checkoutSubmissionAttempts).toBe(0)");
    expect(spec).not.toContain("checkout-submit");
  });

  it("covers the PromptOS viewport matrix without creating new screenshot baselines or staging writes", () => {
    const config = readFileSync("playwright.config.ts", "utf8");
    const matrixSpec = readFileSync("tests/visual/staging-viewport-matrix.spec.ts", "utf8");

    for (const [name, height, width] of [
      ["kit-desktop-1440", 1024, 1440],
      ["kit-tablet-768", 1024, 768],
      ["kit-mobile-390", 844, 390],
      ["kit-minimum-320", 844, 320],
    ] as const) {
      expect(config).toContain(`name: "${name}"`);
      expect(config).toContain(`use: { viewport: { height: ${String(height)}, width: ${String(width)} } }`);
    }

    expect(config).toContain("staging-viewport-matrix\\.spec\\.ts");
    expect(matrixSpec).toContain('request.method() === "GET" || request.method() === "HEAD"');
    expect(matrixSpec).toContain('route.abort("blockedbyclient")');
    expect(matrixSpec).toContain("expect(nonReadOnlyRequests).toEqual([])");
    expect(matrixSpec).toContain("geometry.scrollWidth");
    expect(matrixSpec).not.toContain("toHaveScreenshot");
    expect(matrixSpec).not.toContain("update-snapshots");
  });
});
