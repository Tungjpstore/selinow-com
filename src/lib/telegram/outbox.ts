import { createOpaqueToken } from "../core/ids";
import type { AppBindings } from "../platform/bindings";
import { TelegramClient, TelegramProviderError } from "./client";
import { decryptTelegramRecipientRow, loadActiveTelegramCredential } from "./credentials";
import { resolveTelegramLocale, telegramPaidOrderNotification } from "./localization";

type OutboxJob = {
  attempts: number;
  id: string;
  orderId: string;
  shopId: string;
};

type TelegramDelivery = {
  attributionChannelCode: string | null;
  attributionConnectionId: string | null;
  chatIdCiphertextB64: string | null;
  chatIdIvB64: string | null;
  customerIdentityId: string | null;
  integrationConnectionId: string | null;
  integrationId: string | null;
  identityLocale: string | null;
  keyVersion: string | null;
  orderNumber: string;
  orderLocale: string | null;
  orderPublicId: string;
  preferredLocale: string | null;
  recipientId: string | null;
  shopDefaultLocale: string;
  sourceChannel: string;
};

async function finishJob(env: AppBindings, job: OutboxJob, leaseToken: string, status: "completed" | "failed", errorCode: string | null): Promise<void> {
  const now = new Date().toISOString();
  await env.PLATFORM_DB.prepare("UPDATE outbox_jobs SET status = ?, last_safe_error_code = ?, lease_token = NULL, lease_expires_at = NULL, updated_at = ? WHERE id = ? AND shop_id = ? AND lease_token = ?").bind(status, errorCode, now, job.id, job.shopId, leaseToken).run();
}

async function retryJob(env: AppBindings, job: OutboxJob, leaseToken: string, error: unknown, now: Date): Promise<void> {
  const attempts = job.attempts + 1;
  const code = error instanceof Error && "code" in error && typeof error.code === "string" ? error.code : "telegram_delivery_failed";
  if (error instanceof TelegramProviderError && error.code === "telegram_unauthorized") {
    const delivery = await loadDelivery(env, job);
    if (delivery !== null) await env.PLATFORM_DB.prepare("UPDATE telegram_integrations SET status = 'degraded', last_safe_error_code = 'telegram_unauthorized', last_checked_at = ?, updated_at = ? WHERE id = ? AND status != 'disabled'").bind(now.toISOString(), now.toISOString(), delivery.integrationId).run();
  }
  if (attempts >= 8 || (error instanceof TelegramProviderError && error.code === "telegram_recipient_unavailable")) {
    await finishJob(env, job, leaseToken, "failed", code);
    return;
  }
  const retryAfter = error instanceof TelegramProviderError ? error.retryAfter : null;
  const jitter = crypto.getRandomValues(new Uint16Array(1))[0] ?? 0;
  const delaySeconds = retryAfter ?? Math.min(3_600, 30 * 2 ** Math.min(attempts, 7)) + jitter % 30;
  await env.PLATFORM_DB.prepare("UPDATE outbox_jobs SET status = 'pending', attempts = ?, next_attempt_at = ?, last_safe_error_code = ?, lease_token = NULL, lease_expires_at = NULL, updated_at = ? WHERE id = ? AND shop_id = ? AND lease_token = ?").bind(attempts, new Date(now.getTime() + delaySeconds * 1_000).toISOString(), code, now.toISOString(), job.id, job.shopId, leaseToken).run();
}

async function loadDelivery(env: AppBindings, job: OutboxJob): Promise<TelegramDelivery | null> {
  return env.PLATFORM_DB.prepare(`
    SELECT orders.source_channel AS sourceChannel, orders.public_id AS orderPublicId, orders.order_number AS orderNumber,
      orders.locale AS orderLocale,
      shops.default_locale AS shopDefaultLocale,
      telegram_integrations.id AS integrationId,
      telegram_integrations.channel_connection_id AS integrationConnectionId,
      order_channel_attributions.channel_code AS attributionChannelCode,
      order_channel_attributions.connection_id AS attributionConnectionId,
      customer_identities.id AS customerIdentityId,
      customer_identities.language_code AS identityLocale,
      shop_customers.preferred_locale AS preferredLocale,
      telegram_recipients.id AS recipientId,
      telegram_recipients.key_version AS keyVersion,
      telegram_recipients.chat_id_ciphertext_b64 AS chatIdCiphertextB64,
      telegram_recipients.chat_id_iv_b64 AS chatIdIvB64
    FROM orders
    INNER JOIN shops ON shops.id = orders.shop_id
    LEFT JOIN shop_customers
      ON shop_customers.id = orders.customer_id
      AND shop_customers.shop_id = orders.shop_id
    LEFT JOIN customer_identities
      ON customer_identities.shop_id = orders.shop_id
      AND customer_identities.customer_id = orders.customer_id
      AND customer_identities.provider = 'telegram'
    LEFT JOIN telegram_recipients
      ON telegram_recipients.shop_id = orders.shop_id
      AND telegram_recipients.customer_identity_id = customer_identities.id
      AND telegram_recipients.status = 'active'
    LEFT JOIN telegram_integrations
      ON telegram_integrations.id = telegram_recipients.integration_id
      AND telegram_integrations.shop_id = orders.shop_id
      AND telegram_integrations.status IN ('active', 'degraded')
    LEFT JOIN order_channel_attributions
      ON order_channel_attributions.order_id = orders.id
      AND order_channel_attributions.shop_id = orders.shop_id
    WHERE orders.id = ? AND orders.shop_id = ? AND orders.payment_status = 'paid'
    LIMIT 1
  `).bind(job.orderId, job.shopId).first<TelegramDelivery>();
}

export async function processTelegramOutbox(env: AppBindings, now = new Date(), fetcher: typeof fetch = fetch, shopId: string | null = null): Promise<{ failed: number; processed: number; skipped: number }> {
  const nowIso = now.toISOString();
  const due = await env.PLATFORM_DB.prepare(`SELECT id, shop_id AS shopId, aggregate_id AS orderId, attempts FROM outbox_jobs WHERE kind = 'order_paid' AND next_attempt_at <= ? AND (status = 'pending' OR (status = 'processing' AND lease_expires_at <= ?)) AND (? IS NULL OR shop_id = ?) ORDER BY next_attempt_at, id LIMIT 25`).bind(nowIso, nowIso, shopId, shopId).all<OutboxJob>();
  let processed = 0;
  let failed = 0;
  let skipped = 0;
  for (const job of due.results) {
    const leaseToken = createOpaqueToken(18);
    const leaseExpiresAt = new Date(now.getTime() + 60_000).toISOString();
    const claimed = await env.PLATFORM_DB.prepare("UPDATE outbox_jobs SET status = 'processing', lease_token = ?, lease_expires_at = ?, updated_at = ? WHERE id = ? AND shop_id = ? AND (status = 'pending' OR (status = 'processing' AND lease_expires_at <= ?))").bind(leaseToken, leaseExpiresAt, nowIso, job.id, job.shopId, nowIso).run();
    if (claimed.meta.changes !== 1) continue;
    try {
      const delivery = await loadDelivery(env, job);
      if (
        delivery === null
        || delivery.sourceChannel !== "telegram"
        || (
          delivery.attributionChannelCode !== null
          && (
            delivery.attributionChannelCode !== "telegram"
            || delivery.attributionConnectionId === null
            || delivery.attributionConnectionId !== delivery.integrationConnectionId
          )
        )
      ) {
        await finishJob(env, job, leaseToken, "completed", null);
        skipped += 1;
        continue;
      }
      if (delivery.integrationId === null || delivery.customerIdentityId === null || delivery.recipientId === null || delivery.chatIdCiphertextB64 === null || delivery.chatIdIvB64 === null || delivery.keyVersion === null) throw new Error("telegram_recipient_missing");
      const credential = await loadActiveTelegramCredential(env, delivery.integrationId, job.shopId);
      const chatId = await decryptTelegramRecipientRow(env, { ciphertextB64: delivery.chatIdCiphertextB64, identityId: delivery.customerIdentityId, integrationId: delivery.integrationId, ivB64: delivery.chatIdIvB64, keyVersion: delivery.keyVersion, shopId: job.shopId });
      const locale = resolveTelegramLocale({
        explicitPreference: delivery.preferredLocale,
        identityPreference: delivery.identityLocale,
        requestLanguage: delivery.orderLocale,
        shopDefaultLocale: delivery.shopDefaultLocale,
      });
      const notification = telegramPaidOrderNotification(locale, delivery.orderNumber, delivery.orderPublicId);
      await new TelegramClient(credential.credentials.botToken, fetcher).sendMessage({
        chatId,
        keyboard: notification.keyboard,
        text: notification.text,
      });
      const sentAt = new Date().toISOString();
      await env.PLATFORM_DB.batch([
        env.PLATFORM_DB.prepare("UPDATE telegram_recipients SET last_outbound_at = ?, last_safe_error_code = NULL, updated_at = ? WHERE id = ? AND shop_id = ?").bind(sentAt, sentAt, delivery.recipientId, job.shopId),
        env.PLATFORM_DB.prepare("UPDATE telegram_integrations SET last_outbound_at = ?, updated_at = ? WHERE id = ? AND shop_id = ?").bind(sentAt, sentAt, delivery.integrationId, job.shopId),
      ]);
      await finishJob(env, job, leaseToken, "completed", null);
      processed += 1;
    } catch (error) {
      await retryJob(env, job, leaseToken, error, now);
      failed += 1;
    }
  }
  return { failed, processed, skipped };
}

export async function purgeTelegramUpdateHistory(env: AppBindings, now = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - 30 * 24 * 60 * 60_000).toISOString();
  const results = await env.PLATFORM_DB.batch([
    env.PLATFORM_DB.prepare("DELETE FROM telegram_actions WHERE created_at < ?").bind(cutoff),
    env.PLATFORM_DB.prepare("DELETE FROM telegram_updates WHERE received_at < ? AND status IN ('processed', 'rejected')").bind(cutoff),
  ]);
  return (results[0]?.meta.changes ?? 0) + (results[1]?.meta.changes ?? 0);
}
