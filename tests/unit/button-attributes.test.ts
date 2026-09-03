import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

describe("Button primitive attributes", () => {
  const source = readFileSync("src/components/primitives/Button.astro", "utf8");

  it("forwards native and data attributes before applying controlled button props", () => {
    expect(source).toContain('import type { HTMLAttributes } from "astro/types";');
    expect(source).toContain("interface Props extends NativeButtonProps");
    expect(source).toContain("...attributes");
    expect(source.indexOf("{...attributes}")).toBeLessThan(source.indexOf("aria-busy="));
  });

  it.each([
    ["src/pages/app/customers.astro", "data-customer-table-export"],
    ["src/pages/app/inventory.astro", "data-inventory-export"],
    ["src/pages/app/inventory.astro", "data-threshold-save"],
    ["src/pages/app/orders.astro", "data-order-export"],
    ["src/pages/app/products.astro", "data-product-export"],
    ["src/pages/app/security.astro", "data-password-submit"],
    ["src/pages/app/security.astro", "data-two-factor-disable-otp-request"],
    ["src/pages/app/security.astro", "data-two-factor-enable"],
    ["src/pages/app/security.astro", "data-two-factor-resend"],
    ["src/pages/app/security.astro", "data-two-factor-verify"],
  ])("keeps the %s hook %s on Button", (path, hook) => {
    const page = readFileSync(path, "utf8");
    expect(page).toMatch(new RegExp(`<Button[^>]*\\b${hook}\\b`, "u"));
  });

  it.each([
    "password-submit",
    "two-factor-disable",
    "two-factor-disable-otp-request",
    "two-factor-disable-otp-submit",
    "two-factor-enable",
    "two-factor-resend",
    "two-factor-verify",
  ])("keeps the security action hook %s on Button", (action) => {
    const page = readFileSync("src/pages/app/security.astro", "utf8");
    expect(page).toMatch(new RegExp(`<Button[^>]*data-action="${action}"`, "u"));
  });
});
