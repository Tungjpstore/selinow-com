PRAGMA foreign_keys = ON;

-- Keep provider-facing work durable without allowing a browser request to
-- claim that an operation completed. These fields record only bounded
-- references and retry evidence; provider truth still arrives via a signed
-- webhook or an explicit reconciliation job.
ALTER TABLE subscription_change_requests ADD COLUMN provider_action_ref TEXT CHECK (
  provider_action_ref IS NULL OR (
    length(provider_action_ref) BETWEEN 3 AND 160
    AND provider_action_ref NOT GLOB '*[[:space:]]*'
  )
);
ALTER TABLE subscription_change_requests ADD COLUMN provider_event_id TEXT;
ALTER TABLE subscription_change_requests ADD COLUMN failure_code TEXT CHECK (
  failure_code IS NULL OR (
    length(failure_code) BETWEEN 3 AND 96
    AND failure_code NOT GLOB '*[^a-zA-Z0-9._:-]*'
  )
);
ALTER TABLE subscription_change_requests ADD COLUMN execution_attempts INTEGER NOT NULL DEFAULT 0 CHECK (execution_attempts >= 0);
ALTER TABLE subscription_change_requests ADD COLUMN last_attempt_at TEXT;

CREATE INDEX idx_subscription_change_requests_execution
  ON subscription_change_requests(shop_id, status, last_attempt_at, id);

DROP TRIGGER IF EXISTS subscription_change_requests_transition_guard;

CREATE TRIGGER subscription_change_requests_transition_guard
BEFORE UPDATE ON subscription_change_requests
WHEN NEW.id != OLD.id
  OR NEW.shop_id != OLD.shop_id
  OR NEW.subscription_id != OLD.subscription_id
  OR NEW.current_plan_id != OLD.current_plan_id
  OR NEW.requested_plan_id IS NOT OLD.requested_plan_id
  OR NEW.action != OLD.action
  OR NEW.expected_subscription_version != OLD.expected_subscription_version
  OR NEW.reason_code != OLD.reason_code
  OR NEW.requested_by_user_id != OLD.requested_by_user_id
  OR NEW.created_at != OLD.created_at
  OR NEW.version != OLD.version + 1
  OR NEW.execution_attempts < OLD.execution_attempts
  OR NEW.execution_attempts > OLD.execution_attempts + 1
  OR (NEW.reviewed_by_user_id IS NOT OLD.reviewed_by_user_id AND NEW.status NOT IN ('requested', 'provider_pending', 'rejected'))
  OR (NEW.reviewed_at IS NOT OLD.reviewed_at AND NEW.status NOT IN ('requested', 'provider_pending', 'rejected'))
  OR (NEW.provider_action_ref IS NOT OLD.provider_action_ref AND NEW.status NOT IN ('requested', 'provider_pending', 'completed', 'rejected'))
  OR (NEW.provider_event_id IS NOT OLD.provider_event_id AND NEW.status != 'completed')
  OR (NEW.last_attempt_at IS NOT OLD.last_attempt_at AND NEW.status NOT IN ('requested', 'provider_pending', 'rejected'))
  OR OLD.status IN ('completed', 'canceled', 'rejected')
  OR NOT (
    (OLD.status = 'requested' AND NEW.status IN ('requested', 'provider_pending', 'rejected', 'canceled'))
    OR (OLD.status = 'provider_pending' AND NEW.status IN ('provider_pending', 'requested', 'completed', 'rejected', 'canceled'))
  )
BEGIN
  SELECT RAISE(ABORT, 'subscription_change_request_transition_invalid');
END;

ALTER TABLE billing_checkout_sessions ADD COLUMN expired_at TEXT;

DROP INDEX IF EXISTS idx_billing_checkout_sessions_pending;
CREATE INDEX idx_billing_checkout_sessions_pending
  ON billing_checkout_sessions(status, expires_at, id)
  WHERE status IN ('pending', 'open');

-- Only one provider checkout may be active for a subscription. The existing
-- conditional INSERT remains the race-safe fast path; this index is the
-- database authority when two requests arrive concurrently.
CREATE UNIQUE INDEX idx_billing_checkout_sessions_active_subscription
  ON billing_checkout_sessions(shop_id, subscription_id)
  WHERE status IN ('pending', 'open');

DROP INDEX IF EXISTS idx_shop_subscriptions_provider_ref;
CREATE UNIQUE INDEX idx_shop_subscriptions_provider_ref
  ON shop_subscriptions(billing_provider_code, provider_subscription_ref)
  WHERE provider_subscription_ref IS NOT NULL;

CREATE TRIGGER shop_subscriptions_provider_ref_guard
BEFORE INSERT ON shop_subscriptions
WHEN NEW.provider_subscription_ref IS NOT NULL AND NEW.billing_provider_code IS NULL
BEGIN
  SELECT RAISE(ABORT, 'subscription_provider_scope_mismatch');
END;

CREATE TRIGGER shop_subscriptions_provider_ref_update_guard
BEFORE UPDATE ON shop_subscriptions
WHEN NEW.provider_subscription_ref IS NOT NULL AND NEW.billing_provider_code IS NULL
BEGIN
  SELECT RAISE(ABORT, 'subscription_provider_scope_mismatch');
END;

-- Record the subscription identity resolved by the signed provider event.
-- Unmapped events remain nullable, but a populated pair must be tenant-bound.
ALTER TABLE billing_provider_events ADD COLUMN subscription_id TEXT;
CREATE INDEX idx_billing_provider_events_subscription
  ON billing_provider_events(shop_id, subscription_id, occurred_at, id);

CREATE INDEX idx_billing_provider_events_object
  ON billing_provider_events(provider_code, provider_object_ref, created_at, id)
  WHERE provider_object_ref IS NOT NULL;

DROP TRIGGER IF EXISTS billing_provider_events_identity_immutable;
CREATE TRIGGER billing_provider_events_identity_immutable
BEFORE UPDATE ON billing_provider_events
WHEN NEW.id != OLD.id
  OR NEW.provider_code != OLD.provider_code
  OR NEW.provider_event_id != OLD.provider_event_id
  OR NEW.provider_object_ref IS NOT OLD.provider_object_ref
  OR NEW.payload_hash != OLD.payload_hash
  OR NEW.shop_id IS NOT OLD.shop_id
  OR NEW.subscription_id IS NOT OLD.subscription_id
  OR NEW.event_type != OLD.event_type
  OR NEW.safe_metadata_json != OLD.safe_metadata_json
  OR NEW.occurred_at IS NOT OLD.occurred_at
  OR NEW.created_at != OLD.created_at
BEGIN
  SELECT RAISE(ABORT, 'billing_provider_event_identity_immutable');
END;

CREATE TRIGGER billing_provider_events_subscription_scope_guard
BEFORE INSERT ON billing_provider_events
WHEN NEW.subscription_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM shop_subscriptions
    WHERE shop_subscriptions.shop_id = NEW.shop_id
      AND shop_subscriptions.id = NEW.subscription_id
  )
BEGIN
  SELECT RAISE(ABORT, 'billing_provider_event_subscription_scope_mismatch');
END;

CREATE TRIGGER billing_provider_events_subscription_scope_update_guard
BEFORE UPDATE ON billing_provider_events
WHEN NEW.subscription_id IS NOT OLD.subscription_id
  AND NEW.subscription_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM shop_subscriptions
    WHERE shop_subscriptions.shop_id = NEW.shop_id
      AND shop_subscriptions.id = NEW.subscription_id
  )
BEGIN
  SELECT RAISE(ABORT, 'billing_provider_event_subscription_scope_mismatch');
END;

-- Foreign keys bind IDs, not the tenant/provider identity carried by those
-- IDs. These guards close the remaining cross-tenant write paths.
CREATE TRIGGER billing_checkout_sessions_scope_guard
BEFORE INSERT ON billing_checkout_sessions
WHEN NOT EXISTS (
    SELECT 1
    FROM shop_subscriptions AS subscriptions
    INNER JOIN plan_prices AS prices ON prices.id = NEW.price_id
    WHERE subscriptions.shop_id = NEW.shop_id
      AND subscriptions.id = NEW.subscription_id
      AND prices.plan_id = NEW.plan_id
      AND prices.provider_code = NEW.provider_code
  )
BEGIN
  SELECT RAISE(ABORT, 'billing_checkout_scope_mismatch');
END;

CREATE TRIGGER billing_checkout_sessions_scope_update_guard
BEFORE UPDATE ON billing_checkout_sessions
WHEN NEW.shop_id != OLD.shop_id
  OR NEW.subscription_id != OLD.subscription_id
  OR NEW.plan_id != OLD.plan_id
  OR NEW.price_id != OLD.price_id
  OR NEW.provider_code != OLD.provider_code
  OR (OLD.provider_checkout_ref IS NOT NULL AND NEW.provider_checkout_ref IS NOT OLD.provider_checkout_ref)
  OR NOT EXISTS (
    SELECT 1
    FROM shop_subscriptions AS subscriptions
    INNER JOIN plan_prices AS prices ON prices.id = NEW.price_id
    WHERE subscriptions.shop_id = NEW.shop_id
      AND subscriptions.id = NEW.subscription_id
      AND prices.plan_id = NEW.plan_id
      AND prices.provider_code = NEW.provider_code
  )
BEGIN
  SELECT RAISE(ABORT, 'billing_checkout_scope_mismatch');
END;

CREATE TRIGGER billing_invoice_account_scope_guard
BEFORE INSERT ON billing_invoices
WHEN NEW.billing_account_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM billing_accounts AS accounts
    WHERE accounts.id = NEW.billing_account_id
      AND accounts.shop_id = NEW.shop_id
      AND accounts.provider_code = NEW.provider_code
      AND accounts.currency = NEW.currency
  )
BEGIN
  SELECT RAISE(ABORT, 'billing_invoice_account_scope_mismatch');
END;

CREATE TRIGGER billing_invoice_account_scope_update_guard
BEFORE UPDATE ON billing_invoices
WHEN NEW.billing_account_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM billing_accounts AS accounts
    WHERE accounts.id = NEW.billing_account_id
      AND accounts.shop_id = NEW.shop_id
      AND accounts.provider_code = NEW.provider_code
      AND accounts.currency = NEW.currency
  )
BEGIN
  SELECT RAISE(ABORT, 'billing_invoice_account_scope_mismatch');
END;

CREATE TRIGGER subscription_events_provider_scope_guard
BEFORE INSERT ON subscription_events
WHEN NEW.source_kind = 'provider'
  AND NEW.provider_event_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM billing_provider_events AS events
    WHERE events.id = NEW.provider_event_id
      AND events.shop_id = NEW.shop_id
  )
BEGIN
  SELECT RAISE(ABORT, 'subscription_event_provider_scope_mismatch');
END;
