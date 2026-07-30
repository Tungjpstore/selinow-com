PRAGMA foreign_keys = ON;

-- Direct settlement is seller-owned. Managed credentials are supported only
-- through a provider partner acting as merchant of record. Validate all
-- persisted projection rows before installing guards so policy drift cannot
-- be hidden by a forward migration.
CREATE TABLE IF NOT EXISTS migration_0043_payment_settlement_policy_validation (
  invalid_count INTEGER NOT NULL,
  CONSTRAINT migration_0043_payment_settlement_policy_valid
    CHECK (invalid_count = 0)
) STRICT;

DELETE FROM migration_0043_payment_settlement_policy_validation;

INSERT INTO migration_0043_payment_settlement_policy_validation (invalid_count)
SELECT COUNT(*)
FROM payment_provider_connections
WHERE NOT (
  (
    connection_mode = 'bring_your_own'
    AND settlement_mode = 'direct'
    AND credential_ownership = 'seller'
  )
  OR (
    connection_mode = 'managed'
    AND settlement_mode = 'mor_partner'
    AND credential_ownership = 'provider_partner'
  )
);

DROP TABLE migration_0043_payment_settlement_policy_validation;

CREATE TRIGGER IF NOT EXISTS payment_provider_connections_settlement_policy_insert_guard
BEFORE INSERT ON payment_provider_connections
WHEN NOT (
  (
    NEW.connection_mode = 'bring_your_own'
    AND NEW.settlement_mode = 'direct'
    AND NEW.credential_ownership = 'seller'
  )
  OR (
    NEW.connection_mode = 'managed'
    AND NEW.settlement_mode = 'mor_partner'
    AND NEW.credential_ownership = 'provider_partner'
  )
)
BEGIN
  SELECT RAISE(ABORT, 'payment_provider_connection_settlement_policy_invalid');
END;

CREATE TRIGGER IF NOT EXISTS payment_provider_connections_settlement_policy_update_guard
BEFORE UPDATE OF connection_mode, settlement_mode, credential_ownership
ON payment_provider_connections
WHEN NOT (
  (
    NEW.connection_mode = 'bring_your_own'
    AND NEW.settlement_mode = 'direct'
    AND NEW.credential_ownership = 'seller'
  )
  OR (
    NEW.connection_mode = 'managed'
    AND NEW.settlement_mode = 'mor_partner'
    AND NEW.credential_ownership = 'provider_partner'
  )
)
BEGIN
  SELECT RAISE(ABORT, 'payment_provider_connection_settlement_policy_invalid');
END;
