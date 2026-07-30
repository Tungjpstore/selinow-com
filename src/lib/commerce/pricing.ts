import type { AppBindings } from "../platform/bindings";

export type CommercePricingShop = {
  currency: string;
  id: string;
};

/** Calculate a discount from the persisted code using the shop currency. */
export async function calculateCartDiscountMinor(input: { code: string | null; env: AppBindings; shop: CommercePricingShop; subtotalMinor: number }): Promise<number> {
  if (input.code === null) return 0;
  const now = new Date().toISOString();
  const row = await input.env.PLATFORM_DB.prepare("SELECT type, value, currency, minimum_minor AS minimumMinor FROM discounts WHERE shop_id = ? AND code_normalized = ? AND status = 'active' AND (starts_at IS NULL OR starts_at <= ?) AND (ends_at IS NULL OR ends_at > ?) LIMIT 1").bind(input.shop.id, input.code, now, now).first<{ currency: string | null; minimumMinor: number; type: string; value: number }>();
  if (row === null || input.subtotalMinor < row.minimumMinor || (row.currency !== null && row.currency !== input.shop.currency)) return 0;
  if (row.type === "percentage") return Math.min(input.subtotalMinor, Math.floor(input.subtotalMinor * Math.min(row.value, 10_000) / 10_000));
  if (row.type === "fixed") return Math.min(input.subtotalMinor, row.value);
  return 0;
}
