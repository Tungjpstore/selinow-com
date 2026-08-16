/**
 * Per-solution mini workflow rails. One shared definition so the landing
 * preview tiles and the solutions hub render the same story.
 */
import { createMarketingTranslator, type MarketingTranslator } from "../../lib/i18n/catalogs/marketing";
import { icons } from "./icons";

export type RailStep = Readonly<{ icon: string; label: string; state: "done" | "active" | "todo" }>;

export function solutionRail(slug: string, t: MarketingTranslator): readonly RailStep[] {
  const rails: Record<string, readonly RailStep[]> = {
    "telegram-commerce": [
      { icon: icons.chat(14), label: t("marketing.home.rail.chat"), state: "done" },
      { icon: icons.receipt(14), label: t("marketing.home.rail.order"), state: "done" },
      { icon: icons.shieldCheck(14), label: t("marketing.home.rail.payment"), state: "active" },
      { icon: icons.send(14), label: t("marketing.home.rail.delivery"), state: "todo" },
    ],
    "digital-product-delivery": [
      { icon: icons.cart(14), label: t("marketing.home.rail.checkout"), state: "done" },
      { icon: icons.shieldCheck(14), label: t("marketing.home.rail.verified"), state: "active" },
      { icon: icons.key(14), label: t("marketing.home.rail.entitlement"), state: "todo" },
      { icon: icons.package(14), label: t("marketing.home.rail.secure_delivery"), state: "todo" },
    ],
    "license-key-inventory": [
      { icon: icons.database(14), label: t("marketing.home.rail.pool"), state: "done" },
      { icon: icons.clock(14), label: t("marketing.home.rail.reserve"), state: "active" },
      { icon: icons.lock(14), label: t("marketing.home.rail.allocate"), state: "todo" },
      { icon: icons.unlock(14), label: t("marketing.home.rail.deliver"), state: "todo" },
    ],
  };
  return rails[slug] ?? rails["telegram-commerce"] ?? [];
}

export function solutionRailTranslator(locale: unknown): MarketingTranslator {
  return createMarketingTranslator(locale);
}
