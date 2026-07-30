PRAGMA foreign_keys = ON;

ALTER TABLE shop_settings
  ADD COLUMN support_contact TEXT;

ALTER TABLE shop_settings
  ADD COLUMN terms_url TEXT;

ALTER TABLE shop_settings
  ADD COLUMN privacy_url TEXT;

ALTER TABLE shop_settings
  ADD COLUMN refund_policy_url TEXT;

ALTER TABLE shop_settings
  ADD COLUMN policy_attestation_version INTEGER CHECK (
    policy_attestation_version IS NULL OR policy_attestation_version > 0
  );

ALTER TABLE shop_settings
  ADD COLUMN policy_attested_at TEXT;

ALTER TABLE shop_settings
  ADD COLUMN policy_attested_by_user_id TEXT REFERENCES platform_users(id) ON DELETE SET NULL;

ALTER TABLE telegram_integrations
  ADD COLUMN last_health_update_at TEXT;

ALTER TABLE payment_integrations
  ADD COLUMN last_checked_at TEXT;

ALTER TABLE payment_integrations
  ADD COLUMN last_webhook_verified_at TEXT;

CREATE TABLE shop_onboarding_profiles (
  shop_id TEXT PRIMARY KEY NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  website_enabled INTEGER NOT NULL DEFAULT 0 CHECK (website_enabled IN (0, 1)),
  telegram_enabled INTEGER NOT NULL DEFAULT 0 CHECK (telegram_enabled IN (0, 1)),
  custom_domain_preference TEXT NOT NULL DEFAULT 'later' CHECK (
    custom_domain_preference IN ('skip', 'later', 'connect')
  ),
  current_step TEXT NOT NULL DEFAULT 'shop_created' CHECK (
    current_step IN (
      'account_ready', 'shop_created', 'channel_selected', 'catalog_ready',
      'inventory_ready', 'telegram_ready', 'payos_ready', 'domain_ready',
      'readiness_passed', 'published'
    )
  ),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) WITHOUT ROWID, STRICT;

CREATE TABLE shop_onboarding_steps (
  shop_id TEXT NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  step_code TEXT NOT NULL CHECK (
    step_code IN (
      'account_ready', 'shop_created', 'channel_selected', 'catalog_ready',
      'inventory_ready', 'telegram_ready', 'payos_ready', 'domain_ready',
      'readiness_passed', 'published'
    )
  ),
  status TEXT NOT NULL CHECK (status IN ('pending', 'in_progress', 'complete', 'blocked', 'skipped')),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  started_at TEXT,
  completed_at TEXT,
  last_checked_at TEXT,
  blocking_code TEXT,
  audit_log_id TEXT REFERENCES audit_logs(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (shop_id, step_code)
) WITHOUT ROWID, STRICT;

CREATE INDEX idx_shop_onboarding_steps_shop_status
  ON shop_onboarding_steps(shop_id, status, updated_at DESC, step_code);

CREATE TABLE shop_readiness_runs (
  id TEXT PRIMARY KEY NOT NULL,
  shop_id TEXT NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  trigger_kind TEXT NOT NULL CHECK (trigger_kind IN ('manual', 'publish', 'test')),
  overall_status TEXT NOT NULL CHECK (overall_status IN ('ready', 'blocked')),
  readiness_version INTEGER NOT NULL CHECK (readiness_version > 0),
  required_failure_count INTEGER NOT NULL DEFAULT 0 CHECK (required_failure_count >= 0),
  warning_count INTEGER NOT NULL DEFAULT 0 CHECK (warning_count >= 0),
  checks_json TEXT NOT NULL CHECK (json_valid(checks_json)),
  actor_user_id TEXT REFERENCES platform_users(id) ON DELETE SET NULL,
  request_id TEXT NOT NULL,
  checked_at TEXT NOT NULL,
  created_at TEXT NOT NULL
) STRICT;

CREATE INDEX idx_shop_readiness_runs_shop_created
  ON shop_readiness_runs(shop_id, created_at DESC, id);

CREATE INDEX idx_shop_readiness_runs_shop_status
  ON shop_readiness_runs(shop_id, overall_status, created_at DESC, id);

CREATE INDEX idx_telegram_integrations_shop_health
  ON telegram_integrations(shop_id, status, webhook_status, last_health_update_at, id);

CREATE INDEX idx_payment_integrations_shop_health
  ON payment_integrations(shop_id, status, webhook_status, last_checked_at, last_webhook_verified_at, id);

-- Existing shops keep their current publication status. Channel choices are
-- inferred conservatively from plan entitlement and existing integrations.
INSERT INTO shop_onboarding_profiles (
  shop_id, website_enabled, telegram_enabled, custom_domain_preference,
  current_step, version, created_at, updated_at
)
SELECT
  shops.id,
  CASE
    WHEN COALESCE(json_extract(plans.feature_flags_json, '$.storefront'), 0) = 1 THEN 1
    ELSE 0
  END,
  CASE
    WHEN EXISTS (
      SELECT 1
      FROM telegram_integrations
      WHERE telegram_integrations.shop_id = shops.id
        AND telegram_integrations.status != 'disabled'
    ) THEN 1
    WHEN COALESCE(json_extract(plans.feature_flags_json, '$.storefront'), 0) != 1
      AND COALESCE(json_extract(plans.feature_flags_json, '$.telegram'), 0) = 1 THEN 1
    ELSE 0
  END,
  CASE
    WHEN EXISTS (
      SELECT 1
      FROM shop_domains
      WHERE shop_domains.shop_id = shops.id
        AND shop_domains.type = 'custom'
        AND shop_domains.deleted_at IS NULL
    ) THEN 'connect'
    ELSE 'later'
  END,
  CASE WHEN shops.status = 'active' THEN 'published' ELSE 'channel_selected' END,
  1,
  shops.created_at,
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
FROM shops
INNER JOIN shop_subscriptions
  ON shop_subscriptions.id = (
    SELECT latest_subscription.id
    FROM shop_subscriptions AS latest_subscription
    WHERE latest_subscription.shop_id = shops.id
    ORDER BY latest_subscription.created_at DESC, latest_subscription.id DESC
    LIMIT 1
  )
INNER JOIN plans ON plans.id = shop_subscriptions.plan_id;

WITH step_codes(step_code) AS (
  VALUES
    ('account_ready'),
    ('shop_created'),
    ('channel_selected'),
    ('catalog_ready'),
    ('inventory_ready'),
    ('telegram_ready'),
    ('payos_ready'),
    ('domain_ready'),
    ('readiness_passed'),
    ('published')
)
INSERT INTO shop_onboarding_steps (
  shop_id, step_code, status, version, started_at, completed_at,
  last_checked_at, blocking_code, audit_log_id, created_at, updated_at
)
SELECT
  shops.id,
  step_codes.step_code,
  CASE
    WHEN step_codes.step_code IN ('account_ready', 'shop_created', 'channel_selected') THEN 'complete'
    WHEN step_codes.step_code = 'domain_ready' AND EXISTS (
      SELECT 1
      FROM shop_domains
      WHERE shop_domains.shop_id = shops.id
        AND shop_domains.type = 'platform_subdomain'
        AND shop_domains.status = 'active'
        AND shop_domains.deleted_at IS NULL
    ) THEN 'complete'
    WHEN step_codes.step_code = 'catalog_ready' AND EXISTS (
      SELECT 1
      FROM products
      INNER JOIN product_variants
        ON product_variants.shop_id = products.shop_id
        AND product_variants.product_id = products.id
        AND product_variants.status = 'active'
      WHERE products.shop_id = shops.id AND products.status = 'active'
    ) THEN 'complete'
    WHEN step_codes.step_code = 'inventory_ready' AND EXISTS (
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
            SELECT 1
            FROM inventory_keys
            WHERE inventory_keys.shop_id = products.shop_id
              AND inventory_keys.variant_id = product_variants.id
              AND inventory_keys.status = 'available'
          )
        )
    ) THEN 'complete'
    WHEN step_codes.step_code = 'telegram_ready'
      AND shop_onboarding_profiles.telegram_enabled = 0 THEN 'skipped'
    WHEN step_codes.step_code IN ('readiness_passed', 'published')
      AND shops.status = 'active' THEN 'complete'
    ELSE 'pending'
  END,
  1,
  shops.created_at,
  CASE
    WHEN step_codes.step_code IN ('account_ready', 'shop_created', 'channel_selected') THEN shops.created_at
    WHEN step_codes.step_code IN ('readiness_passed', 'published') AND shops.status = 'active' THEN shops.updated_at
    ELSE NULL
  END,
  NULL,
  NULL,
  NULL,
  shops.created_at,
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
FROM shops
INNER JOIN shop_onboarding_profiles ON shop_onboarding_profiles.shop_id = shops.id
CROSS JOIN step_codes;
