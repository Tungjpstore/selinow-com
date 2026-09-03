import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  DEFAULT_HOME_STACKS,
  defaultHomeStack,
  parseHomeSections,
  resolveHomeSections,
  type StorefrontSectionConfig,
} from "../../src/lib/storefront/sections/registry";
import { parseStorefrontSections } from "../../src/lib/storefront/theme";

/**
 * TM0 — section registry contracts: bounded parsing, safe defaults, universal
 * sections wired into every template home.
 */

function config(overrides: Partial<StorefrontSectionConfig>): StorefrontSectionConfig {
  return { enabled: true, id: "s", settings: {}, type: "usp", ...overrides };
}

describe("TM0 home-section registry", () => {
  it("ships a default stack for every shipped template", () => {
    for (const templateId of ["swift", "pulse", "desk", "aurora", "metro", "bustle", "serenity", "craft", "clinic"]) {
      const stack = defaultHomeStack(templateId);
      expect(stack.length, templateId).toBeGreaterThanOrEqual(4);
      expect(stack[0], templateId).toBe("hero");
      // Universal richness: every default stack carries the trust + FAQ tail.
      expect(stack, templateId).toContain("usp");
      expect(stack, templateId).toContain("faq");
    }
    expect(DEFAULT_HOME_STACKS.swift).toEqual(defaultHomeStack("unknown-template"));
  });

  it("parses persisted sections with bounds and drops unknown shapes", () => {
    const parsed = parseHomeSections([
      { enabled: true, id: "a", settings: {}, type: "hero" },
      { enabled: false, id: "b", settings: {}, type: "faq" },
      { id: "c", settings: {}, type: "not_a_section" },
      "garbage",
      { enabled: true, id: "d", settings: { tone: "bold", count: 3, deep: { x: 1 } }, type: "usp" },
      { enabled: true, id: "a", settings: {}, type: "faq" },
    ]);
    expect(parsed.map((section) => section.id)).toEqual(["a", "b", "d"]);
    expect(parsed[1]?.enabled).toBe(false);
    expect(parsed[2]?.settings).toEqual({ tone: "bold", count: 3 });
  });

  it("caps the stack at twelve sections", () => {
    const flood = Array.from({ length: 30 }, (_, index) => config({ id: `s${String(index)}`, type: "faq" }));
    expect(parseHomeSections(flood)).toHaveLength(12);
  });

  it("resolves the persisted enabled order, falling back to defaults when empty", () => {
    expect(resolveHomeSections("swift", [config({ id: "x", type: "faq" }), config({ id: "y", enabled: false, type: "usp" })]))
      .toEqual(["faq"]);
    expect(resolveHomeSections("pulse", [])).toEqual(DEFAULT_HOME_STACKS.pulse);
  });

  it("surfaces the sections array from raw storefront_json", () => {
    const persisted = parseStorefrontSections(JSON.stringify({
      sections: [{ enabled: true, id: "hero", settings: {}, type: "hero" }],
      templateId: "swift",
    }));
    expect(persisted).toHaveLength(1);
    expect(parseStorefrontSections("{}")).toEqual([]);
    expect(parseStorefrontSections('{"sections": "nope"}')).toEqual([]);
  });
});

describe("TM0 universal sections render contract", () => {
  it("wires USP + FAQ into every template home on the registry tail", () => {
    for (const templateId of Object.keys(DEFAULT_HOME_STACKS)) {
      const home = readFileSync(`src/components/storefront/templates/${templateId}/StoreHome.astro`, "utf8");
      expect(home, templateId).toContain("<USPGrid");
      expect(home, templateId).toContain("<FAQSection");
      expect(home, templateId).toContain("vertical={shop.template.vertical}");
    }
    const css = readFileSync("src/styles/storefront/sections.css", "utf8");
    expect(css).toContain(".usp-section ul");
    expect(css).toContain(".faq-item");
    const catalog = readFileSync("src/lib/i18n/catalogs/storefront.ts", "utf8");
    for (const vertical of ["digital", "physical", "booking"]) {
      expect(catalog).toContain(`"storefront.section.usp.${vertical}.3.title"`);
      expect(catalog).toContain(`"storefront.section.faq.${vertical}.3.q"`);
    }
  });
});
