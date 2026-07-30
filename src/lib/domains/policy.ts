import { AppError } from "../core/errors";

const DEFAULT_PLATFORM_HOSTNAMES = ["selinow.com"] as const;
const INTERNAL_SUFFIXES = [
  "example",
  "home",
  "internal",
  "invalid",
  "lan",
  "local",
  "localdomain",
  "localhost",
  "test",
] as const;
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

export type CustomHostnamePolicyOptions = {
  platformHostnames?: readonly string[];
};

function validationError(issue: string, status = 400): AppError {
  return new AppError("validation_failed", status, [issue]);
}

function isIpv4Address(hostname: string): boolean {
  const labels = hostname.split(".");
  return labels.length === 4 && labels.every((label) => {
    if (!/^\d{1,3}$/u.test(label)) return false;
    const octet = Number(label);
    return octet >= 0 && octet <= 255 && String(octet) === label.replace(/^0+(?=\d)/u, "");
  });
}

function isInternalHostname(hostname: string): boolean {
  return INTERNAL_SUFFIXES.some((suffix) => hostname === suffix || hostname.endsWith(`.${suffix}`));
}

/** Canonicalizes a syntactically valid DNS hostname without applying product policy. */
export function canonicalizeHostname(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) throw validationError("hostname_required");
  if (
    trimmed.includes("://")
    || /[\s/%@?#*\\:]/u.test(trimmed)
    || trimmed.startsWith(".")
    || trimmed.endsWith("..")
  ) {
    throw validationError("hostname_invalid");
  }

  const withoutRootDot = trimmed.endsWith(".") ? trimmed.slice(0, -1) : trimmed;
  let hostname: string;
  try {
    hostname = new URL(`http://${withoutRootDot}`).hostname.toLowerCase();
  } catch {
    throw validationError("hostname_invalid");
  }

  if (hostname.length === 0 || hostname.length > 253 || hostname.includes(":") || hostname.startsWith("[") || isIpv4Address(hostname)) {
    throw validationError("hostname_ip_not_allowed");
  }

  const labels = hostname.split(".");
  if (
    labels.length < 2
    || labels.some((label) => label.length === 0 || label.length > 63 || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u.test(label))
  ) {
    throw validationError("hostname_invalid");
  }

  return hostname;
}

export function normalizeCustomHostname(input: unknown, options: CustomHostnamePolicyOptions = {}): string {
  if (typeof input !== "string") throw validationError("hostname_required");
  const hostname = canonicalizeHostname(input);

  if (isInternalHostname(hostname)) throw validationError("hostname_internal_not_allowed");

  const platformHostnames = options.platformHostnames ?? DEFAULT_PLATFORM_HOSTNAMES;
  for (const value of platformHostnames) {
    const platformHostname = canonicalizeHostname(value);
    if (hostname === platformHostname || hostname.endsWith(`.${platformHostname}`)) {
      throw validationError("hostname_platform_not_allowed", 409);
    }
  }

  // The MVP requires a custom subdomain CNAME. Cover common multi-label public
  // suffixes conservatively until apex support is backed by a full suffix list.
  const labels = hostname.split(".");
  const suffix = labels.slice(-2).join(".");
  if (labels.length < 3 || (labels.length === 3 && COMMON_MULTI_LABEL_PUBLIC_SUFFIXES.has(suffix))) {
    throw validationError("hostname_apex_unsupported");
  }

  return hostname;
}

export type CloudflareReadiness = {
  dnsStatus: string;
  hostnameStatus: string;
  sslStatus: string;
};

export function isCloudflareHostnameReady(input: CloudflareReadiness): boolean {
  return input.hostnameStatus === "active" && input.sslStatus === "active" && input.dnsStatus === "active";
}
