PRAGMA foreign_keys = ON;

-- Existing first-party plans receive explicit finite custom-domain limits.
-- Unknown/custom plans remain unchanged so the application fails closed until
-- an operator assigns a reviewed limit.
UPDATE plans
SET limits_json = json_set(limits_json, '$.customDomains', 0),
    version = version + 1,
    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE code IN ('bot', 'store')
  AND json_type(limits_json, '$.customDomains') IS NULL;

UPDATE plans
SET limits_json = json_set(limits_json, '$.customDomains', 3),
    version = version + 1,
    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE code = 'business'
  AND json_type(limits_json, '$.customDomains') IS NULL;
