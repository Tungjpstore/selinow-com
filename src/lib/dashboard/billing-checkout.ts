export type BillingCheckoutPlan = {
  code: string;
  prices: readonly unknown[];
};

export type BillingCheckoutAdmission = {
  eligible: BillingCheckoutPlan[];
  reasonCode: "billing_market_unavailable" | "plan_price_unavailable" | null;
};

export function getBillingCheckoutAdmission<T extends BillingCheckoutPlan>(input: {
  billingState: string;
  currentPlanCode: string;
  marketReady: boolean;
  plans: readonly T[];
}): { eligible: T[]; reasonCode: BillingCheckoutAdmission["reasonCode"] } {
  if (!input.marketReady) return { eligible: [], reasonCode: "billing_market_unavailable" };
  const eligible = input.plans.filter((plan) => (
    (plan.code === "starter" || plan.code === "pro")
    && plan.prices.length > 0
    && (!new Set(["suspended", "canceled"]).has(input.billingState) || plan.code === input.currentPlanCode)
  ));
  return { eligible, reasonCode: eligible.length === 0 ? "plan_price_unavailable" : null };
}
