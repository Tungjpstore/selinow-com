import { AppError } from "../core/errors";

export const ONBOARDING_STEP_CODES = [
  "account_ready",
  "shop_created",
  "channel_selected",
  "catalog_ready",
  "inventory_ready",
  "telegram_ready",
  "payos_ready",
  "domain_ready",
  "readiness_passed",
  "published",
] as const;

export const CURRENT_POLICY_ATTESTATION_VERSION: number | null = null;

export type OnboardingStepCode = typeof ONBOARDING_STEP_CODES[number];
export type CustomDomainPreference = "connect" | "later" | "skip";

export type OnboardingChannelsInput = {
  customDomainPreference: CustomDomainPreference;
  telegramEnabled: boolean;
  websiteEnabled: boolean;
};

export type OnboardingSettingsInput = {
  attestationAccepted: boolean;
  attestationVersion: number | null;
  privacyUrl: string | null;
  refundPolicyUrl: string | null;
  supportContact: string | null;
  termsUrl: string | null;
};

function rejectUnknownFields(value: Record<string, unknown>, allowed: readonly string[]): void {
  const allowedSet = new Set(allowed);
  const unknown = Object.keys(value).filter((field) => !allowedSet.has(field));
  if (unknown.length > 0) {
    throw new AppError("validation_failed", 400, unknown.map((field) => `unknown_field:${field}`));
  }
}

function requireBoolean(value: unknown, code: string): boolean {
  if (typeof value !== "boolean") {
    throw new AppError("validation_failed", 400, [code]);
  }
  return value;
}

function normalizeOptionalText(value: unknown, code: string, maximumLength: number): string | null {
  if (typeof value !== "string") {
    throw new AppError("validation_failed", 400, [code]);
  }
  const normalized = value.trim().replace(/\s+/gu, " ");
  if (normalized === "") return null;
  const containsControl = Array.from(normalized).some((character) => {
    const point = character.codePointAt(0) ?? 0;
    return point <= 31 || point === 127;
  });
  if (normalized.length > maximumLength || containsControl) {
    throw new AppError("validation_failed", 400, [code]);
  }
  return normalized;
}

function normalizePolicyUrl(value: unknown, code: string): string | null {
  const normalized = normalizeOptionalText(value, code, 512);
  if (normalized === null) return null;

  let parsed: URL;
  try {
    parsed = new URL(normalized);
  } catch {
    throw new AppError("validation_failed", 400, [code]);
  }
  if (
    parsed.protocol !== "https:"
    || parsed.hostname === ""
    || parsed.username !== ""
    || parsed.password !== ""
    || parsed.hash !== ""
  ) {
    throw new AppError("validation_failed", 400, [code]);
  }
  return parsed.toString();
}

export function parseOnboardingChannels(value: Record<string, unknown>): OnboardingChannelsInput {
  rejectUnknownFields(value, ["customDomainPreference", "telegramEnabled", "websiteEnabled"]);
  const websiteEnabled = requireBoolean(value.websiteEnabled, "website_enabled_required");
  const telegramEnabled = requireBoolean(value.telegramEnabled, "telegram_enabled_required");
  if (!websiteEnabled && !telegramEnabled) {
    throw new AppError("validation_failed", 400, ["onboarding_channel_required"]);
  }

  const customDomainPreference = value.customDomainPreference;
  if (!new Set(["connect", "later", "skip"]).has(String(customDomainPreference))) {
    throw new AppError("validation_failed", 400, ["custom_domain_preference_invalid"]);
  }
  if (customDomainPreference === "connect" && !websiteEnabled) {
    throw new AppError("validation_failed", 400, ["custom_domain_requires_website"]);
  }

  return {
    customDomainPreference: customDomainPreference as CustomDomainPreference,
    telegramEnabled,
    websiteEnabled,
  };
}

export function parseOnboardingSettings(value: Record<string, unknown>): OnboardingSettingsInput {
  rejectUnknownFields(value, [
    "attestationAccepted",
    "attestationVersion",
    "privacyUrl",
    "refundPolicyUrl",
    "supportContact",
    "termsUrl",
  ]);

  const attestationAccepted = requireBoolean(value.attestationAccepted, "attestation_accepted_required");
  const attestationVersion = value.attestationVersion;
  if (attestationAccepted && CURRENT_POLICY_ATTESTATION_VERSION === null) {
    throw new AppError("policy_unpublished", 409);
  }
  if (
    attestationAccepted
    && (typeof attestationVersion !== "number"
      || !Number.isSafeInteger(attestationVersion)
      || attestationVersion !== CURRENT_POLICY_ATTESTATION_VERSION)
  ) {
    throw new AppError("validation_failed", 400, ["attestation_version_invalid"]);
  }
  if (!attestationAccepted && attestationVersion !== null) {
    throw new AppError("validation_failed", 400, ["attestation_version_without_acceptance"]);
  }

  return {
    attestationAccepted,
    attestationVersion: attestationAccepted ? CURRENT_POLICY_ATTESTATION_VERSION : null,
    privacyUrl: normalizePolicyUrl(value.privacyUrl, "privacy_url_invalid"),
    refundPolicyUrl: normalizePolicyUrl(value.refundPolicyUrl, "refund_policy_url_invalid"),
    supportContact: normalizeOptionalText(value.supportContact, "support_contact_invalid", 180),
    termsUrl: normalizePolicyUrl(value.termsUrl, "terms_url_invalid"),
  };
}
