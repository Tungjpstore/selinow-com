export { formatMoney } from "../i18n/currency";
import { createStorefrontTranslator } from "../i18n/catalogs/storefront";

export function stockLabel(state: "available" | "low_stock" | "out_of_stock", exact?: number, locale = "en"): string {
  const t = createStorefrontTranslator(locale);
  if (exact !== undefined) return exact > 0 ? t("storefront.stock.exact", { count: exact }) : t("storefront.stock.out");
  if (state === "low_stock") return t("storefront.stock.low");
  if (state === "out_of_stock") return t("storefront.stock.out");
  return t("storefront.stock.available");
}
