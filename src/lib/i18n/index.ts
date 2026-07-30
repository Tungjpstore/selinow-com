export {
  DEFAULT_LOCALE,
  LOCALE_COOKIE_NAME,
  SUPPORTED_LOCALES,
  canonicalizeLocale,
  directionForLocale,
  matchSupportedLocale,
  normalizeSupportedLocale,
  parseAcceptLanguage,
  resolveLocale,
  resolveLocaleWithSource,
  resolveRequestLocaleHint,
  type LocaleResolution,
  type LocaleResolutionInput,
  type LocaleDirection,
  type SupportedLocale,
} from "./locale";
export {
  createTranslator,
  getCatalogParity,
  type CatalogParity,
  type TranslationCatalog,
  type TranslationCatalogs,
  type TranslationParams,
  type TranslationValue,
  type TranslatorOptions,
} from "./catalog";
export {
  createSystemTranslator,
  resolvePresentationLocale,
  systemCatalogs,
  type SystemTranslationParams,
  type SystemTranslator,
} from "./catalogs/system";
export { createDashboardTranslator, dashboardCatalogs } from "./catalogs/dashboard";
export {
  createOnboardingTranslator,
  getOnboardingClientCopy,
  onboardingCatalogs,
  type OnboardingClientCopy,
  type OnboardingCopyKey,
} from "./catalogs/onboarding";
export { adminCatalogs, createAdminTranslator } from "./catalogs/admin";
