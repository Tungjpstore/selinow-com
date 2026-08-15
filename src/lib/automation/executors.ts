import { createId } from "../core/ids";
import type { AppBindings } from "../platform/bindings";
import { TelegramClient, TelegramProviderError } from "../telegram/client";
import { decryptTelegramRecipientRow, loadActiveTelegramCredential } from "../telegram/credentials";
import { createD1AutomationRuleRepository } from "./rules/repository";
import type { RuleActionRun, RuleEventPayload } from "./rules/types";
import { assertSafeWebhookUrl } from "./rules/webhook-guard";
import type { AutomationExecutionReference, AutomationExecutionResult, AutomationExecutor } from "./types";

const SHOP_REFERENCE = /^d1:shop\/([A-Za-z0-9][A-Za-z0-9._:-]{2,127})$/u;

function shopIdFromReference(inputReference: string, expectedShopId: string): string | null {
  const match = SHOP_REFERENCE.exec(inputReference);
  if (match === null || match[1] !== expectedShopId) return null;
  return match[1];
}

async function verifyShopProvision(
  env: AppBindings,
  reference: { inputReference: string; shopId: string },
): Promise<"completed" | "retry" | "failed"> {
  const shopId = shopIdFromReference(reference.inputReference, reference.shopId);
  if (shopId === null) return "failed";
  const row = await env.PLATFORM_DB.prepare(`
    SELECT status
    FROM shops
    WHERE id = ?
    LIMIT 1
  `).bind(shopId).first<{ status: string }>();
  if (row === null) return "failed";
  return row.status === "archived" ? "failed" : "completed";
}

async function verifyPlatformDomain(
  env: AppBindings,
  reference: { inputReference: string; shopId: string },
): Promise<"completed" | "retry" | "failed"> {
  const shopId = shopIdFromReference(reference.inputReference, reference.shopId);
  if (shopId === null) return "failed";
  const row = await env.PLATFORM_DB.prepare(`
    SELECT status
    FROM shop_domains
    WHERE shop_id = ? AND type = 'platform_subdomain'
    LIMIT 1
  `).bind(shopId).first<{ status: string }>();
  if (row === null) return "retry";
  if (row.status === "active") return "completed";
  if (row.status === "deleted" || row.status === "suspended") return "failed";
  return "retry";
}

/**
 * These executors only verify Selinow-owned state. Provider side effects stay
 * behind explicit adapters and are represented as waiting tasks until consent
 * and provider evidence exist.
 */
export function createAutomationExecutors(
  env: AppBindings,
  overrides?: { fetcher?: typeof fetch },
): ReadonlyMap<string, AutomationExecutor> {
  const fetcher = overrides?.fetcher ?? fetch;
  const verifyShop: AutomationExecutor = async (reference) => {
    const result = await verifyShopProvision(env, reference);
    if (result === "completed") return { outcome: "completed" };
    if (result === "failed") return { outcome: "failed", safeErrorCode: "automation_shop_invalid" };
    return { outcome: "retry", safeErrorCode: "automation_shop_unavailable" };
  };

  const verifyDomain: AutomationExecutor = async (reference) => {
    const result = await verifyPlatformDomain(env, reference);
    if (result === "completed") return { outcome: "completed" };
    if (result === "failed") return { outcome: "failed", safeErrorCode: "automation_domain_invalid" };
    return { outcome: "retry", safeErrorCode: "automation_domain_unavailable" };
  };

  return new Map<string, AutomationExecutor>([
    ["shop.provision", verifyShop],
    ["domain.platform.provision", verifyDomain],
    ["rule_notify_telegram", createRuleTelegramExecutor(env, fetcher)],
    ["rule_call_webhook", createRuleWebhookExecutor(env, fetcher)],
    ["rule_tag_customer", createRuleTagExecutor(env)],
    // The visible manual-review task IS the waiting_user task the dispatcher
    // created; resuming it needs no extra side effect here.
    ["rule_create_task", () => Promise.resolve({ outcome: "completed" as const })],
  ]);
}

/* ------------------------- seller rule executors ------------------------- */

const RUN_REFERENCE = /^action:rule-run\/([A-Za-z0-9][A-Za-z0-9._-]{1,127})$/u;
const RULE_TAG = /^[A-Za-z0-9 ._-]{1,40}$/u;
const MAX_RULE_MESSAGE_LENGTH = 1000;
const WEBHOOK_TIMEOUT_MS = 10_000;

/** Closed placeholder list; values come from the safe payload projection only. */
const RULE_PLACEHOLDER = /\{\{(order\.number|order\.public_id|order\.total|order\.currency|customer\.id|stock\.sku|stock\.remaining|payment\.reason|rule\.name)\}\}/gu;

export function renderRuleTemplate(template: string, payload: RuleEventPayload, ruleName: string): string {
  return template.replace(RULE_PLACEHOLDER, (_match, key: string) => {
    if (key === "rule.name") return ruleName;
    if (key === "order.total") {
      const total = payload["order.total_minor"];
      return typeof total === "number" ? String(total) : "";
    }
    const value = payload[key];
    return typeof value === "boolean" || typeof value === "number" || typeof value === "string" ? String(value) : "";
  });
}

async function loadRuleRun(
  env: AppBindings,
  reference: AutomationExecutionReference,
): Promise<RuleActionRun | null> {
  const match = RUN_REFERENCE.exec(reference.inputReference);
  if (match === null || match[1] === undefined) return null;
  const repository = createD1AutomationRuleRepository(env.PLATFORM_DB);
  return repository.getRun({ runId: match[1], shopId: reference.shopId });
}

async function loadRuleName(env: AppBindings, run: RuleActionRun): Promise<string> {
  const row = await env.PLATFORM_DB.prepare(
    "SELECT name FROM automation_rules WHERE id = ? AND shop_id = ? LIMIT 1",
  )
    .bind(run.ruleId, run.shopId)
    .first<{ name: string }>();
  return row?.name ?? "";
}

function payloadCustomerId(run: RuleActionRun): string | null {
  const value = run.eventPayload["customer.id"];
  return typeof value === "string" && value.length > 0 ? value : null;
}

type RecipientRow = {
  chatIdCiphertextB64: string;
  chatIdIvB64: string;
  identityId: string;
  keyVersion: string;
  status: string;
};

async function loadTelegramRecipient(
  env: AppBindings,
  shopId: string,
  integrationId: string,
  customerId: string,
): Promise<RecipientRow | null> {
  // Same recipient resolution as delivery/telegram.ts (last seen identity).
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

function createRuleTelegramExecutor(env: AppBindings, fetchImpl: typeof fetch): AutomationExecutor {
  return async (reference): Promise<AutomationExecutionResult> => {
    const run = await loadRuleRun(env, reference);
    if (run === null) return { outcome: "failed", safeErrorCode: "rule_run_missing" };
    const message = run.actionConfig.message;
    if (typeof message !== "string" || message.length === 0 || message.length > MAX_RULE_MESSAGE_LENGTH) {
      return { outcome: "failed", safeErrorCode: "rule_run_invalid" };
    }
    const customerId = payloadCustomerId(run);
    if (customerId === null) {
      return { outcome: "failed", safeErrorCode: "rule_telegram_recipient_missing" };
    }
    const integration = await env.PLATFORM_DB.prepare(
      "SELECT id FROM telegram_integrations WHERE shop_id = ? AND status IN ('active', 'degraded') ORDER BY id DESC LIMIT 1",
    )
      .bind(run.shopId)
      .first<{ id: string }>();
    if (integration === null) {
      return { outcome: "failed", safeErrorCode: "rule_telegram_not_configured" };
    }
    let botToken: string;
    try {
      const loaded = await loadActiveTelegramCredential(env, integration.id, run.shopId);
      botToken = loaded.credentials.botToken;
    } catch {
      return { outcome: "failed", safeErrorCode: "rule_telegram_not_configured" };
    }
    const recipient = await loadTelegramRecipient(env, run.shopId, integration.id, customerId);
    if (recipient === null) {
      return { outcome: "failed", safeErrorCode: "rule_telegram_recipient_missing" };
    }
    let chatId: string;
    try {
      chatId = await decryptTelegramRecipientRow(env, {
        ciphertextB64: recipient.chatIdCiphertextB64,
        identityId: recipient.identityId,
        integrationId: integration.id,
        ivB64: recipient.chatIdIvB64,
        keyVersion: recipient.keyVersion,
        shopId: run.shopId,
      });
    } catch {
      return { outcome: "failed", safeErrorCode: "rule_telegram_recipient_missing" };
    }
    const ruleName = await loadRuleName(env, run);
    const text = renderRuleTemplate(message, run.eventPayload, ruleName);
    if (text.length === 0) return { outcome: "failed", safeErrorCode: "rule_run_invalid" };
    try {
      // Bot token stays inside the client closure; never logged or stored.
      await new TelegramClient(botToken, fetchImpl).sendMessage({ chatId, text });
      return { outcome: "completed" };
    } catch (error) {
      if (error instanceof TelegramProviderError) {
        if (error.code === "telegram_rate_limited" || error.code === "provider_unavailable" || error.code === "provider_timeout" || error.providerStatus >= 500) {
          const result: AutomationExecutionResult = {
            outcome: "retry",
            ...(error.retryAfter === null ? {} : { retryAfterSeconds: error.retryAfter }),
            safeErrorCode: "rule_telegram_unavailable",
          };
          return result;
        }
        if (error.code === "telegram_recipient_unavailable") {
          return { outcome: "failed", safeErrorCode: "rule_telegram_recipient_unavailable" };
        }
        return { outcome: "failed", safeErrorCode: "rule_telegram_rejected" };
      }
      return { outcome: "retry", safeErrorCode: "rule_telegram_unavailable" };
    }
  };
}

function createRuleWebhookExecutor(env: AppBindings, fetchImpl: typeof fetch): AutomationExecutor {
  return async (reference): Promise<AutomationExecutionResult> => {
    const run = await loadRuleRun(env, reference);
    if (run === null) return { outcome: "failed", safeErrorCode: "rule_run_missing" };
    let url: string;
    try {
      url = assertSafeWebhookUrl(run.actionConfig.url);
    } catch {
      return { outcome: "failed", safeErrorCode: "rule_webhook_unsafe" };
    }
    const ruleName = await loadRuleName(env, run);
    const body = JSON.stringify({
      trigger: run.triggerType,
      rule: { id: run.ruleId, name: ruleName },
      event: run.eventPayload,
    });
    let response: Response;
    try {
      response = await fetchImpl(url, {
        body,
        headers: { "Content-Type": "application/json" },
        method: "POST",
        redirect: "error",
        signal: AbortSignal.timeout(WEBHOOK_TIMEOUT_MS),
      });
    } catch {
      return { outcome: "retry", safeErrorCode: "rule_webhook_unavailable" };
    }
    // Status only; the response body is never read (no exfiltration channel).
    if (response.status >= 200 && response.status < 300) return { outcome: "completed" };
    if (response.status >= 400 && response.status < 500) {
      return { outcome: "failed", safeErrorCode: "rule_webhook_rejected" };
    }
    return { outcome: "retry", safeErrorCode: "rule_webhook_unavailable" };
  };
}

function createRuleTagExecutor(env: AppBindings): AutomationExecutor {
  return async (reference): Promise<AutomationExecutionResult> => {
    const run = await loadRuleRun(env, reference);
    if (run === null) return { outcome: "failed", safeErrorCode: "rule_run_missing" };
    const tag = run.actionConfig.tag;
    if (typeof tag !== "string" || !RULE_TAG.test(tag)) {
      return { outcome: "failed", safeErrorCode: "rule_tag_invalid" };
    }
    const customerId = payloadCustomerId(run);
    if (customerId === null) return { outcome: "failed", safeErrorCode: "rule_customer_missing" };
    const customer = await env.PLATFORM_DB.prepare(
      "SELECT 1 AS found FROM shop_customers WHERE id = ? AND shop_id = ? LIMIT 1",
    )
      .bind(customerId, run.shopId)
      .first<{ found: number }>();
    if (customer === null) return { outcome: "failed", safeErrorCode: "rule_customer_missing" };
    await env.PLATFORM_DB.prepare(
      `INSERT OR IGNORE INTO automation_customer_tags
        (id, shop_id, customer_id, tag, source_rule_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
      .bind(createId("actag"), run.shopId, customerId, tag, run.ruleId, new Date().toISOString())
      .run();
    // INSERT OR IGNORE + UNIQUE(shop_id, customer_id, tag) keeps this
    // naturally idempotent: re-tagging still completes.
    return { outcome: "completed" };
  };
}
