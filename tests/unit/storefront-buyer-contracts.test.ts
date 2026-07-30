import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { classifyCartQuote } from "../../src/lib/storefront/cart-quote";
import { fulfillmentStateView, orderStateLabel, paymentStateView } from "../../src/lib/storefront/order-view";
import { parseStorefrontPublicDetails, safePublicHttpsUrl } from "../../src/lib/storefront/public-details";
import { createStorefrontTranslator } from "../../src/lib/i18n/catalogs/storefront";
import { getCatalogParity } from "../../src/lib/i18n/catalog";
import { storefrontCatalogs } from "../../src/lib/i18n/catalogs/storefront";

describe("storefront public merchant details", () => {
  it("exposes only normalized HTTPS policy links and safe support actions", () => {
    expect(safePublicHttpsUrl("https://shop.example/terms")).toBe("https://shop.example/terms");
    for (const unsafe of [
      "http://shop.example/terms",
      "https://user:secret@shop.example/terms",
      "https://shop.example/terms#private",
      "javascript:alert(1)",
    ]) expect(safePublicHttpsUrl(unsafe)).toBeNull();

    expect(parseStorefrontPublicDetails({
      deliveryText: "  Giao mã sau khi provider xác minh.  ",
      privacyUrl: "https://shop.example/privacy",
      refundPolicyUrl: "http://unsafe.example/refund",
      supportContact: "support@shop.example",
      supportFallback: "Liên hệ cửa hàng",
      termsUrl: "https://shop.example/terms",
    })).toEqual({
      deliveryText: "Giao mã sau khi provider xác minh.",
      privacyUrl: "https://shop.example/privacy",
      refundPolicyUrl: null,
      support: { href: "mailto:support@shop.example", label: "support@shop.example" },
      termsUrl: "https://shop.example/terms",
    });
  });

  it("never turns arbitrary support text into a clickable URL", () => {
    const details = parseStorefrontPublicDetails({
      deliveryText: "",
      privacyUrl: null,
      refundPolicyUrl: null,
      supportContact: "@shop_support",
      supportFallback: "Liên hệ cửa hàng",
      termsUrl: null,
    });
    expect(details.support).toEqual({ href: null, label: "@shop_support" });
    expect(details.deliveryText).toBe("Digital products are delivered after payment is verified.");

    const vietnamese = parseStorefrontPublicDetails({
      deliveryText: "",
      locale: "vi-VN",
      privacyUrl: null,
      refundPolicyUrl: null,
      supportContact: null,
      supportFallback: "",
      termsUrl: null,
    });
    expect(vietnamese.deliveryText).toContain("thanh toán được xác minh");
    expect(vietnamese.support.label).toBe("Liên hệ trực tiếp cửa hàng để được hỗ trợ.");
  });
});

describe("authoritative cart quote projection", () => {
  const local = new Map([["variant-a", {
    priceMinor: 100_000,
    productTitle: "Sản phẩm A",
    variantTitle: "Lifetime",
    version: 2,
  }]]);

  it("distinguishes ready, price-changed and item-changed quotes", () => {
    const item = {
      productTitle: "Sản phẩm A",
      quantity: 1,
      unitPriceMinor: 100_000,
      variantId: "variant-a",
      variantTitle: "Lifetime",
      variantVersion: 2,
    };
    expect(classifyCartQuote(local, [item])).toBe("ready");
    expect(classifyCartQuote(local, [{ ...item, unitPriceMinor: 120_000 }])).toBe("price_changed");
    expect(classifyCartQuote(local, [{ ...item, variantVersion: 3 }])).toBe("item_changed");
    expect(classifyCartQuote(local, [{ ...item, variantId: "variant-missing" }])).toBe("item_changed");
  });

  it("keeps the cart UI bound to the cart and quote APIs with explicit recovery states", async () => {
    const source = await readFile("src/scripts/storefront/cart.ts", "utf8");
    expect(source).toContain('fetch("/api/store/cart"');
    expect(source).toContain('fetch("/api/store/quote"');
    for (const state of ["loading", "item_changed", "out_of_stock", "price_changed", "quote_failed", "stock_changed"]) {
      expect(source).toContain(`state: "${state}"`);
    }
    expect(source).toContain('code === "quote_expired"');
    expect(source).toContain('code === "quote_invalid"');
    expect(source).toContain("quoteMatchesCart(items, quote.items)");
    expect(source).toContain("minus.disabled = item.quantity <= variant.minQuantity");
    expect(source).toContain("plus.disabled = item.quantity >= variant.maxQuantity");
    expect(source).not.toMatch(/localStorage\.getItem\([^)]*(?:token|cookie)/iu);
  });

  it("keeps product quantity controls within the server-projected variant bounds", async () => {
    const [page, source] = await Promise.all([
      readFile("src/pages/products/[slug].astro", "utf8"),
      readFile("src/scripts/storefront/product-detail.ts", "utf8"),
    ]);
    expect(page).toContain('data-min={variant.minPerOrder}');
    expect(page).toContain('aria-describedby="detail-quantity-help"');
    expect(source).toContain("quantityBounds(selected)");
    expect(source).toContain("snapshotFresh = false");
    expect(source).toContain("button.disabled = !snapshotFresh");
    expect(source).toContain('cache: "no-store"');
    expect(source).toContain("input.addEventListener(\"change\"");
  });

  it("keeps retryable checkout failures recoverable without weakening server authority", async () => {
    const [page, controller, catalog] = await Promise.all([
      readFile("src/pages/checkout.astro", "utf8"),
      readFile("src/scripts/storefront/checkout.ts", "utf8"),
      readFile("src/lib/i18n/catalogs/storefront.ts", "utf8"),
    ]);

    expect(page).toContain('id="checkout-retry"');
    expect(controller).toContain('provider_unavailable: t("storefront.checkout.error.provider_unavailable")');
    expect(controller).toContain('payment_currency_unsupported: t("storefront.checkout.error.payment_currency_unsupported")');
    expect(controller).toContain('fetch("/api/store/checkout/intent"');
    expect(controller).toContain('fetch("/api/store/checkout/recover"');
    expect(controller).toContain("selinow-checkout-intent:v1:");
    expect(controller).toContain("checkout_recovery_expired");
    expect(catalog).toContain('"storefront.checkout.error.provider_unavailable": "Dịch vụ tạo đơn đang bận. Đơn chưa được tạo; bạn có thể thử lại an toàn."');
    expect(catalog).toContain('"storefront.checkout.error.payment_currency_unsupported": "Cửa hàng chưa thể nhận đơn có thanh toán bằng loại tiền này. Hãy liên hệ cửa hàng; chưa tạo đơn mới."');
    expect(controller).toContain('type RecoveryAction = "cart" | "quote" | "recover" | "submit";');
    expect(controller).toContain("recoveryForPrepare");
    expect(controller).toContain("recoveryForCheckout");
    expect(controller).toContain("requestSubmit()");
    expect(controller).toContain('code === "turnstile_invalid" || code === "turnstile_required"');
    expect(controller).toContain('fetch("/api/store/quote"');
    expect(controller).toContain('headers: { "Content-Type": "application/json", "Idempotency-Key": intent.idempotencyKey }');
    expect(controller).toContain("renderAuthoritativeQuote(quote)");
    expect(controller).toContain("quoteMatchesCart(quote.items)");
    expect(page).toContain('data-size="flexible"');
  });

  it("separates a missing product from a suspended storefront", async () => {
    const [page, catalog] = await Promise.all([
      readFile("src/pages/products/[slug].astro", "utf8"),
      readFile("src/lib/i18n/catalogs/storefront.ts", "utf8"),
    ]);

    expect(page).toContain('const productUnavailable = shop?.access === "live" && product === null;');
    expect(page).toContain('t("storefront.product.missing_title")');
    expect(page).toContain('t("storefront.product.missing_action")');
    expect(page).toContain('t("storefront.state.suspended.title")');
    expect(catalog).toContain('"storefront.product.missing_title": "Sản phẩm này không còn khả dụng."');
    expect(catalog).toContain('"storefront.product.missing_action": "Xem sản phẩm đang bán"');
    expect(catalog).toContain('"storefront.state.suspended.title": "Cửa hàng đang tạm ngưng nhận đơn."');
    expect(page).not.toContain("Cửa hàng chưa nhận đơn lúc này.");
  });
});

describe("buyer order status copy", () => {
  it("renders canonical human states with an English-safe fallback", () => {
    expect(orderStateLabel("pending")).toBe("Verifying payment");
    expect(orderStateLabel("canceled")).toBe("Canceled");
    expect(orderStateLabel("raw_provider_state")).toBe("Status updating");
    expect(paymentStateView("pending", "processing")).toMatchObject({ tone: "info" });
    expect(paymentStateView("unpaid", "canceled")).toMatchObject({ label: "Payment canceled", tone: "danger" });
    expect(fulfillmentStateView("unfulfilled", "expired")).toMatchObject({ label: "Delivery stopped", tone: "danger" });
    expect(orderStateLabel("pending", "vi-VN")).toBe("Đang xác minh thanh toán");
    expect(paymentStateView("unpaid", "canceled", "vi-VN")).toMatchObject({ label: "Thanh toán đã hủy", tone: "danger" });
    expect(fulfillmentStateView("unfulfilled", "expired", "vi-VN")).toMatchObject({ label: "Đã dừng giao hàng", tone: "danger" });
    expect(orderStateLabel("pending", "fr-FR")).toBe(createStorefrontTranslator("en")("storefront.status.pending"));
    expect(getCatalogParity(storefrontCatalogs)).toEqual({
      extra: { en: [], "vi-VN": [] },
      missing: { en: [], "vi-VN": [] },
    });
  });

  it("keeps payment and fulfillment as separate order timelines with support and retry actions", async () => {
    const [page, script, checkout] = await Promise.all([
      readFile("src/pages/orders/[orderPublicId].astro", "utf8"),
      readFile("src/scripts/storefront/order.ts", "utf8"),
      readFile("src/scripts/storefront/checkout.ts", "utf8"),
    ]);
    expect(script).toContain('appendTimeline(status, t("storefront.order.timeline.payment"');
    expect(script).toContain('appendTimeline(status, t("storefront.order.timeline.fulfillment"');
    expect(script).toContain('t("storefront.order.access_title")');
    expect(script).toContain('t("storefront.order.network_title")');
    expect(script).toContain("copyToClipboard");
    expect(script).toContain('if (!("clipboard" in navigator))');
    expect(script).toContain('sessionStorage.removeItem(tokenKey)');
    expect(script).toContain('payment_pending: t("storefront.order.payment.payment_pending")');
    expect(script).toContain("hasKeyDelivery");
    expect(script).toContain("body.fulfillment.keys.length === 0");
    expect(page).toContain("id=\"order-support\"");
    expect(page).toContain("id=\"refresh-button\"");
    expect(script).not.toContain('toLocaleString("vi-VN")');
    for (const hardcoded of ["Không thể mở", "Kết nối bị gián đoạn", "Đang mở thanh toán", "Sao chép mã"]) {
      expect(script).not.toContain(hardcoded);
    }
    expect(checkout).toContain('createStorefrontTranslator');
    expect(checkout).toContain('body: JSON.stringify({ items, locale })');
    expect(checkout).not.toContain('toLocaleTimeString("vi-VN"');
    for (const hardcoded of ["Không thể tạo đơn", "Báo giá đã hết hạn", "Đang tạo đơn", "Số lượng"]) {
      expect(checkout).not.toContain(hardcoded);
    }
  });

  it("keeps shared storefront client labels localized with a safe English fallback", async () => {
    const [layout, catalogDom, keyReveal, variantSelector, theme, publicDetails, orderView] = await Promise.all([
      readFile("src/layouts/StorefrontLayout.astro", "utf8"),
      readFile("src/scripts/storefront/catalog-dom.ts", "utf8"),
      readFile("src/components/commerce/KeyRevealCard.astro", "utf8"),
      readFile("src/components/commerce/VariantSelector.astro", "utf8"),
      readFile("src/lib/storefront/theme.ts", "utf8"),
      readFile("src/lib/storefront/public-details.ts", "utf8"),
      readFile("src/lib/storefront/order-view.ts", "utf8"),
    ]);
    const english = createStorefrontTranslator("en");
    const unsupportedLocale = createStorefrontTranslator("fr-FR");

    expect(getCatalogParity(storefrontCatalogs)).toEqual({
      extra: { en: [], "vi-VN": [] },
      missing: { en: [], "vi-VN": [] },
    });
    expect(english("storefront.catalog.product_fallback")).toBe("Product");
    expect(english("storefront.catalog.variant_fallback")).toBe("Default variant");
    expect(unsupportedLocale("storefront.catalog.product_fallback")).toBe("Product");
    expect(unsupportedLocale("storefront.catalog.variant_fallback")).toBe("Default variant");
    expect(unsupportedLocale("storefront.fulfillment.key_title")).toBe("Product key");
    expect(unsupportedLocale("storefront.fulfillment.key_copy_failed")).toBe("Could not copy automatically. Select and copy the code manually.");
    expect(layout).toContain('data-cart-count-template={t("storefront.cart_count", { count: "{count}" })}');
    expect(layout).toContain('data-cart-added-label={t("storefront.product.added")}');
    expect(layout).not.toContain('document.documentElement.lang === "en"');
    for (const hardcoded of ["sản phẩm trong giỏ", "Đã thêm vào giỏ", "Thêm vào giỏ"]) {
      expect(layout).not.toContain(hardcoded);
    }
    expect(catalogDom).toContain('t("storefront.catalog.product_fallback")');
    expect(catalogDom).toContain('t("storefront.catalog.variant_fallback")');
    for (const hardcoded of ['?? "Sản phẩm"', '?? "Mặc định"']) {
      expect(catalogDom).not.toContain(hardcoded);
    }
    expect(keyReveal).toContain('createStorefrontTranslator');
    expect(keyReveal).toContain('t("storefront.fulfillment.key_description")');
    expect(keyReveal).toContain('t("storefront.fulfillment.key_copy_success")');
    for (const hardcoded of ["Mã sản phẩm", "Thông tin riêng tư", "Chưa đủ điều kiện", "Đang ẩn", "Đã mở", "Sao chép mã", "Đã sao chép mã vào clipboard.", "Không thể sao chép tự động."]) {
      expect(keyReveal).not.toContain(hardcoded);
    }
    expect(variantSelector).toContain('t("storefront.product.variant_aria")');
    expect(variantSelector).not.toContain("Chọn phiên bản");
    for (const source of [theme, publicDetails, orderView]) {
      expect(source).not.toMatch(/[ăâđêôơư]|[àáảãạèéẻẽẹìíỉĩịòóỏõọùúủũụỳýỷỹỵ]/iu);
    }
  });
});
