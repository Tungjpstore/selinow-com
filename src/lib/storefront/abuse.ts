import { AppError } from "../core/errors";
import { hmacToken } from "../core/crypto";
import type { AppBindings } from "../platform/bindings";
import { customDomainTurnstileAdmissionSql } from "../domains/readiness";
import type { StorefrontShop } from "./store";
import { resolveTurnstileConfiguration, type TurnstileConfiguration } from "./turnstile";

type TurnstileEnvelope = {
  action?: string;
  hostname?: string;
  success?: boolean;
};

function positiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function clientAddress(request: Request): string {
  return request.headers.get("CF-Connecting-IP")?.trim() || "local";
}

async function incrementLimit(input: { action: string; env: AppBindings; request: Request; shopId: string; windowSeconds: number }): Promise<number> {
  const now = new Date();
  const windowStart = new Date(Math.floor(now.getTime() / (input.windowSeconds * 1_000)) * input.windowSeconds * 1_000).toISOString();
  const subjectHash = await hmacToken(
    input.env.IDENTIFIER_HMAC_SECRET,
    `anonymous-rate:v2:${input.shopId}:${input.action}`,
    clientAddress(input.request),
  );
  const row = await input.env.PLATFORM_DB.prepare(`
    INSERT INTO anonymous_request_limits (
      shop_id, action, subject_hash, window_started_at, request_count, updated_at
    ) VALUES (?, ?, ?, ?, 1, ?)
    ON CONFLICT(shop_id, action, subject_hash, window_started_at)
    DO UPDATE SET request_count = anonymous_request_limits.request_count + 1, updated_at = excluded.updated_at
    RETURNING request_count AS requestCount
  `).bind(input.shopId, input.action, subjectHash, windowStart, now.toISOString()).first<{ requestCount: number }>();
  return row?.requestCount ?? 1;
}

async function assertTurnstileHostnameAdmission(input: { env: AppBindings; request: Request; shop: StorefrontShop }): Promise<string> {
  const hostname = new URL(input.request.url).hostname.toLowerCase().replace(/\.$/u, "");
  if (input.shop.currentHostname.toLowerCase().replace(/\.$/u, "") !== hostname) {
    throw new AppError("turnstile_invalid", 403);
  }
  if (input.env.APP_ENV !== "production") return hostname;

  let admitted: { hostname: string } | null;
  try {
    admitted = await input.env.PLATFORM_DB.prepare(`
      SELECT hostname_normalized AS hostname
      FROM shop_domains
      WHERE shop_id = ? AND hostname_normalized = ? AND status = 'active'
        AND delete_requested_at IS NULL AND deleted_at IS NULL
        AND (
          type = 'platform_subdomain'
          OR (
            type = 'custom' AND ownership_verified_at IS NOT NULL
            AND hostname_status = 'active' AND ssl_status = 'active' AND dns_status = 'active'
            AND ${customDomainTurnstileAdmissionSql()}
          )
        )
      LIMIT 1
    `).bind(input.shop.id, hostname).first<{ hostname: string }>();
  } catch {
    throw new AppError("turnstile_unavailable", 503);
  }
  if (admitted?.hostname !== hostname) throw new AppError("turnstile_invalid", 403);
  return hostname;
}

async function verifyTurnstile(input: { configuration: TurnstileConfiguration; env: AppBindings; request: Request; shop: StorefrontShop; token: string }): Promise<void> {
  const hostname = await assertTurnstileHostnameAdmission(input);
  const body = new FormData();
  body.set("secret", input.configuration.secretKey);
  body.set("response", input.token);
  body.set("remoteip", clientAddress(input.request));
  body.set("idempotency_key", crypto.randomUUID());
  let response: Response;
  try {
    response = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
      body,
      method: "POST",
      signal: AbortSignal.timeout(5_000),
    });
  } catch {
    throw new AppError("turnstile_unavailable", 503);
  }
  let result: TurnstileEnvelope;
  try {
    result = await response.json();
  } catch {
    throw new AppError("turnstile_unavailable", 503);
  }
  if (!response.ok || result.success !== true || result.action !== "storefront_checkout" || result.hostname?.toLowerCase() !== hostname) {
    throw new AppError("turnstile_invalid", 403);
  }
}

export async function guardAnonymousCart(input: { env: AppBindings; request: Request; shop: StorefrontShop }): Promise<void> {
  const windowSeconds = positiveInteger(input.env.STOREFRONT_RATE_LIMIT_WINDOW_SECONDS, 600);
  const requestCount = await incrementLimit({ action: "cart", shopId: input.shop.id, ...input, windowSeconds });
  if (requestCount > positiveInteger(input.env.STOREFRONT_CART_RATE_LIMIT, 30)) throw new AppError("rate_limited", 429);
}

export async function guardAnonymousCheckout(input: { env: AppBindings; request: Request; shop: StorefrontShop; turnstileToken: unknown }): Promise<void> {
  const windowSeconds = positiveInteger(input.env.STOREFRONT_RATE_LIMIT_WINDOW_SECONDS, 600);
  const requestCount = await incrementLimit({ action: "checkout", shopId: input.shop.id, ...input, windowSeconds });
  if (requestCount > positiveInteger(input.env.STOREFRONT_CHECKOUT_RATE_LIMIT, 8)) throw new AppError("rate_limited", 429);
  const threshold = positiveInteger(input.env.STOREFRONT_TURNSTILE_THRESHOLD, 3);
  if (requestCount <= threshold) return;
  const configuration = resolveTurnstileConfiguration(input.env);
  if (configuration === null) {
    if (input.env.APP_ENV === "production") throw new AppError("turnstile_unavailable", 503);
    return;
  }
  if (typeof input.turnstileToken !== "string" || input.turnstileToken.length < 10 || input.turnstileToken.length > 2_048) throw new AppError("turnstile_required", 403);
  await verifyTurnstile({ ...input, configuration, token: input.turnstileToken });
}

export async function purgeAnonymousLimits(env: AppBindings, now = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - 24 * 60 * 60_000).toISOString();
  const result = await env.PLATFORM_DB.prepare("DELETE FROM anonymous_request_limits WHERE window_started_at < ?").bind(cutoff).run();
  return result.meta.changes;
}
