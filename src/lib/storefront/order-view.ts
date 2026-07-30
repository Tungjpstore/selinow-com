import { createStorefrontTranslator } from "../i18n/catalogs/storefront";

export type OrderStateTone = "danger" | "info" | "success" | "warning";

export type OrderStateView = {
  detail: string;
  label: string;
  tone: OrderStateTone;
};

const KNOWN_STATES = new Set([
  "canceled", "completed", "exception", "expired", "failed", "fulfilled", "manual_review",
  "overpaid", "paid", "partial", "pending", "pending_payment", "processing", "refunded",
  "reserved", "unfulfilled", "unpaid",
]);

export function orderStateLabel(value: string, locale?: unknown): string {
  const t = createStorefrontTranslator(locale);
  const key = `storefront.status.${value}`;
  return KNOWN_STATES.has(value) ? t(key) : t("storefront.status.unknown");
}

export function paymentStateView(paymentStatus: string, orderStatus: string, locale?: unknown): OrderStateView {
  const t = createStorefrontTranslator(locale);
  if (paymentStatus === "paid") return {
    detail: t("storefront.payment.paid_detail"),
    label: orderStateLabel(paymentStatus, locale),
    tone: "success",
  };
  if (paymentStatus === "pending") return {
    detail: t("storefront.payment.pending_detail"),
    label: orderStateLabel(paymentStatus, locale),
    tone: "info",
  };
  if (paymentStatus === "expired" || orderStatus === "expired") return {
    detail: t("storefront.payment.expired_detail"),
    label: t("storefront.payment.expired_label"),
    tone: "danger",
  };
  if (orderStatus === "canceled") return {
    detail: t("storefront.payment.canceled_detail"),
    label: t("storefront.payment.canceled_label"),
    tone: "danger",
  };
  if (["partial", "overpaid", "failed", "refunded"].includes(paymentStatus)) return {
    detail: t("storefront.payment.exception_detail"),
    label: orderStateLabel(paymentStatus, locale),
    tone: "danger",
  };
  return {
    detail: t("storefront.payment.unpaid_detail"),
    label: orderStateLabel(paymentStatus, locale),
    tone: "warning",
  };
}

export function fulfillmentStateView(fulfillmentStatus: string, orderStatus: string, locale?: unknown): OrderStateView {
  const t = createStorefrontTranslator(locale);
  if (fulfillmentStatus === "fulfilled") return {
    detail: t("storefront.fulfillment.fulfilled_detail"),
    label: orderStateLabel(fulfillmentStatus, locale),
    tone: "success",
  };
  if (["failed", "manual_review"].includes(fulfillmentStatus) || orderStatus === "exception") return {
    detail: t("storefront.fulfillment.exception_detail"),
    label: orderStateLabel(fulfillmentStatus, locale),
    tone: "danger",
  };
  if (orderStatus === "expired" || orderStatus === "canceled") return {
    detail: t("storefront.fulfillment.stopped_detail"),
    label: t("storefront.fulfillment.stopped_label"),
    tone: "danger",
  };
  if (["reserved", "processing"].includes(fulfillmentStatus)) return {
    detail: t("storefront.fulfillment.processing_detail"),
    label: orderStateLabel(fulfillmentStatus, locale),
    tone: "info",
  };
  return {
    detail: t("storefront.fulfillment.unfulfilled_detail"),
    label: orderStateLabel(fulfillmentStatus, locale),
    tone: "warning",
  };
}
