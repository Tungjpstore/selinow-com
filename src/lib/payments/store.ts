import { AppError } from "../core/errors";
import { constantTimeEqual, hmacToken, sha256Json } from "../core/crypto";
import { createId, createOpaqueToken } from "../core/ids";
import { resolveOrderChannelAttribution } from "../channels/attribution";
import { TELEGRAM_CHANNEL_CODE, WEBSITE_CHANNEL_CODE } from "../channels/builtins";
import type { AppBindings } from "../platform/bindings";
import { loadCredentialById } from "./credentials";
import { maskAccountNumber, sanitizeAccountName } from "./policy";
import { PayOSClient, type PaymentLinkResponse, type PaymentLinkStatusResponse } from "./payos";

type PaymentOrder = {
  currency: string;
  expiresAt: string;
  fulfillmentStatus: string;
  id: string;
  orderPublicId: string;
  orderTokenHash: string;
  paymentStatus: string;
  shopId: string;
  status: string;
  totalMinor: number;
};

type ActiveIntegration = { activeCredentialId: string; id: string; publicId: string };
type AttemptRow = {
  cancelOrigin: string | null;
  checkoutDomainId: string | null;
  checkoutUrl: string | null;
  credentialId: string;
  currency: string;
  expectedAmountMinor: number;
  expiresAt: string;
  expectedDescription: string;
  id: string;
  paymentLinkId: string | null;
  providerOrderCode: number;
  qrCode: string | null;
  leaseExpiresAt: string | null;
  leaseToken: string | null;
  nextReconcileAt: string | null;
  reconcileAttempts: number;
  returnOrigin: string | null;
  shopId: string;
  state: string;
};
type PaymentOrigin = { cancelOrigin: string; checkoutDomainId: string; returnOrigin: string };
type PaymentRequestOrigin = { hostname: string; portSuffix: string; protocolPrefix: string };
type ProviderPaymentBinding = { amount: number; currency: string; description: string; orderCode: number; paymentLinkId: string };

export type PaymentLinkView = { checkoutUrl: string; expiresAt: string; paymentAttemptId: string; qrCode: string; state: string };

const PAYOS_PAYMENT_LINK_ID_PATTERN = /^[A-Za-z0-9_-]{1,160}$/u;
const TELEGRAM_ORDER_ATTRIBUTION = resolveOrderChannelAttribution(TELEGRAM_CHANNEL_CODE);
const WEBSITE_ORDER_ATTRIBUTION = resolveOrderChannelAttribution(WEBSITE_CHANNEL_CODE);

function payOSCheckoutUrl(paymentLinkId: string): string {
  if (!PAYOS_PAYMENT_LINK_ID_PATTERN.test(paymentLinkId)) throw new AppError("provider_identity_mismatch", 409);
  return `https://pay.payos.vn/web/${paymentLinkId}`;
}

function assertProviderPaymentBinding(attempt: AttemptRow, binding: ProviderPaymentBinding): void {
  if (
    binding.orderCode !== attempt.providerOrderCode
    || binding.amount !== attempt.expectedAmountMinor
    || binding.currency !== attempt.currency
    || binding.description !== expectedDescriptionFor(attempt)
  ) throw new AppError("provider_identity_mismatch", 409);
  payOSCheckoutUrl(binding.paymentLinkId);
}

function isProviderIdentityMismatch(error: unknown): boolean {
  return error instanceof AppError && error.code === "provider_identity_mismatch";
}

async function authorizeOrder(input: { env: AppBindings; orderPublicId: string; orderToken: string; shopId: string }): Promise<PaymentOrder> {
  const row = await input.env.PLATFORM_DB.prepare(`
    SELECT orders.id, orders.public_id AS orderPublicId,
      orders.shop_id AS shopId, orders.status,
      orders.payment_status AS paymentStatus,
      orders.fulfillment_status AS fulfillmentStatus,
      orders.total_minor AS totalMinor, orders.currency,
      orders.order_token_hash AS orderTokenHash,
      orders.expires_at AS expiresAt
    FROM orders
    LEFT JOIN order_channel_attributions AS attribution
      ON attribution.shop_id = orders.shop_id AND attribution.order_id = orders.id
    WHERE orders.public_id = ? AND orders.shop_id = ?
      AND orders.source_channel = ?
      AND (
        attribution.order_id IS NULL
        OR (
          attribution.channel_code = ?
          AND attribution.adapter_version = ?
          AND attribution.connection_id IS NULL
        )
      )
    LIMIT 1
  `).bind(
    input.orderPublicId,
    input.shopId,
    WEBSITE_ORDER_ATTRIBUTION.legacySourceChannel,
    WEBSITE_ORDER_ATTRIBUTION.channelCode,
    WEBSITE_ORDER_ATTRIBUTION.adapterVersion,
  ).first<PaymentOrder>();
  if (row === null) throw new AppError("order_not_found", 404);
  const hash = await hmacToken(input.env.IDENTIFIER_HMAC_SECRET, "order-access", input.orderToken);
  if (!constantTimeEqual(row.orderTokenHash, hash)) throw new AppError("order_not_found", 404);
  return row;
}

async function authorizePrincipalOrder(input: { connectionId?: string | null; customerId: string; env: AppBindings; orderPublicId: string; shopId: string; sourceChannel?: "telegram" }): Promise<PaymentOrder> {
  const row = input.sourceChannel === "telegram"
    ? await input.env.PLATFORM_DB.prepare(`
        SELECT id, public_id AS orderPublicId, shop_id AS shopId, status,
          payment_status AS paymentStatus, fulfillment_status AS fulfillmentStatus,
          total_minor AS totalMinor, currency, order_token_hash AS orderTokenHash,
          expires_at AS expiresAt
        FROM orders
        WHERE public_id = ? AND shop_id = ? AND customer_id = ?
          AND source_channel = 'telegram'
          AND (
            NOT EXISTS (
              SELECT 1 FROM order_channel_attributions AS legacy_attribution
              WHERE legacy_attribution.shop_id = orders.shop_id
                AND legacy_attribution.order_id = orders.id
            )
            OR EXISTS (
              SELECT 1 FROM order_channel_attributions AS attribution
              WHERE attribution.shop_id = orders.shop_id
                AND attribution.order_id = orders.id
                AND attribution.channel_code = ?
                AND attribution.adapter_version = ?
                AND attribution.connection_id IS ?
            )
          )
        LIMIT 1
      `).bind(
        input.orderPublicId,
        input.shopId,
        input.customerId,
        TELEGRAM_ORDER_ATTRIBUTION.channelCode,
        TELEGRAM_ORDER_ATTRIBUTION.adapterVersion,
        input.connectionId ?? null,
      ).first<PaymentOrder>()
    : await input.env.PLATFORM_DB.prepare(`SELECT id, public_id AS orderPublicId, shop_id AS shopId, status, payment_status AS paymentStatus, fulfillment_status AS fulfillmentStatus, total_minor AS totalMinor, currency, order_token_hash AS orderTokenHash, expires_at AS expiresAt FROM orders WHERE public_id = ? AND shop_id = ? AND customer_id = ? LIMIT 1`).bind(input.orderPublicId, input.shopId, input.customerId).first<PaymentOrder>();
  if (row === null) throw new AppError("order_not_found", 404);
  return row;
}

async function getActiveIntegration(env: AppBindings, shopId: string): Promise<ActiveIntegration> {
  const row = await env.PLATFORM_DB.prepare(`SELECT id, public_id AS publicId, active_credential_id AS activeCredentialId FROM payment_integrations WHERE shop_id = ? AND provider = 'payos' AND status = 'active' AND webhook_status = 'verified' AND active_credential_id IS NOT NULL LIMIT 1`).bind(shopId).first<ActiveIntegration>();
  if (row === null) throw new AppError("payment_not_configured", 409);
  return row;
}

function mapAttempt(row: AttemptRow): PaymentLinkView {
  if (row.checkoutUrl === null || row.paymentLinkId === null) throw new AppError("payment_pending", 409);
  if (row.checkoutUrl !== payOSCheckoutUrl(row.paymentLinkId)) throw new AppError("provider_identity_mismatch", 409);
  return { checkoutUrl: row.checkoutUrl, expiresAt: row.expiresAt, paymentAttemptId: row.id, qrCode: row.qrCode ?? "", state: row.state };
}

function allocateOrderCode(): number {
  const random = crypto.getRandomValues(new Uint32Array(1))[0] ?? 0;
  return Date.now() * 1_000 + random % 1_000;
}

function descriptionFor(orderCode: number): string {
  return `SEL${String(orderCode).slice(-6)}`;
}

function expectedDescriptionFor(attempt: AttemptRow): string {
  return attempt.expectedDescription;
}

function parsePaymentRequestOrigin(env: AppBindings, origin: string): PaymentRequestOrigin {
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    throw new AppError("payment_origin_invalid", 409);
  }
  const protocolAllowed = parsed.protocol === "https:" || (env.APP_ENV === "local" && parsed.protocol === "http:");
  if (parsed.origin !== origin || !protocolAllowed) {
    throw new AppError("payment_origin_invalid", 409);
  }
  return {
    hostname: parsed.hostname.toLowerCase(),
    portSuffix: env.APP_ENV === "local" && parsed.port.length > 0 ? `:${parsed.port}` : "",
    protocolPrefix: env.APP_ENV === "local" ? `${parsed.protocol}//` : "https://",
  };
}

const ATTEMPT_SELECT = `
  SELECT id, shop_id AS shopId, credential_id AS credentialId,
    provider_order_code AS providerOrderCode,
    provider_payment_link_id AS paymentLinkId, state,
    checkout_url AS checkoutUrl, qr_code AS qrCode, expires_at AS expiresAt,
    expected_amount_minor AS expectedAmountMinor, currency,
    expected_description AS expectedDescription,
    checkout_domain_id AS checkoutDomainId, return_origin AS returnOrigin,
    cancel_origin AS cancelOrigin, next_reconcile_at AS nextReconcileAt,
    reconcile_attempts AS reconcileAttempts, lease_token AS leaseToken,
    lease_expires_at AS leaseExpiresAt
  FROM payment_attempts
  WHERE shop_id = ? AND order_id = ? AND provider = 'payos'
  LIMIT 1
`;

async function loadAttempt(env: AppBindings, shopId: string, orderId: string): Promise<AttemptRow | null> {
  return env.PLATFORM_DB.prepare(ATTEMPT_SELECT).bind(shopId, orderId).first<AttemptRow>();
}

async function loadAttemptById(env: AppBindings, attemptId: string, shopId: string): Promise<AttemptRow | null> {
  return env.PLATFORM_DB.prepare(`
    SELECT id, shop_id AS shopId, credential_id AS credentialId,
      provider_order_code AS providerOrderCode,
      provider_payment_link_id AS paymentLinkId, state,
      checkout_url AS checkoutUrl, qr_code AS qrCode, expires_at AS expiresAt,
      expected_amount_minor AS expectedAmountMinor, currency,
      expected_description AS expectedDescription,
      checkout_domain_id AS checkoutDomainId, return_origin AS returnOrigin,
      cancel_origin AS cancelOrigin, next_reconcile_at AS nextReconcileAt,
      reconcile_attempts AS reconcileAttempts, lease_token AS leaseToken,
      lease_expires_at AS leaseExpiresAt
    FROM payment_attempts
    WHERE id = ? AND shop_id = ? AND provider = 'payos'
    LIMIT 1
  `).bind(attemptId, shopId).first<AttemptRow>();
}

function requireAttemptOrigin(attempt: AttemptRow): PaymentOrigin {
  if (attempt.checkoutDomainId === null || attempt.returnOrigin === null || attempt.cancelOrigin === null) {
    throw new AppError("payment_origin_invalid", 409);
  }
  return {
    cancelOrigin: attempt.cancelOrigin,
    checkoutDomainId: attempt.checkoutDomainId,
    returnOrigin: attempt.returnOrigin,
  };
}

async function persistProviderLink(env: AppBindings, attempt: AttemptRow, link: PaymentLinkResponse): Promise<PaymentLinkView> {
  assertProviderPaymentBinding(attempt, { amount: link.amount, currency: link.currency, description: link.description, orderCode: link.orderCode, paymentLinkId: link.paymentLinkId });
  const payloadHash = await sha256Json(link);
  const checkoutUrl = payOSCheckoutUrl(link.paymentLinkId);
  if (link.checkoutUrl !== checkoutUrl) throw new AppError("provider_identity_mismatch", 409);
  const qrCode = link.qrCode;
  const now = new Date().toISOString();
  await env.PLATFORM_DB.batch([
    env.PLATFORM_DB.prepare(`UPDATE payment_attempts SET provider_payment_link_id = ?, provider_status = ?, state = 'pending', checkout_url = ?, qr_code = ?, account_bin = ?, account_number_masked = ?, account_name_sanitized = ?, provider_payload_hash = ?, next_reconcile_at = ?, last_safe_error_code = NULL, updated_at = ? WHERE id = ? AND shop_id = ? AND state IN ('creating', 'error')`).bind(link.paymentLinkId, link.status, checkoutUrl, qrCode, link.bin, maskAccountNumber(link.accountNumber), sanitizeAccountName(link.accountName), payloadHash, new Date(Date.now() + 2 * 60_000).toISOString(), now, attempt.id, attempt.shopId),
    env.PLATFORM_DB.prepare(`UPDATE payment_integrations SET account_bin = ?, account_number_masked = ?, account_name_sanitized = ?, updated_at = ? WHERE id = (SELECT integration_id FROM payment_attempts WHERE id = ?)`).bind(link.bin, maskAccountNumber(link.accountNumber), sanitizeAccountName(link.accountName), now, attempt.id),
  ]);
  return { checkoutUrl, expiresAt: attempt.expiresAt, paymentAttemptId: attempt.id, qrCode, state: "pending" };
}

async function recoverProviderLink(env: AppBindings, client: PayOSClient, attempt: AttemptRow, leaseToken: string | null = null): Promise<PaymentLinkView> {
  const status = await client.getPaymentLink(attempt.providerOrderCode);
  const paymentLinkId = status.id;
  assertProviderPaymentBinding(attempt, { amount: status.amount, currency: status.currency, description: status.description, orderCode: status.orderCode, paymentLinkId });
  const checkoutUrl = payOSCheckoutUrl(paymentLinkId);
  const now = new Date().toISOString();
  const statement = leaseToken === null
    ? env.PLATFORM_DB.prepare(`UPDATE payment_attempts SET provider_payment_link_id = ?, provider_status = ?, state = 'pending', checkout_url = ?, last_reconciled_at = ?, next_reconcile_at = ?, last_safe_error_code = NULL, updated_at = ? WHERE id = ? AND shop_id = ? AND state = 'creating'`).bind(paymentLinkId, status.status, checkoutUrl, now, new Date(Date.now() + 2 * 60_000).toISOString(), now, attempt.id, attempt.shopId)
    : env.PLATFORM_DB.prepare(`UPDATE payment_attempts SET provider_payment_link_id = ?, provider_status = ?, state = 'pending', checkout_url = ?, last_reconciled_at = ?, next_reconcile_at = ?, reconcile_attempts = reconcile_attempts + 1, lease_token = NULL, lease_expires_at = NULL, last_safe_error_code = NULL, updated_at = ? WHERE id = ? AND shop_id = ? AND state = 'error' AND lease_token = ?`).bind(paymentLinkId, status.status, checkoutUrl, now, new Date(Date.now() + 2 * 60_000).toISOString(), now, attempt.id, attempt.shopId, leaseToken);
  const updated = await statement.run();
  if (updated.meta.changes !== 1) {
    const winner = await loadAttemptById(env, attempt.id, attempt.shopId);
    if (winner !== null && (winner.state === "pending" || winner.state === "paid_exact")) return mapAttempt(winner);
    throw new AppError("payment_pending", 409);
  }
  return { checkoutUrl, expiresAt: attempt.expiresAt, paymentAttemptId: attempt.id, qrCode: attempt.qrCode ?? "", state: "pending" };
}

async function resolveExistingAttempt(input: { env: AppBindings; fetcher?: typeof fetch }, attempt: AttemptRow, orderId: string): Promise<PaymentLinkView> {
  if (attempt.state === "pending" || attempt.state === "paid_exact") return mapAttempt(attempt);
  if (attempt.state === "creating" && attempt.paymentLinkId === null) {
    const current = await loadAttempt(input.env, attempt.shopId, orderId);
    if (current !== null && (current.state === "pending" || current.state === "paid_exact")) return mapAttempt(current);
    throw new AppError("payment_pending", 409);
  }
  if (attempt.state !== "error") throw new AppError("payment_pending", 409);
  const now = new Date();
  const nowIso = now.toISOString();
  if (attempt.nextReconcileAt === null || attempt.nextReconcileAt > nowIso
    || (attempt.leaseExpiresAt !== null && attempt.leaseExpiresAt > nowIso)) {
    throw new AppError("payment_pending", 409);
  }
  const leaseToken = createOpaqueToken(18);
  const claimed = await input.env.PLATFORM_DB.prepare(`
    UPDATE payment_attempts
    SET lease_token = ?, lease_expires_at = ?, updated_at = ?
    WHERE id = ? AND shop_id = ? AND state = 'error'
      AND next_reconcile_at IS NOT NULL AND next_reconcile_at <= ?
      AND (lease_token IS NULL OR lease_expires_at IS NULL OR lease_expires_at <= ?)
  `).bind(
    leaseToken,
    new Date(now.getTime() + 60_000).toISOString(),
    nowIso,
    attempt.id,
    attempt.shopId,
    nowIso,
    nowIso,
  ).run();
  if (claimed.meta.changes !== 1) {
    const winner = await loadAttempt(input.env, attempt.shopId, orderId);
    if (winner !== null && (winner.state === "pending" || winner.state === "paid_exact")) return mapAttempt(winner);
    throw new AppError("payment_pending", 409);
  }
  try {
    const credential = await loadCredentialById(input.env, attempt.credentialId, attempt.shopId);
    return await recoverProviderLink(input.env, new PayOSClient(credential.credentials, input.fetcher), attempt, leaseToken);
  } catch (error) {
    if (error instanceof AppError && error.code === "payment_pending") throw error;
    const providerIdentityMismatch = isProviderIdentityMismatch(error);
    const nextAttempts = attempt.reconcileAttempts + 1;
    const jitter = crypto.getRandomValues(new Uint16Array(1))[0] ?? 0;
    const delaySeconds = Math.min(3_600, 30 * 2 ** Math.min(nextAttempts, 7)) + jitter % 30;
    const released = await input.env.PLATFORM_DB.prepare(`
      UPDATE payment_attempts
      SET reconcile_attempts = ?, next_reconcile_at = ?, lease_token = NULL,
        lease_expires_at = NULL, last_safe_error_code = ?,
        updated_at = ?
      WHERE id = ? AND shop_id = ? AND state = 'error' AND lease_token = ?
    `).bind(
      nextAttempts,
      new Date(now.getTime() + delaySeconds * 1_000).toISOString(),
      providerIdentityMismatch ? "provider_identity_mismatch" : "provider_reconcile_failed",
      nowIso,
      attempt.id,
      attempt.shopId,
      leaseToken,
    ).run();
    if (released.meta.changes !== 1) {
      const winner = await loadAttempt(input.env, attempt.shopId, orderId);
      if (winner !== null && (winner.state === "pending" || winner.state === "paid_exact")) return mapAttempt(winner);
    }
    if (providerIdentityMismatch) throw new AppError("provider_identity_mismatch", 409);
    throw new AppError("provider_unavailable", 503);
  }
}

async function createOrRecoverAuthorizedPaymentLink(input: { env: AppBindings; fetcher?: typeof fetch; origin: string; shopId: string }, order: PaymentOrder): Promise<PaymentLinkView> {
  if (order.totalMinor <= 0) throw new AppError("payment_not_required", 409);
  if (order.currency !== "VND") throw new AppError("payment_currency_unsupported", 409, ["payos_currency_unsupported"]);
  if (order.paymentStatus === "paid") throw new AppError("payment_already_completed", 409);
  if (order.status !== "pending_payment" || order.paymentStatus !== "unpaid" || order.expiresAt <= new Date().toISOString()) throw new AppError("payment_not_available", 409);
  let attempt = await loadAttempt(input.env, input.shopId, order.id);
  if (attempt !== null) {
    return resolveExistingAttempt(input, attempt, order.id);
  }
  const integration = await getActiveIntegration(input.env, input.shopId);
  const credential = await loadCredentialById(input.env, integration.activeCredentialId, input.shopId);
  const client = new PayOSClient(credential.credentials, input.fetcher);
  const now = new Date().toISOString();
  const requestOrigin = parsePaymentRequestOrigin(input.env, input.origin);
  let createdAttempt = false;
  for (let retry = 0; retry < 5 && attempt === null; retry += 1) {
    const orderCode = allocateOrderCode();
    const attemptId = createId("pat");
    try {
      const inserted = await input.env.PLATFORM_DB.prepare(`
        INSERT INTO payment_attempts (
          id, public_id, shop_id, order_id, integration_id, credential_id,
          provider, provider_order_code, state, expected_amount_minor, currency,
          expected_description, expires_at, checkout_domain_id, return_origin,
          cancel_origin, created_at, updated_at
        )
        SELECT ?, ?, shops.id, ?, ?, ?, 'payos', ?, 'creating', ?, ?, ?, ?,
          canonical_domain.id,
          ? || canonical_domain.hostname_normalized || ?,
          ? || canonical_domain.hostname_normalized || ?,
          ?, ?
        FROM shops
        INNER JOIN shop_domains AS request_domain
          ON request_domain.shop_id = shops.id
          AND request_domain.hostname_normalized = ?
          AND request_domain.status = 'active'
          AND request_domain.deleted_at IS NULL
          AND (
            request_domain.type = 'platform_subdomain'
            OR request_domain.ownership_verified_at IS NOT NULL
          )
        INNER JOIN shop_domains AS canonical_domain
          ON canonical_domain.id = shops.canonical_domain_id
          AND canonical_domain.shop_id = shops.id
          AND canonical_domain.is_primary = 1
          AND canonical_domain.status = 'active'
          AND canonical_domain.deleted_at IS NULL
          AND (
            canonical_domain.type = 'platform_subdomain'
            OR canonical_domain.ownership_verified_at IS NOT NULL
          )
        WHERE shops.id = ?
      `).bind(
        attemptId,
        createId("pay"),
        order.id,
        integration.id,
        credential.row.credentialId,
        orderCode,
        order.totalMinor,
        order.currency,
        descriptionFor(orderCode),
        order.expiresAt,
        requestOrigin.protocolPrefix,
        requestOrigin.portSuffix,
        requestOrigin.protocolPrefix,
        requestOrigin.portSuffix,
        now,
        now,
        requestOrigin.hostname,
        input.shopId,
      ).run();
      if (inserted.meta.changes !== 1) {
        attempt = await loadAttempt(input.env, input.shopId, order.id);
        if (attempt === null) throw new AppError("payment_origin_invalid", 409);
        break;
      }
      attempt = await loadAttempt(input.env, input.shopId, order.id);
      if (attempt === null || attempt.id !== attemptId) throw new AppError("payment_creation_failed", 409);
      createdAttempt = true;
    } catch (error) {
      attempt = await loadAttempt(input.env, input.shopId, order.id);
      if (attempt !== null) break;
      if (error instanceof AppError && error.code === "payment_origin_invalid") throw error;
      // The remaining expected conflict is the globally unique provider order code.
    }
  }
  if (attempt === null) throw new AppError("payment_creation_failed", 409);
  if (!createdAttempt) {
    return resolveExistingAttempt(input, attempt, order.id);
  }
  const paymentOrigin = requireAttemptOrigin(attempt);
  const request = { amount: order.totalMinor, cancelUrl: `${paymentOrigin.cancelOrigin}/orders/${order.orderPublicId}?payment=cancel`, description: expectedDescriptionFor(attempt), expiredAt: Math.floor(Date.parse(order.expiresAt) / 1_000), orderCode: attempt.providerOrderCode, returnUrl: `${paymentOrigin.returnOrigin}/orders/${order.orderPublicId}?payment=return` };
  try {
    const link = await client.createPaymentLink(request);
    return await persistProviderLink(input.env, attempt, link);
  } catch (createError) {
    try {
      return await recoverProviderLink(input.env, client, attempt);
    } catch (recoveryError) {
      const providerIdentityMismatch = isProviderIdentityMismatch(createError) || isProviderIdentityMismatch(recoveryError);
      await input.env.PLATFORM_DB.prepare(`UPDATE payment_attempts SET state = 'error', last_safe_error_code = ?, next_reconcile_at = ?, updated_at = ? WHERE id = ? AND shop_id = ? AND state = 'creating'`).bind(providerIdentityMismatch ? "provider_identity_mismatch" : "provider_create_unconfirmed", new Date(Date.now() + 60_000).toISOString(), new Date().toISOString(), attempt.id, input.shopId).run();
      if (providerIdentityMismatch) throw new AppError("provider_identity_mismatch", 409);
      throw new AppError("provider_unavailable", 503);
    }
  }
}

export async function createOrRecoverPaymentLink(input: { env: AppBindings; fetcher?: typeof fetch; orderPublicId: string; orderToken: string; origin: string; shopId: string }): Promise<PaymentLinkView> {
  return createOrRecoverAuthorizedPaymentLink(input, await authorizeOrder(input));
}

export type PaymentFulfillmentEligibility = {
  eligible: boolean;
  reason: "fulfillment_pending" | "order_expired" | "order_ineligible" | "payment_unconfirmed" | "ready";
};

async function hasGeneratedLicenseFulfillmentSchema(env: AppBindings): Promise<boolean> {
  try {
    const row = await env.PLATFORM_DB.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'generated_license_artifacts' LIMIT 1",
    ).first<{ name: string }>();
    return row !== null;
  } catch {
    // Preserve the legacy pooled-key boundary for narrow test doubles.
    return false;
  }
}

async function decidePaymentFulfillmentEligibility(env: AppBindings, order: PaymentOrder): Promise<PaymentFulfillmentEligibility> {
  if (order.status === "expired") return { eligible: false, reason: "order_expired" };
  if (order.paymentStatus !== "paid") return { eligible: false, reason: "payment_unconfirmed" };
  if (order.status !== "completed" && order.status !== "processing") return { eligible: false, reason: "order_ineligible" };
  const allocation = await env.PLATFORM_DB.prepare(`
    SELECT COUNT(*) AS digitalItemCount
    FROM fulfillment_items
    INNER JOIN fulfillments
      ON fulfillments.id = fulfillment_items.fulfillment_id
      AND fulfillments.shop_id = fulfillment_items.shop_id
      AND fulfillments.order_id = ?
      AND fulfillments.fulfillment_type = 'digital_keys'
      AND fulfillments.state = 'fulfilled'
    INNER JOIN inventory_keys
      ON inventory_keys.id = fulfillment_items.inventory_key_id
      AND inventory_keys.shop_id = fulfillment_items.shop_id
      AND inventory_keys.status = 'sold'
    INNER JOIN order_items
      ON order_items.id = fulfillment_items.order_item_id
      AND order_items.shop_id = fulfillment_items.shop_id
      AND order_items.order_id = fulfillments.order_id
    WHERE fulfillment_items.shop_id = ?
  `).bind(order.id, order.shopId).first<{ digitalItemCount: number }>();
  const digitalItemCount = allocation?.digitalItemCount ?? 0;
  if (!(await hasGeneratedLicenseFulfillmentSchema(env))) {
    if (digitalItemCount < 1) return { eligible: false, reason: "fulfillment_pending" };
    return { eligible: true, reason: "ready" };
  }
  const generated = await env.PLATFORM_DB.prepare(`
    SELECT
      COALESCE((
        SELECT SUM(requirement.grant_quantity)
        FROM order_item_entitlement_requirements AS requirement
        INNER JOIN entitlement_resources AS resource
          ON resource.id = requirement.resource_id
          AND resource.shop_id = requirement.shop_id
          AND resource.resource_type = 'generated_license'
        WHERE requirement.order_id = ? AND requirement.shop_id = ?
      ), 0) AS expectedGeneratedCount,
      (
        SELECT COUNT(*)
        FROM generated_license_artifacts AS artifact
        INNER JOIN generated_license_requests AS request
          ON request.id = artifact.request_id
          AND request.shop_id = artifact.shop_id
          AND request.status = 'succeeded'
        INNER JOIN entitlements AS entitlement
          ON entitlement.id = request.entitlement_id
          AND entitlement.shop_id = request.shop_id
          AND entitlement.status = 'active'
          AND (entitlement.access_expires_at IS NULL OR entitlement.access_expires_at > ?)
        WHERE request.order_id = ? AND request.shop_id = ?
          AND artifact.status = 'active'
      ) AS readyGeneratedCount,
      (
        SELECT COUNT(*) FROM fulfillments
        WHERE order_id = ? AND shop_id = ? AND state != 'fulfilled'
      ) AS pendingFulfillmentCount
  `).bind(
    order.id,
    order.shopId,
    new Date().toISOString(),
    order.id,
    order.shopId,
    order.id,
    order.shopId,
  ).first<{
    expectedGeneratedCount: number;
    pendingFulfillmentCount: number;
    readyGeneratedCount: number;
  }>();
  const expectedGeneratedCount = generated?.expectedGeneratedCount ?? 0;
  const readyGeneratedCount = generated?.readyGeneratedCount ?? 0;
  if ((generated?.pendingFulfillmentCount ?? 0) > 0
    || readyGeneratedCount < expectedGeneratedCount
    || digitalItemCount + readyGeneratedCount < 1) {
    return { eligible: false, reason: "fulfillment_pending" };
  }
  return { eligible: true, reason: "ready" };
}

/**
 * Payment state is authoritative for the fulfillment gate. This read-only
 * projection deliberately exposes no provider identity or payment evidence.
 */
export async function getPaymentFulfillmentEligibility(input: { env: AppBindings; orderPublicId: string; orderToken: string; shopId: string }): Promise<PaymentFulfillmentEligibility> {
  return decidePaymentFulfillmentEligibility(input.env, await authorizeOrder(input));
}

export async function getPrincipalPaymentFulfillmentEligibility(input: { connectionId?: string | null; customerId: string; env: AppBindings; orderPublicId: string; shopId: string; sourceChannel?: "telegram" }): Promise<PaymentFulfillmentEligibility> {
  return decidePaymentFulfillmentEligibility(input.env, await authorizePrincipalOrder(input));
}

export async function createOrRecoverPrincipalPaymentHandoff(input: { connectionId?: string | null; customerId: string; env: AppBindings; fetcher?: typeof fetch; orderPublicId: string; origin: string; shopId: string; sourceChannel?: "telegram" }): Promise<PaymentLinkView> {
  return createOrRecoverAuthorizedPaymentLink(input, await authorizePrincipalOrder(input));
}

export async function createOrRecoverTelegramPaymentLink(input: { connectionId?: string | null; customerId: string; env: AppBindings; fetcher?: typeof fetch; orderPublicId: string; origin: string; shopId: string }): Promise<PaymentLinkView> {
  return createOrRecoverPrincipalPaymentHandoff({ ...input, sourceChannel: "telegram" });
}

export function normalizeReconciliation(status: PaymentLinkStatusResponse): { amount: number; currency: string; description: string; occurredAt: string; orderCode: number; paymentLinkId: string; providerStatus: string; reference: string; success: boolean } {
  // `amountPaid` is cumulative, so use the latest complete transaction as the
  // evidence timestamp. Picking index zero can classify a payment completed by
  // a later transfer as timely when the first transfer happened before expiry.
  const transactions = status.transactions
    .map((transaction) => {
      const occurredAt = typeof transaction.transactionDateTime === "string" && Number.isFinite(Date.parse(transaction.transactionDateTime))
        ? transaction.transactionDateTime
        : null;
      const description = typeof transaction.description === "string" && transaction.description.length > 0
        ? transaction.description
        : null;
      const reference = typeof transaction.reference === "string" && transaction.reference.length > 0
        ? transaction.reference
        : null;
      return occurredAt === null || description === null ? null : { description, occurredAt, reference };
    });
  const completeTransactions = transactions.every((transaction) => transaction !== null) && transactions.length > 0;
  const complete = completeTransactions ? transactions : [];
  const transaction = complete.reduce<{ description: string; occurredAt: string; reference: string | null } | null>((latest, current) => {
    if (latest === null || Date.parse(current.occurredAt) > Date.parse(latest.occurredAt)) return current;
    return latest;
  }, null);
  const descriptions = new Set(complete.map((item) => item.description));
  const fallbackOccurredAt = new Date().toISOString();
  return {
    amount: status.amountPaid,
    currency: status.currency,
    description: transaction?.description ?? "",
    occurredAt: transaction?.occurredAt ?? fallbackOccurredAt,
    orderCode: status.orderCode,
    paymentLinkId: status.id,
    providerStatus: status.status,
    reference: transaction?.reference ?? `status:${status.id}:${status.status}`,
    // A PAID aggregate is actionable only when every contributing transaction
    // has signed timing/identity evidence and those descriptions agree.
    success: status.status === "PAID" && completeTransactions && descriptions.size === 1,
  };
}
