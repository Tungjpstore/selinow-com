import { DEFAULT_LOCALE, matchSupportedLocale, type SupportedLocale } from "./locale";

/**
 * Currency metadata is intentionally provider-neutral. Amounts in commerce
 * state are integer minor units; no exchange-rate conversion happens here.
 */
export const CURRENCY_METADATA = {
  EUR: { code: "EUR", minorUnit: 2, numericCode: "978" },
  JPY: { code: "JPY", minorUnit: 0, numericCode: "392" },
  USD: { code: "USD", minorUnit: 2, numericCode: "840" },
  VND: { code: "VND", minorUnit: 0, numericCode: "704" },
} as const;

export type SupportedCurrencyCode = keyof typeof CURRENCY_METADATA;
export type CurrencyMetadata = (typeof CURRENCY_METADATA)[SupportedCurrencyCode];

export const SUPPORTED_CURRENCY_CODES: readonly SupportedCurrencyCode[] = ["USD", "EUR", "JPY", "VND"];

export function normalizeCurrencyCode(value: unknown): SupportedCurrencyCode | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toUpperCase();
  return isSupportedCurrency(normalized) ? normalized : null;
}

export function isSupportedCurrency(value: unknown): value is SupportedCurrencyCode {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(CURRENCY_METADATA, value);
}

export function getCurrencyMetadata(currency: string): CurrencyMetadata {
  const normalized = normalizeCurrencyCode(currency);
  if (normalized === null) throw new RangeError("unsupported_currency");
  return CURRENCY_METADATA[normalized];
}

export function minorUnitFor(currency: string): number {
  return getCurrencyMetadata(currency).minorUnit;
}

/** HTML number inputs expose a locale-neutral decimal string through `.value`. */
export function currencyInputStep(currency: string): string {
  const minorUnit = minorUnitFor(currency);
  return minorUnit === 0 ? "1" : `0.${"0".repeat(minorUnit - 1)}1`;
}

/** Convert a seller-entered major-unit decimal to the integer minor-unit API contract. */
export function parseMajorAmountToMinor(value: unknown, currency: string): number | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length > 64) return null;
  const minorUnit = minorUnitFor(currency);
  const pattern = minorUnit === 0
    ? /^\d+$/u
    : new RegExp(`^(?:\\d+(?:\\.\\d{0,${String(minorUnit)}})?|\\.\\d{1,${String(minorUnit)}})$`, "u");
  if (!pattern.test(normalized)) return null;
  const [whole = "0", fraction = ""] = normalized.split(".", 2);
  const scale = 10n ** BigInt(minorUnit);
  const amount = BigInt(whole === "" ? "0" : whole) * scale
    + BigInt(fraction.padEnd(minorUnit, "0") || "0");
  return amount <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(amount) : null;
}

/** Render a stored minor-unit integer as the decimal value expected by an editor input. */
export function formatMinorAmountForInput(amountMinor: number, currency: string): string {
  if (!Number.isSafeInteger(amountMinor) || amountMinor < 0) throw new RangeError("minor_amount_invalid");
  const minorUnit = minorUnitFor(currency);
  if (minorUnit === 0) return String(amountMinor);
  const scale = 10 ** minorUnit;
  const whole = Math.floor(amountMinor / scale);
  const fraction = String(amountMinor % scale).padStart(minorUnit, "0");
  return `${String(whole)}.${fraction}`;
}

function resolveMoneyLocale(locale: string | undefined): SupportedLocale {
  return matchSupportedLocale(locale) ?? DEFAULT_LOCALE;
}

/** Format an integer minor-unit amount without applying any exchange rate. */
export function formatMoney(amountMinor: number, currency: string, locale = "en"): string {
  if (!Number.isSafeInteger(amountMinor)) throw new RangeError("minor_amount_invalid");
  const metadata = getCurrencyMetadata(currency);
  const majorAmount = amountMinor / (10 ** metadata.minorUnit);
  const formatter = new Intl.NumberFormat(resolveMoneyLocale(locale), {
    currency: metadata.code,
    maximumFractionDigits: metadata.minorUnit,
    minimumFractionDigits: metadata.minorUnit,
    style: "currency",
  });
  return formatter.format(majorAmount);
}
