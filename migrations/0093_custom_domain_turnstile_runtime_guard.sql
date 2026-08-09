-- Keep migrate-before-deploy and rollback windows fail-closed. Older Workers
-- know only hostname/SSL/DNS readiness and must not be able to reactivate or
-- select a custom domain after 0092 removes its Turnstile admission evidence.
CREATE TRIGGER shop_domains_turnstile_active_insert_guard
BEFORE INSERT ON shop_domains
WHEN NEW.type = 'custom'
  AND (NEW.status = 'active' OR NEW.is_primary = 1)
  AND NOT COALESCE((
    NEW.ownership_verified_at IS NOT NULL
    AND NEW.hostname_status = 'active'
    AND NEW.ssl_status = 'active'
    AND NEW.dns_status = 'active'
    AND NEW.delete_requested_at IS NULL
    AND NEW.deleted_at IS NULL
    AND json_extract(NEW.validation_metadata_json, '$.turnstile.status') = 'active'
    AND json_extract(NEW.validation_metadata_json, '$.turnstile.hostname') = NEW.hostname_normalized
    AND json_extract(NEW.validation_metadata_json, '$.turnstile.mode') = 'operator_managed'
    AND json_extract(NEW.validation_metadata_json, '$.turnstile.source') = 'cloudflare_widget_domains'
    AND json_type(NEW.validation_metadata_json, '$.turnstile.checkedAt') = 'text'
    AND julianday(json_extract(NEW.validation_metadata_json, '$.turnstile.checkedAt')) IS NOT NULL
    AND julianday(json_extract(NEW.validation_metadata_json, '$.turnstile.checkedAt')) >= julianday('now', '-12 hours')
    AND julianday(json_extract(NEW.validation_metadata_json, '$.turnstile.checkedAt')) <= julianday('now')
  ), 0)
BEGIN
  SELECT RAISE(ABORT, 'custom_domain_turnstile_admission_required');
END;

CREATE TRIGGER shop_domains_turnstile_active_update_guard
BEFORE UPDATE OF
  shop_id,
  type,
  status,
  is_primary,
  ownership_verified_at,
  hostname_status,
  ssl_status,
  dns_status,
  validation_metadata_json,
  hostname_normalized,
  delete_requested_at,
  deleted_at
ON shop_domains
WHEN NEW.type = 'custom'
  AND (NEW.status = 'active' OR NEW.is_primary = 1)
  AND NOT COALESCE((
    NEW.ownership_verified_at IS NOT NULL
    AND NEW.hostname_status = 'active'
    AND NEW.ssl_status = 'active'
    AND NEW.dns_status = 'active'
    AND NEW.delete_requested_at IS NULL
    AND NEW.deleted_at IS NULL
    AND json_extract(NEW.validation_metadata_json, '$.turnstile.status') = 'active'
    AND json_extract(NEW.validation_metadata_json, '$.turnstile.hostname') = NEW.hostname_normalized
    AND json_extract(NEW.validation_metadata_json, '$.turnstile.mode') = 'operator_managed'
    AND json_extract(NEW.validation_metadata_json, '$.turnstile.source') = 'cloudflare_widget_domains'
    AND json_type(NEW.validation_metadata_json, '$.turnstile.checkedAt') = 'text'
    AND julianday(json_extract(NEW.validation_metadata_json, '$.turnstile.checkedAt')) IS NOT NULL
    AND julianday(json_extract(NEW.validation_metadata_json, '$.turnstile.checkedAt')) >= julianday('now', '-12 hours')
    AND julianday(json_extract(NEW.validation_metadata_json, '$.turnstile.checkedAt')) <= julianday('now')
  ), 0)
BEGIN
  SELECT RAISE(ABORT, 'custom_domain_turnstile_admission_required');
END;

CREATE TRIGGER shop_domains_identity_update_guard
BEFORE UPDATE OF shop_id, type, hostname_normalized ON shop_domains
WHEN NEW.shop_id <> OLD.shop_id
  OR NEW.type <> OLD.type
  OR NEW.hostname_normalized <> OLD.hostname_normalized
BEGIN
  SELECT RAISE(ABORT, 'shop_domain_identity_immutable');
END;

CREATE TRIGGER shops_turnstile_canonical_insert_guard
BEFORE INSERT ON shops
WHEN NEW.canonical_domain_id IS NOT NULL
  AND EXISTS (
    SELECT 1 FROM shop_domains AS selected
    WHERE selected.id = NEW.canonical_domain_id AND selected.type = 'custom'
  )
  AND NOT EXISTS (
    SELECT 1
    FROM shop_domains AS selected
    WHERE selected.id = NEW.canonical_domain_id
      AND selected.shop_id = NEW.id
      AND selected.type = 'custom'
      AND selected.status = 'active'
      AND selected.is_primary = 1
      AND selected.ownership_verified_at IS NOT NULL
      AND selected.hostname_status = 'active'
      AND selected.ssl_status = 'active'
      AND selected.dns_status = 'active'
      AND selected.delete_requested_at IS NULL
      AND selected.deleted_at IS NULL
      AND json_extract(selected.validation_metadata_json, '$.turnstile.status') = 'active'
      AND json_extract(selected.validation_metadata_json, '$.turnstile.hostname') = selected.hostname_normalized
      AND json_extract(selected.validation_metadata_json, '$.turnstile.mode') = 'operator_managed'
      AND json_extract(selected.validation_metadata_json, '$.turnstile.source') = 'cloudflare_widget_domains'
      AND json_type(selected.validation_metadata_json, '$.turnstile.checkedAt') = 'text'
      AND julianday(json_extract(selected.validation_metadata_json, '$.turnstile.checkedAt')) IS NOT NULL
      AND julianday(json_extract(selected.validation_metadata_json, '$.turnstile.checkedAt')) >= julianday('now', '-12 hours')
      AND julianday(json_extract(selected.validation_metadata_json, '$.turnstile.checkedAt')) <= julianday('now')
  )
BEGIN
  SELECT RAISE(ABORT, 'custom_domain_canonical_not_ready');
END;

CREATE TRIGGER shops_turnstile_canonical_update_guard
BEFORE UPDATE OF canonical_domain_id ON shops
WHEN NEW.canonical_domain_id IS NOT NULL
  AND EXISTS (
    SELECT 1 FROM shop_domains AS selected
    WHERE selected.id = NEW.canonical_domain_id AND selected.type = 'custom'
  )
  AND NOT EXISTS (
    SELECT 1
    FROM shop_domains AS selected
    WHERE selected.id = NEW.canonical_domain_id
      AND selected.shop_id = NEW.id
      AND selected.type = 'custom'
      AND selected.status = 'active'
      AND selected.is_primary = 1
      AND selected.ownership_verified_at IS NOT NULL
      AND selected.hostname_status = 'active'
      AND selected.ssl_status = 'active'
      AND selected.dns_status = 'active'
      AND selected.delete_requested_at IS NULL
      AND selected.deleted_at IS NULL
      AND json_extract(selected.validation_metadata_json, '$.turnstile.status') = 'active'
      AND json_extract(selected.validation_metadata_json, '$.turnstile.hostname') = selected.hostname_normalized
      AND json_extract(selected.validation_metadata_json, '$.turnstile.mode') = 'operator_managed'
      AND json_extract(selected.validation_metadata_json, '$.turnstile.source') = 'cloudflare_widget_domains'
      AND json_type(selected.validation_metadata_json, '$.turnstile.checkedAt') = 'text'
      AND julianday(json_extract(selected.validation_metadata_json, '$.turnstile.checkedAt')) IS NOT NULL
      AND julianday(json_extract(selected.validation_metadata_json, '$.turnstile.checkedAt')) >= julianday('now', '-12 hours')
      AND julianday(json_extract(selected.validation_metadata_json, '$.turnstile.checkedAt')) <= julianday('now')
  )
BEGIN
  SELECT RAISE(ABORT, 'custom_domain_canonical_not_ready');
END;

-- An older Worker can write between 0092 and this migration. Repair any row
-- it reactivated before relying on the guards for subsequent writes.
UPDATE shop_domains
SET status = CASE WHEN status = 'active' THEN 'validating' ELSE status END,
    is_primary = 0,
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
WHERE type = 'custom'
  AND deleted_at IS NULL
  AND (status = 'active' OR is_primary = 1)
  AND NOT COALESCE((
    ownership_verified_at IS NOT NULL
    AND hostname_status = 'active'
    AND ssl_status = 'active'
    AND dns_status = 'active'
    AND delete_requested_at IS NULL
    AND json_extract(validation_metadata_json, '$.turnstile.status') = 'active'
    AND json_extract(validation_metadata_json, '$.turnstile.hostname') = hostname_normalized
    AND json_extract(validation_metadata_json, '$.turnstile.mode') = 'operator_managed'
    AND json_extract(validation_metadata_json, '$.turnstile.source') = 'cloudflare_widget_domains'
    AND json_type(validation_metadata_json, '$.turnstile.checkedAt') = 'text'
    AND julianday(json_extract(validation_metadata_json, '$.turnstile.checkedAt')) IS NOT NULL
    AND julianday(json_extract(validation_metadata_json, '$.turnstile.checkedAt')) >= julianday('now', '-12 hours')
    AND julianday(json_extract(validation_metadata_json, '$.turnstile.checkedAt')) <= julianday('now')
  ), 0);

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

UPDATE shops
SET canonical_domain_id = (
      SELECT primary_domain.id
      FROM shop_domains AS primary_domain
      WHERE primary_domain.shop_id = shops.id
        AND primary_domain.is_primary = 1
        AND primary_domain.status = 'active'
        AND primary_domain.delete_requested_at IS NULL
        AND primary_domain.deleted_at IS NULL
        AND (
          primary_domain.type = 'platform_subdomain'
          OR (
            primary_domain.type = 'custom'
            AND primary_domain.ownership_verified_at IS NOT NULL
            AND primary_domain.hostname_status = 'active'
            AND primary_domain.ssl_status = 'active'
            AND primary_domain.dns_status = 'active'
            AND json_extract(primary_domain.validation_metadata_json, '$.turnstile.status') = 'active'
            AND json_extract(primary_domain.validation_metadata_json, '$.turnstile.hostname') = primary_domain.hostname_normalized
            AND json_extract(primary_domain.validation_metadata_json, '$.turnstile.mode') = 'operator_managed'
            AND json_extract(primary_domain.validation_metadata_json, '$.turnstile.source') = 'cloudflare_widget_domains'
            AND json_type(primary_domain.validation_metadata_json, '$.turnstile.checkedAt') = 'text'
            AND julianday(json_extract(primary_domain.validation_metadata_json, '$.turnstile.checkedAt')) IS NOT NULL
            AND julianday(json_extract(primary_domain.validation_metadata_json, '$.turnstile.checkedAt')) >= julianday('now', '-12 hours')
            AND julianday(json_extract(primary_domain.validation_metadata_json, '$.turnstile.checkedAt')) <= julianday('now')
          )
        )
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
        canonical.type = 'custom'
        AND canonical.ownership_verified_at IS NOT NULL
        AND canonical.hostname_status = 'active'
        AND canonical.ssl_status = 'active'
        AND canonical.dns_status = 'active'
        AND json_extract(canonical.validation_metadata_json, '$.turnstile.status') = 'active'
        AND json_extract(canonical.validation_metadata_json, '$.turnstile.hostname') = canonical.hostname_normalized
        AND json_extract(canonical.validation_metadata_json, '$.turnstile.mode') = 'operator_managed'
        AND json_extract(canonical.validation_metadata_json, '$.turnstile.source') = 'cloudflare_widget_domains'
        AND json_type(canonical.validation_metadata_json, '$.turnstile.checkedAt') = 'text'
        AND julianday(json_extract(canonical.validation_metadata_json, '$.turnstile.checkedAt')) IS NOT NULL
        AND julianday(json_extract(canonical.validation_metadata_json, '$.turnstile.checkedAt')) >= julianday('now', '-12 hours')
        AND julianday(json_extract(canonical.validation_metadata_json, '$.turnstile.checkedAt')) <= julianday('now')
      )
    )
);
