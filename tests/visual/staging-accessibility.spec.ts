import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

const appOrigin = process.env.SELINOW_VISUAL_APP_ORIGIN ?? "https://app-staging.selinow.com";

async function expectNoWcagViolations(page: Page): Promise<void> {
  const result = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
    .analyze();
  const summary = result.violations.map((violation) => ({
    help: violation.help,
    id: violation.id,
    impact: violation.impact,
    targets: violation.nodes.flatMap((node) => node.target),
  }));

  expect(summary, JSON.stringify(summary, null, 2)).toEqual([]);
}

test("storefront home has no WCAG A/AA violations", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  await expectNoWcagViolations(page);
});

test("product detail has no WCAG A/AA violations", async ({ page }) => {
  await page.goto("/products/signal-editor-lifetime");
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  await expectNoWcagViolations(page);
});

test("cart has no WCAG A/AA violations", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Thêm vào giỏ: Signal Editor Lifetime" }).click();
  await page.getByRole("link", { name: /Giỏ hàng 1 sản phẩm/u }).click();
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  await expectNoWcagViolations(page);
});

test("login boundary has no WCAG A/AA violations", async ({ page }) => {
  await page.goto(`${appOrigin}/app`);
  await expect(page).toHaveURL(`${appOrigin}/login`);
  await expectNoWcagViolations(page);
});
