PRAGMA foreign_keys = ON;

-- Country configuration is nullable so existing tenants are not assigned a
-- legal country without explicit seller evidence during onboarding.
ALTER TABLE shops
  ADD COLUMN merchant_country_code TEXT CHECK (
    merchant_country_code IS NULL
    OR (length(merchant_country_code) = 2 AND merchant_country_code = upper(merchant_country_code)
      AND merchant_country_code GLOB '[A-Z][A-Z]')
  );

ALTER TABLE shops
  ADD COLUMN business_country_code TEXT CHECK (
    business_country_code IS NULL
    OR (length(business_country_code) = 2 AND business_country_code = upper(business_country_code)
      AND business_country_code GLOB '[A-Z][A-Z]')
  );

-- Keep tenant identity first for future country eligibility and seller-admin
-- filters. Partial predicates avoid indexing legacy shops until configured.
CREATE INDEX idx_shops_tenant_merchant_country
  ON shops(id, merchant_country_code)
  WHERE merchant_country_code IS NOT NULL;

CREATE INDEX idx_shops_tenant_business_country
  ON shops(id, business_country_code)
  WHERE business_country_code IS NOT NULL;
