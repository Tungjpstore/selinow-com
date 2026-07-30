/**
 * Locale handling is deliberately centralized so cache keys, API validation,
 * and provider hints all agree on the same supported set.
 */
export const SUPPORTED_LOCALES = ["en", "vi-VN"] as const;
export type SupportedLocale = (typeof SUPPORTED_LOCALES)[number];

export const DEFAULT_LOCALE: SupportedLocale = "en";
export const LOCALE_COOKIE_NAME = "selinow_locale";

const SUPPORTED_BY_LANGUAGE: Readonly<Record<string, SupportedLocale>> = {
  en: "en",
  vi: "vi-VN",
};

const LANGUAGE_TAG_PATTERN = /^[A-Za-z0-9-]+$/u;
const ACCEPT_LANGUAGE_MAX_BYTES = 4_096;
const ACCEPT_LANGUAGE_MAX_RANGES = 32;
const RTL_LANGUAGES = new Set([
  "ar",
  "arc",
  "ckb",
  "dv",
  "fa",
  "he",
  "ks",
  "nqo",
  "ps",
  "sd",
  "syr",
  "ug",
  "ur",
  "yi",
]);

export type LocaleDirection = "ltr" | "rtl";

/** Return the canonical BCP47 tag, or null for malformed/untrusted input. */
export function canonicalizeLocale(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > 128 || !LANGUAGE_TAG_PATTERN.test(trimmed)) return null;
  try {
    return Intl.getCanonicalLocales(trimmed)[0] ?? null;
  } catch {
    return null;
  }
}

/** Resolve document direction from the locale's canonical primary language. */
export function directionForLocale(locale: string | null | undefined): LocaleDirection {
  const canonical = canonicalizeLocale(locale);
  if (canonical === null) return "ltr";

  try {
    return RTL_LANGUAGES.has(new Intl.Locale(canonical).language.toLowerCase()) ? "rtl" : "ltr";
  } catch {
    return "ltr";
  }
}

/**
 * Map a valid BCP47 tag to the closest supported locale. Region/script/Unicode
 * extensions are accepted as hints, while unsupported languages return null.
 */
export function matchSupportedLocale(value: unknown): SupportedLocale | null {
  const canonical = canonicalizeLocale(value);
  if (canonical === null) return null;
  if ((SUPPORTED_LOCALES as readonly string[]).includes(canonical)) return canonical as SupportedLocale;

  try {
    const language = new Intl.Locale(canonical).language.toLowerCase();
    return SUPPORTED_BY_LANGUAGE[language] ?? null;
  } catch {
    return null;
  }
}

type AcceptLanguageRange = {
  order: number;
  quality: number;
  range: string;
};

function parseQuality(value: string): number | null {
  const trimmed = value.trim();
  if (!/^(?:0(?:\.\d{0,3})?|1(?:\.0{0,3})?)$/u.test(trimmed)) return null;
  const quality = Number(trimmed);
  return Number.isFinite(quality) ? quality : null;
}

/** Parse an HTTP Accept-Language header into canonical language ranges. */
export function parseAcceptLanguage(value: string | null | undefined): readonly string[] {
  if (value === null || value === undefined || value.length > ACCEPT_LANGUAGE_MAX_BYTES) return [];

  const ranges: AcceptLanguageRange[] = [];
  for (const [order, item] of value.split(",").slice(0, ACCEPT_LANGUAGE_MAX_RANGES).entries()) {
    const [rawRange, ...parameters] = item.trim().split(";");
    const range = rawRange?.trim();
    if (range === undefined || range === "") continue;

    let quality = 1;
    let malformed = false;
    for (const parameter of parameters) {
      const separator = parameter.indexOf("=");
      if (separator < 1 || parameter.slice(0, separator).trim().toLowerCase() !== "q") {
        malformed = true;
        break;
      }
      const parsed = parseQuality(parameter.slice(separator + 1));
      if (parsed === null) {
        malformed = true;
        break;
      }
      quality = parsed;
    }
    if (malformed || quality <= 0) continue;
    if (range === "*") {
      ranges.push({ order, quality, range });
      continue;
    }
    const canonical = canonicalizeLocale(range);
    if (canonical !== null) ranges.push({ order, quality, range: canonical });
  }

  return ranges
    .sort((left, right) => right.quality - left.quality || left.order - right.order)
    .map((entry) => entry.range);
}

export type LocaleResolutionInput = {
  explicit?: unknown;
  cookie?: unknown;
  acceptLanguage?: string | null;
  /** Tenant/platform default is considered only after explicit browser choices. */
  fallback?: unknown;
};

export type LocaleResolution = {
  locale: SupportedLocale;
  source: "explicit" | "cookie" | "accept-language" | "fallback" | "default";
};

function resolveCandidate(value: unknown): SupportedLocale | null {
  return matchSupportedLocale(value);
}

/** Resolve user preference in deterministic order, always ending in English. */
export function resolveLocaleWithSource(input: LocaleResolutionInput = {}): LocaleResolution {
  const explicit = resolveCandidate(input.explicit);
  if (explicit !== null) return { locale: explicit, source: "explicit" };

  const cookie = resolveCandidate(input.cookie);
  if (cookie !== null) return { locale: cookie, source: "cookie" };

  for (const range of parseAcceptLanguage(input.acceptLanguage)) {
    const accepted = resolveCandidate(range);
    if (accepted !== null) return { locale: accepted, source: "accept-language" };
    // A wildcard means "any supported locale"; use the configured fallback
    // before the final English default rather than making a random choice.
    if (range === "*") break;
  }

  const fallback = resolveCandidate(input.fallback);
  if (fallback !== null) return { locale: fallback, source: "fallback" };
  return { locale: DEFAULT_LOCALE, source: "default" };
}

export function resolveLocale(input: LocaleResolutionInput = {}): SupportedLocale {
  return resolveLocaleWithSource(input).locale;
}

/** Resolve only a supported browser/request hint, leaving tenant fallback open. */
export function resolveRequestLocaleHint(input: Omit<LocaleResolutionInput, "fallback"> = {}): SupportedLocale | undefined {
  const resolution = resolveLocaleWithSource(input);
  return resolution.source === "default" ? undefined : resolution.locale;
}

/** Normalize to a supported locale, using English when no hint is usable. */
export function normalizeSupportedLocale(value: unknown): SupportedLocale {
  return matchSupportedLocale(value) ?? DEFAULT_LOCALE;
}
