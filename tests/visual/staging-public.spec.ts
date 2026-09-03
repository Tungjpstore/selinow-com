import { expect, test, type Page } from "@playwright/test";

import { publicVisualScreenshots, signalVisualProduct } from "./staging-contract";

const appOrigin = process.env.SELINOW_VISUAL_APP_ORIGIN ?? "https://app-staging.selinow.com";

async function expectStablePage(page: Page): Promise<void> {
  await page.evaluate(async () => document.fonts.ready);
  const geometry = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    viewportWidth: document.documentElement.clientWidth,
  }));
  expect(geometry.scrollWidth).toBeLessThanOrEqual(geometry.viewportWidth);
}

async function expectHydratedCart(page: Page): Promise<void> {
  const cartItems = page.locator("[data-cart-variant-id]");
  await expect(cartItems).toHaveCount(1);
  await expect(cartItems).toBeVisible();
  await expect(page.locator("#cart-empty")).toBeHidden();
  await expect(page.locator("#cart-quote-status")).toHaveAttribute("data-state", "ready");
  await expect(page.locator("#cart-total")).toHaveText("249.000 ₫");
  await expect(page.locator("#checkout-link")).toBeVisible();
  await expect(page.locator("#checkout-link")).not.toHaveAttribute("aria-disabled", "true");
}

test("storefront home", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Công cụ sắc gọn cho một ngày làm việc sâu.");
  await expectStablePage(page);
  await expect(page).toHaveScreenshot(publicVisualScreenshots[0], { fullPage: true });
});

test("product detail", async ({ page }) => {
  await page.goto(signalVisualProduct.path);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(signalVisualProduct.heading);
  const addToCart = page.locator("#detail-add");
  await expect(addToCart).toBeEnabled();
  await expect(addToCart).toHaveText("Thêm vào giỏ");
  await expectStablePage(page);
  await expect(page).toHaveScreenshot(publicVisualScreenshots[1], { fullPage: true });
});

test("cart and checkout", async ({ page }) => {
  let checkoutSubmissionAttempts = 0;
  await page.route("**/api/store/checkout", async (route) => {
    checkoutSubmissionAttempts += 1;
    await route.abort("blockedbyclient");
  });
  await page.goto("/");
  await page.getByRole("button", { name: signalVisualProduct.addToCartName }).click();
  await page.getByRole("link", { name: /Giỏ hàng 1 sản phẩm/u }).click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Kiểm tra trước khi đặt hàng.");
  await expectHydratedCart(page);
  await expectStablePage(page);
  await expect(page).toHaveScreenshot(publicVisualScreenshots[2], { fullPage: true });

  await page.route("**/api/store/cart", async (route) => route.fulfill({
    body: JSON.stringify({ cartId: "visual-cart", cartToken: "visual-token" }),
    contentType: "application/json",
    status: 200,
  }));
  await page.route("**/api/store/quote", async (route) => route.fulfill({
    body: JSON.stringify({
      quote: {
        currency: "VND",
        expiresAt: "2030-01-01T00:00:00.000Z",
        items: [signalVisualProduct.quoteItem],
        quoteEvidence: "quote-evidence-visual-123456789012345678901234567890",
        totalMinor: 249_000,
      },
    }),
    contentType: "application/json",
    status: 200,
  }));
  await page.getByRole("link", { name: "Tiếp tục đặt hàng" }).click();
  await expect(page.locator("#checkout-total")).toHaveText("249.000 ₫");
  await expectStablePage(page);
  await expect(page).toHaveScreenshot(publicVisualScreenshots[3], {
    fullPage: true,
    mask: [page.locator(".cf-turnstile")],
  });
  expect(checkoutSubmissionAttempts).toBe(0);
});

test("unauthenticated dashboard boundary", async ({ page }) => {
  await page.goto(`${appOrigin}/app`);
  await expect(page).toHaveURL(`${appOrigin}/login`);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Đăng nhập để tiếp tục");
  await expectStablePage(page);
  await expect(page).toHaveScreenshot(publicVisualScreenshots[4], { fullPage: true });
});
