/**
 * SSRF guard for seller-configured webhook URLs.
 *
 * Cloudflare Workers has no DNS API before fetch, so this blocks by pattern:
 * https-only, port 443 only, no embedded credentials, and no IP-literal /
 * private / localhost-style hosts. Residual risk: DNS rebinding of a public
 * hostname onto a private IP cannot be blocked at this layer (follow-up v2:
 * domain allowlist).
 */
import { AppError } from "../../core/errors";

const IPV4_LITERAL = /^\d{1,3}(?:\.\d{1,3}){3}$/u;

const BLOCKED_HOST_SUFFIXES = [
  ".localhost",
  ".local",
  ".internal",
  ".home.arpa",
  ".lan",
] as const;

function unsafe(): AppError {
  return new AppError("validation_failed", 400, ["webhook_url_unsafe"]);
}

export function assertSafeWebhookUrl(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 2048) throw unsafe();
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw unsafe();
  }
  if (url.protocol !== "https:") throw unsafe();
  if (url.username !== "" || url.password !== "") throw unsafe();
  if (url.port !== "" && url.port !== "443") throw unsafe();

  const host = url.hostname.toLowerCase();
  if (host === "") throw unsafe();
  // IPv6 literals (URL exposes them bracketed) or bare colons.
  if (host.includes("[") || host.includes(":")) throw unsafe();
  // IPv4 literals cover 127/8, 10/8, 172.16/12, 192.168/16, 169.254/16,
  // 100.64/10 and 0.0.0.0 by refusing every dotted-quad outright.
  if (IPV4_LITERAL.test(host)) throw unsafe();
  if (host === "localhost" || host === "metadata.google.internal") throw unsafe();
  for (const suffix of BLOCKED_HOST_SUFFIXES) {
    if (host.endsWith(suffix)) throw unsafe();
  }
  // Single-label hosts have no public TLD.
  if (!host.includes(".")) throw unsafe();

  return url.toString();
}
