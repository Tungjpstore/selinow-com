PRAGMA foreign_keys = ON;

-- Zalo Official Account OAuth is admitted only for a reviewed, active
-- connector request. This forward migration extends the original connector
-- scope guard without changing an already-applied migration.
DROP TRIGGER IF EXISTS channel_connector_requests_scope_insert_guard;

CREATE TRIGGER channel_connector_requests_scope_insert_guard
BEFORE INSERT ON channel_connector_requests
WHEN NEW.channel_code != NEW.provider_code
  OR NEW.channel_code NOT IN ('telegram.mini_app', 'zalo.mini_app', 'zalo.oa', 'whatsapp.cloud', 'discord.bot')
  OR NOT EXISTS (
    SELECT 1 FROM shop_members AS members
    WHERE members.shop_id = NEW.shop_id
      AND members.user_id = NEW.requested_by_user_id
      AND members.status = 'active'
  )
BEGIN
  SELECT RAISE(ABORT, 'channel_connector_request_scope_mismatch');
END;
