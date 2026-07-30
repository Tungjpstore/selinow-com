import { describe, expect, it } from "vitest";

import { contrastInk, parseStorefrontContent, parseStorefrontTheme } from "../../src/lib/storefront/theme";

describe("storefront tenant theme guards", () => {
  it("normalizes valid brand colors and chooses readable button ink", () => {
    const theme = parseStorefrontTheme(JSON.stringify({ accentColor: "#f6c344", primaryColor: "#176b5b" }));
    expect(theme.brand).toBe("#176B5B");
    expect(theme.accent).toBe("#F6C344");
    expect(theme.accentInk).toBe("#0B1020");
    expect(contrastInk("#0B1020")).toBe("#FFFFFF");
  });

  it("falls back safely for malformed branding and storefront JSON", () => {
    const theme = parseStorefrontTheme('{"primaryColor":"javascript:alert(1)","logoUrl":"http://unsafe.example"}');
    const content = parseStorefrontContent("not-json", "Cửa hàng Test");
    expect(theme.brand).toBe("#5B5CEB");
    expect(theme.logoUrl).toBeNull();
    expect(content.headline).toContain("Digital products");
    expect(content.footerText).toContain("Cửa hàng Test");
    expect(content.seoTitle).toContain("Cửa hàng Test");
    expect(content.seoDescription).toContain("Discover digital products");
  });

  it("localizes generated defaults without changing merchant-provided content", () => {
    const storefrontJson = JSON.stringify({ headline: "Merchant headline" });
    const english = parseStorefrontContent(storefrontJson, "Example Store", "en");
    const vietnamese = parseStorefrontContent(storefrontJson, "Cửa hàng Ví dụ", "vi-VN");

    expect(english).toMatchObject({
      deliveryText: "Digital products are delivered after payment is verified.",
      headline: "Merchant headline",
      supportText: "Need help? Contact the store directly before paying.",
    });
    expect(vietnamese).toMatchObject({
      deliveryText: "Sản phẩm số được giao sau khi thanh toán được xác minh.",
      headline: "Merchant headline",
      supportText: "Cần hỗ trợ? Liên hệ trực tiếp cửa hàng trước khi thanh toán.",
    });
  });

  it("keeps seller SEO metadata bounded and falls back to storefront copy", () => {
    const content = parseStorefrontContent(JSON.stringify({
      description: "Mô tả cửa hàng",
      seoDescription: "Mô tả SEO ngắn",
      seoTitle: "Tiêu đề SEO",
    }), "Test");
    expect(content.seoTitle).toBe("Tiêu đề SEO");
    expect(content.seoDescription).toBe("Mô tả SEO ngắn");
    expect(parseStorefrontContent(JSON.stringify({ description: "Mô tả" }), "Test").seoDescription).toBe("Mô tả");
    const bounded = parseStorefrontContent(JSON.stringify({ description: "x".repeat(240) }), "Tên shop rất dài ".repeat(8));
    expect(bounded.seoDescription.length).toBeLessThanOrEqual(160);
    expect(bounded.seoTitle.length).toBeLessThanOrEqual(60);
  });

  it("does not expose exact stock unless the seller opted in", () => {
    expect(parseStorefrontContent('{"showExactStock":false}', "Test").showExactStock).toBe(false);
    expect(parseStorefrontContent('{"showExactStock":true}', "Test").showExactStock).toBe(true);
  });

  it("keeps merchant ink readable across light, dark and mid-tone branding", () => {
    for (const color of ["#FFFFFF", "#000000", "#777777", "#F6C344", "#176B5B", "#5B5CEB"]) {
      const theme = parseStorefrontTheme(JSON.stringify({ accentColor: color, primaryColor: color }));
      expect(contrastInk(color), color).toMatch(/^#(?:0B1020|FFFFFF)$/u);
      expect(theme.brandInk).toBe(contrastInk(color));
      expect(theme.accentInk).toBe(contrastInk(color));
    }
  });
});
