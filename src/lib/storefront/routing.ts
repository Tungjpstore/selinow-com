import type { AppBindings } from "../platform/bindings";
import { resolveLocale } from "../i18n/locale";

const RESERVED_SUBDOMAINS = new Set([
  "admin", "api", "app", "assets", "auth", "billing", "cdn", "customers", "dashboard", "dev",
  "docs", "email", "help", "login", "mail", "media", "proxy-fallback", "signup", "staging", "static",
  "status", "support", "test", "www",
]);

export type PlatformHostKind = "api" | "dashboard" | "marketing" | "reserved" | "tenant-candidate" | "unknown";

export function normalizeHostname(value: string): string {
  const normalized = value.trim().toLowerCase().replace(/\.+$/u, "");
  if (normalized.length === 0 || normalized.length > 253 || normalized.includes(":") || /^\d+(?:\.\d+){3}$/u.test(normalized)) return "";
  const labels = normalized.split(".");
  if (labels.some((label) => label.length === 0 || label.length > 63 || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u.test(label))) return "";
  return normalized;
}

function originHostname(origin: string): string {
  return normalizeHostname(new URL(origin).hostname);
}

export function classifyPlatformHost(hostnameInput: string, env: Pick<AppBindings, "API_ORIGIN" | "DASHBOARD_ORIGIN" | "PLATFORM_BASE_DOMAIN" | "PLATFORM_ORIGIN">): PlatformHostKind {
  const hostname = normalizeHostname(hostnameInput);
  if (hostname === "") return "unknown";
  if (hostname === originHostname(env.PLATFORM_ORIGIN) || hostname === normalizeHostname(env.PLATFORM_BASE_DOMAIN)) return "marketing";
  if (hostname === originHostname(env.DASHBOARD_ORIGIN)) return "dashboard";
  if (hostname === originHostname(env.API_ORIGIN)) return "api";

  const base = normalizeHostname(env.PLATFORM_BASE_DOMAIN);
  if (base === "" || !hostname.endsWith(`.${base}`)) return "tenant-candidate";
  const prefix = hostname.slice(0, -(base.length + 1));
  if (!prefix.includes(".") && RESERVED_SUBDOMAINS.has(prefix)) return "reserved";
  return prefix.includes(".") ? "unknown" : "tenant-candidate";
}

export function isPublicStorefrontPath(pathname: string): boolean {
  return pathname === "/" || /^\/products\/[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\/?$/u.test(pathname);
}

export function isPrivateStorefrontPath(pathname: string): boolean {
  return pathname === "/cart"
    || pathname === "/checkout"
    || pathname.startsWith("/orders/")
    || pathname.startsWith("/api/store/");
}

export function normalizeStorefrontLocale(value: string | null, fallback: string): string {
  return resolveLocale({ acceptLanguage: value, fallback });
}

export function buildStorefrontCacheKey(input: { hostname: string; incarnation: string; locale: string; pathname: string; search?: string; version: number | string }): string {
  const hostname = normalizeHostname(input.hostname);
  const incarnation = input.incarnation;
  const locale = normalizeStorefrontLocale(input.locale, "vi");
  const pathname = input.pathname.startsWith("/") ? input.pathname : `/${input.pathname}`;
  const version = String(input.version);
  if (!/^[a-z0-9][a-z0-9_-]{0,127}$/iu.test(incarnation)) throw new RangeError("invalid storefront cache incarnation");
  if (!/^[1-9][0-9]*(?:-[1-9][0-9]*)?$/u.test(version)) throw new RangeError("invalid storefront cache version");
  return `https://storefront-cache.invalid/i/${encodeURIComponent(incarnation)}/v${version}/${encodeURIComponent(hostname)}/${encodeURIComponent(locale)}${pathname}${input.search ?? ""}`;
}

export function getCanonicalStorefrontUrl(input: { canonicalHostname: string | null; request: Request }): URL | null {
  if (input.canonicalHostname === null) return null;
  const requestUrl = new URL(input.request.url);
  const currentHostname = normalizeHostname(requestUrl.hostname);
  const canonicalHostname = normalizeHostname(input.canonicalHostname);
  if (canonicalHostname === "" || canonicalHostname === currentHostname || !isPublicStorefrontPath(requestUrl.pathname)) return null;
  requestUrl.hostname = canonicalHostname;
  requestUrl.protocol = "https:";
  requestUrl.port = "";
  return requestUrl;
}

export function isReservedSubdomain(value: string): boolean {
  return RESERVED_SUBDOMAINS.has(value.toLowerCase());
}
