PRAGMA foreign_keys = ON;

-- Publish authoritative Dodo Payments external price references for public plans.
-- Transitions pending placeholder price references to published Dodo price IDs,
-- enabling the public marketing catalog on the landing page and /pricing.

UPDATE plan_prices
SET provider_price_ref = 'dodo_pri_starter_vn_v1',
    updated_at = CURRENT_TIMESTAMP
WHERE id = 'price_starter_vn_v1'
  AND provider_code = 'dodo'
  AND provider_price_ref LIKE 'pending:%';

UPDATE plan_prices
SET provider_price_ref = 'dodo_pri_pro_vn_v1',
    updated_at = CURRENT_TIMESTAMP
WHERE id = 'price_pro_vn_v1'
  AND provider_code = 'dodo'
  AND provider_price_ref LIKE 'pending:%';

UPDATE plan_prices
SET provider_price_ref = 'dodo_pri_starter_global_v1',
    updated_at = CURRENT_TIMESTAMP
WHERE id = 'price_starter_global_v1'
  AND provider_code = 'dodo'
  AND provider_price_ref LIKE 'pending:%';

UPDATE plan_prices
SET provider_price_ref = 'dodo_pri_pro_global_v1',
    updated_at = CURRENT_TIMESTAMP
WHERE id = 'price_pro_global_v1'
  AND provider_code = 'dodo'
  AND provider_price_ref LIKE 'pending:%';
