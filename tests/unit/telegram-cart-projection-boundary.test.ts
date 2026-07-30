import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { TelegramCartProjectionPort } from "../../src/lib/commerce/cart-projection";

type Prepared = {
  bind(...values: unknown[]): Prepared;
  first(): Promise<Record<string, unknown> | null>;
  run(): Promise<never>;
};

function projectionEnv(cart: Record<string, unknown> | null): { bindings: unknown[][]; env: { PLATFORM_DB: { prepare(sql: string): Prepared } }; sql: string[]; writes: number } {
  const bindings: unknown[][] = [];
  const sql: string[] = [];
  let writes = 0;
  const env = {
    PLATFORM_DB: {
      prepare(statement: string): Prepared {
        sql.push(statement);
        const prepared: Prepared = {
          bind: (...values) => {
            bindings.push(values);
            return prepared;
          },
          first: () => Promise.resolve(cart),
          run: () => {
            writes += 1;
            return Promise.reject(new Error("projection must not write"));
          },
        };
        return prepared;
      },
    },
  };
  return { bindings, env, sql, get writes() { return writes; } };
}

describe("Telegram cart projection boundary", () => {
  it("reads an active tenant-bound cart without creating an empty cart", async () => {
    const fixture = projectionEnv(null);
    const port = new TelegramCartProjectionPort({
      env: fixture.env as never,
      shopId: "shop-projection",
      subjectHash: "subject-projection",
    });

    await expect(port.readCart()).resolves.toEqual({ cartId: null, discountCode: null, itemCount: 0 });
    expect(fixture.sql).toHaveLength(1);
    expect(fixture.sql[0]).toContain("FROM carts");
    expect(fixture.sql[0]).not.toMatch(/\b(?:INSERT|UPDATE|DELETE)\b/iu);
    expect(fixture.bindings[0]?.slice(0, 2)).toEqual(["shop-projection", "subject-projection"]);
    expect(fixture.writes).toBe(0);
  });

  it("returns only the projection and never exposes mutation or authorization APIs", () => {
    const source = readFileSync("src/lib/commerce/cart-projection.ts", "utf8");
    expect(source).not.toMatch(/(?:\b(?:INSERT|UPDATE|DELETE)\b|\bbatch\s*\(|\.run\s*\()/iu);
    expect(source).not.toMatch(/AppError|CommerceContext|authorize|permission|forbidden/iu);
    expect(source).toMatch(/interface CommerceReadOnlyCartProjectionPort/iu);
    expect(source).toMatch(/readCart\(\)/u);
  });

  it("routes Telegram cart rendering through the read-only projection seam", () => {
    const source = readFileSync("src/lib/telegram/commerce.ts", "utf8");
    expect(source).toContain("createTelegramCartProjectionPort({ env, identity, shop }).readCart()");
    expect(source).not.toContain("loadTelegramCartLines");
  });

  it("keeps cart-item reads tenant-scoped when an active cart exists", async () => {
    const fixture = projectionEnv({ cartId: "cart-projection", discountCode: "SAVE10", itemCount: 1 });
    const port = new TelegramCartProjectionPort({
      env: fixture.env as never,
      shopId: "shop-projection",
      subjectHash: "subject-projection",
    });

    await expect(port.readCart()).resolves.toEqual({ cartId: "cart-projection", discountCode: "SAVE10", itemCount: 1 });
    expect(fixture.sql).toHaveLength(1);
    expect(fixture.sql[0]).toContain("cart_items.shop_id = carts.shop_id");
    expect(fixture.sql[0]).not.toMatch(/\b(?:INSERT|UPDATE|DELETE)\b/iu);
    expect(fixture.bindings[0]?.slice(0, 2)).toEqual(["shop-projection", "subject-projection"]);
    expect(fixture.writes).toBe(0);
  });
});
