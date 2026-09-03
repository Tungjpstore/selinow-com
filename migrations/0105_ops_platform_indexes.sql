-- Forward-only platform-leading operational indexes for cross-tenant admin
-- console queries. The existing operational indexes are shop-leading, so
-- platform-wide listings and counts (dead letters, payment exceptions,
-- failed/dead-letter delivery jobs) fall back to full scans. Keyset
-- pagination for the admin list services orders by (created_at DESC, id DESC)
-- or reads failed delivery jobs by status; these indexes back those paths
-- with column directions matching the listing order.

CREATE INDEX IF NOT EXISTS idx_queue_dead_letters_platform_status
  ON queue_dead_letters(status, created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_payment_exceptions_platform_status
  ON payment_exceptions(status, created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_delivery_jobs_platform_attention
  ON delivery_jobs(status, updated_at DESC, id DESC)
  WHERE status IN ('failed', 'dead_letter');
