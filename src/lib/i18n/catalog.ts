import { DEFAULT_LOCALE, resolveLocale, type SupportedLocale } from "./locale";

export type TranslationValue = string;
export type TranslationCatalog = Readonly<Record<string, TranslationValue>>;
export type TranslationCatalogs = Readonly<Record<SupportedLocale, TranslationCatalog>>;
export type TranslationParams = Readonly<Record<string, string | number>>;
export type TranslatorOptions = Readonly<{ missingTranslation?: string }>;

export type CatalogParity = Readonly<{
  missing: Readonly<Record<SupportedLocale, readonly string[]>>;
  extra: Readonly<Record<SupportedLocale, readonly string[]>>;
}>;

function sortedKeys(catalog: TranslationCatalog): string[] {
  return Object.keys(catalog).sort((left, right) => left.localeCompare(right));
}

/** Compare every catalog to English, the source of truth for required keys. */
export function getCatalogParity(catalogs: TranslationCatalogs): CatalogParity {
  const sourceKeys = new Set(Object.keys(catalogs[DEFAULT_LOCALE]));
  const missing = {} as Record<SupportedLocale, readonly string[]>;
  const extra = {} as Record<SupportedLocale, readonly string[]>;

  for (const locale of ["en", "vi-VN"] as const) {
    const keys = new Set(Object.keys(catalogs[locale]));
    missing[locale] = sortedKeys(catalogs[DEFAULT_LOCALE]).filter((key) => !keys.has(key));
    extra[locale] = sortedKeys(catalogs[locale]).filter((key) => !sourceKeys.has(key));
  }

  return { extra, missing };
}

function interpolate(template: string, params: TranslationParams | undefined): string {
  if (params === undefined) return template;
  return template.replace(/\{([A-Za-z][A-Za-z0-9_.-]*)\}/gu, (placeholder, key: string) => {
    const value = params[key];
    return value === undefined ? placeholder : String(value);
  });
}

/**
 * Build a small, dependency-free translator. Missing supported-locale keys use
 * English; an unknown key returns an empty string (or the configured safe
 * fallback) rather than leaking an internal translation key to a user.
 */
export function createTranslator(catalogs: TranslationCatalogs, locale: unknown, options: TranslatorOptions = {}) {
  const resolvedLocale = resolveLocale({ explicit: locale });
  return (key: string, params?: TranslationParams): string => {
    const localized = catalogs[resolvedLocale][key]
      ?? catalogs[DEFAULT_LOCALE][key]
      ?? options.missingTranslation
      ?? "";
    return interpolate(localized, params);
  };
}
