-- Paddle is the selected platform billing provider for both markets. Seller
-- order payments may still use PayOS; these rows are subscription prices only.
UPDATE plan_prices
SET provider_code = 'paddle',
    provider_price_ref = CASE
      WHEN market_code = 'vn' AND plan_id = 'plan_starter_v1' THEN 'pending:paddle:starter:vn:month:v1'
      WHEN market_code = 'vn' AND plan_id = 'plan_pro_v1' THEN 'pending:paddle:pro:vn:month:v1'
      ELSE provider_price_ref
    END,
    updated_at = CURRENT_TIMESTAMP
WHERE market_code = 'vn'
  AND plan_id IN ('plan_starter_v1', 'plan_pro_v1')
  AND is_active = 1;
