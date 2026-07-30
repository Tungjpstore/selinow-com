PRAGMA defer_foreign_keys = ON;

CREATE TABLE custom_domain_claims (
  id TEXT PRIMARY KEY NOT NULL,
  shop_id TEXT NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  hostname_normalized TEXT NOT NULL,
  challenge_hash TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  verified_at TEXT,
  last_checked_at TEXT,
  check_attempts INTEGER NOT NULL DEFAULT 0 CHECK (check_attempts >= 0),
  last_safe_error_code TEXT,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (shop_id, hostname_normalized)
) STRICT;

CREATE INDEX idx_custom_domain_claims_shop_pending
  ON custom_domain_claims(shop_id, verified_at, expires_at, created_at, id);

CREATE INDEX idx_custom_domain_claims_hostname
  ON custom_domain_claims(hostname_normalized, verified_at, expires_at, id);

-- The table rebuild would otherwise trigger the checkout-domain RESTRICT FK.
-- Keep the references outside the FK graph and restore them after the rename.
CREATE TABLE custom_domain_checkout_refs_0018 (
  payment_attempt_id TEXT PRIMARY KEY NOT NULL,
  checkout_domain_id TEXT NOT NULL
) WITHOUT ROWID, STRICT;

INSERT INTO custom_domain_checkout_refs_0018 (payment_attempt_id, checkout_domain_id)
SELECT id, checkout_domain_id
FROM payment_attempts
WHERE checkout_domain_id IS NOT NULL;

UPDATE payment_attempts
SET checkout_domain_id = NULL
WHERE checkout_domain_id IS NOT NULL;

-- Rebuild the table to remove the original inline hostname UNIQUE constraint.
-- Legacy custom rows are tombstoned because readiness signals are not proof of ownership.
CREATE TABLE shop_domains_rebuilt (
  id TEXT PRIMARY KEY NOT NULL,
  shop_id TEXT NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  hostname_normalized TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('platform_subdomain', 'custom')),
  status TEXT NOT NULL CHECK (status IN ('pending', 'validating', 'active', 'failed', 'suspended', 'deleted')),
  is_primary INTEGER NOT NULL DEFAULT 0 CHECK (is_primary IN (0, 1)),
  cloudflare_hostname_id TEXT,
  hostname_status TEXT,
  ssl_status TEXT,
  validation_metadata_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(validation_metadata_json)),
  last_checked_at TEXT,
  activated_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  dns_status TEXT CHECK (dns_status IN ('pending', 'active', 'error')),
  next_check_at TEXT,
  check_attempts INTEGER NOT NULL DEFAULT 0 CHECK (check_attempts >= 0),
  lease_token TEXT,
  lease_expires_at TEXT,
  last_safe_error_code TEXT,
  deleted_at TEXT,
  delete_requested_at TEXT,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  ownership_verified_at TEXT
) STRICT;

INSERT INTO shop_domains_rebuilt (
  id, shop_id, hostname_normalized, type, status, is_primary,
  cloudflare_hostname_id, hostname_status, ssl_status,
  validation_metadata_json, last_checked_at, activated_at, created_at,
  updated_at, dns_status, next_check_at, check_attempts, lease_token,
  lease_expires_at, last_safe_error_code, deleted_at, delete_requested_at,
  version, ownership_verified_at
)
SELECT
  id,
  shop_id,
  CASE
    WHEN type = 'custom' THEN 'legacy-unverified-' || id || '.invalid'
    ELSE hostname_normalized
  END,
  type,
  CASE
    WHEN type = 'custom' THEN 'deleted'
    ELSE status
  END,
  CASE
    WHEN type = 'custom' THEN 0
    ELSE is_primary
  END,
  CASE
    WHEN type = 'custom' THEN NULL
    ELSE cloudflare_hostname_id
  END,
  CASE WHEN type = 'custom' THEN NULL ELSE hostname_status END,
  CASE WHEN type = 'custom' THEN NULL ELSE ssl_status END,
  CASE WHEN type = 'custom' THEN '{}' ELSE validation_metadata_json END,
  CASE WHEN type = 'custom' THEN NULL ELSE last_checked_at END,
  CASE WHEN type = 'custom' THEN NULL ELSE activated_at END,
  created_at,
  updated_at,
  CASE WHEN type = 'custom' THEN NULL ELSE dns_status END,
  CASE
    WHEN type = 'custom' THEN NULL
    ELSE next_check_at
  END,
  CASE WHEN type = 'custom' THEN 0 ELSE check_attempts END,
  CASE WHEN type = 'custom' THEN NULL ELSE lease_token END,
  CASE WHEN type = 'custom' THEN NULL ELSE lease_expires_at END,
  CASE
    WHEN type = 'custom' THEN 'ownership_reverification_required'
    ELSE last_safe_error_code
  END,
  CASE
    WHEN type = 'custom' THEN COALESCE(deleted_at, updated_at, created_at)
    ELSE deleted_at
  END,
  CASE WHEN type = 'custom' THEN NULL ELSE delete_requested_at END,
  CASE
    WHEN type = 'custom' THEN version + 1
    ELSE version
  END,
  NULL
FROM shop_domains;

DROP TABLE shop_domains;
ALTER TABLE shop_domains_rebuilt RENAME TO shop_domains;

UPDATE payment_attempts
SET checkout_domain_id = (
  SELECT saved.checkout_domain_id
  FROM custom_domain_checkout_refs_0018 AS saved
  WHERE saved.payment_attempt_id = payment_attempts.id
)
WHERE id IN (SELECT payment_attempt_id FROM custom_domain_checkout_refs_0018);

DROP TABLE custom_domain_checkout_refs_0018;

CREATE UNIQUE INDEX idx_shop_domains_platform_hostname
  ON shop_domains(hostname_normalized)
  WHERE type = 'platform_subdomain' AND deleted_at IS NULL;

CREATE UNIQUE INDEX idx_shop_domains_verified_hostname
  ON shop_domains(hostname_normalized)
  WHERE type = 'custom' AND ownership_verified_at IS NOT NULL AND deleted_at IS NULL;

CREATE UNIQUE INDEX idx_shop_domains_cloudflare_hostname
  ON shop_domains(cloudflare_hostname_id)
  WHERE cloudflare_hostname_id IS NOT NULL;

CREATE UNIQUE INDEX idx_shop_domains_one_primary
  ON shop_domains(shop_id)
  WHERE is_primary = 1 AND deleted_at IS NULL;

CREATE INDEX idx_shop_domains_reconcile
  ON shop_domains(next_check_at, id)
  WHERE type = 'custom' AND ownership_verified_at IS NOT NULL
    AND deleted_at IS NULL AND next_check_at IS NOT NULL;

CREATE INDEX idx_shop_domains_shop_live
  ON shop_domains(shop_id, deleted_at, status, created_at, id);

CREATE INDEX idx_shop_domains_shop_status
  ON shop_domains(shop_id, status, updated_at DESC);

-- If a legacy unverified custom domain was canonical, fall back safely.
UPDATE shop_domains
SET is_primary = 0,
    version = version + 1,
    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE type = 'custom' AND ownership_verified_at IS NULL AND is_primary = 1;

UPDATE shop_domains
SET is_primary = 1,
    version = version + 1,
    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE id IN (
  SELECT (
    SELECT platform_domain.id
    FROM shop_domains AS platform_domain
    WHERE platform_domain.shop_id = shops.id
      AND platform_domain.type = 'platform_subdomain'
      AND platform_domain.status = 'active'
      AND platform_domain.deleted_at IS NULL
    ORDER BY platform_domain.created_at, platform_domain.id
    LIMIT 1
  )
  FROM shops
  WHERE NOT EXISTS (
    SELECT 1 FROM shop_domains AS current_primary
    WHERE current_primary.shop_id = shops.id
      AND current_primary.is_primary = 1
      AND current_primary.status = 'active'
      AND current_primary.deleted_at IS NULL
  )
);

UPDATE shops
SET canonical_domain_id = (
      SELECT primary_domain.id
      FROM shop_domains AS primary_domain
      WHERE primary_domain.shop_id = shops.id
        AND primary_domain.is_primary = 1
        AND primary_domain.status = 'active'
        AND primary_domain.deleted_at IS NULL
      ORDER BY primary_domain.created_at, primary_domain.id
      LIMIT 1
    ),
    readiness_version = readiness_version + 1,
    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE NOT EXISTS (
  SELECT 1 FROM shop_domains AS canonical
  WHERE canonical.id = shops.canonical_domain_id
    AND canonical.shop_id = shops.id
    AND canonical.is_primary = 1
    AND canonical.status = 'active'
    AND canonical.deleted_at IS NULL
    AND (canonical.type = 'platform_subdomain' OR canonical.ownership_verified_at IS NOT NULL)
);
