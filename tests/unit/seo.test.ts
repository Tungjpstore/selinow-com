import { describe, expect, it } from "vitest";

import {
  absoluteSeoUrl,
  alternateLocaleUrl,
  marketingLocaleAlternates,
  ogLocaleFor,
  schemaPrice,
  serializeStructuredData,
} from "../../src/lib/seo";

describe("global SEO URL and structured-data helpers", () => {
  it("creates canonical absolute URLs without depending on the current host", () => {
    expect(absoluteSeoUrl("pricing")).toBe("https://selinow.com/pricing");
    expect(absoluteSeoUrl("/pricing", "https://shop.example.com")).toBe("https://shop.example.com/pricing");
  });

  it("uses a stable query variant for non-default locales", () => {
    expect(alternateLocaleUrl("/pricing", "en")).toBe("https://selinow.com/pricing");
    expect(alternateLocaleUrl("/pricing", "vi-VN")).toBe("https://selinow.com/pricing?lang=vi-VN");
  });

  it("publishes reciprocal hreflang links including x-default", () => {
    expect(marketingLocaleAlternates("/")).toEqual([
      { href: "https://selinow.com/", hreflang: "en" },
      { href: "https://selinow.com/?lang=vi-VN", hreflang: "vi-VN" },
      { href: "https://selinow.com/", hreflang: "x-default" },
    ]);
  });

  it("maps BCP47 locales to Open Graph locale tags", () => {
    expect(ogLocaleFor("en")).toBe("en_US");
    expect(ogLocaleFor("vi-VN")).toBe("vi_VN");
    expect(ogLocaleFor("fr-FR")).toBe("en_US");
  });

  it("serializes JSON-LD without allowing script termination", () => {
    expect(serializeStructuredData({ description: "</script><script>alert(1)</script>" })).not.toContain("</script>");
    expect(serializeStructuredData({ name: "Selinow" })).toContain('"name":"Selinow"');
  });

  it("converts integer minor units into schema.org prices", () => {
    expect(schemaPrice(1_234, "USD")).toBe("12.34");
    expect(schemaPrice(1_234, "JPY")).toBe("1234");
    expect(schemaPrice(199_000, "VND")).toBe("199000");
    expect(() => schemaPrice(-1, "USD")).toThrow("minor_amount_invalid");
  });
});
