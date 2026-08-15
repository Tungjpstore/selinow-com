PRAGMA foreign_keys = ON;

-- Keep the direct-D1 session invariant aligned with the runtime admission gate
-- when a plan is deactivated after the original session migration is applied.
DROP TRIGGER telegram_mini_app_sessions_scope_insert_guard;

CREATE TRIGGER telegram_mini_app_sessions_scope_insert_guard
BEFORE INSERT ON telegram_mini_app_sessions
WHEN NOT EXISTS (
  SELECT 1
  FROM shops
  INNER JOIN shop_subscriptions
    ON shop_subscriptions.shop_id = shops.id
    AND shop_subscriptions.state IN ('trialing', 'active', 'past_due')
  INNER JOIN plans
    ON plans.id = shop_subscriptions.plan_id
    AND plans.is_active = 1
  INNER JOIN telegram_integrations
    ON telegram_integrations.shop_id = shops.id
    AND telegram_integrations.id = NEW.integration_id
    AND telegram_integrations.status IN ('active', 'degraded')
    AND telegram_integrations.webhook_status = 'verified'
    AND telegram_integrations.active_credential_id = NEW.credential_id
  INNER JOIN telegram_credentials
    ON telegram_credentials.id = NEW.credential_id
    AND telegram_credentials.integration_id = telegram_integrations.id
    AND telegram_credentials.shop_id = shops.id
    AND telegram_credentials.status = 'active'
  INNER JOIN channel_connector_requests
    ON channel_connector_requests.id = NEW.connector_request_id
    AND channel_connector_requests.shop_id = shops.id
    AND channel_connector_requests.channel_code = 'telegram.mini_app'
    AND channel_connector_requests.provider_code = 'telegram.mini_app'
    AND channel_connector_requests.status = 'active'
    AND telegram_credentials.version = NEW.credential_version
  WHERE shops.id = NEW.shop_id
    AND shops.status = 'active'
)
BEGIN
  SELECT RAISE(ABORT, 'telegram_mini_app_session_scope_mismatch');
END;
