import { AppError } from "../core/errors";

export type WebsiteCheckoutExpectedItem = {
  quantity: number;
  unitPriceMinor: number;
  variantId: string;
  variantVersion: number;
};

export function parseWebsiteCheckoutExpected(value: unknown): WebsiteCheckoutExpectedItem[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 20) {
    throw new AppError("validation_failed", 400, ["expected_items_invalid"]);
  }
  const expected = value.map((item) => {
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      throw new AppError("validation_failed", 400, ["expected_item_invalid"]);
    }
    const row = item as Record<string, unknown>;
    if (
      Object.keys(row).some((key) => !new Set(["quantity", "unitPriceMinor", "variantId", "variantVersion"]).has(key))
      || typeof row.variantId !== "string"
      || !/^var_[0-9a-f-]{36}$/u.test(row.variantId)
      || (row.quantity !== undefined && (typeof row.quantity !== "number" || !Number.isSafeInteger(row.quantity) || row.quantity < 1 || row.quantity > 1_000))
      || typeof row.unitPriceMinor !== "number"
      || !Number.isSafeInteger(row.unitPriceMinor)
      || row.unitPriceMinor < 0
      || typeof row.variantVersion !== "number"
      || !Number.isSafeInteger(row.variantVersion)
      || row.variantVersion < 1
    ) {
      throw new AppError("validation_failed", 400, ["expected_item_invalid"]);
    }
    return {
      // Legacy website clients omitted quantity for single-unit lines. Keep
      // that wire compatibility here while the canonical command stays strict.
      quantity: row.quantity ?? 1,
      unitPriceMinor: row.unitPriceMinor,
      variantId: row.variantId,
      variantVersion: row.variantVersion,
    };
  });
  if (new Set(expected.map((item) => item.variantId)).size !== expected.length) {
    throw new AppError("validation_failed", 400, ["expected_item_duplicate"]);
  }
  return expected;
}

export function requireWebsiteCartReference(cartId: unknown, cartToken: unknown): { cartId: string; cartToken: string } {
  if (
    typeof cartId !== "string"
    || !/^cart_[0-9a-f-]{36}$/u.test(cartId)
    || typeof cartToken !== "string"
    || cartToken.length < 20
    || cartToken.length > 512
  ) {
    throw new AppError("cart_not_found", 404);
  }
  return { cartId, cartToken };
}

export function requireWebsiteCheckoutIdempotencyKey(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9._:-]{16,128}$/u.test(value)) {
    throw new AppError("validation_failed", 400, ["idempotency_key_invalid"]);
  }
  return value;
}

export function requireWebsiteEvidence(value: unknown, issue: "quote_invalid" | "checkout_recovery_invalid"): string {
  if (typeof value !== "string" || value.length < 40 || value.length > 4_096) {
    throw new AppError(issue, 409);
  }
  return value;
}
