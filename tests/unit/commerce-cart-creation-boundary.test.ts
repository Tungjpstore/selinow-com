import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

function source(path: string): string {
  return readFileSync(path, "utf8");
}

describe("canonical cart creation boundary", () => {
  it("keeps Website and Telegram cart-row creation behind the shared helper", () => {
    const canonical = source("src/lib/commerce/cart-creation.ts");
    const website = source("src/lib/commerce/store.ts");
    const telegram = source("src/lib/commerce/telegram-port.ts");

    expect(canonical).toContain("export async function createCanonicalCart");
    expect(canonical).toContain("INSERT INTO carts");
    expect(canonical).toContain("INSERT INTO cart_items");
    expect(website).toContain("createCanonicalCart({ channel: \"web\"");
    expect(telegram).toContain("createCanonicalCart({ channel: \"telegram\"");
    expect(telegram).not.toMatch(/INSERT INTO (?:carts|cart_items)/u);
  });

  it("uses one provider-neutral quote projection for Website and Telegram", () => {
    const website = source("src/lib/commerce/store.ts");
    const telegram = source("src/lib/commerce/telegram-port.ts");
    expect(website).toContain("projectCanonicalCartQuote(");
    expect(telegram).toContain("projectCanonicalCartQuote(");
  });

  it("routes non-empty Telegram cart rendering through the application quote", () => {
    const telegramRuntime = source("src/lib/telegram/commerce.ts");
    expect(telegramRuntime).toContain("application.quoteCart(context");
  });
});
