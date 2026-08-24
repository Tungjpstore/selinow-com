PRAGMA foreign_keys = ON;

-- Premium storefront templates are a Pro entitlement. Existing Pro
-- subscriptions join the live plan row, so this forward-only catalog update
-- restores access without rewriting tenant subscription history.
UPDATE plans
SET feature_flags_json = json_set(
      feature_flags_json,
      '$.premiumStorefrontTemplates',
      json('true')
    ),
    version = version + 1,
    updated_at = CURRENT_TIMESTAMP
WHERE id = 'plan_pro_v1'
  AND code = 'pro'
  AND is_active = 1
  AND COALESCE(json_extract(feature_flags_json, '$.premiumStorefrontTemplates'), 0) != 1;

-- Fail the migration instead of silently reporting success if the canonical
-- active Pro row is missing, duplicated, or still lacks the entitlement.
CREATE TABLE migration_assert_0118_pro_entitlement (
  verified INTEGER NOT NULL CHECK (verified = 1)
);

INSERT INTO migration_assert_0118_pro_entitlement (verified)
SELECT CASE WHEN COUNT(*) = 1 THEN 1 ELSE 0 END
FROM plans
WHERE id = 'plan_pro_v1'
  AND code = 'pro'
  AND is_active = 1
  AND json_extract(feature_flags_json, '$.premiumStorefrontTemplates') = 1;

DROP TABLE migration_assert_0118_pro_entitlement;
