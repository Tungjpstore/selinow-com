PRAGMA foreign_keys = ON;

-- Close the rolling-deploy gap after 0082. A legacy runtime creates the owner
-- membership before the trial subscription, so the database can recover the
-- durable account claim without trusting application version ordering.
INSERT OR IGNORE INTO account_trial_claims (user_id, shop_id, claimed_at)
SELECT members.user_id, subscriptions.shop_id, subscriptions.created_at
FROM shop_subscriptions AS subscriptions
INNER JOIN shop_members AS members
  ON members.shop_id = subscriptions.shop_id
WHERE subscriptions.state = 'trialing'
  AND members.role = 'owner'
  AND members.status = 'active'
ORDER BY subscriptions.created_at ASC, members.created_at ASC, members.user_id ASC;

CREATE TABLE migration_0087_trial_claim_guard (
  mismatch_count INTEGER NOT NULL CHECK (mismatch_count = 0)
) STRICT;

INSERT INTO migration_0087_trial_claim_guard (mismatch_count)
SELECT COUNT(*)
FROM shop_subscriptions AS subscriptions
WHERE subscriptions.state = 'trialing'
  AND NOT EXISTS (
    SELECT 1 FROM account_trial_claims AS claims
    WHERE claims.shop_id = subscriptions.shop_id
  );

DROP TABLE migration_0087_trial_claim_guard;

CREATE TRIGGER shop_subscriptions_trial_claim_insert_guard
BEFORE INSERT ON shop_subscriptions
WHEN NEW.state = 'trialing'
  AND NEW.trial_ends_at IS NOT NULL
  AND NEW.trial_ends_at > CURRENT_TIMESTAMP
BEGIN
  INSERT OR IGNORE INTO account_trial_claims (user_id, shop_id, claimed_at)
  SELECT members.user_id, NEW.shop_id, NEW.created_at
  FROM shop_members AS members
  WHERE members.shop_id = NEW.shop_id
    AND members.role = 'owner'
    AND members.status = 'active'
  ORDER BY members.created_at ASC, members.user_id ASC
  LIMIT 1;

  SELECT RAISE(ABORT, 'trial_account_claim_required')
  WHERE NOT EXISTS (
    SELECT 1 FROM account_trial_claims AS claims
    WHERE claims.shop_id = NEW.shop_id
  );
END;

CREATE TRIGGER shop_subscriptions_trial_claim_update_guard
BEFORE UPDATE OF state, shop_id ON shop_subscriptions
WHEN NEW.state = 'trialing'
  AND NEW.trial_ends_at IS NOT NULL
  AND NEW.trial_ends_at > CURRENT_TIMESTAMP
  AND NOT EXISTS (
    SELECT 1 FROM account_trial_claims AS claims
    WHERE claims.shop_id = NEW.shop_id
  )
BEGIN
  INSERT OR IGNORE INTO account_trial_claims (user_id, shop_id, claimed_at)
  SELECT members.user_id, NEW.shop_id, NEW.created_at
  FROM shop_members AS members
  WHERE members.shop_id = NEW.shop_id
    AND members.role = 'owner'
    AND members.status = 'active'
  ORDER BY members.created_at ASC, members.user_id ASC
  LIMIT 1;

  SELECT RAISE(ABORT, 'trial_account_claim_required')
  WHERE NOT EXISTS (
    SELECT 1 FROM account_trial_claims AS claims
    WHERE claims.shop_id = NEW.shop_id
  );
END;

CREATE TRIGGER shop_customers_anonymized_insert_guard
BEFORE INSERT ON shop_customers
WHEN NEW.anonymized_at IS NOT NULL
  AND (
    NEW.email_normalized IS NOT NULL
    OR NEW.display_name IS NOT NULL
    OR NEW.status != 'blocked'
  )
BEGIN
  SELECT RAISE(ABORT, 'customer_anonymized_immutable');
END;

CREATE TRIGGER shop_customers_anonymized_update_guard
BEFORE UPDATE ON shop_customers
WHEN OLD.anonymized_at IS NOT NULL
  AND (
    NEW.anonymized_at IS NULL
    OR NEW.anonymized_at != OLD.anonymized_at
    OR NEW.email_normalized IS NOT NULL
    OR NEW.display_name IS NOT NULL
    OR NEW.status != 'blocked'
  )
BEGIN
  SELECT RAISE(ABORT, 'customer_anonymized_immutable');
END;

CREATE TRIGGER checkout_recovery_capabilities_tenant_order_insert_guard
BEFORE INSERT ON checkout_recovery_capabilities
WHEN NEW.consumed_order_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM orders
    WHERE orders.id = NEW.consumed_order_id
      AND orders.shop_id = NEW.shop_id
  )
BEGIN
  SELECT RAISE(ABORT, 'checkout_recovery_order_tenant_mismatch');
END;

DROP TRIGGER checkout_recovery_capabilities_tenant_order_guard;

CREATE TRIGGER checkout_recovery_capabilities_tenant_order_guard
BEFORE UPDATE OF shop_id, consumed_order_id ON checkout_recovery_capabilities
WHEN NEW.consumed_order_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM orders
    WHERE orders.id = NEW.consumed_order_id
      AND orders.shop_id = NEW.shop_id
  )
BEGIN
  SELECT RAISE(ABORT, 'checkout_recovery_order_tenant_mismatch');
END;
