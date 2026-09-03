PRAGMA foreign_keys = ON;

-- Pro storefront templates are an entitlement, not a UI-only capability.
-- Repair the published Pro plan catalog without changing Starter or any
-- tenant subscription rows. The predicate keeps this forward-only data fix
-- idempotent for local replay and restore validation.
UPDATE plans
SET feature_flags_json = json_set(
      feature_flags_json,
      '$.premiumStorefrontTemplates',
      json('true')
    ),
    version = version + 1,
    updated_at = CURRENT_TIMESTAMP
WHERE code = 'pro'
  AND json_type(feature_flags_json, '$.premiumStorefrontTemplates') IS NOT 'true';

PRAGMA foreign_keys = ON;
