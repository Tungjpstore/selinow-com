PRAGMA foreign_keys = ON;

-- Keep connector intent tenant-bound even when a maintenance or recovery path
-- writes directly to D1 instead of going through the application service.
CREATE TRIGGER channel_connector_requests_scope_insert_guard
BEFORE INSERT ON channel_connector_requests
WHEN NEW.channel_code != NEW.provider_code
  OR NEW.channel_code NOT IN ('telegram.mini_app', 'zalo.mini_app', 'whatsapp.cloud', 'discord.bot')
  OR NOT EXISTS (
    SELECT 1 FROM shop_members AS members
    WHERE members.shop_id = NEW.shop_id
      AND members.user_id = NEW.requested_by_user_id
      AND members.status = 'active'
  )
BEGIN
  SELECT RAISE(ABORT, 'channel_connector_request_scope_mismatch');
END;

CREATE TRIGGER channel_connector_requests_reviewer_scope_guard
BEFORE UPDATE ON channel_connector_requests
WHEN NEW.reviewed_by_user_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM shop_members AS reviewers
    WHERE reviewers.shop_id = NEW.shop_id
      AND reviewers.user_id = NEW.reviewed_by_user_id
      AND reviewers.status = 'active'
  )
BEGIN
  SELECT RAISE(ABORT, 'channel_connector_request_reviewer_scope_mismatch');
END;
