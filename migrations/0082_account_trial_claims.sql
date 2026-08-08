PRAGMA foreign_keys = ON;

-- A public account receives one evaluation trial. The claim is separate from
-- mutable subscription state so canceling or expiring a shop cannot mint a new
-- trial, and the primary key closes concurrent create-shop races in D1.
CREATE TABLE account_trial_claims (
  user_id TEXT PRIMARY KEY NOT NULL REFERENCES platform_users(id) ON DELETE RESTRICT,
  shop_id TEXT NOT NULL UNIQUE REFERENCES shops(id) ON DELETE RESTRICT,
  claimed_at TEXT NOT NULL
) WITHOUT ROWID, STRICT;

CREATE INDEX idx_account_trial_claims_shop
  ON account_trial_claims(shop_id, user_id);

-- Preserve historical trial use. If legacy data contains multiple trial shops
-- for one owner, the oldest claim wins and the account remains ineligible for
-- another evaluation.
INSERT OR IGNORE INTO account_trial_claims (user_id, shop_id, claimed_at)
SELECT members.user_id, members.shop_id, subscriptions.created_at
FROM shop_members AS members
INNER JOIN shop_subscriptions AS subscriptions
  ON subscriptions.shop_id = members.shop_id
WHERE members.role = 'owner'
  AND subscriptions.trial_ends_at IS NOT NULL
ORDER BY subscriptions.created_at ASC, members.shop_id ASC;
