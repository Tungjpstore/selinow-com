export type OverviewLoadState = "forbidden" | "ready" | "unavailable";

export type SellerSellability =
  | "blocked"
  | "draft"
  | "owner_only"
  | "ready"
  | "suspended"
  | "unavailable";

export function deriveSellerSellability(input: {
  readinessReady: boolean;
  readinessState: OverviewLoadState;
  shopStatus: string;
}): SellerSellability {
  if (input.shopStatus === "suspended") return "suspended";
  if (input.shopStatus !== "active") return "draft";
  if (input.readinessState === "unavailable") return "unavailable";
  if (input.readinessState === "forbidden") return "owner_only";
  return input.readinessReady ? "ready" : "blocked";
}

export function hasCompleteActionAuthority(input: {
  catalogRequired: boolean;
  catalogState: OverviewLoadState;
  ordersState: OverviewLoadState;
  readinessState: OverviewLoadState;
}): boolean {
  return input.ordersState === "ready"
    && input.readinessState === "ready"
    && (!input.catalogRequired || input.catalogState === "ready");
}
