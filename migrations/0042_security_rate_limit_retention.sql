PRAGMA foreign_keys = ON;

-- Cron retention scans expired windows globally; tenant deletion continues to
-- use the existing tenant-leading shop/action index.
CREATE INDEX idx_security_rate_limits_expiry
  ON security_rate_limits(window_ends_at, shop_id, id, blocked_until);
