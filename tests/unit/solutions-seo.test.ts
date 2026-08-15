import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  getSolutionPage,
  getSolutionsHub,
  solutionSlugs,
} from "../../src/lib/content/solutions";

describe("bilingual solution SEO content", () => {
  it("resolves every published solution in both locales", () => {
    expect(solutionSlugs).toEqual([
      "telegram-commerce",
      "digital-product-delivery",
      "license-key-inventory",
    ]);

    for (const slug of solutionSlugs) {
      const english = getSolutionPage(slug, "en");
      const vietnamese = getSolutionPage(slug, "vi-VN");
      expect(english).not.toBeNull();
      expect(vietnamese).not.toBeNull();
      expect(english?.seoTitle).toBeTruthy();
      expect(vietnamese?.seoTitle).toBeTruthy();
      expect(english?.seoDescription).toBeTruthy();
      expect(vietnamese?.seoDescription).toBeTruthy();
    }
  });

  it("keeps workflow and FAQ depth consistent across locales", () => {
    for (const slug of solutionSlugs) {
      const english = getSolutionPage(slug, "en");
      const vietnamese = getSolutionPage(slug, "vi-VN");
      expect(english?.workflow).toHaveLength(4);
      expect(vietnamese?.workflow).toHaveLength(4);
      expect(english?.faq).toHaveLength(3);
      expect(vietnamese?.faq).toHaveLength(3);
      expect(english?.workflow.every((step) => step.title && step.description)).toBe(true);
      expect(vietnamese?.faq.every((item) => item.question && item.answer)).toBe(true);
    }
  });

  it("provides localized hub metadata and calls to action", () => {
    const english = getSolutionsHub("en");
    const vietnamese = getSolutionsHub("vi-VN");
    expect(english.seoTitle).toContain("Commerce solutions");
    expect(vietnamese.seoTitle).toContain("Giải pháp");
    expect(english.cta).not.toBe(vietnamese.cta);
    expect(english.relatedTitle).not.toBe(vietnamese.relatedTitle);
  });

  it("keeps the published solution set discoverable from sitemap and llms pages", () => {
    const sitemap = readFileSync(join(process.cwd(), "src/pages/sitemap.xml.ts"), "utf8");
    const llms = readFileSync(join(process.cwd(), "src/pages/llms.txt.ts"), "utf8");
    expect(sitemap).toContain("/solutions");
    expect(sitemap).toContain("solutionSlugs.map");
    expect(llms).toContain("https://selinow.com/solutions/${slug}");
  });
});
