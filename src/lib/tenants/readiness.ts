import { AppError } from "../core/errors";
import { subscriptionAllows } from "../billing/entitlements";
import { createId } from "../core/ids";
import { tryRecordActivationMilestone } from "../analytics/activation";
import { CURRENT_POLICY_ATTESTATION_VERSION } from "../onboarding/policy";
import type { AppBindings } from "../platform/bindings";
import { getShopForMember } from "./store";

const PAYOS_HEALTH_TTL_MS = 24 * 60 * 60_000;
const TELEGRAM_HEALTH_TTL_MS = 30 * 24 * 60 * 60_000;

export type ReadinessCheck = {
  actionUrl?: string;
  checkedAt: string;
  code: string;
  messageKey: string;
  required: boolean;
  status: "fail" | "pass" | "warning";
};

export type ReadinessResult = {
  checkedAt: string;
  checks: ReadinessCheck[];
  readinessVersion: number;
  ready: boolean;
  runId: string | null;
};

export type ReadinessTrigger = "manual" | "publish" | "test";

export type ReadinessSnapshot = {
  canonicalDomainReady: boolean;
  catalogReady: boolean;
  criticalIntegrationError: boolean;
  customDomainPreference: "connect" | "later" | "skip";
  customDomainReady: boolean;
  fulfillmentReady: boolean;
  payosLastCheckedAt: string | null;
  payosLastWebhookVerifiedAt: string | null;
  payosStatus: string | null;
  payosWebhookStatus: string | null;
  platformDomainReady: boolean;
  policyAttestationVersion: number | null;
  policyAttestedAt: string | null;
  privacyUrl: string | null;
  readinessVersion: number;
  refundPolicyUrl: string | null;
  shopStatus: string;
  storefrontEntitled: boolean;
  subscriptionState: string;
  trialEndsAt?: string | null;
  graceEndsAt?: string | null;
  supportContact: string | null;
  telegramEnabled: boolean;
  telegramEntitled: boolean;
  telegramLastHealthUpdateAt: string | null;
  telegramStatus: string | null;
  telegramWebhookStatus: string | null;
  termsUrl: string | null;
  websiteEnabled: boolean;
};

type ReadinessRow = {
  canonicalDomainReady: number;
  catalogReady: number;
  criticalIntegrationError: number;
  customDomainPreference: "connect" | "later" | "skip";
  customDomainReady: number;
  fulfillmentReady: number;
  payosLastCheckedAt: string | null;
  payosLastWebhookVerifiedAt: string | null;
  payosStatus: string | null;
  payosWebhookStatus: string | null;
  platformDomainReady: number;
  policyAttestationVersion: number | null;
  policyAttestedAt: string | null;
  privacyUrl: string | null;
  readinessVersion: number;
  refundPolicyUrl: string | null;
  shopId: string;
  shopStatus: string;
  storefrontEntitled: number;
  subscriptionState: string;
  trialEndsAt: string | null;
  graceEndsAt: string | null;
  supportContact: string | null;
  telegramEnabled: number;
  telegramEntitled: number;
  telegramLastHealthUpdateAt: string | null;
  telegramStatus: string | null;
  telegramWebhookStatus: string | null;
  termsUrl: string | null;
  websiteEnabled: number;
};

function check(input: Omit<ReadinessCheck, "checkedAt">, checkedAt: string): ReadinessCheck {
  return { ...input, checkedAt };
}

function isFreshTimestamp(value: string | null, now: Date, maximumAgeMs: number): boolean {
  if (value === null) return false;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp)
    && timestamp <= now.getTime() + 5 * 60_000
    && timestamp >= now.getTime() - maximumAgeMs;
}

export function evaluateReadinessSnapshot(
  snapshot: ReadinessSnapshot,
  checkedAt = new Date().toISOString(),
): ReadinessResult {
  const now = new Date(checkedAt);
  if (!Number.isFinite(now.getTime())) throw new AppError("validation_failed", 400, ["checked_at_invalid"]);

  const channelSelected = snapshot.websiteEnabled || snapshot.telegramEnabled;
  const channelEntitled = (!snapshot.websiteEnabled || snapshot.storefrontEntitled)
    && (!snapshot.telegramEnabled || snapshot.telegramEntitled);
  const shopPublishable = new Set(["draft", "active"]).has(snapshot.shopStatus);
  const subscriptionPublishable = subscriptionAllows({
    graceEndsAt: snapshot.graceEndsAt,
    now,
    subscriptionState: snapshot.subscriptionState,
    trialEndsAt: snapshot.trialEndsAt,
  });
  const payosReady = snapshot.payosStatus === "active"
    && snapshot.payosWebhookStatus === "verified"
    && isFreshTimestamp(snapshot.payosLastCheckedAt, now, PAYOS_HEALTH_TTL_MS)
    && isFreshTimestamp(snapshot.payosLastWebhookVerifiedAt, now, PAYOS_HEALTH_TTL_MS);
  const telegramReady = !snapshot.telegramEnabled || (
    snapshot.telegramStatus === "active"
    && snapshot.telegramWebhookStatus === "verified"
    && isFreshTimestamp(snapshot.telegramLastHealthUpdateAt, now, TELEGRAM_HEALTH_TTL_MS)
  );
  const policiesReady = snapshot.supportContact !== null
    && snapshot.termsUrl !== null
    && snapshot.privacyUrl !== null
    && snapshot.refundPolicyUrl !== null
    && snapshot.policyAttestedAt !== null
    && snapshot.policyAttestationVersion === CURRENT_POLICY_ATTESTATION_VERSION;

  const checks: ReadinessCheck[] = [
    check({
      actionUrl: "/app",
      code: "shop_state_publishable",
      messageKey: shopPublishable ? "readiness.shop.pass" : "readiness.shop.fail",
      required: true,
      status: shopPublishable ? "pass" : "fail",
    }, checkedAt),
    check({
      actionUrl: "/app",
      code: "subscription_publishable",
      messageKey: subscriptionPublishable ? "readiness.subscription.pass" : "readiness.subscription.fail",
      required: true,
      status: !subscriptionPublishable ? "fail" : snapshot.subscriptionState === "past_due" || snapshot.subscriptionState === "grace_period" ? "warning" : "pass",
    }, checkedAt),
    check({
      actionUrl: "/onboarding#channels",
      code: "channel_selected",
      messageKey: channelSelected ? "readiness.channels.pass" : "readiness.channels.fail",
      required: true,
      status: channelSelected ? "pass" : "fail",
    }, checkedAt),
    check({
      actionUrl: "/onboarding#channels",
      code: "channel_entitlements",
      messageKey: channelEntitled ? "readiness.entitlements.pass" : "readiness.entitlements.fail",
      required: true,
      status: channelEntitled ? "pass" : "fail",
    }, checkedAt),
    check({
      actionUrl: "/onboarding#domain",
      code: "platform_domain_ready",
      messageKey: snapshot.platformDomainReady ? "readiness.platform_domain.pass" : "readiness.platform_domain.fail",
      required: true,
      status: snapshot.platformDomainReady ? "pass" : "fail",
    }, checkedAt),
    check({
      actionUrl: "/onboarding#catalog",
      code: "catalog_ready",
      messageKey: snapshot.catalogReady ? "readiness.catalog.pass" : "readiness.catalog.fail",
      required: true,
      status: snapshot.catalogReady ? "pass" : "fail",
    }, checkedAt),
    check({
      actionUrl: "/onboarding#inventory",
      code: "fulfillment_ready",
      messageKey: snapshot.fulfillmentReady ? "readiness.fulfillment.pass" : "readiness.fulfillment.fail",
      required: true,
      status: snapshot.fulfillmentReady ? "pass" : "fail",
    }, checkedAt),
    check({
      actionUrl: "/onboarding#payos",
      code: "payos_ready",
      messageKey: payosReady ? "readiness.payos.pass" : "readiness.payos.fail",
      required: true,
      status: payosReady ? "pass" : "fail",
    }, checkedAt),
    check({
      actionUrl: "/onboarding#telegram",
      code: "telegram_ready",
      messageKey: !snapshot.telegramEnabled
        ? "readiness.telegram.skipped"
        : telegramReady ? "readiness.telegram.pass" : "readiness.telegram.fail",
      required: snapshot.telegramEnabled,
      status: telegramReady ? "pass" : "fail",
    }, checkedAt),
    check({
      actionUrl: "/onboarding#storefront",
      code: "storefront_ready",
      messageKey: !snapshot.websiteEnabled
        ? "readiness.storefront.skipped"
        : snapshot.canonicalDomainReady ? "readiness.storefront.pass" : "readiness.storefront.fail",
      required: snapshot.websiteEnabled,
      status: !snapshot.websiteEnabled || snapshot.canonicalDomainReady ? "pass" : "fail",
    }, checkedAt),
    check({
      actionUrl: "/onboarding#policies",
      code: "policies_ready",
      messageKey: policiesReady ? "readiness.policies.pass" : "readiness.policies.fail",
      required: true,
      status: policiesReady ? "pass" : "fail",
    }, checkedAt),
    check({
      actionUrl: "/onboarding#readiness",
      code: "integration_health",
      messageKey: snapshot.criticalIntegrationError
        ? "readiness.integration_health.fail"
        : "readiness.integration_health.pass",
      required: true,
      status: snapshot.criticalIntegrationError ? "fail" : "pass",
    }, checkedAt),
    check({
      actionUrl: "/app/domains",
      code: "custom_domain_ready",
      messageKey: snapshot.customDomainPreference !== "connect"
        ? "readiness.custom_domain.skipped"
        : snapshot.customDomainReady ? "readiness.custom_domain.pass" : "readiness.custom_domain.warning",
      required: false,
      status: snapshot.customDomainPreference === "connect" && !snapshot.customDomainReady ? "warning" : "pass",
    }, checkedAt),
  ];

  return {
    checkedAt,
    checks,
    readinessVersion: snapshot.readinessVersion,
    ready: checks.every((item) => !item.required || item.status !== "fail"),
    runId: null,
  };
}

async function loadReadinessRow(env: AppBindings, shopId: string): Promise<ReadinessRow> {
  const row = await env.PLATFORM_DB.prepare(`
    SELECT
      shops.id AS shopId,
      shops.status AS shopStatus,
      shops.readiness_version AS readinessVersion,
      current_subscription.state AS subscriptionState,
      current_subscription.trial_ends_at AS trialEndsAt,
      current_subscription.grace_ends_at AS graceEndsAt,
      CASE WHEN json_extract(plans.feature_flags_json, '$.storefront') = 1 THEN 1 ELSE 0 END AS storefrontEntitled,
      CASE WHEN json_extract(plans.feature_flags_json, '$.telegram') = 1 THEN 1 ELSE 0 END AS telegramEntitled,
      onboarding.website_enabled AS websiteEnabled,
      onboarding.telegram_enabled AS telegramEnabled,
      onboarding.custom_domain_preference AS customDomainPreference,
      settings.support_contact AS supportContact,
      settings.terms_url AS termsUrl,
      settings.privacy_url AS privacyUrl,
      settings.refund_policy_url AS refundPolicyUrl,
      settings.policy_attestation_version AS policyAttestationVersion,
      settings.policy_attested_at AS policyAttestedAt,
      payment_integrations.status AS payosStatus,
      payment_integrations.webhook_status AS payosWebhookStatus,
      payment_integrations.last_checked_at AS payosLastCheckedAt,
      payment_integrations.last_webhook_verified_at AS payosLastWebhookVerifiedAt,
      telegram_integrations.status AS telegramStatus,
      telegram_integrations.webhook_status AS telegramWebhookStatus,
      telegram_integrations.last_health_update_at AS telegramLastHealthUpdateAt,
      EXISTS (
        SELECT 1 FROM shop_domains
        WHERE shop_domains.shop_id = shops.id
          AND shop_domains.type = 'platform_subdomain'
          AND shop_domains.status = 'active'
          AND shop_domains.hostname_normalized = shops.slug || '.' || ?
          AND shop_domains.deleted_at IS NULL
          AND shop_domains.delete_requested_at IS NULL
      ) AS platformDomainReady,
      EXISTS (
        SELECT 1
        FROM shop_domains AS canonical
        WHERE canonical.id = shops.canonical_domain_id
          AND canonical.shop_id = shops.id
          AND canonical.status = 'active'
          AND canonical.is_primary = 1
          AND canonical.deleted_at IS NULL
          AND canonical.delete_requested_at IS NULL
          AND (
            canonical.type = 'platform_subdomain'
            OR (
              canonical.type = 'custom'
              AND canonical.hostname_status = 'active'
              AND canonical.ssl_status = 'active'
              AND canonical.dns_status = 'active'
            )
          )
      ) AS canonicalDomainReady,
      EXISTS (
        SELECT 1 FROM shop_domains
        WHERE shop_domains.shop_id = shops.id
          AND shop_domains.type = 'custom'
          AND shop_domains.status = 'active'
          AND shop_domains.hostname_status = 'active'
          AND shop_domains.ssl_status = 'active'
          AND shop_domains.dns_status = 'active'
          AND shop_domains.deleted_at IS NULL
          AND shop_domains.delete_requested_at IS NULL
      ) AS customDomainReady,
      EXISTS (
        SELECT 1
        FROM products
        INNER JOIN product_variants
          ON product_variants.shop_id = products.shop_id
          AND product_variants.product_id = products.id
          AND product_variants.status = 'active'
        WHERE products.shop_id = shops.id AND products.status = 'active'
      ) AS catalogReady,
      EXISTS (
        SELECT 1
        FROM products
        INNER JOIN product_variants
          ON product_variants.shop_id = products.shop_id
          AND product_variants.product_id = products.id
          AND product_variants.status = 'active'
        WHERE products.shop_id = shops.id
          AND products.status = 'active'
          AND (
            products.fulfillment_type = 'manual'
            OR EXISTS (
              SELECT 1 FROM inventory_keys
              WHERE inventory_keys.shop_id = products.shop_id
                AND inventory_keys.variant_id = product_variants.id
                AND inventory_keys.status = 'available'
            )
          )
      ) AS fulfillmentReady,
      CASE
        WHEN payment_integrations.status = 'error' THEN 1
        WHEN onboarding.telegram_enabled = 1 AND telegram_integrations.status IN ('degraded', 'error') THEN 1
        ELSE 0
      END AS criticalIntegrationError
    FROM shops
    INNER JOIN shop_onboarding_profiles AS onboarding ON onboarding.shop_id = shops.id
    INNER JOIN shop_settings AS settings ON settings.shop_id = shops.id
    INNER JOIN shop_subscriptions AS current_subscription
      ON current_subscription.id = (
        SELECT latest_subscription.id
        FROM shop_subscriptions AS latest_subscription
        WHERE latest_subscription.shop_id = shops.id
        ORDER BY latest_subscription.created_at DESC, latest_subscription.id DESC
        LIMIT 1
      )
    INNER JOIN plans ON plans.id = current_subscription.plan_id
    LEFT JOIN payment_integrations
      ON payment_integrations.shop_id = shops.id AND payment_integrations.provider = 'payos'
    LEFT JOIN telegram_integrations ON telegram_integrations.shop_id = shops.id
    WHERE shops.id = ?
    LIMIT 1
  `).bind(env.PLATFORM_BASE_DOMAIN, shopId).first<ReadinessRow>();
  if (row === null) throw new AppError("onboarding_not_initialized", 409);
  return row;
}

function mapSnapshot(row: ReadinessRow): ReadinessSnapshot {
  return {
    canonicalDomainReady: row.canonicalDomainReady === 1,
    catalogReady: row.catalogReady === 1,
    criticalIntegrationError: row.criticalIntegrationError === 1,
    customDomainPreference: row.customDomainPreference,
    customDomainReady: row.customDomainReady === 1,
    fulfillmentReady: row.fulfillmentReady === 1,
    payosLastCheckedAt: row.payosLastCheckedAt,
    payosLastWebhookVerifiedAt: row.payosLastWebhookVerifiedAt,
    payosStatus: row.payosStatus,
    payosWebhookStatus: row.payosWebhookStatus,
    platformDomainReady: row.platformDomainReady === 1,
    policyAttestationVersion: row.policyAttestationVersion,
    policyAttestedAt: row.policyAttestedAt,
    privacyUrl: row.privacyUrl,
    readinessVersion: row.readinessVersion,
    refundPolicyUrl: row.refundPolicyUrl,
    shopStatus: row.shopStatus,
    storefrontEntitled: row.storefrontEntitled === 1,
    subscriptionState: row.subscriptionState,
    trialEndsAt: row.trialEndsAt,
    graceEndsAt: row.graceEndsAt,
    supportContact: row.supportContact,
    telegramEnabled: row.telegramEnabled === 1,
    telegramEntitled: row.telegramEntitled === 1,
    telegramLastHealthUpdateAt: row.telegramLastHealthUpdateAt,
    telegramStatus: row.telegramStatus,
    telegramWebhookStatus: row.telegramWebhookStatus,
    termsUrl: row.termsUrl,
    websiteEnabled: row.websiteEnabled === 1,
  };
}

async function requireOwnerActor(input: {
  env: AppBindings;
  shopPublicId: string;
  userId: string;
}): Promise<{ shopId: string }> {
  const actor = await getShopForMember({
    capability: "shop:update",
    env: input.env,
    shopPublicId: input.shopPublicId,
    userId: input.userId,
  });
  if (actor.row.role !== "owner") throw new AppError("authorization_denied", 403);
  return { shopId: actor.row.shop_id };
}

export async function getShopReadiness(input: {
  env: AppBindings;
  shopPublicId: string;
  userId: string;
}): Promise<ReadinessResult> {
  const actor = await requireOwnerActor(input);
  const row = await loadReadinessRow(input.env, actor.shopId);
  return evaluateReadinessSnapshot(mapSnapshot(row));
}

function stepState(result: ReadinessResult, snapshot: ReadinessSnapshot, code: string): {
  blockingCode: string | null;
  status: "blocked" | "complete" | "pending" | "skipped";
} {
  const readinessCheck = (checkCode: string) => result.checks.find((item) => item.code === checkCode);
  const fromCheck = (checkCode: string) => {
    const item = readinessCheck(checkCode);
    return item?.status === "pass"
      ? { blockingCode: null, status: "complete" as const }
      : { blockingCode: item?.code ?? checkCode, status: "blocked" as const };
  };
  switch (code) {
    case "account_ready":
    case "shop_created": return { blockingCode: null, status: "complete" };
    case "channel_selected": return fromCheck("channel_selected");
    case "catalog_ready": return fromCheck("catalog_ready");
    case "inventory_ready": return fromCheck("fulfillment_ready");
    case "telegram_ready": return snapshot.telegramEnabled
      ? fromCheck("telegram_ready")
      : { blockingCode: null, status: "skipped" };
    case "payos_ready": return fromCheck("payos_ready");
    case "domain_ready": return fromCheck("platform_domain_ready");
    case "readiness_passed": return result.ready
      ? { blockingCode: null, status: "complete" }
      : { blockingCode: result.checks.find((item) => item.required && item.status === "fail")?.code ?? "readiness_failed", status: "blocked" };
    case "published": return snapshot.shopStatus === "active"
      ? { blockingCode: null, status: "complete" }
      : { blockingCode: null, status: "pending" };
    default: return { blockingCode: "onboarding_step_unknown", status: "blocked" };
  }
}

function currentStep(result: ReadinessResult, snapshot: ReadinessSnapshot): string {
  if (snapshot.shopStatus === "active") return "published";
  const ordered: Array<[string, string]> = [
    ["channel_selected", "channel_selected"],
    ["catalog_ready", "catalog_ready"],
    ["fulfillment_ready", "inventory_ready"],
    ["payos_ready", "payos_ready"],
    ["platform_domain_ready", "domain_ready"],
    ["policies_ready", "domain_ready"],
  ];
  if (snapshot.telegramEnabled) ordered.splice(3, 0, ["telegram_ready", "telegram_ready"]);
  for (const [checkCode, stepCode] of ordered) {
    if (result.checks.find((item) => item.code === checkCode)?.status === "fail") return stepCode;
  }
  return result.ready ? "readiness_passed" : "channel_selected";
}

export async function runShopReadiness(input: {
  env: AppBindings;
  requestId: string;
  shopPublicId: string;
  trigger: ReadinessTrigger;
  userId: string;
}): Promise<ReadinessResult> {
  const actor = await requireOwnerActor(input);
  const row = await loadReadinessRow(input.env, actor.shopId);
  const snapshot = mapSnapshot(row);
  const evaluated = evaluateReadinessSnapshot(snapshot);
  const runId = createId("rdy");
  const auditId = createId("aud");
  const failures = evaluated.checks.filter((item) => item.required && item.status === "fail").length;
  const warnings = evaluated.checks.filter((item) => item.status === "warning").length;
  const statements = [
    input.env.PLATFORM_DB.prepare(`
      INSERT INTO audit_logs (
        id, shop_id, actor_type, actor_id, action, resource_type,
        resource_id, safe_metadata_json, request_id, created_at
      ) VALUES (?, ?, 'user', ?, 'onboarding.readiness_checked', 'shop_readiness_run', ?, ?, ?, ?)
    `).bind(
      auditId,
      actor.shopId,
      input.userId,
      runId,
      JSON.stringify({ failures, trigger: input.trigger, warnings }),
      input.requestId,
      evaluated.checkedAt,
    ),
    input.env.PLATFORM_DB.prepare(`
      INSERT INTO shop_readiness_runs (
        id, shop_id, trigger_kind, overall_status, readiness_version,
        required_failure_count, warning_count, checks_json, actor_user_id,
        request_id, checked_at, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      runId,
      actor.shopId,
      input.trigger,
      evaluated.ready ? "ready" : "blocked",
      evaluated.readinessVersion,
      failures,
      warnings,
      JSON.stringify(evaluated.checks),
      input.userId,
      input.requestId,
      evaluated.checkedAt,
      evaluated.checkedAt,
    ),
  ];
  for (const code of [
    "account_ready", "shop_created", "channel_selected", "catalog_ready", "inventory_ready",
    "telegram_ready", "payos_ready", "domain_ready", "readiness_passed", "published",
  ]) {
    const state = stepState(evaluated, snapshot, code);
    statements.push(input.env.PLATFORM_DB.prepare(`
      UPDATE shop_onboarding_steps
      SET status = ?,
          started_at = COALESCE(started_at, ?),
          completed_at = CASE
            WHEN ? IN ('complete', 'skipped') THEN COALESCE(completed_at, ?)
            ELSE NULL
          END,
          last_checked_at = ?,
          blocking_code = ?,
          audit_log_id = ?,
          version = version + 1,
          updated_at = ?
      WHERE shop_id = ? AND step_code = ?
    `).bind(
      state.status,
      evaluated.checkedAt,
      state.status,
      evaluated.checkedAt,
      evaluated.checkedAt,
      state.blockingCode,
      auditId,
      evaluated.checkedAt,
      actor.shopId,
      code,
    ));
  }
  statements.push(input.env.PLATFORM_DB.prepare(`
    UPDATE shop_onboarding_profiles
    SET current_step = ?, version = version + 1, updated_at = ?
    WHERE shop_id = ?
  `).bind(currentStep(evaluated, snapshot), evaluated.checkedAt, actor.shopId));
  await input.env.PLATFORM_DB.batch(statements);
  if (evaluated.ready) {
    await tryRecordActivationMilestone({
      env: input.env,
      idempotencyKey: "readiness_passed",
      milestone: "readiness_passed",
      projection: { trigger: input.trigger },
      reason: "passed",
      shopId: actor.shopId,
      source: "readiness",
    });
  }
  return { ...evaluated, runId };
}

export async function publishReadyStorefront(input: {
  env: AppBindings;
  expectedStorefrontVersion?: number;
  requestId: string;
  shopPublicId: string;
  userId: string;
}): Promise<ReadinessResult> {
  const actor = await requireOwnerActor(input);
  const readiness = await runShopReadiness({ ...input, trigger: "publish" });
  const failures = readiness.checks
    .filter((item) => item.required && item.status === "fail")
    .map((item) => item.code);
  if (!readiness.ready) throw new AppError("readiness_failed", 409, failures);

  const checkedAtMs = Date.parse(readiness.checkedAt);
  const payosFreshAfter = new Date(checkedAtMs - PAYOS_HEALTH_TTL_MS).toISOString();
  const telegramFreshAfter = new Date(checkedAtMs - TELEGRAM_HEALTH_TTL_MS).toISOString();
  const notAfter = new Date(checkedAtMs + 5 * 60_000).toISOString();
  const publishedAt = new Date().toISOString();
  const auditId = createId("aud");

  const results = await input.env.PLATFORM_DB.batch([
    input.env.PLATFORM_DB.prepare(`
      UPDATE shops
      SET status = 'active',
          readiness_version = readiness_version + 1,
          updated_at = ?
      WHERE id = (
          SELECT shops.id FROM shops WHERE shops.public_id = ? LIMIT 1
        )
        AND public_id = ?
        AND readiness_version = ?
        AND status IN ('draft', 'active')
        AND EXISTS (
          SELECT 1 FROM shop_members
          WHERE shop_members.shop_id = shops.id
            AND shop_members.user_id = ?
            AND shop_members.role = 'owner'
            AND shop_members.status = 'active'
        )
        AND EXISTS (
          SELECT 1 FROM shop_settings
          WHERE shop_settings.shop_id = shops.id
            AND (? IS NULL OR shop_settings.version = ?)
        )
        AND EXISTS (
          SELECT 1
          FROM shop_onboarding_profiles
          INNER JOIN shop_subscriptions
            ON shop_subscriptions.id = (
              SELECT latest_subscription.id
              FROM shop_subscriptions AS latest_subscription
              WHERE latest_subscription.shop_id = shops.id
              ORDER BY latest_subscription.created_at DESC, latest_subscription.id DESC
              LIMIT 1
            )
          INNER JOIN plans ON plans.id = shop_subscriptions.plan_id
          WHERE shop_onboarding_profiles.shop_id = shops.id
            AND (
              shop_subscriptions.state = 'active'
              OR (
                shop_subscriptions.state = 'trialing'
                AND shop_subscriptions.trial_ends_at IS NOT NULL
                AND shop_subscriptions.trial_ends_at > ?
              )
              OR (
                shop_subscriptions.state IN ('past_due', 'grace_period')
                AND shop_subscriptions.grace_ends_at IS NOT NULL
                AND shop_subscriptions.grace_ends_at > ?
              )
            )
            AND (shop_onboarding_profiles.website_enabled = 1 OR shop_onboarding_profiles.telegram_enabled = 1)
            AND (
              shop_onboarding_profiles.website_enabled = 0
              OR json_extract(plans.feature_flags_json, '$.storefront') = 1
            )
            AND (
              shop_onboarding_profiles.telegram_enabled = 0
              OR json_extract(plans.feature_flags_json, '$.telegram') = 1
            )
        )
        AND EXISTS (
          SELECT 1 FROM shop_domains
          WHERE shop_domains.shop_id = shops.id
            AND shop_domains.type = 'platform_subdomain'
            AND shop_domains.status = 'active'
            AND shop_domains.hostname_normalized = shops.slug || '.' || ?
            AND shop_domains.deleted_at IS NULL
            AND shop_domains.delete_requested_at IS NULL
        )
        AND EXISTS (
          SELECT 1
          FROM products
          INNER JOIN product_variants
            ON product_variants.shop_id = products.shop_id
            AND product_variants.product_id = products.id
            AND product_variants.status = 'active'
          WHERE products.shop_id = shops.id AND products.status = 'active'
        )
        AND EXISTS (
          SELECT 1
          FROM products
          INNER JOIN product_variants
            ON product_variants.shop_id = products.shop_id
            AND product_variants.product_id = products.id
            AND product_variants.status = 'active'
          WHERE products.shop_id = shops.id
            AND products.status = 'active'
            AND (
              products.fulfillment_type = 'manual'
              OR EXISTS (
                SELECT 1 FROM inventory_keys
                WHERE inventory_keys.shop_id = products.shop_id
                  AND inventory_keys.variant_id = product_variants.id
                  AND inventory_keys.status = 'available'
              )
            )
        )
        AND EXISTS (
          SELECT 1 FROM payment_integrations
          WHERE payment_integrations.shop_id = shops.id
            AND payment_integrations.provider = 'payos'
            AND payment_integrations.status = 'active'
            AND payment_integrations.webhook_status = 'verified'
            AND payment_integrations.last_checked_at BETWEEN ? AND ?
            AND payment_integrations.last_webhook_verified_at BETWEEN ? AND ?
        )
        AND NOT EXISTS (
          SELECT 1 FROM shop_onboarding_profiles
          WHERE shop_onboarding_profiles.shop_id = shops.id
            AND shop_onboarding_profiles.telegram_enabled = 1
            AND NOT EXISTS (
              SELECT 1 FROM telegram_integrations
              WHERE telegram_integrations.shop_id = shops.id
                AND telegram_integrations.status = 'active'
                AND telegram_integrations.webhook_status = 'verified'
                AND telegram_integrations.last_health_update_at BETWEEN ? AND ?
            )
        )
        AND NOT EXISTS (
          SELECT 1 FROM shop_onboarding_profiles
          WHERE shop_onboarding_profiles.shop_id = shops.id
            AND shop_onboarding_profiles.website_enabled = 1
            AND NOT EXISTS (
              SELECT 1 FROM shop_domains AS canonical
              WHERE canonical.id = shops.canonical_domain_id
                AND canonical.shop_id = shops.id
                AND canonical.status = 'active'
                AND canonical.is_primary = 1
                AND canonical.deleted_at IS NULL
                AND canonical.delete_requested_at IS NULL
                AND (
                  canonical.type = 'platform_subdomain'
                  OR (
                    canonical.type = 'custom'
                    AND canonical.hostname_status = 'active'
                    AND canonical.ssl_status = 'active'
                    AND canonical.dns_status = 'active'
                  )
                )
            )
        )
        AND EXISTS (
          SELECT 1 FROM shop_settings
          WHERE shop_settings.shop_id = shops.id
            AND shop_settings.support_contact IS NOT NULL
            AND shop_settings.terms_url IS NOT NULL
            AND shop_settings.privacy_url IS NOT NULL
            AND shop_settings.refund_policy_url IS NOT NULL
            AND shop_settings.policy_attestation_version = ?
            AND shop_settings.policy_attested_at IS NOT NULL
            AND shop_settings.policy_attested_by_user_id IS NOT NULL
        )
    `).bind(
      publishedAt,
      input.shopPublicId,
      input.shopPublicId,
      readiness.readinessVersion,
      input.userId,
      input.expectedStorefrontVersion ?? null,
      input.expectedStorefrontVersion ?? null,
      publishedAt,
      publishedAt,
      input.env.PLATFORM_BASE_DOMAIN,
      payosFreshAfter,
      notAfter,
      payosFreshAfter,
      notAfter,
      telegramFreshAfter,
      notAfter,
      CURRENT_POLICY_ATTESTATION_VERSION,
    ),
    input.env.PLATFORM_DB.prepare(`
      UPDATE shop_settings
      SET published_branding_json = branding_json,
          published_storefront_json = storefront_json,
          published_version = version,
          published_at = ?
      WHERE shop_id = (
          SELECT id FROM shops
          WHERE public_id = ?
            AND status = 'active'
            AND updated_at = ?
            AND readiness_version = ?
        )
        AND (? IS NULL OR version = ?)
    `).bind(
      publishedAt,
      input.shopPublicId,
      publishedAt,
      readiness.readinessVersion + 1,
      input.expectedStorefrontVersion ?? null,
      input.expectedStorefrontVersion ?? null,
    ),
    input.env.PLATFORM_DB.prepare(`
      INSERT INTO audit_logs (
        id, shop_id, actor_type, actor_id, action, resource_type,
        resource_id, safe_metadata_json, request_id, created_at
      )
      SELECT ?, shops.id, 'user', ?, 'storefront.published', 'shop', shops.id, ?, ?, ?
      FROM shops
      WHERE shops.public_id = ? AND shops.status = 'active' AND shops.updated_at = ?
    `).bind(
      auditId,
      input.userId,
      JSON.stringify({ readinessRunId: readiness.runId }),
      input.requestId,
      publishedAt,
      input.shopPublicId,
      publishedAt,
    ),
    input.env.PLATFORM_DB.prepare(`
      UPDATE shop_onboarding_steps
      SET status = 'complete',
          started_at = COALESCE(started_at, ?),
          completed_at = COALESCE(completed_at, ?),
          last_checked_at = ?,
          blocking_code = NULL,
          audit_log_id = ?,
          version = version + 1,
          updated_at = ?
      WHERE shop_id = (
          SELECT id FROM shops
          WHERE public_id = ? AND status = 'active' AND updated_at = ?
        )
        AND step_code = 'published'
    `).bind(publishedAt, publishedAt, publishedAt, auditId, publishedAt, input.shopPublicId, publishedAt),
    input.env.PLATFORM_DB.prepare(`
      UPDATE shop_onboarding_profiles
      SET current_step = 'published', version = version + 1, updated_at = ?
      WHERE shop_id = (
        SELECT id FROM shops
        WHERE public_id = ? AND status = 'active' AND updated_at = ?
      )
    `).bind(publishedAt, input.shopPublicId, publishedAt),
  ]);

  if ((results[0]?.meta.changes ?? 0) !== 1) {
    if (input.expectedStorefrontVersion !== undefined) {
      const current = await input.env.PLATFORM_DB.prepare(`
        SELECT shop_settings.version
        FROM shop_settings
        INNER JOIN shops ON shops.id = shop_settings.shop_id
        INNER JOIN shop_members
          ON shop_members.shop_id = shops.id
          AND shop_members.user_id = ?
          AND shop_members.role = 'owner'
          AND shop_members.status = 'active'
        WHERE shops.public_id = ?
        LIMIT 1
      `).bind(input.userId, input.shopPublicId).first<{ version: number }>();
      if (current !== null && current.version !== input.expectedStorefrontVersion) {
        throw new AppError("resource_conflict", 409, ["storefront_draft_stale"]);
      }
    }
    throw new AppError("readiness_changed", 409, ["rerun_readiness_required"]);
  }
  if ((results[1]?.meta.changes ?? 0) !== 1) throw new AppError("resource_conflict", 409, ["storefront_publish_conflict"]);
  await tryRecordActivationMilestone({
    env: input.env,
    idempotencyKey: "storefront_published",
    milestone: "storefront_published",
    reason: "published",
    shopId: actor.shopId,
    source: "storefront",
  });
  return { ...readiness, readinessVersion: readiness.readinessVersion + 1 };
}
