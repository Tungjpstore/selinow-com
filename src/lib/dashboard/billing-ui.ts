import { createSystemTranslator } from "../i18n";

export type SubscriptionStateTone = "danger" | "info" | "neutral" | "success" | "warning";

export type SubscriptionStatePresentation = {
  impact: string;
  label: string;
  tone: SubscriptionStateTone;
};

const SUBSCRIPTION_STATE_TONES: Readonly<Record<string, SubscriptionStateTone>> = {
  active: "success",
  canceled: "neutral",
  cancel_scheduled: "success",
  downgrade_scheduled: "info",
  grace_period: "warning",
  pending_payment: "info",
  past_due: "warning",
  suspended: "danger",
  trialing: "info",
  upgrade_pending: "info",
};

export function subscriptionStatePresentation(state: string, locale?: unknown): SubscriptionStatePresentation {
  const t = createSystemTranslator(locale);
  const knownState = SUBSCRIPTION_STATE_TONES[state] === undefined ? "unknown" : state;
  return {
    impact: t(`subscription.impact.${knownState}`),
    label: t(`subscription.status.${knownState}`),
    tone: SUBSCRIPTION_STATE_TONES[state] ?? "neutral",
  };
}
