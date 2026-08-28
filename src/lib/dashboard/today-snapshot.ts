import { AppError } from "../core/errors";
import { listSellerCatalog } from "../catalog/store";
import { listSellerOrders, type SellerOrderSummary } from "../commerce/seller-orders";
import { getSellerMetricsRange, type SellerMetricsRange } from "./metrics";
import { deriveSellerSellability } from "./overview-ui";
import { listSellerAuditEntries, type SellerAuditEntry } from "../operations/seller-audit";
import { listAutomationTasks } from "../automation/api-service";
import { getShopReadiness, type ReadinessCheck, type ReadinessResult } from "../tenants/readiness";
import { getShopForMember } from "../tenants/store";
import type { AppBindings } from "../platform/bindings";

/**
 * EX3.2 — getSellerTodaySnapshot: the cockpit read model. One call composes
 * the sections the Today page renders, each carrying the six-state
 * WorkspaceDataState contract so a failed read can never look like empty
 * data. Copy stays with the UI: queue items carry machine kinds/codes and the
 * page maps them to localized labels. Role truth: readiness + audit are
 * owner-only (forbidden section otherwise); catalog needs owner/manager;
 * orders follow the order-actor visibility rules.
 */

export type TodaySectionState = "ready" | "empty" | "unavailable" | "forbidden" | "waiting_provider" | "waiting_user";

export type TodaySection<T> = { data?: T; state: TodaySectionState };

export type TodayQueueItem = {
  count?: number;
  /** ISO timestamp of the strongest evidence behind the item. */
  evidenceAt?: string;
  kind:
    | "automation_waiting_user"
    | "catalog_unavailable"
    | "fulfillment_exception"
    | "orders_unavailable"
    | "payment_exception"
    | "readiness_fail"
    | "readiness_unavailable"
    | "readiness_warning"
    | "stockout";
  readinessCode?: string;
  severity: "blocked" | "warning";
};

export type TodayActivityEntry = { action: string; actorType: string; createdAt: string; id: string; resourceType: string };

export type TodayRecentOrder = {
  createdAt: string;
  currency: string;
  fulfillmentStatus: string;
  orderId: string;
  orderNumber: string;
  paymentStatus: string;
  totalMinor: number;
  updatedAt: string;
};

export type TodayHealth = { readinessReady: boolean; sellability: ReturnType<typeof deriveSellerSellability> };

export type TodaySnapshot = {
  fetchedAt: string;
  activity: TodaySection<TodayActivityEntry[]>;
  health: TodaySection<TodayHealth>;
  metrics: TodaySection<SellerMetricsRange>;
  queue: TodaySection<TodayQueueItem[]>;
  recentOrders: TodaySection<TodayRecentOrder[]>;
  role: string;
};

/** Minimal typed view over listSellerCatalog's unknown[] projections. */
type CatalogProductRow = { fulfillmentType: string; id: string; status: string };
type CatalogVariantRow = { availableStock: number | null; productId: string; status: string };
type CatalogView = { products: CatalogProductRow[]; variants: CatalogVariantRow[] };

function catalogView(catalog: { categories: unknown[]; products: unknown[]; variants: unknown[] }): CatalogView {
  return {
    products: catalog.products as CatalogProductRow[],
    variants: catalog.variants as CatalogVariantRow[],
  };
}

function readinessView(result: ReadinessResult): { checks: ReadinessCheck[]; ready: boolean } {
  return { checks: result.checks, ready: result.ready };
}

function stateFromError(error: unknown): TodaySectionState {
  if (error instanceof AppError) {
    if (error.status === 403) return "forbidden";
    if (error.code === "recent_auth_required") return "waiting_user";
  }
  return "unavailable";
}

async function section<T>(load: () => Promise<T>): Promise<TodaySection<T>> {
  try {
    return { data: await load(), state: "ready" };
  } catch (error) {
    if (!(error instanceof AppError)) throw error;
    return { state: stateFromError(error) };
  }
}

type QueueItemInput = { count?: number; evidenceAt?: string; kind: TodayQueueItem["kind"]; readinessCode?: string; severity: TodayQueueItem["severity"] };

function queueItem(item: QueueItemInput): TodayQueueItem {
  const built: TodayQueueItem = { kind: item.kind, severity: item.severity };
  if (item.count !== undefined) built.count = item.count;
  if (item.evidenceAt !== undefined) built.evidenceAt = item.evidenceAt;
  if (item.readinessCode !== undefined) built.readinessCode = item.readinessCode;
  return built;
}

export async function getSellerTodaySnapshot(input: {
  env: AppBindings;
  now?: Date;
  shopPublicId: string;
  userId: string;
}): Promise<TodaySnapshot> {
  const member = await getShopForMember({ capability: "shop:read", env: input.env, shopPublicId: input.shopPublicId, userId: input.userId });
  const role = member.row.role;
  const shopStatus = member.row.shop_status;

  const ordersSection = await section(() => listSellerOrders({ env: input.env, shopPublicId: input.shopPublicId, userId: input.userId }));
  const readinessSection = await section(async () =>
    readinessView(await getShopReadiness({ env: input.env, shopPublicId: input.shopPublicId, userId: input.userId })));
  const catalogSection = await section(async () =>
    catalogView(await listSellerCatalog({ env: input.env, shopPublicId: input.shopPublicId, userId: input.userId })));
  const metricsSection = await section(() =>
    getSellerMetricsRange({
      days: 7,
      env: input.env,
      ...(input.now === undefined ? {} : { now: input.now }),
      shopPublicId: input.shopPublicId,
      userId: input.userId,
    }));
  const activitySection = await section(() =>
    listSellerAuditEntries({ env: input.env, limit: 10, shopPublicId: input.shopPublicId, userId: input.userId }));
  const automationSection = await section(() =>
    listAutomationTasks({ env: input.env, limit: 20, shopPublicId: input.shopPublicId, status: "waiting_user", userId: input.userId }));

  const queue: TodayQueueItem[] = [];
  for (const check of readinessSection.data?.checks ?? []) {
    if (check.status === "pass") continue;
    queue.push(queueItem({
      evidenceAt: check.checkedAt,
      kind: check.status === "fail" ? "readiness_fail" : "readiness_warning",
      readinessCode: check.code,
      severity: check.status === "fail" ? "blocked" : "warning",
    }));
  }
  if (ordersSection.state === "unavailable") {
    queue.push(queueItem({ kind: "orders_unavailable", severity: "blocked" }));
  }
  if (catalogSection.state === "unavailable") {
    queue.push(queueItem({ kind: "catalog_unavailable", severity: "blocked" }));
  }
  if (readinessSection.state === "unavailable") {
    queue.push(queueItem({ kind: "readiness_unavailable", severity: "blocked" }));
  }
  const orders = ordersSection.data ?? [];
  const paymentExceptions = orders.filter((order) => order.paymentStatus === "partial" || order.paymentStatus === "overpaid" || order.paymentStatus === "failed");
  const fulfillmentExceptions = orders.filter((order) => order.fulfillmentStatus === "failed" || order.fulfillmentStatus === "manual_review");
  if (ordersSection.state === "ready" && paymentExceptions.length > 0) {
    const paymentEvidence = paymentExceptions[0]?.updatedAt;
  queue.push(queueItem({ count: paymentExceptions.length, ...(paymentEvidence === undefined ? {} : { evidenceAt: paymentEvidence }), kind: "payment_exception", severity: "blocked" }));
  }
  if (ordersSection.state === "ready" && fulfillmentExceptions.length > 0) {
    const fulfillmentEvidence = fulfillmentExceptions[0]?.updatedAt;
  queue.push(queueItem({ count: fulfillmentExceptions.length, ...(fulfillmentEvidence === undefined ? {} : { evidenceAt: fulfillmentEvidence }), kind: "fulfillment_exception", severity: "blocked" }));
  }
  const licenseProducts = new Set(
    catalogSection.data?.products
      .filter((product) => product.status === "active" && product.fulfillmentType === "license_key")
      .map((product) => product.id) ?? [],
  );
  const stockouts = catalogSection.data?.variants.filter((variant) =>
    variant.status === "active" && licenseProducts.has(variant.productId) && (variant.availableStock ?? 0) <= 0) ?? [];
  if (catalogSection.state === "ready" && stockouts.length > 0) {
    queue.push(queueItem({ count: stockouts.length, kind: "stockout", severity: "warning" }));
  }
  const waitingUser = automationSection.data?.tasks ?? [];
  if (automationSection.state === "ready" && waitingUser.length > 0) {
    const automationEvidence = waitingUser[0]?.updatedAt;
  queue.push(queueItem({ count: waitingUser.length, ...(automationEvidence === undefined ? {} : { evidenceAt: automationEvidence }), kind: "automation_waiting_user", severity: "warning" }));
  }
  queue.sort((left, right) => (left.severity === right.severity ? 0 : left.severity === "blocked" ? -1 : 1));

  const health: TodaySection<TodayHealth> = {
    data: {
      readinessReady: readinessSection.data?.ready === true,
      sellability: deriveSellerSellability({
        readinessReady: readinessSection.data?.ready === true,
        readinessState: readinessSection.state === "ready" ? "ready" : readinessSection.state === "forbidden" ? "forbidden" : "unavailable",
        shopStatus,
      }),
    },
    state: "ready",
  };

  const recentOrders: TodayRecentOrder[] = orders.slice(0, 6).map((order: SellerOrderSummary) => ({
    createdAt: order.createdAt,
    currency: order.currency,
    fulfillmentStatus: order.fulfillmentStatus,
    orderId: order.orderId,
    orderNumber: order.orderNumber,
    paymentStatus: order.paymentStatus,
    totalMinor: order.totalMinor,
    updatedAt: order.updatedAt,
  }));

  const activity: TodayActivityEntry[] = (activitySection.data ?? []).map((entry: SellerAuditEntry) => ({
    action: entry.action,
    actorType: entry.actorType,
    createdAt: entry.createdAt,
    id: entry.id,
    resourceType: entry.resourceType,
  }));

  return {
    activity: { ...(activity.length > 0 ? { data: activity } : {}), state: activitySection.state === "ready" ? (activity.length === 0 ? "empty" : "ready") : activitySection.state },
    fetchedAt: new Date().toISOString(),
    health,
    metrics: metricsSection,
    queue: { data: queue, state: "ready" },
    recentOrders: { ...(recentOrders.length > 0 ? { data: recentOrders } : {}), state: ordersSection.state === "ready" ? (recentOrders.length === 0 ? "empty" : "ready") : ordersSection.state },
    role,
  };
}
