-- Existing custom domains predate exact Turnstile widget admission evidence.
-- Keep every legacy row fail-closed until the domain checker reads back the
-- operator-managed widget allowlist for the exact hostname.
UPDATE shop_domains
SET status = CASE
      WHEN status = 'active' THEN 'validating'
      ELSE status
    END,
    is_primary = 0,
    validation_metadata_json = json_set(
      validation_metadata_json,
      '$.turnstile',
      json_object(
        'hostname', hostname_normalized,
        'mode', 'operator_managed',
        'source', 'cloudflare_widget_domains',
        'status', 'pending',
        'checkedAt', NULL
      )
    ),
    next_check_at = CASE
      WHEN ownership_verified_at IS NOT NULL AND delete_requested_at IS NULL
        THEN strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      ELSE next_check_at
    END,
    last_safe_error_code = CASE
      WHEN hostname_status = 'active' AND ssl_status = 'active' AND dns_status = 'active'
        THEN 'domain_turnstile_admission_pending'
      ELSE last_safe_error_code
    END,
    version = version + 1,
    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE type = 'custom' AND deleted_at IS NULL;

-- Restore one safe platform primary after legacy custom primaries are demoted.
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
      AND platform_domain.delete_requested_at IS NULL
      AND platform_domain.deleted_at IS NULL
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
      AND current_primary.delete_requested_at IS NULL
      AND current_primary.deleted_at IS NULL
  )
);

-- Canonical routing must reference the surviving primary or remain null when
-- no safe platform fallback exists.
UPDATE shops
SET canonical_domain_id = (
      SELECT primary_domain.id
      FROM shop_domains AS primary_domain
      WHERE primary_domain.shop_id = shops.id
        AND primary_domain.is_primary = 1
        AND primary_domain.status = 'active'
        AND primary_domain.delete_requested_at IS NULL
        AND primary_domain.deleted_at IS NULL
      ORDER BY primary_domain.created_at, primary_domain.id
      LIMIT 1
    ),
    readiness_version = readiness_version + 1,
    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE NOT EXISTS (
  SELECT 1
  FROM shop_domains AS canonical
  WHERE canonical.id = shops.canonical_domain_id
    AND canonical.shop_id = shops.id
    AND canonical.is_primary = 1
    AND canonical.status = 'active'
    AND canonical.delete_requested_at IS NULL
    AND canonical.deleted_at IS NULL
    AND (
      canonical.type = 'platform_subdomain'
      OR (
        canonical.ownership_verified_at IS NOT NULL
        AND canonical.hostname_status = 'active'
        AND canonical.ssl_status = 'active'
        AND canonical.dns_status = 'active'
        AND json_extract(canonical.validation_metadata_json, '$.turnstile.status') = 'active'
        AND json_extract(canonical.validation_metadata_json, '$.turnstile.hostname') = canonical.hostname_normalized
        AND json_extract(canonical.validation_metadata_json, '$.turnstile.mode') = 'operator_managed'
        AND json_extract(canonical.validation_metadata_json, '$.turnstile.source') = 'cloudflare_widget_domains'
      )
    )
);
