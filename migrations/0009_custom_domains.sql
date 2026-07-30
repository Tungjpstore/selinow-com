PRAGMA foreign_keys = ON;

ALTER TABLE shop_domains
  ADD COLUMN dns_status TEXT CHECK (dns_status IN ('pending', 'active', 'error'));

ALTER TABLE shop_domains
  ADD COLUMN next_check_at TEXT;

ALTER TABLE shop_domains
  ADD COLUMN check_attempts INTEGER NOT NULL DEFAULT 0 CHECK (check_attempts >= 0);

ALTER TABLE shop_domains
  ADD COLUMN lease_token TEXT;

ALTER TABLE shop_domains
  ADD COLUMN lease_expires_at TEXT;

ALTER TABLE shop_domains
  ADD COLUMN last_safe_error_code TEXT;

ALTER TABLE shop_domains
  ADD COLUMN deleted_at TEXT;

ALTER TABLE shop_domains
  ADD COLUMN delete_requested_at TEXT;

ALTER TABLE shop_domains
  ADD COLUMN version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0);

-- Phase 7 makes the three readiness signals authoritative. Any legacy custom
-- hostname must revalidate before it can route traffic again.
UPDATE shop_domains
SET status = 'deleted',
    is_primary = 0,
    dns_status = COALESCE(dns_status, 'pending'),
    next_check_at = NULL,
    deleted_at = COALESCE(deleted_at, updated_at, created_at),
    version = version + 1
WHERE type = 'custom' AND status = 'deleted';

UPDATE shop_domains
SET status = 'validating',
    is_primary = 0,
    dns_status = 'pending',
    next_check_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
    last_safe_error_code = 'domain_revalidation_required',
    version = version + 1,
    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE type = 'custom'
  AND status IN ('pending', 'validating', 'active', 'failed');

-- Repair legacy duplicate/invalid primary flags before enforcing uniqueness.
-- Prefer the same-shop active canonical domain, then the platform subdomain.
UPDATE shop_domains AS candidate
SET is_primary = 0,
    version = version + 1,
    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE candidate.is_primary = 1
  AND candidate.id <> COALESCE(
    (
      SELECT canonical.id
      FROM shops
      INNER JOIN shop_domains AS canonical
        ON canonical.id = shops.canonical_domain_id
        AND canonical.shop_id = shops.id
        AND canonical.status = 'active'
      WHERE shops.id = candidate.shop_id
      LIMIT 1
    ),
    (
      SELECT platform_domain.id
      FROM shop_domains AS platform_domain
      WHERE platform_domain.shop_id = candidate.shop_id
        AND platform_domain.type = 'platform_subdomain'
        AND platform_domain.status = 'active'
      ORDER BY platform_domain.created_at, platform_domain.id
      LIMIT 1
    ),
    candidate.id
  );

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
    ORDER BY platform_domain.created_at, platform_domain.id
    LIMIT 1
  )
  FROM shops
  WHERE NOT EXISTS (
    SELECT 1
    FROM shop_domains AS current_primary
    WHERE current_primary.shop_id = shops.id
      AND current_primary.is_primary = 1
      AND current_primary.status = 'active'
  )
);

UPDATE shops
SET canonical_domain_id = (
  SELECT primary_domain.id
  FROM shop_domains AS primary_domain
  WHERE primary_domain.shop_id = shops.id
    AND primary_domain.is_primary = 1
    AND primary_domain.status = 'active'
  ORDER BY primary_domain.created_at, primary_domain.id
  LIMIT 1
),
    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE canonical_domain_id IS NULL
   OR NOT EXISTS (
     SELECT 1
     FROM shop_domains AS canonical
     WHERE canonical.id = shops.canonical_domain_id
       AND canonical.shop_id = shops.id
       AND canonical.is_primary = 1
       AND canonical.status = 'active'
   );

CREATE UNIQUE INDEX idx_shop_domains_cloudflare_hostname
  ON shop_domains(cloudflare_hostname_id)
  WHERE cloudflare_hostname_id IS NOT NULL;

CREATE UNIQUE INDEX idx_shop_domains_one_primary
  ON shop_domains(shop_id)
  WHERE is_primary = 1 AND deleted_at IS NULL;

CREATE INDEX idx_shop_domains_reconcile
  ON shop_domains(next_check_at, id)
  WHERE type = 'custom' AND deleted_at IS NULL AND next_check_at IS NOT NULL;

CREATE INDEX idx_shop_domains_shop_live
  ON shop_domains(shop_id, deleted_at, status, created_at, id);

ALTER TABLE payment_attempts
  ADD COLUMN checkout_domain_id TEXT REFERENCES shop_domains(id) ON DELETE RESTRICT;

ALTER TABLE payment_attempts
  ADD COLUMN return_origin TEXT;

ALTER TABLE payment_attempts
  ADD COLUMN cancel_origin TEXT;

UPDATE payment_attempts
SET checkout_domain_id = (
      SELECT canonical.id
      FROM shops
      INNER JOIN shop_domains AS canonical
        ON canonical.id = shops.canonical_domain_id
        AND canonical.shop_id = shops.id
        AND canonical.is_primary = 1
        AND canonical.status = 'active'
      WHERE shops.id = payment_attempts.shop_id
    ),
    return_origin = (
      SELECT 'https://' || canonical.hostname_normalized
      FROM shops
      INNER JOIN shop_domains AS canonical
        ON canonical.id = shops.canonical_domain_id
        AND canonical.shop_id = shops.id
        AND canonical.is_primary = 1
        AND canonical.status = 'active'
      WHERE shops.id = payment_attempts.shop_id
    ),
    cancel_origin = (
      SELECT 'https://' || canonical.hostname_normalized
      FROM shops
      INNER JOIN shop_domains AS canonical
        ON canonical.id = shops.canonical_domain_id
        AND canonical.shop_id = shops.id
        AND canonical.is_primary = 1
        AND canonical.status = 'active'
      WHERE shops.id = payment_attempts.shop_id
    )
WHERE state IN ('creating', 'pending', 'error');

CREATE INDEX idx_payment_attempts_checkout_domain
  ON payment_attempts(shop_id, checkout_domain_id, state, expires_at, id)
  WHERE checkout_domain_id IS NOT NULL;
