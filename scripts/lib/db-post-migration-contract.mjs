import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { runWrangler } from "./cli.mjs";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

export const REQUIRED_POST_MIGRATION_OBJECTS = Object.freeze({
  table: Object.freeze([
    "activation_backfill_checkpoints",
    "activation_milestones",
    "api_credentials",
    "billing_accounts",
    "billing_checkout_sessions",
    "billing_invoices",
    "billing_provider_events",
    "catalog_channel_visibility",
    "channel_connector_requests",
    "channel_customer_identities",
    "channel_oauth_states",
    "channel_provider_event_receipts",
    "channel_provider_verification_evidence",
    "customer_notes",
    "auth_request_admissions",
    "telegram_actions",
    "telegram_action_history",
    "order_access_recovery_tokens",
    "order_messages",
    "order_notes",
    "payment_remediation_requests",
    "plan_prices",
    "account_trial_claims",
    "shop_member_invitations",
    "shop_subscriptions",
    "subscription_change_requests",
    "subscription_events",
    "telegram_mini_app_sessions",
    "telegram_updates",
    "usage_events",
  ]),
  index: Object.freeze([
    "idx_activation_milestones_shop_code_time",
    "idx_activation_milestones_shop_time",
    "idx_account_trial_claims_shop",
    "idx_api_credentials_shop_expires",
    "idx_api_credentials_shop_status",
    "idx_audit_logs_admin_created",
    "idx_auth_request_admissions_expiry",
    "idx_auth_request_admissions_requester_window",
    "idx_auth_request_admissions_subject_window",
    "idx_auth_request_admissions_window",
    "idx_billing_accounts_shop_status",
    "idx_billing_checkout_sessions_active_subscription",
    "idx_billing_checkout_sessions_pending",
    "idx_billing_checkout_sessions_shop_status",
    "idx_billing_invoices_shop_status",
    "idx_billing_provider_events_object",
    "idx_billing_provider_events_shop_created",
    "idx_billing_provider_events_status",
    "idx_billing_provider_events_subscription",
    "idx_catalog_channel_visibility_shop_channel_status",
    "idx_catalog_channel_visibility_shop_product",
    "idx_channel_connector_requests_active",
    "idx_channel_connector_requests_provider_status",
    "idx_channel_connector_requests_shop_status",
    "idx_channel_customer_identities_connection",
    "idx_channel_customer_identities_shop_customer",
    "idx_channel_oauth_states_expiry",
    "idx_channel_oauth_states_lookup_hash",
    "idx_channel_oauth_states_pending_connector",
    "idx_channel_oauth_states_shop_status",
    "idx_channel_provider_event_receipts_connection",
    "idx_channel_provider_event_receipts_retry",
    "idx_channel_provider_event_receipts_shop_status",
    "idx_channel_provider_verification_connection",
    "idx_channel_provider_verification_expiry",
    "idx_channel_provider_verification_shop_status",
    "idx_customer_notes_shop_customer",
    "idx_order_messages_provider_pending",
    "idx_order_messages_shop_order",
    "idx_order_notes_shop_order",
    "idx_order_access_recovery_tokens_active_order",
    "idx_order_access_recovery_tokens_previous",
    "idx_order_access_recovery_tokens_replacement",
    "idx_order_access_recovery_tokens_retention",
    "idx_order_access_recovery_tokens_shop_customer",
    "idx_order_access_recovery_tokens_shop_order",
    "idx_orders_admin_updated",
    "idx_orders_shop_id_customer",
    "idx_payment_remediation_requests_active_exception",
    "idx_payment_remediation_requests_admin_status",
    "idx_payment_remediation_requests_shop_status",
    "idx_plan_prices_active_offer",
    "idx_plan_prices_market_active",
    "idx_plan_prices_provider_ref",
    "idx_shop_member_invitations_expiry",
    "idx_shop_member_invitations_pending_email",
    "idx_shop_member_invitations_shop_status",
    "idx_shop_members_public_id",
    "idx_shop_members_shop_status_role",
    "idx_shop_subscriptions_open",
    "idx_shop_subscriptions_provider_ref",
    "idx_shop_subscriptions_shop_id",
    "idx_shop_subscriptions_state_period",
    "idx_subscription_change_requests_active",
    "idx_subscription_change_requests_execution",
    "idx_subscription_change_requests_shop_status",
    "idx_subscription_events_shop_created",
    "idx_subscription_events_subscription",
    "idx_telegram_integrations_shop_generation",
    "idx_telegram_actions_generation",
    "idx_telegram_action_history_generation",
    "idx_telegram_mini_app_sessions_expiry",
    "idx_telegram_mini_app_sessions_integration_launch",
    "idx_telegram_mini_app_sessions_shop_status",
    "idx_telegram_updates_generation_processing",
    "idx_telegram_updates_shop_received",
    "idx_telegram_updates_status",
    "idx_usage_counters_shop_kind_metric",
    "idx_usage_events_shop_period",
    "idx_usage_events_source",
    "idx_usage_events_subscription",
  ]),
  trigger: Object.freeze([
    "activation_milestones_projection_insert_guard",
    "activation_milestones_projection_update_guard",
    "api_credentials_active_limit_insert",
    "api_credentials_identity_immutable",
    "api_credentials_no_delete",
    "api_credentials_require_active_member_insert",
    "api_credentials_transition_guard",
    "billing_checkout_sessions_scope_guard",
    "billing_checkout_sessions_scope_update_guard",
    "billing_invoice_account_scope_guard",
    "billing_invoice_account_scope_update_guard",
    "billing_provider_events_identity_immutable",
    "billing_provider_events_no_delete",
    "billing_provider_events_subscription_scope_guard",
    "billing_provider_events_subscription_scope_update_guard",
    "billing_provider_events_transition_guard",
    "catalog_channel_visibility_channel_enable_defaults",
    "catalog_channel_visibility_channel_insert_defaults",
    "catalog_channel_visibility_lifecycle_guard",
    "catalog_channel_visibility_no_delete",
    "catalog_channel_visibility_product_insert_defaults",
    "catalog_channel_visibility_scope_insert_guard",
    "catalog_channel_visibility_scope_update_guard",
    "channel_connections_identity_immutable",
    "channel_connector_requests_identity_immutable",
    "channel_connector_requests_immutable_delete",
    "channel_connector_requests_reviewer_scope_guard",
    "channel_connector_requests_scope_insert_guard",
    "channel_customer_identities_identity_immutable",
    "channel_customer_identities_scope_insert_guard",
    "channel_customer_identities_scope_update_guard",
    "channel_oauth_states_identity_immutable",
    "channel_oauth_states_immutable_delete",
    "channel_oauth_states_scope_insert_guard",
    "channel_oauth_states_status_timestamp_guard",
    "channel_oauth_states_status_timestamp_update_guard",
    "channel_provider_event_receipts_identity_immutable",
    "channel_provider_event_receipts_immutable_delete",
    "channel_provider_event_receipts_scope_insert_guard",
    "channel_provider_event_receipts_transition_guard",
    "channel_provider_verification_credential_scope_insert_guard",
    "channel_provider_verification_identity_immutable",
    "channel_provider_verification_immutable_delete",
    "channel_provider_verification_reviewer_scope_guard",
    "channel_provider_verification_reviewer_scope_insert_guard",
    "channel_provider_verification_scope_insert_guard",
    "channel_provider_verification_status_timestamp_guard",
    "channel_provider_verification_status_timestamp_update_guard",
    "customer_notes_no_delete",
    "customer_notes_redaction_guard",
    "order_messages_author_scope_insert_guard",
    "order_messages_no_delete",
    "order_messages_transition_guard",
    "order_notes_no_delete",
    "order_notes_redaction_guard",
    "order_access_recovery_tokens_consume_rotate_order",
    "order_access_recovery_tokens_customer_anonymize",
    "order_access_recovery_tokens_identity_immutable",
    "order_access_recovery_tokens_redaction_guard",
    "order_access_recovery_tokens_scope_insert_guard",
    "order_access_recovery_tokens_terminal_immutable",
    "shop_domains_identity_update_guard",
    "shop_domains_turnstile_active_insert_guard",
    "shop_domains_turnstile_active_update_guard",
    "shops_turnstile_canonical_insert_guard",
    "shops_turnstile_canonical_update_guard",
    "payment_remediation_requests_no_delete",
    "payment_remediation_requests_scope_insert_guard",
    "payment_remediation_requests_transition_guard",
    "plan_prices_immutable_identity",
    "plan_prices_no_delete",
    "plan_prices_published_reference_guard",
    "plans_public_assignable_insert_guard",
    "plans_public_assignable_update_guard",
    "product_variants_activation_timestamp_immutable",
    "product_variants_activation_timestamp_insert",
    "product_variants_activation_timestamp_update",
    "products_activation_timestamp_immutable",
    "products_activation_timestamp_insert",
    "products_activation_timestamp_update",
    "shop_subscriptions_provider_ref_guard",
    "shop_subscriptions_provider_ref_update_guard",
    "shop_subscriptions_price_snapshot_presence_guard",
    "shop_subscriptions_price_snapshot_presence_update_guard",
    "shop_subscriptions_price_snapshot_scope_guard",
    "shop_subscriptions_price_snapshot_scope_update_guard",
    "shop_subscriptions_trialing_insert_guard",
    "shop_subscriptions_trialing_update_guard",
    "subscription_change_requests_no_delete",
    "subscription_change_requests_scope_insert_guard",
    "subscription_change_requests_transition_guard",
    "subscription_events_no_delete",
    "subscription_events_no_update",
    "subscription_events_provider_scope_guard",
    "outbox_jobs_quarantine_legacy_order_paid_insert",
    "telegram_credentials_legacy_generation_busy_guard",
    "telegram_integrations_generation_switch_required",
    "telegram_integrations_generation_transition_guard",
    "telegram_integrations_delivery_generation_busy_guard",
    "telegram_integrations_archive_actions_on_generation_change",
    "telegram_integrations_legacy_generation_fence",
    "telegram_mini_app_sessions_identity_immutable",
    "telegram_mini_app_sessions_scope_insert_guard",
    "telegram_updates_generation_claim_guard",
    "telegram_updates_generation_insert_guard",
    "telegram_updates_legacy_generation_attribute",
    "telegram_actions_generation_insert_guard",
    "telegram_actions_legacy_generation_attribute",
    "usage_events_no_delete",
    "usage_events_no_update",
  ]),
});

export const REQUIRED_POST_MIGRATION_COLUMNS = Object.freeze({
  account_trial_claims: Object.freeze(["claimed_at", "shop_id", "user_id"]),
  auth_request_admissions: Object.freeze([
    "id", "action", "requester_hash", "window_started_at", "window_ends_at", "created_at",
    "subject_hash", "delivery_permitted",
  ]),
  billing_accounts: Object.freeze(["currency", "provider_code", "shop_id"]),
  billing_checkout_sessions: Object.freeze([
    "expired_at", "plan_id", "price_id", "provider_code", "shop_id", "subscription_id",
  ]),
  billing_invoices: Object.freeze(["billing_account_id", "currency", "provider_code", "shop_id"]),
  billing_provider_events: Object.freeze(["id", "shop_id", "status", "subscription_id"]),
  channel_oauth_states: Object.freeze(["state_lookup_hash"]),
  order_access_recovery_tokens: Object.freeze([
    "id", "shop_id", "order_id", "customer_id", "token_hash", "recipient_hash",
    "issued_request_id", "issued_at", "expires_at", "consumed_at",
    "consumed_request_id", "previous_order_token_hash",
    "replacement_order_token_hash", "retention_expires_at", "revoked_at",
    "redacted_at", "created_at",
  ]),
  activation_milestones: Object.freeze(["id", "milestone_code", "projection_json", "shop_id"]),
  plans: Object.freeze(["is_assignable", "is_public", "schema_version"]),
  products: Object.freeze(["activated_at"]),
  product_variants: Object.freeze(["activated_at"]),
  shop_customers: Object.freeze(["version"]),
  shop_members: Object.freeze(["member_public_id", "version"]),
  shop_subscriptions: Object.freeze([
    "billing_provider_code",
    "market_code",
    "price_amount_minor",
    "price_currency",
    "price_id",
    "price_interval",
    "price_version",
    "provider_customer_ref",
    "provider_subscription_ref",
    "version",
  ]),
  subscription_change_requests: Object.freeze([
    "execution_attempts", "failure_code", "last_attempt_at", "provider_action_ref", "provider_event_id",
  ]),
  subscription_events: Object.freeze(["id", "provider_event_id", "shop_id", "source_kind", "to_state"]),
  telegram_integrations: Object.freeze(["generation_state", "integration_generation"]),
  telegram_actions: Object.freeze(["integration_generation"]),
  telegram_action_history: Object.freeze(["integration_generation"]),
  telegram_updates: Object.freeze(["credential_id", "integration_generation"]),
  usage_counters: Object.freeze(["period_kind"]),
});

function quoteSqlString(value) {
  return `'${value.replaceAll("'", "''")}'`;
}

export const POST_MIGRATION_FOREIGN_KEY_SQL = "PRAGMA foreign_key_check;";
export const POST_MIGRATION_OBJECT_SQL = `
SELECT type, name
FROM sqlite_master
WHERE type IN ('table', 'index', 'trigger')
ORDER BY type, name;
`;
// D1 rejects correlated pragma table-valued joins against sqlite_master. Keep
// the admission query deterministic by expanding the reviewed table set into
// constant pragma_table_info calls. Keep each compound group within D1's
// five-term limit.
const D1_MAX_COMPOUND_SELECT_TERMS = 5;
const POST_MIGRATION_COLUMN_SELECTS = Object.keys(REQUIRED_POST_MIGRATION_COLUMNS)
  .map((table) => `SELECT ${quoteSqlString(table)} AS table_name, name AS column_name, cid FROM pragma_table_info(${quoteSqlString(table)})`);
const POST_MIGRATION_COLUMN_GROUPS = [];
for (let index = 0; index < POST_MIGRATION_COLUMN_SELECTS.length; index += D1_MAX_COMPOUND_SELECT_TERMS) {
  POST_MIGRATION_COLUMN_GROUPS.push(`SELECT * FROM (\n${POST_MIGRATION_COLUMN_SELECTS.slice(index, index + D1_MAX_COMPOUND_SELECT_TERMS).join("\nUNION ALL\n")}\n)`);
}
export const POST_MIGRATION_COLUMN_SQL = `
SELECT table_name, column_name
FROM (
${POST_MIGRATION_COLUMN_GROUPS.join("\nUNION ALL\n")}
)
ORDER BY table_name, column_name;
`;
export const POST_MIGRATION_CROSS_LEDGER_SQL = `
SELECT COUNT(*) AS mismatch_count FROM (
  SELECT id FROM (
  SELECT id FROM (
  SELECT events.id
  FROM subscription_events AS events
  LEFT JOIN billing_provider_events AS provider ON provider.id = events.provider_event_id
  WHERE events.source_kind = 'provider'
    AND (
      events.provider_event_id IS NULL
      OR provider.id IS NULL
      OR provider.shop_id IS NULL
      OR provider.shop_id != events.shop_id
      OR provider.subscription_id IS NULL
      OR provider.subscription_id != events.subscription_id
    )
  UNION ALL
  SELECT invoices.id
  FROM billing_invoices AS invoices
  LEFT JOIN billing_accounts AS accounts ON accounts.id = invoices.billing_account_id
  WHERE invoices.billing_account_id IS NOT NULL
    AND (
      accounts.id IS NULL
      OR accounts.shop_id != invoices.shop_id
      OR accounts.provider_code != invoices.provider_code
      OR accounts.currency != invoices.currency
    )
  UNION ALL
  SELECT sessions.id
  FROM billing_checkout_sessions AS sessions
  LEFT JOIN shop_subscriptions AS subscriptions ON subscriptions.id = sessions.subscription_id
  LEFT JOIN plan_prices AS prices ON prices.id = sessions.price_id
  WHERE subscriptions.id IS NULL
    OR subscriptions.shop_id != sessions.shop_id
    OR prices.id IS NULL
    OR prices.plan_id != sessions.plan_id
    OR prices.provider_code != sessions.provider_code
    OR (
      sessions.status IN ('pending', 'open')
      AND (
        subscriptions.state != 'pending_payment'
        OR subscriptions.price_id IS NULL
        OR subscriptions.price_id != sessions.price_id
        OR subscriptions.market_code IS NULL
        OR subscriptions.market_code != prices.market_code
        OR subscriptions.price_currency IS NULL
        OR subscriptions.price_currency != prices.currency
        OR subscriptions.price_amount_minor IS NULL
        OR subscriptions.price_amount_minor != prices.amount_minor
        OR subscriptions.price_interval IS NULL
        OR subscriptions.price_interval != prices.interval
        OR subscriptions.price_version IS NULL
        OR subscriptions.price_version != prices.version
      )
    )
  UNION ALL
  SELECT subscriptions.id
  FROM shop_subscriptions AS subscriptions
  LEFT JOIN plan_prices AS prices ON prices.id = subscriptions.price_id
  WHERE (
    subscriptions.price_id IS NULL
    AND (
      subscriptions.market_code IS NOT NULL
      OR subscriptions.price_currency IS NOT NULL
      OR subscriptions.price_amount_minor IS NOT NULL
      OR subscriptions.price_interval IS NOT NULL
      OR subscriptions.price_version IS NOT NULL
    )
  )
  OR (
    subscriptions.price_id IS NOT NULL
    AND (
      subscriptions.billing_provider_code IS NULL
      OR subscriptions.market_code IS NULL
      OR subscriptions.price_currency IS NULL
      OR subscriptions.price_amount_minor IS NULL
      OR subscriptions.price_interval IS NULL
      OR subscriptions.price_version IS NULL
      OR prices.id IS NULL
      OR prices.provider_code != subscriptions.billing_provider_code
      OR prices.market_code != subscriptions.market_code
      OR prices.currency != subscriptions.price_currency
      OR prices.amount_minor != subscriptions.price_amount_minor
      OR prices.interval != subscriptions.price_interval
      OR prices.version != subscriptions.price_version
      OR (
        subscriptions.state != 'pending_payment'
        AND prices.plan_id != subscriptions.plan_id
      )
    )
  )
  UNION ALL
  SELECT milestones.id
  FROM activation_milestones AS milestones
  WHERE (
    CASE
      WHEN json_valid(milestones.projection_json) = 0 THEN 1
      WHEN json_type(milestones.projection_json) != 'object' THEN 1
      ELSE EXISTS (
        SELECT 1
        FROM json_each(milestones.projection_json)
        WHERE key NOT IN ('channel', 'currency', 'fulfillment_type', 'trigger')
          OR type != 'text'
          OR (key = 'channel' AND value NOT IN ('website', 'telegram'))
          OR (key = 'currency' AND value NOT IN ('VND', 'USD', 'EUR', 'JPY'))
          OR (key = 'fulfillment_type' AND value NOT IN ('license_key', 'manual'))
          OR (key = 'trigger' AND value NOT IN ('manual', 'publish', 'test'))
      )
    END
  )
  OR (
    milestones.milestone_code = 'trial_converted'
      AND NOT EXISTS (
        SELECT 1
        FROM subscription_events AS events
        INNER JOIN billing_provider_events AS provider ON provider.id = events.provider_event_id
        WHERE events.shop_id = milestones.shop_id
          AND events.to_state = 'active'
          AND events.source_kind = 'provider'
          AND provider.shop_id = milestones.shop_id
          AND provider.status = 'processed'
      )
  )
  ) AS platform_ledgers
  UNION ALL
  SELECT recovery.id
  FROM order_access_recovery_tokens AS recovery
  LEFT JOIN orders AS order_row
    ON order_row.shop_id = recovery.shop_id
    AND order_row.id = recovery.order_id
    AND order_row.customer_id = recovery.customer_id
  LEFT JOIN shop_customers AS customers
    ON customers.shop_id = recovery.shop_id
    AND customers.id = recovery.customer_id
  WHERE order_row.id IS NULL
    OR customers.id IS NULL
    OR recovery.expires_at <= recovery.issued_at
    OR recovery.retention_expires_at <= recovery.expires_at
    OR (recovery.consumed_at IS NULL) != (recovery.consumed_request_id IS NULL)
    OR (recovery.consumed_at IS NULL) != (recovery.previous_order_token_hash IS NULL)
    OR (recovery.consumed_at IS NULL) != (recovery.replacement_order_token_hash IS NULL)
    OR (recovery.consumed_at IS NOT NULL
      AND recovery.previous_order_token_hash = recovery.replacement_order_token_hash)
    OR (recovery.consumed_at IS NOT NULL AND recovery.consumed_at < recovery.issued_at)
    OR (recovery.revoked_at IS NOT NULL AND recovery.revoked_at < recovery.issued_at)
    OR (recovery.consumed_at IS NOT NULL AND recovery.revoked_at IS NOT NULL)
    OR (recovery.redacted_at IS NOT NULL AND recovery.consumed_at IS NULL)
    OR (recovery.redacted_at IS NOT NULL
      AND recovery.redacted_at < recovery.retention_expires_at)
  UNION ALL
  SELECT domain.id
  FROM shop_domains AS domain
  WHERE domain.type = 'custom'
    AND (domain.status = 'active' OR domain.is_primary = 1)
    AND NOT COALESCE((
      domain.ownership_verified_at IS NOT NULL
      AND domain.hostname_status = 'active'
      AND domain.ssl_status = 'active'
      AND domain.dns_status = 'active'
      AND domain.delete_requested_at IS NULL
      AND domain.deleted_at IS NULL
      AND json_extract(domain.validation_metadata_json, '$.turnstile.status') = 'active'
      AND json_extract(domain.validation_metadata_json, '$.turnstile.hostname') = domain.hostname_normalized
      AND json_extract(domain.validation_metadata_json, '$.turnstile.mode') = 'operator_managed'
      AND json_extract(domain.validation_metadata_json, '$.turnstile.source') = 'cloudflare_widget_domains'
      AND json_type(domain.validation_metadata_json, '$.turnstile.checkedAt') = 'text'
      AND julianday(json_extract(domain.validation_metadata_json, '$.turnstile.checkedAt')) IS NOT NULL
      AND julianday(json_extract(domain.validation_metadata_json, '$.turnstile.checkedAt')) >= julianday('now', '-12 hours')
      AND julianday(json_extract(domain.validation_metadata_json, '$.turnstile.checkedAt')) <= julianday('now')
    ), 0)
  UNION ALL
  SELECT shop.id
  FROM shops AS shop
  WHERE shop.canonical_domain_id IS NOT NULL
    AND EXISTS (SELECT 1 FROM shop_domains AS candidate
      WHERE candidate.id = shop.canonical_domain_id AND candidate.type = 'custom')
    AND NOT EXISTS (SELECT 1 FROM shop_domains AS canonical
      WHERE canonical.id = shop.canonical_domain_id
        AND canonical.shop_id = shop.id
        AND canonical.type = 'custom'
        AND canonical.status = 'active'
        AND canonical.is_primary = 1
        AND canonical.ownership_verified_at IS NOT NULL
        AND canonical.hostname_status = 'active'
        AND canonical.ssl_status = 'active'
        AND canonical.dns_status = 'active'
        AND canonical.delete_requested_at IS NULL
        AND canonical.deleted_at IS NULL
        AND json_extract(canonical.validation_metadata_json, '$.turnstile.status') = 'active'
        AND json_extract(canonical.validation_metadata_json, '$.turnstile.hostname') = canonical.hostname_normalized
        AND json_extract(canonical.validation_metadata_json, '$.turnstile.mode') = 'operator_managed'
        AND json_extract(canonical.validation_metadata_json, '$.turnstile.source') = 'cloudflare_widget_domains'
        AND json_type(canonical.validation_metadata_json, '$.turnstile.checkedAt') = 'text'
        AND julianday(json_extract(canonical.validation_metadata_json, '$.turnstile.checkedAt')) IS NOT NULL
        AND julianday(json_extract(canonical.validation_metadata_json, '$.turnstile.checkedAt')) >= julianday('now', '-12 hours')
        AND julianday(json_extract(canonical.validation_metadata_json, '$.turnstile.checkedAt')) <= julianday('now'))
  UNION ALL
  SELECT admission.id
  FROM auth_request_admissions AS admission
  WHERE admission.action NOT IN ('magic_link_request', 'shop_create')
    OR length(admission.requester_hash) NOT BETWEEN 16 AND 128
    OR admission.window_ends_at <= admission.window_started_at
    OR (admission.subject_hash IS NOT NULL
      AND length(admission.subject_hash) NOT BETWEEN 16 AND 128)
    OR admission.delivery_permitted NOT IN (0, 1)
    OR (admission.action = 'shop_create'
      AND (admission.subject_hash IS NULL OR admission.delivery_permitted != 1))
) AS prior_ledgers
  UNION ALL
  SELECT id FROM (
  SELECT job.id
  FROM outbox_jobs AS job
  WHERE job.kind = 'order_paid' AND job.status != 'completed'
  UNION ALL
  SELECT integration.id
  FROM telegram_integrations AS integration
  WHERE integration.integration_generation <= 0
    OR integration.generation_state NOT IN ('active', 'draining')
  UNION ALL
  SELECT update_row.id
  FROM telegram_updates AS update_row
  LEFT JOIN telegram_integrations AS integration
    ON integration.id = update_row.integration_id
    AND integration.shop_id = update_row.shop_id
  WHERE update_row.integration_generation <= 0
    OR integration.id IS NULL
    OR (update_row.status = 'processing'
      AND (integration.generation_state != 'active'
        OR integration.integration_generation != update_row.integration_generation
        OR integration.active_credential_id IS NOT update_row.credential_id))
  UNION ALL
  SELECT action_row.id
  FROM telegram_actions AS action_row
  LEFT JOIN telegram_integrations AS integration
    ON integration.id = action_row.integration_id
    AND integration.shop_id = action_row.shop_id
  WHERE action_row.integration_generation <= 0
    OR integration.id IS NULL
  UNION ALL
  SELECT history.id
  FROM telegram_action_history AS history
  LEFT JOIN telegram_integrations AS integration
    ON integration.id = history.integration_id
    AND integration.shop_id = history.shop_id
  WHERE history.integration_generation <= 0
    OR integration.id IS NULL
    OR history.integration_generation > integration.integration_generation
  ) AS telegram_ledgers
);
`;

function parseRemoteRows(output, issue) {
  let payload;
  try {
    payload = JSON.parse(String(output ?? ""));
  } catch {
    throw new Error(`${issue}_invalid_json`);
  }
  const envelopes = Array.isArray(payload) ? payload : [payload];
  if (envelopes.length === 0 || envelopes.some((envelope) => (
    envelope?.success !== true || !Array.isArray(envelope?.results)
  ))) {
    throw new Error(`${issue}_invalid_result`);
  }
  const rows = envelopes.flatMap((envelope) => envelope.results);
  if (rows.some((row) => typeof row !== "object" || row === null || Array.isArray(row))) {
    throw new Error(`${issue}_invalid_result`);
  }
  return rows;
}

export function parsePostMigrationForeignKeyOutput(output) {
  const rows = parseRemoteRows(output, "post_migration_foreign_key_contract");
  if (rows.length !== 0) throw new Error("post_migration_foreign_key_violation");
  return { violationCount: 0 };
}

export function parsePostMigrationObjectOutput(output) {
  const rows = parseRemoteRows(output, "post_migration_object_contract");
  const observed = new Set();
  for (const row of rows) {
    if (!new Set(["table", "index", "trigger"]).has(row.type) || typeof row.name !== "string") {
      throw new Error("post_migration_object_contract_invalid_result");
    }
    const key = `${row.type}:${row.name}`;
    if (observed.has(key)) throw new Error("post_migration_object_contract_invalid_result");
    observed.add(key);
  }
  for (const [type, names] of Object.entries(REQUIRED_POST_MIGRATION_OBJECTS)) {
    for (const name of names) {
      if (!observed.has(`${type}:${name}`)) throw new Error(`post_migration_object_missing:${type}:${name}`);
    }
  }
  const forbidden = rows.find((row) => (
    row.type === "table" && (
      row.name === "api_credentials_v0068"
      || row.name === "auth_request_admissions_legacy_0094"
      || row.name === "telegram_updates_pre_generation"
      || row.name === "telegram_updates_pre_rollback"
      || /_legacy_00(?:70|76)$/u.test(row.name)
    )
  ));
  if (forbidden) throw new Error(`post_migration_legacy_object_present:${forbidden.name}`);
  return { objectCount: observed.size };
}

export function parsePostMigrationColumnOutput(output) {
  const rows = parseRemoteRows(output, "post_migration_column_contract");
  const observed = new Set();
  for (const row of rows) {
    if (typeof row.table_name !== "string" || typeof row.column_name !== "string") {
      throw new Error("post_migration_column_contract_invalid_result");
    }
    const key = `${row.table_name}:${row.column_name}`;
    if (observed.has(key)) throw new Error("post_migration_column_contract_invalid_result");
    observed.add(key);
  }
  for (const [table, columns] of Object.entries(REQUIRED_POST_MIGRATION_COLUMNS)) {
    for (const column of columns) {
      if (!observed.has(`${table}:${column}`)) throw new Error(`post_migration_column_missing:${table}:${column}`);
    }
  }
  return { columnCount: observed.size };
}

export function parsePostMigrationCrossLedgerOutput(output) {
  const rows = parseRemoteRows(output, "post_migration_cross_ledger_contract");
  if (rows.length !== 1) throw new Error("post_migration_cross_ledger_contract_invalid_result");
  const mismatchCount = rows[0]?.mismatch_count;
  if (typeof mismatchCount !== "number" || !Number.isSafeInteger(mismatchCount) || mismatchCount < 0) {
    throw new Error("post_migration_cross_ledger_contract_invalid_result");
  }
  if (mismatchCount !== 0) throw new Error("post_migration_cross_ledger_mismatch");
  return { mismatchCount };
}

export function assertRemotePostMigrationContract(input = {}) {
  const environmentName = input.environmentName;
  if (!new Set(["staging", "production"]).has(environmentName)) {
    throw new Error("post_migration_environment_invalid");
  }
  const runner = input.runWranglerImplementation ?? runWrangler;
  const runnerOptions = {
    cwd: input.repositoryRoot ?? repositoryRoot,
    env: input.environment,
  };
  const baseArgs = [
    "d1", "execute", "PLATFORM_DB", "--env", environmentName, "--remote", "--command",
  ];
  const execute = (sql, issue) => {
    try {
      return runner([...baseArgs, sql, "--json"], runnerOptions).stdout;
    } catch (error) {
      throw new Error(issue, { cause: error });
    }
  };
  const foreignKeys = parsePostMigrationForeignKeyOutput(execute(
    POST_MIGRATION_FOREIGN_KEY_SQL,
    "post_migration_foreign_key_contract_unavailable",
  ));
  const objects = parsePostMigrationObjectOutput(execute(
    POST_MIGRATION_OBJECT_SQL,
    "post_migration_object_contract_unavailable",
  ));
  const columns = parsePostMigrationColumnOutput(execute(
    POST_MIGRATION_COLUMN_SQL,
    "post_migration_column_contract_unavailable",
  ));
  const crossLedger = parsePostMigrationCrossLedgerOutput(execute(
    POST_MIGRATION_CROSS_LEDGER_SQL,
    "post_migration_cross_ledger_contract_unavailable",
  ));
  return { ...foreignKeys, ...objects, ...columns, ...crossLedger, ok: true };
}
