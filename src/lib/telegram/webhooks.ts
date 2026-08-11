import { sha256Json } from "../core/crypto";
import { subscriptionAllows } from "../billing/entitlements";
import { AppError } from "../core/errors";
import { createId } from "../core/ids";
import { readJsonObject } from "../http/request";
import type { AppBindings } from "../platform/bindings";
import { TelegramClient, TelegramProviderError } from "./client";
import { decryptTelegramCredentialRow, loadTelegramWebhookIntegration, verifyTelegramWebhookSecret } from "./credentials";
import { handleTelegramCommerce } from "./commerce";
import { resolveTelegramLocale, telegramText } from "./localization";
import { parseTelegramUpdate } from "./policy";
import type { TelegramCallbackUpdate, TelegramMessageUpdate, TelegramUpdate } from "./types";

type UpdateRow = {
  id: string;
  payloadHash: string;
  status: string;
  updatedAt: string;
};

export type TelegramWebhookResult = {
  duplicate: boolean;
  processed: boolean;
  state: string;
};

async function auditPayloadConflict(input: { env: AppBindings; integrationId: string; requestId: string; shopId: string; updateId: number }): Promise<void> {
  const now = new Date().toISOString();
  await input.env.PLATFORM_DB.batch([
    input.env.PLATFORM_DB.prepare("UPDATE telegram_updates SET status = 'rejected', safe_result_code = 'telegram_update_payload_conflict', processed_at = ?, updated_at = ? WHERE integration_id = ? AND update_id = ?").bind(now, now, input.integrationId, input.updateId),
    input.env.PLATFORM_DB.prepare(`INSERT INTO audit_logs (id, shop_id, actor_type, actor_id, action, resource_type, resource_id, safe_metadata_json, request_id, created_at) VALUES (?, ?, 'system', NULL, 'telegram.update_payload_conflict', 'telegram_integration', ?, ?, ?, ?)`).bind(createId("aud"), input.shopId, input.integrationId, JSON.stringify({ updateId: input.updateId }), input.requestId, now),
  ]);
}

async function claimExistingUpdate(input: {
  env: AppBindings;
  existing: UpdateRow;
  integrationId: string;
  payloadHash: string;
}): Promise<{ duplicate: boolean; rowId: string; shouldProcess: boolean }> {
  if (input.existing.payloadHash !== input.payloadHash) {
    throw new AppError("telegram_update_payload_conflict", 409);
  }
  if (input.existing.status === "processed" || input.existing.status === "rejected") {
    return { duplicate: true, rowId: input.existing.id, shouldProcess: false };
  }
  const staleBefore = new Date(Date.now() - 60_000).toISOString();
  const claimed = await input.env.PLATFORM_DB.prepare("UPDATE telegram_updates SET status = 'processing', attempts = attempts + 1, updated_at = ? WHERE id = ? AND integration_id = ? AND (status IN ('accepted', 'failed') OR (status = 'processing' AND updated_at <= ?))").bind(new Date().toISOString(), input.existing.id, input.integrationId, staleBefore).run();
  return { duplicate: true, rowId: input.existing.id, shouldProcess: claimed.meta.changes === 1 };
}

async function registerUpdate(input: { env: AppBindings; integrationId: string; kind: TelegramUpdate["kind"]; payloadHash: string; requestId: string; shopId: string; updateId: number }): Promise<{ duplicate: boolean; rowId: string; shouldProcess: boolean }> {
  const existing = await input.env.PLATFORM_DB.prepare("SELECT id, payload_hash AS payloadHash, status, updated_at AS updatedAt FROM telegram_updates WHERE integration_id = ? AND update_id = ? LIMIT 1").bind(input.integrationId, input.updateId).first<UpdateRow>();
  if (existing !== null) {
    if (existing.payloadHash !== input.payloadHash) await auditPayloadConflict(input);
    return claimExistingUpdate({ ...input, existing });
  }
  const rowId = createId("tgu");
  const now = new Date().toISOString();
  try {
    await input.env.PLATFORM_DB.prepare("INSERT INTO telegram_updates (id, shop_id, integration_id, update_id, payload_hash, update_kind, status, attempts, received_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'processing', 1, ?, ?)").bind(rowId, input.shopId, input.integrationId, input.updateId, input.payloadHash, input.kind, now, now).run();
    return { duplicate: false, rowId, shouldProcess: true };
  } catch {
    // A concurrent delivery may have inserted the unique update row. Re-read
    // once; persistent storage failures must remain fail-closed.
    const raced = await input.env.PLATFORM_DB.prepare("SELECT id, payload_hash AS payloadHash, status, updated_at AS updatedAt FROM telegram_updates WHERE integration_id = ? AND update_id = ? LIMIT 1").bind(input.integrationId, input.updateId).first<UpdateRow>();
    if (raced === null) throw new AppError("telegram_update_record_failed", 500);
    if (raced.payloadHash !== input.payloadHash) await auditPayloadConflict(input);
    return claimExistingUpdate({ ...input, existing: raced });
  }
}

async function markProcessed(env: AppBindings, input: { credentialId: string; integrationId: string; rowId: string; shopId: string }, resultCode: string): Promise<void> {
  const now = new Date().toISOString();
  await env.PLATFORM_DB.batch([
    env.PLATFORM_DB.prepare("UPDATE telegram_updates SET status = 'processed', safe_result_code = ?, processed_at = ?, updated_at = ? WHERE id = ? AND integration_id = ? AND shop_id = ? AND status IN ('processing', 'failed')").bind(resultCode, now, now, input.rowId, input.integrationId, input.shopId),
    env.PLATFORM_DB.prepare("UPDATE telegram_integrations SET last_update_at = ?, last_safe_error_code = CASE WHEN status = 'active' THEN NULL ELSE last_safe_error_code END, updated_at = ? WHERE id = ? AND shop_id = ? AND active_credential_id = ? AND status IN ('active', 'degraded')").bind(now, now, input.integrationId, input.shopId, input.credentialId),
  ]);
}

// Telegram sendMessage has no idempotency key. A terminal pre-send claim gives
// replies at-most-once attempt semantics: ambiguous provider failures may lose
// a reply, but a webhook retry cannot send the same update again.
async function claimReplyAttempt(
  env: AppBindings,
  input: { credentialId: string; integrationId: string; rowId: string; shopId: string },
  resultCode: string,
): Promise<void> {
  const now = new Date().toISOString();
  const results = await env.PLATFORM_DB.batch([
    env.PLATFORM_DB.prepare(`
      UPDATE telegram_updates
      SET status = 'processed', safe_result_code = ?, processed_at = ?, updated_at = ?
      WHERE id = ? AND integration_id = ? AND shop_id = ? AND status = 'processing'
        AND EXISTS (
          SELECT 1 FROM telegram_integrations
          INNER JOIN telegram_credentials
            ON telegram_credentials.id = telegram_integrations.active_credential_id
            AND telegram_credentials.integration_id = telegram_integrations.id
            AND telegram_credentials.shop_id = telegram_integrations.shop_id
            AND telegram_credentials.status = 'active'
          WHERE telegram_integrations.id = ?
            AND telegram_integrations.shop_id = ?
            AND telegram_integrations.active_credential_id = ?
            AND telegram_integrations.status IN ('active', 'degraded')
        )
    `).bind(
      resultCode,
      now,
      now,
      input.rowId,
      input.integrationId,
      input.shopId,
      input.integrationId,
      input.shopId,
      input.credentialId,
    ),
    env.PLATFORM_DB.prepare(`
      UPDATE telegram_integrations
      SET last_update_at = ?,
        last_safe_error_code = CASE WHEN status = 'active' THEN NULL ELSE last_safe_error_code END,
        updated_at = ?
      WHERE id = ? AND shop_id = ? AND active_credential_id = ?
        AND status IN ('active', 'degraded')
    `).bind(now, now, input.integrationId, input.shopId, input.credentialId),
  ]);
  if (results[0]?.meta.changes !== 1) throw new AppError("telegram_update_claim_lost", 409);
}

async function markFailed(env: AppBindings, input: { credentialId: string; integrationId: string; rowId: string; shopId: string }, code: string): Promise<void> {
  const now = new Date().toISOString();
  await env.PLATFORM_DB.prepare("UPDATE telegram_updates SET status = 'failed', safe_result_code = ?, updated_at = ? WHERE id = ? AND integration_id = ? AND shop_id = ? AND status IN ('processing', 'failed')").bind(code, now, input.rowId, input.integrationId, input.shopId).run();
}

async function answerCallback(client: TelegramClient, update: TelegramUpdate, text?: string): Promise<void> {
  if (update.kind !== "callback_query" && update.kind !== "unsupported_callback_query") return;
  try { await client.answerCallbackQuery(update.callbackId, text); } catch { /* Callback acknowledgement must not repeat a business mutation. */ }
}

async function handleNonPrivate(input: { botUsername: string | null; client: TelegramClient; locale: string; update: TelegramCallbackUpdate | TelegramMessageUpdate }): Promise<void> {
  const botLink = input.botUsername === null
    ? telegramText(input.locale, "webhook.openPrivate")
    : telegramText(input.locale, "webhook.privateLink", { url: `https://t.me/${input.botUsername}` });
  await input.client.sendMessage({ chatId: String(input.update.chat.id), text: telegramText(input.locale, "webhook.privateOnly", { link: botLink }) });
}

async function markProviderDegraded(env: AppBindings, input: { credentialId: string; integrationId: string; shopId: string }, code: string): Promise<void> {
  const now = new Date().toISOString();
  await env.PLATFORM_DB.prepare("UPDATE telegram_integrations SET status = 'degraded', last_safe_error_code = ?, last_checked_at = ?, updated_at = ? WHERE id = ? AND shop_id = ? AND active_credential_id = ? AND status != 'disabled'").bind(code, now, now, input.integrationId, input.shopId, input.credentialId).run();
}

async function isCurrentGeneration(input: { env: AppBindings; credentialId: string; integrationId: string; shopId: string }): Promise<boolean> {
  const row = await input.env.PLATFORM_DB.prepare(`
    SELECT telegram_integrations.active_credential_id AS activeCredentialId
    FROM telegram_integrations
    INNER JOIN telegram_credentials
      ON telegram_credentials.id = telegram_integrations.active_credential_id
      AND telegram_credentials.integration_id = telegram_integrations.id
      AND telegram_credentials.shop_id = telegram_integrations.shop_id
      AND telegram_credentials.status = 'active'
    WHERE telegram_integrations.id = ?
      AND telegram_integrations.shop_id = ?
      AND telegram_integrations.active_credential_id = ?
      AND telegram_integrations.status IN ('active', 'degraded')
    LIMIT 1
  `).bind(input.integrationId, input.shopId, input.credentialId).first<{ activeCredentialId: string }>();
  return row?.activeCredentialId === input.credentialId;
}

async function rejectStaleGeneration(input: { env: AppBindings; integrationId: string; requestId: string; rowId: string; shopId: string; updateId: number }): Promise<void> {
  const now = new Date().toISOString();
  await input.env.PLATFORM_DB.batch([
    input.env.PLATFORM_DB.prepare("UPDATE telegram_updates SET status = 'rejected', safe_result_code = 'telegram_update_stale_generation', processed_at = ?, updated_at = ? WHERE id = ? AND integration_id = ? AND shop_id = ? AND status IN ('processing', 'failed')").bind(now, now, input.rowId, input.integrationId, input.shopId),
    input.env.PLATFORM_DB.prepare("INSERT INTO audit_logs (id, shop_id, actor_type, actor_id, action, resource_type, resource_id, safe_metadata_json, request_id, created_at) VALUES (?, ?, 'system', NULL, 'telegram.update_stale_generation', 'telegram_integration', ?, ?, ?, ?)").bind(createId("aud"), input.shopId, input.integrationId, JSON.stringify({ updateId: input.updateId }), input.requestId, now),
  ]);
}

function providerResult(error: TelegramProviderError): "recipient" | "retry" | "terminal" {
  if (error.code === "telegram_recipient_unavailable") return "recipient";
  if (error.code === "telegram_unauthorized") return "terminal";
  return "retry";
}

export function isDraftTelegramHealthStart(update: TelegramUpdate): boolean {
  if (update.kind !== "message" || update.chat.type !== "private") return false;
  const tokens = update.text.trim().split(/\s+/u);
  if (tokens.length !== 1) return false;
  const command = (tokens[0] ?? "").toLowerCase().replace(/@[a-z0-9_]+$/u, "");
  return command === "/start";
}

async function handleDraftHealthStart(input: {
  client: TelegramClient;
  credentialId: string;
  env: AppBindings;
  integrationId: string;
  locale: string;
  shopId: string;
  update: TelegramUpdate;
}): Promise<void> {
  if (input.update.kind !== "message") throw new AppError("telegram_update_invalid", 400);
  await input.client.sendMessage({
    chatId: String(input.update.chat.id),
    text: telegramText(input.locale, "webhook.draftConnected"),
  });
  const now = new Date().toISOString();
  await input.env.PLATFORM_DB.prepare("UPDATE telegram_integrations SET last_health_update_at = ?, last_update_at = ?, last_outbound_at = ?, last_safe_error_code = NULL, updated_at = ? WHERE id = ? AND shop_id = ? AND active_credential_id = ? AND status IN ('active', 'degraded')").bind(now, now, now, now, input.integrationId, input.shopId, input.credentialId).run();
}

export async function processTelegramWebhook(input: { env: AppBindings; fetcher?: typeof fetch; request: Request; requestId: string; webhookPublicId: string }): Promise<TelegramWebhookResult> {
  const integration = await loadTelegramWebhookIntegration(input.env, input.webhookPublicId);
  if (!await verifyTelegramWebhookSecret(input.env, integration, input.request.headers.get("X-Telegram-Bot-Api-Secret-Token"))) throw new AppError("telegram_webhook_invalid", 401);
  const subscriptionAllowsHealth = subscriptionAllows({
    currentPeriodEnd: integration.currentPeriodEnd,
    graceEndsAt: integration.graceEndsAt,
    subscriptionState: integration.subscriptionState,
    trialEndsAt: integration.trialEndsAt,
  });
  const commerceAllowed = integration.shopStatus === "active" && subscriptionAllowsHealth;
  const draftHealthAllowed = integration.shopStatus === "draft" && subscriptionAllowsHealth;
  if (!commerceAllowed && !draftHealthAllowed) throw new AppError("tenant_suspended", 403);
  const body = await readJsonObject(input.request, 64 * 1024);
  const [payloadHash, update] = await Promise.all([sha256Json(body), Promise.resolve(parseTelegramUpdate(body))]);
  const locale = resolveTelegramLocale({ requestLanguage: update.user.languageCode, shopDefaultLocale: integration.defaultLocale });
  // The SQL ledger predates inline callback handling and only admits the two
  // provider update kinds; retain the durable callback bucket for unsupported
  // inline callbacks while returning an explicit ignored state.
  const updateKind = update.kind === "unsupported_callback_query" ? "callback_query" : update.kind;
  const registered = await registerUpdate({ env: input.env, integrationId: integration.integrationId, kind: updateKind, payloadHash, requestId: input.requestId, shopId: integration.shopId, updateId: update.updateId });
  const credentials = await decryptTelegramCredentialRow(input.env, integration.credential);
  const client = new TelegramClient(credentials.botToken, input.fetcher);
  const generation = { credentialId: integration.credential.credentialId, env: input.env, integrationId: integration.integrationId, shopId: integration.shopId };
  const updateLedger = { credentialId: integration.credential.credentialId, integrationId: integration.integrationId, rowId: registered.rowId, shopId: integration.shopId };
  let replyAttemptClaimed = false;
  const rejectIfStale = async (): Promise<boolean> => {
    if (await isCurrentGeneration(generation)) return false;
    await rejectStaleGeneration({ env: input.env, integrationId: integration.integrationId, requestId: input.requestId, rowId: registered.rowId, shopId: integration.shopId, updateId: update.updateId });
    return true;
  };
  if (!registered.shouldProcess) {
    return { duplicate: true, processed: false, state: "duplicate" };
  }
  if (await rejectIfStale()) {
    return { duplicate: registered.duplicate, processed: false, state: "stale_generation" };
  }
  if (update.kind === "unsupported_callback_query") {
    if (await rejectIfStale()) return { duplicate: registered.duplicate, processed: false, state: "stale_generation" };
    await claimReplyAttempt(input.env, updateLedger, "callback_unsupported");
    await answerCallback(client, update, telegramText(locale, "webhook.callbackPrivate"));
    return { duplicate: registered.duplicate, processed: true, state: "callback_unsupported" };
  }
  if (update.user.isBot) {
    await markProcessed(input.env, updateLedger, "bot_actor_ignored");
    return { duplicate: registered.duplicate, processed: true, state: "ignored" };
  }
  if (update.kind === "message" && update.text.length === 0) {
    await markProcessed(input.env, updateLedger, "message_unsupported");
    return { duplicate: registered.duplicate, processed: true, state: "ignored" };
  }
  if (draftHealthAllowed) {
    if (!isDraftTelegramHealthStart(update)) {
      await markProcessed(input.env, updateLedger, "draft_action_blocked");
      return { duplicate: registered.duplicate, processed: true, state: "draft_action_blocked" };
    }
    try {
      if (await rejectIfStale()) return { duplicate: registered.duplicate, processed: false, state: "stale_generation" };
      await claimReplyAttempt(input.env, updateLedger, "draft_health_confirmed");
      replyAttemptClaimed = true;
      await handleDraftHealthStart({ client, credentialId: integration.credential.credentialId, env: input.env, integrationId: integration.integrationId, locale, shopId: integration.shopId, update });
      return { duplicate: registered.duplicate, processed: true, state: "draft_health_confirmed" };
    } catch (error) {
      const code = error instanceof AppError ? error.code : "internal_error";
      await markFailed(input.env, updateLedger, code);
      if (error instanceof TelegramProviderError) await markProviderDegraded(input.env, generation, error.code);
      throw error;
    }
  }
  try {
    if (update.chat.type !== "private") {
      if (await rejectIfStale()) return { duplicate: registered.duplicate, processed: false, state: "stale_generation" };
      await claimReplyAttempt(input.env, updateLedger, "private_chat_required");
      replyAttemptClaimed = true;
      await handleNonPrivate({ botUsername: integration.botUsername, client, locale, update });
      if (await isCurrentGeneration(generation)) await answerCallback(client, update, telegramText(locale, "webhook.callbackPrivate"));
      return { duplicate: registered.duplicate, processed: true, state: "private_chat_required" };
    }
    if (await rejectIfStale()) return { duplicate: registered.duplicate, processed: false, state: "stale_generation" };
    const result = await handleTelegramCommerce({ env: input.env, ...(input.fetcher === undefined ? {} : { fetcher: input.fetcher }), integrationId: integration.integrationId, shopId: integration.shopId, update });
    if (await rejectIfStale()) return { duplicate: registered.duplicate, processed: false, state: "stale_generation" };
    await claimReplyAttempt(input.env, updateLedger, result.resultCode);
    replyAttemptClaimed = true;
    await client.sendMessage({ chatId: result.identity.chatId, ...(result.reply.keyboard === undefined ? {} : { keyboard: result.reply.keyboard }), ...(result.reply.protectContent === undefined ? {} : { protectContent: result.reply.protectContent }), text: result.reply.text });
    if (await isCurrentGeneration(generation)) await answerCallback(client, update);
    const now = new Date().toISOString();
    const healthAt = isDraftTelegramHealthStart(update) ? now : null;
    await input.env.PLATFORM_DB.batch([
      input.env.PLATFORM_DB.prepare("UPDATE telegram_recipients SET last_outbound_at = ?, last_safe_error_code = NULL, status = 'active', updated_at = ? WHERE integration_id = ? AND customer_identity_id = ?").bind(now, now, integration.integrationId, result.identity.identityId),
      input.env.PLATFORM_DB.prepare("UPDATE telegram_integrations SET last_outbound_at = ?, last_health_update_at = COALESCE(?, last_health_update_at), updated_at = ? WHERE id = ? AND shop_id = ? AND active_credential_id = ? AND status IN ('active', 'degraded')").bind(now, healthAt, now, integration.integrationId, integration.shopId, integration.credential.credentialId),
    ]);
    return { duplicate: registered.duplicate, processed: true, state: result.resultCode };
  } catch (error) {
    const code = error instanceof AppError ? error.code : "internal_error";
    if (!replyAttemptClaimed) {
      try {
        await claimReplyAttempt(input.env, updateLedger, code);
        replyAttemptClaimed = true;
      } catch { /* Leave the update retryable when the terminal attempt cannot be claimed. */ }
    }
    if (replyAttemptClaimed && await isCurrentGeneration(generation)) {
      await answerCallback(client, update, telegramText(locale, "webhook.callbackError"));
    }
    await markFailed(input.env, updateLedger, code);
    if (error instanceof TelegramProviderError) {
      const classification = providerResult(error);
      if (classification === "terminal") {
        await markProviderDegraded(input.env, generation, error.code);
        return { duplicate: registered.duplicate, processed: false, state: "degraded" };
      }
      if (classification === "recipient") {
        await markProcessed(input.env, updateLedger, error.code);
        return { duplicate: registered.duplicate, processed: false, state: error.code };
      }
    }
    throw error;
  }
}

export function isTelegramCallbackUpdate(update: TelegramUpdate): update is TelegramCallbackUpdate {
  return update.kind === "callback_query";
}
