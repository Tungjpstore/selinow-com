import { describe, expect, it } from "vitest";

import { decryptInventoryKey, encryptInventoryKey } from "../../src/lib/crypto/inventory";

const KEK = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

describe("inventory key encryption", () => {
  it("round-trips with the bound tenant and variant AAD", async () => {
    const encrypted = await encryptInventoryKey({
      hmacSecret: "test-fingerprint-secret",
      keyVersion: "v1",
      kek: KEK,
      plaintext: "LICENSE-KEY-SECRET",
      shopId: "shop-a",
      variantId: "variant-a",
    });

    await expect(decryptInventoryKey({
      ...encrypted,
      kek: KEK,
      shopId: "shop-a",
      variantId: "variant-a",
    })).resolves.toBe("LICENSE-KEY-SECRET");
  });

  it("fails closed when ciphertext is moved to another tenant", async () => {
    const encrypted = await encryptInventoryKey({
      hmacSecret: "test-fingerprint-secret",
      keyVersion: "v1",
      kek: KEK,
      plaintext: "LICENSE-KEY-SECRET",
      shopId: "shop-a",
      variantId: "variant-a",
    });

    await expect(decryptInventoryKey({
      ...encrypted,
      kek: KEK,
      shopId: "shop-b",
      variantId: "variant-a",
    })).rejects.toMatchObject({ code: "inventory_decryption_failed" });
  });

  it("creates stable scoped fingerprints without exposing plaintext", async () => {
    const first = await encryptInventoryKey({ hmacSecret: "fingerprint", keyVersion: "v1", kek: KEK, plaintext: "same-key", shopId: "shop-a", variantId: "variant-a" });
    const second = await encryptInventoryKey({ hmacSecret: "fingerprint", keyVersion: "v1", kek: KEK, plaintext: "same-key", shopId: "shop-a", variantId: "variant-a" });
    const otherVariant = await encryptInventoryKey({ hmacSecret: "fingerprint", keyVersion: "v1", kek: KEK, plaintext: "same-key", shopId: "shop-a", variantId: "variant-b" });

    expect(first.fingerprint).toBe(second.fingerprint);
    expect(first.ciphertextB64).not.toBe(second.ciphertextB64);
    expect(first.fingerprint).not.toBe(otherVariant.fingerprint);
    expect(JSON.stringify(first)).not.toContain("same-key");
  });
});
