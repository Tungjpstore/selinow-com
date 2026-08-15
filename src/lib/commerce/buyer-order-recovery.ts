import { constantTimeEqual, hmacToken } from "../core/crypto";
import { AppError, isAppError } from "../core/errors";
import { createId, toBase64Url } from "../core/ids";
import { createStorefrontTranslator } from "../i18n/catalogs/storefront";
import { loggerFor } from "../operations/logger";
import type { AppBindings } from "../platform/bindings";
import type { StorefrontShop } from "../storefront/store";
import { normalizeCustomerEmail } from "./policy";

const ORDER_PUBLIC_ID = /^order_[0-9a-f-]{36}$/u;
const RECOVERY_ID = /^orc_[0-9a-f-]{36}$/u;
const RECOVERY_TTL_MS = 15 * 60_000;
const RECOVERY_ARTIFACT_RETENTION_MS = 30 * 24 * 60 * 60_000;
const MAX_FUTURE_SKEW_MS = 60_000;
const RECOVERY_RATE_WINDOW_SECONDS = 60 * 60;
const RECOVERY_GLOBAL_REQUESTER_RATE_LIMIT = 20;
const RECOVERY_SHOP_REQUESTER_RATE_LIMIT = 5;
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

type RecoveryClaims = {
  expiresAt: string;
  issuedAt: string;
  orderPublicId: string;
  recoveryId: string;
  shopId: string;
  version: 1;
};

type RecoverableOrder = {
  customerId: string;
  email: string;
  locale: string;
  orderId: string;
  orderPublicId: string;
};

type RecoveryRow = {
  consumedAt: string | null;
  currentOrderTokenHash: string;
  customerId: string;
  email: string;
  expiresAt: string;
  issuedAt: string;
  orderId: string;
  orderPublicId: string;
  recipientHash: string;
  revokedAt: string | null;
  tokenHash: string;
};

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function fromBase64Url(value: string): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) throw new AppError("order_recovery_invalid", 410);
  const padded = value.replaceAll("-", "+").replaceAll("_", "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  try {
    return new Uint8Array(Uint8Array.from(atob(padded), (character) => character.charCodeAt(0)));
  } catch {
    throw new AppError("order_recovery_invalid", 410);
  }
}

function parseClaims(encoded: string): RecoveryClaims {
  let parsed: unknown;
  try {
    parsed = JSON.parse(decoder.decode(fromBase64Url(encoded))) as unknown;
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError("order_recovery_invalid", 410);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new AppError("order_recovery_invalid", 410);
  const claims = parsed as Partial<RecoveryClaims>;
  if (
    claims.version !== 1
    || typeof claims.expiresAt !== "string"
    || typeof claims.issuedAt !== "string"
    || typeof claims.orderPublicId !== "string"
    || !ORDER_PUBLIC_ID.test(claims.orderPublicId)
    || typeof claims.recoveryId !== "string"
    || !RECOVERY_ID.test(claims.recoveryId)
    || typeof claims.shopId !== "string"
    || claims.shopId.length < 3
    || claims.shopId.length > 128
  ) throw new AppError("order_recovery_invalid", 410);
  return claims as RecoveryClaims;
}

async function signRecoveryClaims(input: Omit<RecoveryClaims, "version"> & { secret: string }): Promise<string> {
  const claims: RecoveryClaims = {
    expiresAt: input.expiresAt,
    issuedAt: input.issuedAt,
    orderPublicId: input.orderPublicId,
    recoveryId: input.recoveryId,
    shopId: input.shopId,
    version: 1,
  };
  const encoded = toBase64Url(encoder.encode(JSON.stringify(claims)));
  const signature = await hmacToken(input.secret, "buyer-order-recovery-link:v1", encoded);
  return `${encoded}.${signature}`;
}

async function verifyRecoveryToken(input: {
  now: Date;
  orderPublicId: string;
  secret: string;
  shopId: string;
  token: string;
}): Promise<RecoveryClaims> {
  if (input.token.length < 80 || input.token.length > 2_048) throw new AppError("order_recovery_invalid", 410);
  const parts = input.token.split(".");
  if (parts.length !== 2) throw new AppError("order_recovery_invalid", 410);
  const [encoded, suppliedSignature] = parts;
  if (encoded === undefined || suppliedSignature === undefined) throw new AppError("order_recovery_invalid", 410);
  const expectedSignature = await hmacToken(input.secret, "buyer-order-recovery-link:v1", encoded);
  if (!constantTimeEqual(suppliedSignature, expectedSignature)) throw new AppError("order_recovery_invalid", 410);
  const claims = parseClaims(encoded);
  const issuedAt = Date.parse(claims.issuedAt);
  const expiresAt = Date.parse(claims.expiresAt);
  const nowMs = input.now.getTime();
  if (!Number.isFinite(issuedAt) || !Number.isFinite(expiresAt) || issuedAt >= expiresAt
    || expiresAt - issuedAt > RECOVERY_TTL_MS || issuedAt > nowMs + MAX_FUTURE_SKEW_MS) {
    throw new AppError("order_recovery_invalid", 410);
  }
  if (expiresAt <= nowMs) throw new AppError("order_recovery_expired", 410);
  if (claims.shopId !== input.shopId || claims.orderPublicId !== input.orderPublicId) {
    throw new AppError("order_recovery_invalid", 410);
  }
  return claims;
}

async function recipientHash(env: AppBindings, shopId: string, email: string): Promise<string> {
  return hmacToken(env.IDENTIFIER_HMAC_SECRET, `buyer-order-recovery-recipient:v1:${shopId}`, email);
}

async function tokenHash(env: AppBindings, token: string): Promise<string> {
  return hmacToken(env.IDENTIFIER_HMAC_SECRET, "buyer-order-recovery-token:v1", token);
}

function normalizedRequesterAddress(value: string): string {
  const normalized = value.trim();
  return normalized.length > 0 && normalized.length <= 128 ? normalized : "unknown";
}

async function incrementRecoveryRateLimit(input: {
  action: string;
  env: AppBindings;
  limit: number;
  now: Date;
  scopeKey: string;
  shopId: string | null;
  subjectHash: string;
}): Promise<void> {
  const windowStartMs = Math.floor(input.now.getTime() / (RECOVERY_RATE_WINDOW_SECONDS * 1_000))
    * RECOVERY_RATE_WINDOW_SECONDS * 1_000;
  const windowStartedAt = new Date(windowStartMs).toISOString();
  const windowEndsAt = new Date(windowStartMs + RECOVERY_RATE_WINDOW_SECONDS * 1_000).toISOString();
  const row = await input.env.PLATFORM_DB.prepare(`
    INSERT INTO security_rate_limits (
      id, shop_id, scope_key, action, subject_hash, window_started_at,
      window_ends_at, request_count, blocked_count, blocked_until,
      last_safe_reason_code, version, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, 0, NULL, NULL, 1, ?, ?)
    ON CONFLICT(scope_key, action, subject_hash, window_started_at)
    DO UPDATE SET
      request_count = security_rate_limits.request_count + 1,
      blocked_count = security_rate_limits.blocked_count + CASE
        WHEN security_rate_limits.request_count + 1 > ? THEN 1 ELSE 0 END,
      blocked_until = CASE
        WHEN security_rate_limits.request_count + 1 > ? THEN excluded.window_ends_at
        ELSE security_rate_limits.blocked_until END,
      last_safe_reason_code = CASE
        WHEN security_rate_limits.request_count + 1 > ? THEN 'buyer_order_recovery_rate_limited'
        ELSE security_rate_limits.last_safe_reason_code END,
      version = security_rate_limits.version + 1,
      updated_at = excluded.updated_at
    RETURNING request_count AS requestCount
  `).bind(
    createId("lim"),
    input.shopId,
    input.scopeKey,
    input.action,
    input.subjectHash,
    windowStartedAt,
    windowEndsAt,
    input.now.toISOString(),
    input.now.toISOString(),
    input.limit,
    input.limit,
    input.limit,
  ).first<{ requestCount: number }>();
  if (row === null) throw new AppError("order_recovery_admission_failed", 500);
  if (row.requestCount > input.limit) throw new AppError("rate_limited", 429);
}

async function guardRecoveryRequesterRate(input: {
  env: AppBindings;
  now: Date;
  requesterAddress: string;
  shopId: string;
}): Promise<void> {
  const requesterAddress = normalizedRequesterAddress(input.requesterAddress);
  const globalSubjectHash = await hmacToken(
    input.env.IDENTIFIER_HMAC_SECRET,
    "buyer-order-recovery-rate-global:v1",
    requesterAddress,
  );
  await incrementRecoveryRateLimit({
    action: "buyer_order_recovery_request_global",
    env: input.env,
    limit: RECOVERY_GLOBAL_REQUESTER_RATE_LIMIT,
    now: input.now,
    scopeKey: "platform",
    shopId: null,
    subjectHash: globalSubjectHash,
  });
  const shopSubjectHash = await hmacToken(
    input.env.IDENTIFIER_HMAC_SECRET,
    `buyer-order-recovery-rate-shop:v1:${input.shopId}`,
    requesterAddress,
  );
  await incrementRecoveryRateLimit({
    action: "buyer_order_recovery_request",
    env: input.env,
    limit: RECOVERY_SHOP_REQUESTER_RATE_LIMIT,
    now: input.now,
    scopeKey: `shop:${input.shopId}`,
    shopId: input.shopId,
    subjectHash: shopSubjectHash,
  });
}

function recoveryOrigin(origin: string, shop: StorefrontShop): string {
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    throw new AppError("order_recovery_origin_invalid", 403);
  }
  const localHttp = parsed.protocol === "http:" && (parsed.hostname === "localhost" || parsed.hostname.endsWith(".localhost"));
  if ((!localHttp && parsed.protocol !== "https:") || parsed.hostname.toLowerCase() !== shop.currentHostname.toLowerCase()) {
    throw new AppError("order_recovery_origin_invalid", 403);
  }
  return parsed.origin;
}

async function sendRecoveryEmail(input: {
  email: string;
  env: AppBindings;
  link: string;
  locale: string;
}): Promise<void> {
  const t = createStorefrontTranslator(input.locale);
  await input.env.EMAIL.send({
    from: { email: input.env.EMAIL_FROM_ADDRESS, name: input.env.EMAIL_FROM_NAME },
    html: [
      `<p>${escapeHtml(t("storefront.order.recovery.email_intro"))}</p>`,
      `<p><a href="${escapeHtml(input.link)}">${escapeHtml(t("storefront.order.recovery.email_action"))}</a></p>`,
      `<p>${escapeHtml(t("storefront.order.recovery.email_expiry"))}</p>`,
      `<p>${escapeHtml(t("storefront.order.recovery.email_ignore"))}</p>`,
    ].join(""),
    subject: t("storefront.order.recovery.email_subject"),
    text: [
      t("storefront.order.recovery.email_intro"),
      "",
      input.link,
      "",
      t("storefront.order.recovery.email_expiry"),
      t("storefront.order.recovery.email_ignore"),
    ].join("\n"),
    to: input.email,
  });
}

type BuyerOrderRecoveryRequestInput = {
  defer?: (operation: Promise<void>) => void;
  email: unknown;
  env: AppBindings;
  now?: Date;
  orderPublicId: string;
  origin: string;
  requesterAddress: string;
  requestId: string;
  shop: StorefrontShop;
};

async function issueBuyerOrderRecovery(input: BuyerOrderRecoveryRequestInput & { now: Date }): Promise<void> {
  const nowIso = input.now.toISOString();
  const origin = recoveryOrigin(input.origin, input.shop);
  let email: string | null;
  try {
    email = normalizeCustomerEmail(input.email);
  } catch (error) {
    if (isAppError(error) && error.code === "validation_failed") return;
    throw error;
  }
  if (email === null) return;
  const recipient = await recipientHash(input.env, input.shop.id, email);
  if (!ORDER_PUBLIC_ID.test(input.orderPublicId)) return;
  const order = await input.env.PLATFORM_DB.prepare(`
    SELECT orders.id AS orderId, orders.public_id AS orderPublicId,
      orders.locale, customers.id AS customerId,
      customers.email_normalized AS email
    FROM orders
    INNER JOIN shop_customers AS customers
      ON customers.id = orders.customer_id
      AND customers.shop_id = orders.shop_id
    WHERE orders.shop_id = ?
      AND orders.public_id = ?
      AND orders.source_channel = 'web'
      AND customers.email_normalized = ?
      AND customers.anonymized_at IS NULL
    LIMIT 1
  `).bind(input.shop.id, input.orderPublicId, email).first<RecoverableOrder>();
  if (order === null) return;

  const recoveryId = createId("orc");
  const expiresAt = new Date(input.now.getTime() + RECOVERY_TTL_MS).toISOString();
  const retentionExpiresAt = new Date(input.now.getTime() + RECOVERY_ARTIFACT_RETENTION_MS).toISOString();
  const token = await signRecoveryClaims({
    expiresAt,
    issuedAt: nowIso,
    orderPublicId: order.orderPublicId,
    recoveryId,
    secret: input.env.IDENTIFIER_HMAC_SECRET,
    shopId: input.shop.id,
  });
  const hashedToken = await tokenHash(input.env, token);
  const results = await input.env.PLATFORM_DB.batch([
    input.env.PLATFORM_DB.prepare(`
      UPDATE order_access_recovery_tokens
      SET revoked_at = ?
      WHERE shop_id = ? AND order_id = ?
        AND consumed_at IS NULL AND revoked_at IS NULL AND expires_at <= ?
    `).bind(nowIso, input.shop.id, order.orderId, nowIso),
    input.env.PLATFORM_DB.prepare(`
      INSERT OR IGNORE INTO order_access_recovery_tokens (
        id, shop_id, order_id, customer_id, token_hash, recipient_hash,
        issued_request_id, issued_at, expires_at, retention_expires_at, created_at
      )
      SELECT ?, orders.shop_id, orders.id, customers.id, ?, ?, ?, ?, ?, ?, ?
      FROM orders
      INNER JOIN shop_customers AS customers
        ON customers.id = orders.customer_id
        AND customers.shop_id = orders.shop_id
      WHERE orders.id = ? AND orders.shop_id = ? AND orders.public_id = ?
        AND orders.source_channel = 'web'
        AND customers.id = ? AND customers.email_normalized = ?
        AND customers.anonymized_at IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM order_access_recovery_tokens AS active
          WHERE active.shop_id = orders.shop_id AND active.order_id = orders.id
            AND active.consumed_at IS NULL AND active.revoked_at IS NULL
        )
    `).bind(
      recoveryId,
      hashedToken,
      recipient,
      input.requestId,
      nowIso,
      expiresAt,
      retentionExpiresAt,
      nowIso,
      order.orderId,
      input.shop.id,
      order.orderPublicId,
      order.customerId,
      email,
    ),
  ]);
  if ((results[1]?.meta.changes ?? 0) !== 1) return;

  const link = new URL(`/orders/${encodeURIComponent(order.orderPublicId)}`, origin);
  link.hash = `recovery=${encodeURIComponent(token)}`;
  try {
    await sendRecoveryEmail({ email, env: input.env, link: link.toString(), locale: order.locale });
  } catch {
    await input.env.PLATFORM_DB.prepare(`
      UPDATE order_access_recovery_tokens
      SET revoked_at = ?
      WHERE id = ? AND shop_id = ? AND order_id = ?
        AND consumed_at IS NULL AND revoked_at IS NULL
    `).bind(nowIso, recoveryId, input.shop.id, order.orderId).run();
    loggerFor(input.env).warn({
      errorCode: "buyer_order_recovery_email_failed",
      event: "commerce.buyer_order_recovery_failed",
      requestId: input.requestId,
      source: "http",
    });
  }
}

export async function requestBuyerOrderRecovery(input: BuyerOrderRecoveryRequestInput): Promise<void> {
  const now = input.now ?? new Date();
  await guardRecoveryRequesterRate({
    env: input.env,
    now,
    requesterAddress: input.requesterAddress,
    shopId: input.shop.id,
  });
  const operation = issueBuyerOrderRecovery({ ...input, now });
  if (input.defer !== undefined) {
    input.defer(operation.catch((error: unknown) => {
      loggerFor(input.env).warn({
        errorCode: isAppError(error) ? error.code : "buyer_order_recovery_internal_error",
        event: "commerce.buyer_order_recovery_failed",
        requestId: input.requestId,
        source: "http",
      });
    }));
    return;
  }
  await operation;
}

export async function consumeBuyerOrderRecovery(input: {
  env: AppBindings;
  now?: Date;
  orderPublicId: string;
  requestId: string;
  shop: StorefrontShop;
  token: unknown;
}): Promise<{ orderId: string; orderToken: string }> {
  if (!ORDER_PUBLIC_ID.test(input.orderPublicId) || typeof input.token !== "string") {
    throw new AppError("order_recovery_invalid", 410);
  }
  const now = input.now ?? new Date();
  const claims = await verifyRecoveryToken({
    now,
    orderPublicId: input.orderPublicId,
    secret: input.env.IDENTIFIER_HMAC_SECRET,
    shopId: input.shop.id,
    token: input.token,
  });
  const hashedToken = await tokenHash(input.env, input.token);
  const row = await input.env.PLATFORM_DB.prepare(`
    SELECT recovery.token_hash AS tokenHash,
      recovery.recipient_hash AS recipientHash,
      recovery.issued_at AS issuedAt, recovery.expires_at AS expiresAt,
      recovery.consumed_at AS consumedAt, recovery.revoked_at AS revokedAt,
      orders.id AS orderId, orders.public_id AS orderPublicId,
      orders.order_token_hash AS currentOrderTokenHash,
      recovery.customer_id AS customerId,
      customers.email_normalized AS email
    FROM order_access_recovery_tokens AS recovery
    INNER JOIN orders
      ON orders.id = recovery.order_id AND orders.shop_id = recovery.shop_id
    INNER JOIN shop_customers AS customers
      ON customers.id = recovery.customer_id
      AND customers.id = orders.customer_id
      AND customers.shop_id = recovery.shop_id
    WHERE recovery.id = ? AND recovery.shop_id = ?
      AND orders.public_id = ? AND orders.source_channel = 'web'
      AND customers.email_normalized IS NOT NULL
      AND customers.anonymized_at IS NULL
    LIMIT 1
  `).bind(claims.recoveryId, input.shop.id, input.orderPublicId).first<RecoveryRow>();
  if (row === null || row.consumedAt !== null || row.revokedAt !== null
    || row.issuedAt !== claims.issuedAt || row.expiresAt !== claims.expiresAt
    || !constantTimeEqual(row.tokenHash, hashedToken)) {
    throw new AppError("order_recovery_invalid", 410);
  }
  const expectedRecipient = await recipientHash(input.env, input.shop.id, row.email);
  if (!constantTimeEqual(row.recipientHash, expectedRecipient)) throw new AppError("order_recovery_invalid", 410);

  const nowIso = now.toISOString();
  const orderToken = await deriveBuyerOrderRecoveryAccessToken(input.env, input.shop.id, claims.recoveryId);
  const orderTokenHash = await hmacToken(input.env.IDENTIFIER_HMAC_SECRET, "order-access", orderToken);
  const result = await input.env.PLATFORM_DB.prepare(`
    UPDATE order_access_recovery_tokens
    SET consumed_at = ?, consumed_request_id = ?, previous_order_token_hash = ?,
      replacement_order_token_hash = ?
    WHERE id = ? AND shop_id = ? AND order_id = ? AND customer_id = ?
      AND token_hash = ? AND recipient_hash = ?
      AND issued_at = ? AND expires_at = ?
      AND consumed_at IS NULL AND revoked_at IS NULL AND expires_at > ?
      AND EXISTS (
        SELECT 1 FROM orders
        INNER JOIN shop_customers
          ON shop_customers.id = orders.customer_id
          AND shop_customers.shop_id = orders.shop_id
        WHERE orders.id = order_access_recovery_tokens.order_id
          AND orders.shop_id = order_access_recovery_tokens.shop_id
          AND orders.public_id = ?
          AND orders.customer_id = order_access_recovery_tokens.customer_id
          AND orders.source_channel = 'web'
          AND shop_customers.email_normalized = ?
          AND shop_customers.anonymized_at IS NULL
      )
  `).bind(
    nowIso,
    input.requestId,
    row.currentOrderTokenHash,
    orderTokenHash,
    claims.recoveryId,
    input.shop.id,
    row.orderId,
    row.customerId,
    hashedToken,
    row.recipientHash,
    claims.issuedAt,
    claims.expiresAt,
    nowIso,
    row.orderPublicId,
    row.email,
  ).run();
  if (result.meta.changes !== 1) {
    throw new AppError("order_recovery_invalid", 410);
  }
  return { orderId: row.orderPublicId, orderToken };
}

async function deriveBuyerOrderRecoveryAccessToken(env: AppBindings, shopId: string, recoveryId: string): Promise<string> {
  return hmacToken(env.IDENTIFIER_HMAC_SECRET, `buyer-order-recovery-access-token:v1:${shopId}`, recoveryId);
}

export async function resolveCurrentBuyerOrderRecoveryToken(input: {
  currentOrderTokenHash: string;
  env: AppBindings;
  orderId: string;
  shopId: string;
}): Promise<string | null> {
  const row = await input.env.PLATFORM_DB.prepare(`
    SELECT id
    FROM order_access_recovery_tokens
    WHERE shop_id = ? AND order_id = ?
      AND consumed_at IS NOT NULL AND revoked_at IS NULL
      AND replacement_order_token_hash = ?
    ORDER BY consumed_at DESC, id DESC
    LIMIT 1
  `).bind(input.shopId, input.orderId, input.currentOrderTokenHash).first<{ id: string }>();
  if (row === null) return null;
  const token = await deriveBuyerOrderRecoveryAccessToken(input.env, input.shopId, row.id);
  const tokenHash = await hmacToken(input.env.IDENTIFIER_HMAC_SECRET, "order-access", token);
  return constantTimeEqual(tokenHash, input.currentOrderTokenHash) ? token : null;
}

export async function isBuyerOrderRecoveryBinding(input: {
  candidateBindingHash: string;
  currentOrderTokenHash: string;
  env: AppBindings;
  orderId: string;
  shopId: string;
}): Promise<boolean> {
  if (constantTimeEqual(input.candidateBindingHash, input.currentOrderTokenHash)) return true;
  const row = await input.env.PLATFORM_DB.prepare(`
    SELECT 1 AS matched
    WHERE EXISTS (
      SELECT 1 FROM order_access_recovery_tokens AS current_recovery
      WHERE current_recovery.shop_id = ? AND current_recovery.order_id = ?
        AND current_recovery.consumed_at IS NOT NULL
        AND current_recovery.revoked_at IS NULL
        AND current_recovery.replacement_order_token_hash = ?
    )
      AND EXISTS (
        SELECT 1 FROM order_access_recovery_tokens AS historical_recovery
        WHERE historical_recovery.shop_id = ? AND historical_recovery.order_id = ?
          AND historical_recovery.consumed_at IS NOT NULL
          AND historical_recovery.revoked_at IS NULL
          AND (
            historical_recovery.previous_order_token_hash = ?
            OR historical_recovery.replacement_order_token_hash = ?
          )
      )
    LIMIT 1
  `).bind(
    input.shopId,
    input.orderId,
    input.currentOrderTokenHash,
    input.shopId,
    input.orderId,
    input.candidateBindingHash,
    input.candidateBindingHash,
  ).first<{ matched: number }>();
  return row !== null;
}

export async function purgeBuyerOrderRecoveryArtifacts(input: {
  env: AppBindings;
  limit?: number;
  now?: Date;
}): Promise<{ deleted: number; redacted: number }> {
  const nowIso = (input.now ?? new Date()).toISOString();
  const limit = Math.max(1, Math.min(500, input.limit ?? 100));
  const deleted = await input.env.PLATFORM_DB.prepare(`
    DELETE FROM order_access_recovery_tokens
    WHERE id IN (
      SELECT id FROM order_access_recovery_tokens
      WHERE retention_expires_at <= ?
        AND consumed_at IS NULL
        AND (revoked_at IS NOT NULL OR expires_at <= ?)
      ORDER BY retention_expires_at, id
      LIMIT ?
    )
  `).bind(nowIso, nowIso, limit).run();
  const redacted = await input.env.PLATFORM_DB.prepare(`
    UPDATE order_access_recovery_tokens
    SET token_hash = lower(hex(randomblob(32))),
      recipient_hash = lower(hex(randomblob(32))),
      issued_request_id = 'redacted:' || id,
      redacted_at = ?
    WHERE id IN (
      SELECT id FROM order_access_recovery_tokens
      WHERE retention_expires_at <= ?
        AND consumed_at IS NOT NULL
        AND redacted_at IS NULL
      ORDER BY retention_expires_at, id
      LIMIT ?
    )
  `).bind(nowIso, nowIso, limit).run();
  return { deleted: deleted.meta.changes, redacted: redacted.meta.changes };
}
