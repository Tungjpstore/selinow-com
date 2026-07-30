PRAGMA foreign_keys = ON;

-- Pending ownership proofs use brand-bound TXT names and tokens. Removing only
-- unverified claims forces the application to issue a fresh Selinow challenge;
-- verified claims and their authoritative custom domains remain unchanged.
DELETE FROM custom_domain_claims
WHERE verified_at IS NULL;

-- Map every remote platform hostname that is not already on Selinow. Tenant
-- staging hosts have at least four labels; production hosts have three. The
-- first label is the tenant/platform slug in both environments.
-- Cloudflare D1 remote rejects CREATE TEMP TABLE with SQLITE_AUTH. Use a
-- migration-scoped table instead and drop it before the migration completes.
CREATE TABLE selinow_platform_domain_map_0019 (
  domain_id TEXT PRIMARY KEY NOT NULL,
  old_hostname TEXT NOT NULL,
  new_hostname TEXT NOT NULL
) WITHOUT ROWID, STRICT;

INSERT INTO selinow_platform_domain_map_0019 (domain_id, old_hostname, new_hostname)
SELECT
  id,
  hostname_normalized,
  substr(hostname_normalized, 1, instr(hostname_normalized, '.') - 1)
    || CASE
      WHEN length(hostname_normalized) - length(replace(hostname_normalized, '.', '')) >= 3
        THEN '.staging.selinow.com'
      ELSE '.selinow.com'
    END
FROM shop_domains
WHERE type = 'platform_subdomain'
  AND instr(hostname_normalized, '.') > 1
  AND hostname_normalized <> 'localhost'
  AND substr(hostname_normalized, -length('.localhost')) <> '.localhost'
  AND hostname_normalized <> 'selinow.com'
  AND substr(hostname_normalized, -length('.selinow.com')) <> '.selinow.com';

-- Payment attempts keep their checkout-domain FK and are rewritten from the
-- exact mapped origin. Verified custom-domain snapshots are never selected.
UPDATE payment_attempts
SET return_origin = CASE
      WHEN return_origin = 'https://' || (
        SELECT mapping.old_hostname
        FROM selinow_platform_domain_map_0019 AS mapping
        WHERE mapping.domain_id = payment_attempts.checkout_domain_id
      ) THEN 'https://' || (
        SELECT mapping.new_hostname
        FROM selinow_platform_domain_map_0019 AS mapping
        WHERE mapping.domain_id = payment_attempts.checkout_domain_id
      )
      ELSE return_origin
    END,
    cancel_origin = CASE
      WHEN cancel_origin = 'https://' || (
        SELECT mapping.old_hostname
        FROM selinow_platform_domain_map_0019 AS mapping
        WHERE mapping.domain_id = payment_attempts.checkout_domain_id
      ) THEN 'https://' || (
        SELECT mapping.new_hostname
        FROM selinow_platform_domain_map_0019 AS mapping
        WHERE mapping.domain_id = payment_attempts.checkout_domain_id
      )
      ELSE cancel_origin
    END,
    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE checkout_domain_id IN (SELECT domain_id FROM selinow_platform_domain_map_0019);

-- Domain IDs remain stable, preserving canonical and payment references. The
-- existing partial unique index aborts on a live target collision.
UPDATE shop_domains
SET hostname_normalized = (
      SELECT mapping.new_hostname
      FROM selinow_platform_domain_map_0019 AS mapping
      WHERE mapping.domain_id = shop_domains.id
    ),
    version = version + 1,
    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE id IN (SELECT domain_id FROM selinow_platform_domain_map_0019);

DROP TABLE selinow_platform_domain_map_0019;

-- Rebrand only empty/legacy-default themes and the controlled demo fixtures.
-- Seller-selected colors and optional logo fields are otherwise preserved.
UPDATE shop_settings
SET branding_json = CASE shop_id
      WHEN 'shp_61000000-0000-4000-8000-000000000001'
        THEN json_set(branding_json, '$.primaryColor', '#5B5CEB', '$.accentColor', '#3B82F6')
      WHEN 'shp_62000000-0000-4000-8000-000000000002'
        THEN json_set(branding_json, '$.primaryColor', '#7C3AED', '$.accentColor', '#5B5CEB')
      WHEN 'shp_63000000-0000-4000-8000-000000000003'
        THEN json_set(branding_json, '$.primaryColor', '#3B82F6', '$.accentColor', '#7C3AED')
      WHEN 'shp_64000000-0000-4000-8000-000000000004'
        THEN json_set(branding_json, '$.primaryColor', '#0B1020', '$.accentColor', '#5B5CEB')
      ELSE json_set(branding_json, '$.primaryColor', '#5B5CEB', '$.accentColor', '#3B82F6')
    END,
    version = version + 1,
    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE shop_id IN (
    'shp_61000000-0000-4000-8000-000000000001',
    'shp_62000000-0000-4000-8000-000000000002',
    'shp_63000000-0000-4000-8000-000000000003',
    'shp_64000000-0000-4000-8000-000000000004'
  )
  OR branding_json = '{}'
  OR (
    upper(json_extract(branding_json, '$.primaryColor')) = '#176B5B'
    AND upper(json_extract(branding_json, '$.accentColor')) = '#E9A62F'
  );

-- Missing defaults and legacy platform footers receive the Selinow sentence.
-- Other seller-authored footer copy remains byte-for-byte unchanged.
UPDATE shop_settings
SET storefront_json = json_set(
      storefront_json,
      '$.footerText',
      (
        SELECT shops.name || ' vận hành cửa hàng trên Selinow.'
        FROM shops
        WHERE shops.id = shop_settings.shop_id
      )
    ),
    version = version + 1,
    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE json_type(storefront_json, '$.footerText') IS NULL
  OR json_type(storefront_json, '$.footerText') <> 'text'
  OR trim(json_extract(storefront_json, '$.footerText')) = ''
  OR instr(json_extract(storefront_json, '$.footerText'), ' vận hành cửa hàng trên ') > 0;
