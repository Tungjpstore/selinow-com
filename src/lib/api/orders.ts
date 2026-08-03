import type { AppBindings } from "../platform/bindings";
import { encodePublicApiCursor, type PublicApiPage } from "./pagination";

type OrderRow = {
  createdAt: string;
  currency: string;
  fulfillmentStatus: string;
  itemCount: number;
  orderId: string;
  orderNumber: string;
  paymentStatus: string;
  primaryItem: string | null;
  status: string;
  totalMinor: number;
  updatedAt: string;
};

export type PublicApiOrders = {
  items: OrderRow[];
  limit: number;
  nextCursor: string | null;
};

export async function getPublicApiOrders(input: {
  env: AppBindings;
  page: PublicApiPage;
  shopId: string;
}): Promise<PublicApiOrders> {
  const cursor = input.page.cursor;
  const rows = await input.env.PLATFORM_DB.prepare(`
    SELECT orders.public_id AS orderId,
      orders.order_number AS orderNumber,
      orders.status,
      orders.payment_status AS paymentStatus,
      orders.fulfillment_status AS fulfillmentStatus,
      orders.total_minor AS totalMinor,
      orders.currency,
      orders.created_at AS createdAt,
      orders.updated_at AS updatedAt,
      COUNT(order_items.id) AS itemCount,
      MIN(order_items.product_title) AS primaryItem
    FROM orders
    LEFT JOIN order_items
      ON order_items.shop_id = orders.shop_id
      AND order_items.order_id = orders.id
    WHERE orders.shop_id = ?
      AND (? IS NULL OR orders.created_at < ?
        OR (orders.created_at = ? AND orders.public_id < ?))
    GROUP BY orders.id
    ORDER BY orders.created_at DESC, orders.public_id DESC
    LIMIT ?
  `).bind(
    input.shopId,
    cursor?.createdAt ?? null,
    cursor?.createdAt ?? null,
    cursor?.createdAt ?? null,
    cursor?.id ?? null,
    input.page.limit + 1,
  ).all<OrderRow>();
  const hasMore = rows.results.length > input.page.limit;
  const items = hasMore ? rows.results.slice(0, input.page.limit) : rows.results;
  const last = items.at(-1);
  return {
    items,
    limit: input.page.limit,
    nextCursor: hasMore && last !== undefined
      ? encodePublicApiCursor({ createdAt: last.createdAt, id: last.orderId })
      : null,
  };
}
