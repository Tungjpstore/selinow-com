import type { AppBindings } from "../platform/bindings";

export type InvoiceStatus = "draft" | "failed" | "open" | "paid" | "past_due" | "refunded" | "void";

export type ShopInvoice = {
  amountMinor: number;
  createdAt: string;
  currency: string;
  id: string;
  paidAt: string | null;
  providerCode: string;
  providerInvoiceRef: string | null;
  status: InvoiceStatus;
};

const MAX_INVOICES = 50;

/**
 * Lists billing invoices for one shop only. The caller must already have
 * resolved membership with the "billing:manage" capability (see
 * getSellerBilling); the shop_id here is the tenant-scoped primary filter and
 * never crosses tenants. Provider transaction references are intentionally not
 * returned: the seller UI only needs the safe invoice reference.
 */
export async function listShopInvoices(input: {
  env: AppBindings;
  limit?: number;
  shopId: string;
}): Promise<ShopInvoice[]> {
  const requestedLimit = input.limit;
  const limit = Number.isSafeInteger(requestedLimit) && (requestedLimit as number) > 0
    ? Math.min(requestedLimit as number, MAX_INVOICES)
    : MAX_INVOICES;
  const rows = await input.env.PLATFORM_DB.prepare(`
    SELECT id, status, amount_minor AS amountMinor, currency,
      paid_at AS paidAt, provider_code AS providerCode,
      provider_invoice_ref AS providerInvoiceRef, created_at AS createdAt
    FROM billing_invoices
    WHERE shop_id = ?
    ORDER BY created_at DESC, id DESC
    LIMIT ?
  `).bind(input.shopId, limit).all<ShopInvoice>();
  return rows.results;
}
