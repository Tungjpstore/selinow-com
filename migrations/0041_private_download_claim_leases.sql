PRAGMA foreign_keys = ON;

-- Ephemeral lease rows fence private-download replay before any object read.
CREATE TABLE delivery_grant_claims (
  id TEXT PRIMARY KEY NOT NULL,
  shop_id TEXT NOT NULL REFERENCES shops(id) ON DELETE RESTRICT,
  grant_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  lease_expires_at TEXT NOT NULL,
  UNIQUE (shop_id, id),
  UNIQUE (shop_id, grant_id),
  FOREIGN KEY (shop_id, grant_id)
    REFERENCES delivery_grants(shop_id, id) ON DELETE RESTRICT,
  CHECK (
    julianday(created_at) IS NOT NULL
    AND julianday(lease_expires_at) IS NOT NULL
    AND julianday(lease_expires_at) > julianday(created_at)
    AND julianday(lease_expires_at) <= julianday(created_at, '+5 minutes')
  )
) STRICT;

CREATE INDEX idx_delivery_grant_claims_shop_expiry
  ON delivery_grant_claims(shop_id, lease_expires_at, id);

CREATE TRIGGER delivery_grant_claims_scope_guard_insert
BEFORE INSERT ON delivery_grant_claims
WHEN NOT EXISTS (
  SELECT 1
  FROM delivery_grants AS grants
  INNER JOIN digital_entitlements AS entitlements
    ON entitlements.id = grants.entitlement_id
    AND entitlements.shop_id = grants.shop_id
  INNER JOIN orders
    ON orders.id = grants.order_id
    AND orders.shop_id = grants.shop_id
  INNER JOIN digital_asset_versions
    ON digital_asset_versions.id = grants.asset_version_id
    AND digital_asset_versions.shop_id = grants.shop_id
  INNER JOIN digital_assets
    ON digital_assets.id = digital_asset_versions.asset_id
    AND digital_assets.shop_id = digital_asset_versions.shop_id
  WHERE grants.id = NEW.grant_id
    AND grants.shop_id = NEW.shop_id
    AND grants.status = 'active'
    AND julianday(NEW.created_at) >= julianday(grants.created_at)
    AND julianday(grants.expires_at) > julianday(NEW.created_at)
    AND julianday(NEW.lease_expires_at) <= julianday(grants.expires_at)
    AND entitlements.status = 'active'
    AND entitlements.download_count < entitlements.max_downloads
    AND (
      entitlements.access_expires_at IS NULL
      OR julianday(entitlements.access_expires_at) > julianday(NEW.created_at)
    )
    AND orders.payment_status = 'paid'
    AND orders.status IN ('processing', 'completed')
    AND digital_assets.status = 'active'
    AND digital_asset_versions.status = 'active'
    AND NOT EXISTS (
      SELECT 1
      FROM delivery_grant_consumptions
      WHERE shop_id = grants.shop_id
        AND grant_id = grants.id
    )
)
BEGIN
  SELECT RAISE(ABORT, 'private_file_claim_scope_mismatch');
END;

CREATE TRIGGER delivery_grant_claims_immutable_update
BEFORE UPDATE ON delivery_grant_claims
BEGIN
  SELECT RAISE(ABORT, 'private_file_claim_immutable');
END;
