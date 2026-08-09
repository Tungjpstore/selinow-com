import { createDashboardTranslator } from "../i18n/catalogs/dashboard";

const COMMON_MULTI_LABEL_PUBLIC_SUFFIXES = new Set([
  "co.in",
  "co.jp",
  "co.kr",
  "co.nz",
  "co.uk",
  "com.au",
  "com.br",
  "com.cn",
  "com.hk",
  "com.mx",
  "com.sg",
  "com.tr",
  "com.tw",
  "com.vn",
  "net.au",
  "net.vn",
  "org.uk",
  "org.vn",
]);

export type HostnameDraftResult =
  | { code: null; hostname: string }
  | { code: "hostname_apex_unsupported" | "hostname_invalid" | "hostname_required"; hostname: null };

export type DomainReadiness = {
  dnsStatus: string | null;
  hostnameStatus: string | null;
  sslStatus: string | null;
  status: string;
  turnstileStatus: string | null;
  type: "custom" | "platform_subdomain";
};

export type DomainLifecycleInput = DomainReadiness & {
  isPrimary: boolean;
  ownershipStatus: "pending" | "verified" | null;
};

export type DomainLifecycleKey = "ownership" | "hostname" | "dns" | "ssl" | "turnstile" | "primary" | "routing";

export type DomainLifecycleStep = {
  key: DomainLifecycleKey;
  label: string;
  status: string | null;
};

export const DOMAIN_LIFECYCLE_ORDER: readonly DomainLifecycleKey[] = [
  "ownership",
  "hostname",
  "dns",
  "ssl",
  "turnstile",
  "primary",
  "routing",
] as const;

export function domainStatusLabel(status: string | null, locale?: unknown): string {
  const t = createDashboardTranslator(locale);
  if (status === null || status.length === 0) return t("dashboard.domains.status.not_started");
  return t(`dashboard.domains.status.${status}`, { status })
    || t("dashboard.domains.status.processing", { status });
}

export function domainStatusTone(status: string | null): "error" | "neutral" | "success" | "warning" {
  if (["active", "primary", "verified"].includes(status ?? "")) return "success";
  if (status === null || status.length === 0 || status === "available") return "neutral";
  if (["blocked", "deleted", "expired", "failed", "moved", "suspended"].some((value) => status.includes(value))) return "error";
  return "warning";
}

function isIpv4Address(hostname: string): boolean {
  const labels = hostname.split(".");
  return labels.length === 4 && labels.every((label) => {
    if (!/^\d{1,3}$/u.test(label)) return false;
    const value = Number(label);
    return value >= 0 && value <= 255;
  });
}

export function validateHostnameDraft(value: string): HostnameDraftResult {
  const trimmed = value.trim();
  if (trimmed.length === 0) return { code: "hostname_required", hostname: null };
  if (
    trimmed.includes("://")
    || /[\s/%@?#*\\:]/u.test(trimmed)
    || trimmed.startsWith(".")
    || trimmed.endsWith("..")
  ) {
    return { code: "hostname_invalid", hostname: null };
  }

  const withoutRootDot = trimmed.endsWith(".") ? trimmed.slice(0, -1) : trimmed;
  let hostname: string;
  try {
    hostname = new URL(`http://${withoutRootDot}`).hostname.toLowerCase();
  } catch {
    return { code: "hostname_invalid", hostname: null };
  }

  const labels = hostname.split(".");
  if (
    hostname.length > 253
    || hostname.includes(":")
    || isIpv4Address(hostname)
    || labels.length < 2
    || labels.some((label) => label.length === 0 || label.length > 63 || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u.test(label))
  ) {
    return { code: "hostname_invalid", hostname: null };
  }

  const suffix = labels.slice(-2).join(".");
  if (labels.length < 3 || (labels.length === 3 && COMMON_MULTI_LABEL_PUBLIC_SUFFIXES.has(suffix))) {
    return { code: "hostname_apex_unsupported", hostname: null };
  }

  return { code: null, hostname };
}

export function isDomainReady(domain: DomainReadiness): boolean {
  if (domain.type === "platform_subdomain") return domain.status === "active";
  return domain.status === "active"
    && domain.hostnameStatus === "active"
    && domain.sslStatus === "active"
    && domain.dnsStatus === "active"
    && domain.turnstileStatus === "active";
}

export function deriveDomainLifecycle(domain: DomainLifecycleInput, locale?: unknown): readonly DomainLifecycleStep[] {
  const t = createDashboardTranslator(locale);
  const routingReady = domain.ownershipStatus === "verified" && isDomainReady(domain);
  const ownershipStatus = domain.status === "ownership_expired" ? domain.status : domain.ownershipStatus;
  const routingStatus = routingReady
    ? "active"
    : domain.status === "failed" || domain.status === "suspended"
      ? domain.status
      : "pending";

  return [
    { key: "ownership", label: t("dashboard.domains.lifecycle.ownership"), status: ownershipStatus },
    { key: "hostname", label: t("dashboard.domains.lifecycle.hostname"), status: domain.hostnameStatus },
    { key: "dns", label: t("dashboard.domains.lifecycle.dns"), status: domain.dnsStatus },
    { key: "ssl", label: t("dashboard.domains.lifecycle.ssl"), status: domain.sslStatus },
    { key: "turnstile", label: t("dashboard.domains.lifecycle.turnstile"), status: domain.turnstileStatus },
    { key: "primary", label: t("dashboard.domains.lifecycle.primary"), status: domain.isPrimary ? "primary" : routingReady ? "available" : "pending" },
    { key: "routing", label: t("dashboard.domains.lifecycle.routing"), status: routingStatus },
  ];
}
