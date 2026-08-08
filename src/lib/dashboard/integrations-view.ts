import { createSystemTranslator, resolvePresentationLocale } from "../i18n";

export type IntegrationTone = "danger" | "info" | "neutral" | "success" | "warning";

export type IntegrationState = {
  label: string;
  tone: IntegrationTone;
  summary: string;
  checked: string;
  error: string | null;
};

export type TelegramIntegrationLike = {
  bot: { displayName: string; username: string } | null;
  lastCheckedAt: string | null;
  lastSafeErrorCode: string | null;
  status: string;
  webhookStatus: string;
};

export type PaymentIntegrationLike = {
  lastCheckedAt: string | null;
  lastSafeErrorCode: string | null;
  status: string;
  webhookStatus: string;
};

export type DomainLike = {
  hostname: string;
  isPrimary: boolean | number;
  lastCheckedAt: string | null;
  lastSafeErrorCode?: string | null;
  status: string;
  type: string;
};

const ERROR_KEYS: Readonly<Record<string, string>> = {
  authorization_denied: "integration.error.authorization_denied",
  csrf_invalid: "integration.error.csrf_invalid",
  csrf_missing: "integration.error.csrf_missing",
  recent_auth_required: "integration.error.recent_auth_required",
  payment_not_configured: "integration.error.payment_not_configured",
  payment_provider_environment_not_admitted: "integration.error.payment_provider_environment_not_admitted",
  provider_unavailable: "integration.error.provider_unavailable",
  provider_verification_failed: "integration.error.provider_verification_failed",
  telegram_webhook_failed: "integration.error.telegram_webhook_failed",
  telegram_provider_delivery_error: "integration.error.telegram_provider_delivery_error",
  telegram_bot_already_connected: "integration.error.telegram_bot_already_connected",
  credential_already_connected: "integration.error.credential_already_connected",
  credential_channel_mismatch: "integration.error.credential_channel_mismatch",
  validation_failed: "integration.error.validation_failed",
  internal_error: "integration.error.internal_error",
};

function localizedResource(resource: string, locale?: unknown): string {
  const normalized = resource.trim().toLocaleLowerCase("en");
  const t = createSystemTranslator(locale);
  if (normalized === "telegram") return t("integration.resource.telegram");
  if (normalized === "payos") return t("integration.resource.payos");
  if (normalized === "domain" || normalized === "domains" || normalized === "tên miền") return t("integration.resource.domain");
  return resource;
}

export function safeErrorCode(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "object" && value !== null && typeof (value as { code?: unknown }).code === "string") {
    return (value as { code: string }).code;
  }
  return "internal_error";
}

export function safeErrorMessage(value: unknown, requestId?: unknown, locale?: unknown): string {
  const code = safeErrorCode(value);
  const t = createSystemTranslator(locale);
  const base = t(ERROR_KEYS[code] ?? "integration.error.generic");
  return typeof requestId === "string" && requestId.length > 0
    ? `${base} ${t("integration.support_code", { requestId })}`
    : base;
}

export function formatIntegrationTime(value: string | null, timeZone = "Asia/Ho_Chi_Minh", locale?: unknown): string {
  const resolvedLocale = resolvePresentationLocale(locale);
  const t = createSystemTranslator(resolvedLocale);
  if (value === null) return t("integration.checked.no_provider");
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return t("integration.checked.recent");
  try {
    const time = new Intl.DateTimeFormat(resolvedLocale, { dateStyle: "short", timeStyle: "short", timeZone }).format(new Date(timestamp));
    return t("integration.checked.at", { time });
  } catch {
    return t("integration.checked.recent");
  }
}

export function statusFor(status: string | null, webhookStatus: string | null, locale?: unknown): { label: string; tone: IntegrationTone } {
  const t = createSystemTranslator(locale);
  if (status === null || status === "disconnected" || status === "disabled") return { label: t("integration.status.disconnected"), tone: "neutral" };
  if (status === "active" && (webhookStatus === "verified" || webhookStatus === "active")) return { label: t("integration.status.active"), tone: "success" };
  if (status === "degraded" || webhookStatus === "mismatch") return { label: t("integration.status.degraded"), tone: "warning" };
  if (status === "connecting") return { label: t("integration.status.connecting"), tone: "info" };
  if (status === "waiting_user") return { label: t("integration.status.waiting_user"), tone: "warning" };
  if (status === "waiting_provider" || status === "pending" || webhookStatus === "pending") return { label: t("integration.status.waiting_provider"), tone: "info" };
  if (status.includes("expired")) return { label: t("integration.status.expired"), tone: "danger" };
  if (status === "failed" || status === "error" || webhookStatus === "error") return { label: t("integration.status.failed"), tone: "danger" };
  return { label: t("integration.status.checking"), tone: "info" };
}

export function unavailableState(resource: string, locale?: unknown): IntegrationState {
  const t = createSystemTranslator(locale);
  const resourceLabel = localizedResource(resource, locale);
  return {
    label: t("integration.label.no_permission"),
    tone: "warning",
    summary: t("integration.summary.resource.no_permission", { resource: resourceLabel }),
    checked: t("integration.checked.no_provider"),
    error: null,
  };
}

export function loadErrorState(resource: string, error: unknown, locale?: unknown): IntegrationState {
  const t = createSystemTranslator(locale);
  const resourceLabel = localizedResource(resource, locale);
  return {
    label: t("integration.label.unreadable"),
    tone: "danger",
    summary: t("integration.summary.resource.unreadable", { resource: resourceLabel }),
    checked: t("integration.checked.no_provider"),
    error: safeErrorMessage(error, undefined, locale),
  };
}

export function telegramState(view: TelegramIntegrationLike | null, timeZone?: string, locale?: unknown): IntegrationState {
  const t = createSystemTranslator(locale);
  const state = statusFor(view?.status ?? null, view?.webhookStatus ?? null, locale);
  const summary = view === null
    ? t("integration.summary.telegram.none")
    : view.bot === null
      ? t("integration.summary.telegram.unknown")
      : `${view.bot.displayName} · @${view.bot.username}`;
  return { ...state, summary, checked: formatIntegrationTime(view?.lastCheckedAt ?? null, timeZone, locale), error: view?.lastSafeErrorCode === null || view?.lastSafeErrorCode === undefined ? null : safeErrorMessage(view.lastSafeErrorCode, undefined, locale) };
}

export function paymentState(view: PaymentIntegrationLike | null, timeZone?: string, locale?: unknown): IntegrationState {
  const t = createSystemTranslator(locale);
  const state = statusFor(view?.status ?? null, view?.webhookStatus ?? null, locale);
  const summary = view === null
    ? t("integration.summary.payment.none")
    : state.tone === "success"
      ? t("integration.summary.payment.ready")
      : t("integration.summary.payment.not_ready");
  return { ...state, summary, checked: formatIntegrationTime(view?.lastCheckedAt ?? null, timeZone, locale), error: view?.lastSafeErrorCode === null || view?.lastSafeErrorCode === undefined ? null : safeErrorMessage(view.lastSafeErrorCode, undefined, locale) };
}

export function domainState(domains: readonly DomainLike[], timeZone?: string, locale?: unknown): IntegrationState {
  const t = createSystemTranslator(locale);
  const primary = domains.find((domain) => domain.isPrimary === true || domain.isPrimary === 1) ?? domains[0] ?? null;
  if (primary === null) return { label: t("integration.label.no_address"), tone: "neutral", summary: t("integration.summary.domain.none"), checked: t("integration.checked.no_provider"), error: null };
  const state = primary.lastSafeErrorCode !== null && primary.lastSafeErrorCode !== undefined
    ? { label: t("integration.label.attention"), tone: "warning" as const }
    : primary.status === "active"
    ? { label: t("integration.status.active"), tone: "success" as const }
    : primary.status === "error" || primary.status === "failed"
      ? { label: t("integration.label.attention"), tone: "danger" as const }
      : { label: t("integration.label.waiting_check"), tone: "warning" as const };
  const checked = primary.type === "platform_subdomain" && primary.lastCheckedAt === null
    ? t("integration.checked.platform_address")
    : formatIntegrationTime(primary.lastCheckedAt, timeZone, locale);
  const primarySuffix = primary.isPrimary === true || primary.isPrimary === 1
    ? ` · ${t("integration.summary.domain.primary")}`
    : "";
  return { ...state, summary: `${primary.hostname}${primarySuffix}`, checked, error: primary.lastSafeErrorCode === null || primary.lastSafeErrorCode === undefined ? null : safeErrorMessage(primary.lastSafeErrorCode, undefined, locale) };
}
