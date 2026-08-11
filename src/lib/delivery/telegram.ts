import { AppError } from "../core/errors";
import type { AppBindings } from "../platform/bindings";
import { TelegramClient, TelegramProviderError } from "../telegram/client";
import {
  decryptTelegramCredentialRow,
  decryptTelegramRecipientRow,
  type TelegramCredentialRow,
} from "../telegram/credentials";
import { resolveTelegramLocale, telegramPaidOrderNotification } from "../telegram/localization";

export type TelegramDeliveryJobReference = {
  connectionId: string;
  eventId: string;
  id: string;
  purpose: string;
  shopId: string;
};

export type TelegramDeliveryResult =
  | { kind: "delivered" }
  | { errorCode: string; kind: "failed" }
  | { errorCode: string; kind: "retryable"; providerOutcome?: "not_sent" | "unknown"; retryAfterSeconds?: number };

type JobContextRow = {
  aggregateId: string | null;
  aggregateType: string | null;
  attributionChannelCode: string | null;
  attributionConnectionId: string | null;
  connectionId: string;
  customerId: string | null;
  eventId: string;
  eventSchemaVersion: number | null;
  eventStatus: string | null;
  eventType: string | null;
  jobStatus: string;
  orderId: string | null;
  orderNumber: string | null;
  orderLocale: string | null;
  orderPaymentStatus: string | null;
  orderPublicId: string | null;
  orderSourceChannel: string | null;
  preferredLocale: string | null;
  identityLocale: string | null;
  shopDefaultLocale: string | null;
  purpose: string;
  queueKind: string;
  shopStatus: string | null;
};

type ConnectionContextRow = {
  activeCredentialId: string | null;
  channelCode: string | null;
  channelStatus: string | null;
  connectionStatus: string;
  hasOutboundGrant: number;
  integrationId: string | null;
  integrationStatus: string | null;
  providerCode: string;
};

type RecipientRow = {
  chatIdCiphertextB64: string;
  chatIdIvB64: string;
  identityId: string;
  keyVersion: string;
  recipientId: string;
  status: string;
};

const DELIVERY_PURPOSE = "order.paid";

function failed(errorCode: string): TelegramDeliveryResult {
  return { errorCode, kind: "failed" };
}

function retryable(
  errorCode: string,
  retryAfterSeconds?: number,
  providerOutcome: "not_sent" | "unknown" = "unknown",
): TelegramDeliveryResult {
  return retryAfterSeconds === undefined
    ? { errorCode, kind: "retryable", providerOutcome }
    : { errorCode, kind: "retryable", providerOutcome, retryAfterSeconds };
}

function classifyProviderError(error: unknown): TelegramDeliveryResult {
  if (error instanceof TelegramProviderError) {
    if (error.code === "telegram_rate_limited") {
      return retryable(error.code, error.retryAfter ?? undefined, "not_sent");
    }
    if (
      error.code === "provider_timeout"
      || error.code === "provider_unavailable"
      || error.code === "provider_response_invalid"
      || error.code === "provider_response_too_large"
      || error.status >= 500
    ) {
      return retryable(error.code);
    }
    return failed(error.code);
  }
  if (error instanceof AppError) return failed(error.code);
  return retryable("telegram_delivery_failed");
}

async function loadJobContext(
  env: AppBindings,
  job: TelegramDeliveryJobReference,
): Promise<JobContextRow | null> {
  return env.PLATFORM_DB.prepare(`
    SELECT delivery_jobs.event_id AS eventId,
      delivery_jobs.connection_id AS connectionId,
      delivery_jobs.purpose,
      delivery_jobs.queue_kind AS queueKind,
      delivery_jobs.status AS jobStatus,
      domain_events.event_type AS eventType,
      domain_events.aggregate_type AS aggregateType,
      domain_events.aggregate_id AS aggregateId,
      domain_events.schema_version AS eventSchemaVersion,
      domain_events.status AS eventStatus,
      shops.status AS shopStatus,
      shops.default_locale AS shopDefaultLocale,
      orders.id AS orderId,
      orders.public_id AS orderPublicId,
      orders.order_number AS orderNumber,
      orders.locale AS orderLocale,
      orders.customer_id AS customerId,
      orders.source_channel AS orderSourceChannel,
      orders.payment_status AS orderPaymentStatus,
      shop_customers.preferred_locale AS preferredLocale,
      customer_identities.language_code AS identityLocale,
      order_channel_attributions.channel_code AS attributionChannelCode,
      order_channel_attributions.connection_id AS attributionConnectionId
    FROM delivery_jobs
    LEFT JOIN domain_events
      ON domain_events.id = delivery_jobs.event_id
      AND domain_events.shop_id = delivery_jobs.shop_id
    LEFT JOIN shops ON shops.id = delivery_jobs.shop_id
    LEFT JOIN orders
      ON orders.id = domain_events.aggregate_id
      AND orders.shop_id = delivery_jobs.shop_id
    LEFT JOIN shop_customers
      ON shop_customers.id = orders.customer_id
      AND shop_customers.shop_id = orders.shop_id
    LEFT JOIN customer_identities
      ON customer_identities.shop_id = orders.shop_id
      AND customer_identities.customer_id = orders.customer_id
      AND customer_identities.provider = 'telegram'
    LEFT JOIN order_channel_attributions
      ON order_channel_attributions.order_id = orders.id
      AND order_channel_attributions.shop_id = delivery_jobs.shop_id
    WHERE delivery_jobs.id = ? AND delivery_jobs.shop_id = ?
    LIMIT 1
  `).bind(job.id, job.shopId).first<JobContextRow>();
}

function validateJobContext(
  row: JobContextRow | null,
  job: TelegramDeliveryJobReference,
): TelegramDeliveryResult | null {
  if (row === null) return failed("telegram_delivery_job_not_found");
  if (
    row.eventId !== job.eventId
    || row.connectionId !== job.connectionId
    || row.purpose !== job.purpose
  ) {
    return failed("telegram_delivery_job_reference_mismatch");
  }
  if (row.jobStatus !== "processing") return failed("telegram_delivery_job_not_claimed");
  if (row.queueKind !== "notification" || row.purpose !== DELIVERY_PURPOSE) {
    return failed("telegram_delivery_purpose_unsupported");
  }
  if (
    row.eventType !== "order.paid"
    || row.aggregateType !== "order"
    || row.eventSchemaVersion !== 1
    || row.aggregateId === null
    || row.aggregateId !== row.orderId
  ) {
    return failed("telegram_delivery_event_invalid");
  }
  if (row.eventStatus !== "published") return failed("telegram_delivery_event_not_published");
  if (row.shopStatus !== "active") return failed("telegram_delivery_shop_unavailable");
  if (
    row.orderPublicId === null
    || row.orderNumber === null
    || row.customerId === null
  ) {
    return failed("telegram_delivery_order_unavailable");
  }
  if (row.orderPaymentStatus !== "paid") return failed("telegram_delivery_order_not_paid");
  if (
    row.orderSourceChannel !== "telegram"
    || row.attributionChannelCode !== "telegram"
    || row.attributionConnectionId !== job.connectionId
  ) {
    return failed("telegram_delivery_attribution_mismatch");
  }
  return null;
}

async function loadConnectionContext(
  env: AppBindings,
  job: TelegramDeliveryJobReference,
  nowIso: string,
): Promise<ConnectionContextRow | null> {
  return env.PLATFORM_DB.prepare(`
    SELECT channel_connections.provider_code AS providerCode,
      channel_connections.status AS connectionStatus,
      shop_channels.channel_code AS channelCode,
      shop_channels.status AS channelStatus,
      telegram_integrations.id AS integrationId,
      telegram_integrations.status AS integrationStatus,
      telegram_integrations.active_credential_id AS activeCredentialId,
      EXISTS (
        SELECT 1 FROM channel_connection_grants
        WHERE channel_connection_grants.shop_id = channel_connections.shop_id
          AND channel_connection_grants.connection_id = channel_connections.id
          AND channel_connection_grants.capability_code = 'conversation.outbound'
          AND (
            channel_connection_grants.expires_at IS NULL
            OR channel_connection_grants.expires_at > ?
          )
      ) AS hasOutboundGrant
    FROM channel_connections
    LEFT JOIN shop_channels
      ON shop_channels.id = channel_connections.shop_channel_id
      AND shop_channels.shop_id = channel_connections.shop_id
    LEFT JOIN telegram_integrations
      ON telegram_integrations.channel_connection_id = channel_connections.id
      AND telegram_integrations.shop_id = channel_connections.shop_id
    WHERE channel_connections.id = ? AND channel_connections.shop_id = ?
    LIMIT 1
  `).bind(nowIso, job.connectionId, job.shopId).first<ConnectionContextRow>();
}

function validateConnectionContext(row: ConnectionContextRow | null): TelegramDeliveryResult | null {
  if (
    row === null
    || row.providerCode !== "telegram"
    || row.channelCode !== "telegram"
    || row.channelStatus !== "enabled"
    || !new Set(["active", "degraded"]).has(row.connectionStatus)
  ) {
    return failed("telegram_delivery_connection_unavailable");
  }
  if (row.hasOutboundGrant !== 1) return failed("telegram_delivery_outbound_grant_missing");
  if (
    row.integrationId === null
    || row.activeCredentialId === null
    || !new Set(["active", "degraded"]).has(row.integrationStatus ?? "")
  ) {
    return failed("telegram_delivery_integration_unavailable");
  }
  return null;
}

async function loadCredential(
  env: AppBindings,
  shopId: string,
  integrationId: string,
  credentialId: string,
): Promise<TelegramCredentialRow | null> {
  return env.PLATFORM_DB.prepare(`
    SELECT telegram_credentials.id AS credentialId,
      telegram_credentials.integration_id AS integrationId,
      telegram_credentials.shop_id AS shopId,
      telegram_credentials.status,
      telegram_credentials.key_version AS keyVersion,
      telegram_credentials.bot_token_ciphertext_b64 AS botTokenCiphertextB64,
      telegram_credentials.bot_token_iv_b64 AS botTokenIvB64,
      telegram_credentials.webhook_secret_ciphertext_b64 AS webhookSecretCiphertextB64,
      telegram_credentials.webhook_secret_iv_b64 AS webhookSecretIvB64,
      telegram_credentials.token_fingerprint AS tokenFingerprint,
      telegram_credentials.webhook_secret_digest AS webhookSecretDigest
    FROM telegram_credentials
    WHERE telegram_credentials.id = ?
      AND telegram_credentials.integration_id = ?
      AND telegram_credentials.shop_id = ?
      AND telegram_credentials.status = 'active'
    LIMIT 1
  `).bind(credentialId, integrationId, shopId).first<TelegramCredentialRow>();
}

async function loadRecipient(
  env: AppBindings,
  shopId: string,
  integrationId: string,
  customerId: string,
): Promise<RecipientRow | null> {
  return env.PLATFORM_DB.prepare(`
    SELECT telegram_recipients.id AS recipientId,
      telegram_recipients.status,
      telegram_recipients.key_version AS keyVersion,
      telegram_recipients.chat_id_ciphertext_b64 AS chatIdCiphertextB64,
      telegram_recipients.chat_id_iv_b64 AS chatIdIvB64,
      customer_identities.id AS identityId
    FROM customer_identities
    INNER JOIN telegram_recipients
      ON telegram_recipients.customer_identity_id = customer_identities.id
      AND telegram_recipients.shop_id = customer_identities.shop_id
      AND telegram_recipients.integration_id = ?
    WHERE customer_identities.shop_id = ?
      AND customer_identities.customer_id = ?
      AND customer_identities.provider = 'telegram'
    ORDER BY telegram_recipients.last_seen_at DESC, telegram_recipients.id
    LIMIT 1
  `).bind(integrationId, shopId, customerId).first<RecipientRow>();
}

export async function deliverTelegramJob(input: {
  beforeProviderAttempt?: () => Promise<void>;
  env: AppBindings;
  fetcher?: typeof fetch;
  job: TelegramDeliveryJobReference;
  now?: Date;
}): Promise<TelegramDeliveryResult> {
  const now = input.now ?? new Date();
  let jobContext: JobContextRow | null;
  let connectionContext: ConnectionContextRow | null;
  try {
    jobContext = await loadJobContext(input.env, input.job);
    const jobFailure = validateJobContext(jobContext, input.job);
    if (jobFailure !== null) return jobFailure;
    connectionContext = await loadConnectionContext(input.env, input.job, now.toISOString());
  } catch {
    return retryable("telegram_delivery_state_unavailable");
  }

  const connectionFailure = validateConnectionContext(connectionContext);
  if (connectionFailure !== null) return connectionFailure;
  if (
    jobContext === null
    || jobContext.customerId === null
    || jobContext.orderPublicId === null
    || jobContext.orderNumber === null
    || connectionContext === null
    || connectionContext.integrationId === null
    || connectionContext.activeCredentialId === null
  ) {
    return failed("telegram_delivery_state_invalid");
  }

  let credential: TelegramCredentialRow | null;
  let recipient: RecipientRow | null;
  try {
    [credential, recipient] = await Promise.all([
      loadCredential(
        input.env,
        input.job.shopId,
        connectionContext.integrationId,
        connectionContext.activeCredentialId,
      ),
      loadRecipient(
        input.env,
        input.job.shopId,
        connectionContext.integrationId,
        jobContext.customerId,
      ),
    ]);
  } catch {
    return retryable("telegram_delivery_state_unavailable");
  }
  if (credential === null) return failed("telegram_delivery_credential_unavailable");
  if (recipient === null) return failed("telegram_delivery_recipient_missing");
  if (recipient.status !== "active") return failed("telegram_recipient_unavailable");

  let botToken: string;
  let chatId: string;
  try {
    const [plaintextCredential, plaintextChatId] = await Promise.all([
      decryptTelegramCredentialRow(input.env, credential),
      decryptTelegramRecipientRow(input.env, {
        ciphertextB64: recipient.chatIdCiphertextB64,
        identityId: recipient.identityId,
        integrationId: connectionContext.integrationId,
        ivB64: recipient.chatIdIvB64,
        keyVersion: recipient.keyVersion,
        shopId: input.job.shopId,
      }),
    ]);
    botToken = plaintextCredential.botToken;
    chatId = plaintextChatId;
  } catch (error) {
    return classifyProviderError(error);
  }

  try {
    const locale = resolveTelegramLocale({
      explicitPreference: jobContext.preferredLocale,
      identityPreference: jobContext.identityLocale,
      requestLanguage: jobContext.orderLocale,
      shopDefaultLocale: jobContext.shopDefaultLocale,
    });
    const notification = telegramPaidOrderNotification(locale, jobContext.orderNumber, jobContext.orderPublicId);
    if (input.beforeProviderAttempt !== undefined) await input.beforeProviderAttempt();
    await new TelegramClient(botToken, input.fetcher).sendMessage({
      chatId,
      keyboard: notification.keyboard,
      text: notification.text,
    });
    return { kind: "delivered" };
  } catch (error) {
    return classifyProviderError(error);
  }
}
