import { AppError } from "../core/errors";

/**
 * Subscription state is authoritative only when its time-bound entitlement is
 * still valid. Trial and grace rows without a deadline fail closed.
 */
export type SubscriptionAccessInput = {
  graceEndsAt?: string | null | undefined;
  now?: Date | string | undefined;
  subscriptionState: string;
  trialEndsAt?: string | null | undefined;
};

function asTime(value: string | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const time = Date.parse(value);
  return Number.isFinite(time) ? time : null;
}

export function subscriptionAllows(input: SubscriptionAccessInput): boolean {
  const now = input.now instanceof Date
    ? input.now.getTime()
    : Date.parse(input.now ?? new Date().toISOString());
  if (!Number.isFinite(now)) return false;
  if (["active", "cancel_scheduled", "upgrade_pending", "downgrade_scheduled"].includes(input.subscriptionState)) return true;
  if (input.subscriptionState === "trialing") {
    const trialEndsAt = asTime(input.trialEndsAt);
    return trialEndsAt !== null && trialEndsAt > now;
  }
  if (input.subscriptionState === "past_due" || input.subscriptionState === "grace_period") {
    const graceEndsAt = asTime(input.graceEndsAt);
    return graceEndsAt !== null && graceEndsAt > now;
  }
  return false;
}

export function assertSubscriptionAllows(input: SubscriptionAccessInput): void {
  if (!subscriptionAllows(input)) throw new AppError("subscription_required", 402);
}
