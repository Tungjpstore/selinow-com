import { createStorefrontTranslator } from "../i18n/catalogs/storefront";

export type StorefrontSupport = {
  href: string | null;
  label: string;
};

export type StorefrontPublicDetails = {
  deliveryText: string;
  privacyUrl: string | null;
  refundPolicyUrl: string | null;
  support: StorefrontSupport;
  termsUrl: string | null;
};

function normalizedText(value: string | null, fallback: string, maximum: number): string {
  if (value === null) return fallback;
  const normalized = value.trim().replace(/\s+/gu, " ");
  const hasControl = Array.from(normalized).some((character) => {
    const point = character.codePointAt(0) ?? 0;
    return point <= 31 || point === 127;
  });
  return normalized.length > 0 && normalized.length <= maximum && !hasControl ? normalized : fallback;
}

export function safePublicHttpsUrl(value: string | null): string | null {
  if (value === null || value.length > 512) return null;
  try {
    const url = new URL(value);
    if (
      url.protocol !== "https:"
      || url.hostname === ""
      || url.username !== ""
      || url.password !== ""
      || url.hash !== ""
    ) return null;
    return url.toString();
  } catch {
    return null;
  }
}

function supportHref(label: string): string | null {
  const url = safePublicHttpsUrl(label);
  if (url !== null) return url;
  if (label.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(label)) return `mailto:${label}`;
  return null;
}

export function parseStorefrontPublicDetails(input: {
  deliveryText: string;
  privacyUrl: string | null;
  refundPolicyUrl: string | null;
  locale?: unknown;
  supportContact: string | null;
  supportFallback: string;
  termsUrl: string | null;
}): StorefrontPublicDetails {
  const t = createStorefrontTranslator(input.locale);
  const fallback = normalizedText(input.supportFallback, t("storefront.defaults.support_contact"), 180);
  const label = normalizedText(input.supportContact, fallback, 180);
  return {
    deliveryText: normalizedText(input.deliveryText, t("storefront.defaults.delivery"), 240),
    privacyUrl: safePublicHttpsUrl(input.privacyUrl),
    refundPolicyUrl: safePublicHttpsUrl(input.refundPolicyUrl),
    support: { href: supportHref(label), label },
    termsUrl: safePublicHttpsUrl(input.termsUrl),
  };
}
