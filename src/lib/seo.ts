import { DEFAULT_LOCALE, SUPPORTED_LOCALES, normalizeSupportedLocale, type SupportedLocale } from "./i18n/locale";
import { minorUnitFor } from "./i18n/currency";

export const SITE_ORIGIN = "https://selinow.com";

export type SeoStructuredData = Record<string, unknown>;

/** Build an absolute URL while keeping query strings out of canonical paths by default. */
export function absoluteSeoUrl(path: string, origin = SITE_ORIGIN): string {
  const normalizedOrigin = origin.endsWith("/") ? origin.slice(0, -1) : origin;
  return new URL(path.startsWith("/") ? path : `/${path}`, `${normalizedOrigin}/`).toString();
}

/** Escape JSON-LD delimiters that could prematurely close an inline script. */
export function serializeStructuredData(value: SeoStructuredData): string {
  return JSON.stringify(value).replace(/</gu, "\\u003c");
}

export function ogLocaleFor(locale: unknown): string {
  return normalizeSupportedLocale(locale) === "vi-VN" ? "vi_VN" : "en_US";
}

export function alternateLocaleUrl(pathname: string, locale: SupportedLocale, origin = SITE_ORIGIN): string {
  const url = new URL(pathname.startsWith("/") ? pathname : `/${pathname}`, `${origin.replace(/\/$/u, "")}/`);
  if (locale !== DEFAULT_LOCALE) url.searchParams.set("lang", locale);
  return url.toString();
}

export function marketingLocaleAlternates(pathname: string, origin = SITE_ORIGIN): readonly { href: string; hreflang: string }[] {
  return [
    ...SUPPORTED_LOCALES.map((locale) => ({ href: alternateLocaleUrl(pathname, locale, origin), hreflang: locale })),
    { href: alternateLocaleUrl(pathname, DEFAULT_LOCALE, origin), hreflang: "x-default" },
  ];
}

export function schemaPrice(amountMinor: number, currency: string): string {
  if (!Number.isSafeInteger(amountMinor) || amountMinor < 0) throw new RangeError("minor_amount_invalid");
  const minorUnit = minorUnitFor(currency);
  const scale = 10 ** minorUnit;
  return (amountMinor / scale).toFixed(minorUnit);
}
