INSERT OR IGNORE INTO plans (
  id,
  code,
  name,
  feature_flags_json,
  limits_json,
  version,
  is_active,
  created_at,
  updated_at
) VALUES
  ('plan_bot_v1', 'bot', 'Bot', '{"telegram":true,"storefront":false,"customDomain":false}', '{"products":25,"ordersPerMonth":300,"staffSeats":1,"customDomains":0}', 1, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('plan_store_v1', 'store', 'Store', '{"telegram":true,"storefront":true,"customDomain":"addon"}', '{"products":100,"ordersPerMonth":2000,"staffSeats":3,"customDomains":0}', 1, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('plan_business_v1', 'business', 'Business', '{"telegram":true,"storefront":true,"customDomain":true}', '{"products":500,"ordersPerMonth":10000,"staffSeats":10,"customDomains":3}', 1, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);

INSERT OR IGNORE INTO reserved_slugs (slug, reason, created_at) VALUES
  ('www', 'platform_hostname', CURRENT_TIMESTAMP),
  ('app', 'platform_hostname', CURRENT_TIMESTAMP),
  ('api', 'platform_hostname', CURRENT_TIMESTAMP),
  ('admin', 'platform_hostname', CURRENT_TIMESTAMP),
  ('media', 'platform_hostname', CURRENT_TIMESTAMP),
  ('assets', 'platform_hostname', CURRENT_TIMESTAMP),
  ('customers', 'platform_hostname', CURRENT_TIMESTAMP),
  ('proxy-fallback', 'platform_hostname', CURRENT_TIMESTAMP),
  ('status', 'platform_hostname', CURRENT_TIMESTAMP),
  ('support', 'platform_hostname', CURRENT_TIMESTAMP),
  ('docs', 'platform_hostname', CURRENT_TIMESTAMP),
  ('help', 'platform_hostname', CURRENT_TIMESTAMP),
  ('mail', 'platform_hostname', CURRENT_TIMESTAMP),
  ('email', 'platform_hostname', CURRENT_TIMESTAMP),
  ('billing', 'platform_hostname', CURRENT_TIMESTAMP),
  ('auth', 'platform_hostname', CURRENT_TIMESTAMP),
  ('login', 'platform_hostname', CURRENT_TIMESTAMP),
  ('signup', 'platform_hostname', CURRENT_TIMESTAMP),
  ('dashboard', 'platform_hostname', CURRENT_TIMESTAMP),
  ('cdn', 'platform_hostname', CURRENT_TIMESTAMP),
  ('static', 'platform_hostname', CURRENT_TIMESTAMP),
  ('test', 'platform_hostname', CURRENT_TIMESTAMP),
  ('staging', 'platform_hostname', CURRENT_TIMESTAMP),
  ('dev', 'platform_hostname', CURRENT_TIMESTAMP);

INSERT OR IGNORE INTO platform_settings (key, value_json, version, updated_at) VALUES
  ('schema_version', '{"value":1}', 1, CURRENT_TIMESTAMP),
  ('default_trial_days', '{"value":14}', 1, CURRENT_TIMESTAMP),
  ('subscription_grace_days', '{"value":7}', 1, CURRENT_TIMESTAMP);
