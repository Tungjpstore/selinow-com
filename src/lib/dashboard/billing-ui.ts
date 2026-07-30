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
  grace_period: "warning",
  past_due: "warning",
  suspended: "danger",
  trialing: "info",
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
