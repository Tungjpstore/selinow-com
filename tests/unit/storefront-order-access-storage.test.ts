import { describe, expect, it } from "vitest";

import { createOrderAccessStorage } from "../../src/scripts/storefront/order-access-storage";

describe("storefront order access storage", () => {
  it("keeps the current order token available when browser storage is unavailable", () => {
    const storage = createOrderAccessStorage({
      getItem: () => { throw new Error("storage_blocked"); },
      removeItem: () => { throw new Error("storage_blocked"); },
      setItem: () => { throw new Error("storage_blocked"); },
    });

    storage.set("order_a", "opaque-order-token");

    expect(storage.get("order_a")).toBe("opaque-order-token");
    storage.remove("order_a");
    expect(storage.get("order_a")).toBeNull();
  });

  it("keeps the current order token available when no storage object exists", () => {
    const storage = createOrderAccessStorage(null);

    storage.set("order_a", "opaque-order-token");

    expect(storage.get("order_a")).toBe("opaque-order-token");
  });

  it("uses storage when available and falls back per key after a storage failure", () => {
    const values = new Map<string, string>();
    let failWrites = false;
    const storage = createOrderAccessStorage({
      getItem: (key) => values.get(key) ?? null,
      removeItem: (key) => { values.delete(key); },
      setItem: (key, value) => {
        if (failWrites) throw new Error("storage_quota");
        values.set(key, value);
      },
    });

    storage.set("order_a", "token-a");
    expect(storage.get("order_a")).toBe("token-a");
    failWrites = true;
    storage.set("order_b", "token-b");
    expect(storage.get("order_b")).toBe("token-b");
    expect(values.get("order_b")).toBeUndefined();
  });

  it("prefers the recovered token when replacing a stale stored token fails", () => {
    const values = new Map([["order_a", "stale-token"]]);
    const storage = createOrderAccessStorage({
      getItem: (key) => values.get(key) ?? null,
      removeItem: (key) => { values.delete(key); },
      setItem: () => { throw new Error("storage_quota"); },
    });

    storage.set("order_a", "recovered-token");

    expect(storage.get("order_a")).toBe("recovered-token");
    expect(values.get("order_a")).toBe("stale-token");
  });
});
