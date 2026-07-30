PRAGMA foreign_keys = ON;

-- Keep semantic ISO-3166 validation in D1 instead of accepting any two-letter
-- user-assigned identifier. The reference is global and code-only so future
-- forward migrations can add newly assigned codes without touching shops.
CREATE TABLE iso_3166_alpha2_country_codes (
  code TEXT PRIMARY KEY NOT NULL CHECK (
    length(code) = 2 AND code = upper(code) AND code GLOB '[A-Z][A-Z]'
  )
) WITHOUT ROWID, STRICT;

INSERT INTO iso_3166_alpha2_country_codes (code) VALUES
  ('AD'), ('AE'), ('AF'), ('AG'), ('AI'), ('AL'), ('AM'), ('AO'), ('AQ'), ('AR'),
  ('AS'), ('AT'), ('AU'), ('AW'), ('AX'), ('AZ'), ('BA'), ('BB'), ('BD'), ('BE'),
  ('BF'), ('BG'), ('BH'), ('BI'), ('BJ'), ('BL'), ('BM'), ('BN'), ('BO'), ('BQ'),
  ('BR'), ('BS'), ('BT'), ('BV'), ('BW'), ('BY'), ('BZ'), ('CA'), ('CC'), ('CD'),
  ('CF'), ('CG'), ('CH'), ('CI'), ('CK'), ('CL'), ('CM'), ('CN'), ('CO'), ('CR'),
  ('CU'), ('CV'), ('CW'), ('CX'), ('CY'), ('CZ'), ('DE'), ('DJ'), ('DK'), ('DM'),
  ('DO'), ('DZ'), ('EC'), ('EE'), ('EG'), ('EH'), ('ER'), ('ES'), ('ET'), ('FI'),
  ('FJ'), ('FK'), ('FM'), ('FO'), ('FR'), ('GA'), ('GB'), ('GD'), ('GE'), ('GF'),
  ('GG'), ('GH'), ('GI'), ('GL'), ('GM'), ('GN'), ('GP'), ('GQ'), ('GR'), ('GS'),
  ('GT'), ('GU'), ('GW'), ('GY'), ('HK'), ('HM'), ('HN'), ('HR'), ('HT'), ('HU'),
  ('ID'), ('IE'), ('IL'), ('IM'), ('IN'), ('IO'), ('IQ'), ('IR'), ('IS'), ('IT'),
  ('JE'), ('JM'), ('JO'), ('JP'), ('KE'), ('KG'), ('KH'), ('KI'), ('KM'), ('KN'),
  ('KP'), ('KR'), ('KW'), ('KY'), ('KZ'), ('LA'), ('LB'), ('LC'), ('LI'), ('LK'),
  ('LR'), ('LS'), ('LT'), ('LU'), ('LV'), ('LY'), ('MA'), ('MC'), ('MD'), ('ME'),
  ('MF'), ('MG'), ('MH'), ('MK'), ('ML'), ('MM'), ('MN'), ('MO'), ('MP'), ('MQ'),
  ('MR'), ('MS'), ('MT'), ('MU'), ('MV'), ('MW'), ('MX'), ('MY'), ('MZ'), ('NA'),
  ('NC'), ('NE'), ('NF'), ('NG'), ('NI'), ('NL'), ('NO'), ('NP'), ('NR'), ('NU'),
  ('NZ'), ('OM'), ('PA'), ('PE'), ('PF'), ('PG'), ('PH'), ('PK'), ('PL'), ('PM'),
  ('PN'), ('PR'), ('PS'), ('PT'), ('PW'), ('PY'), ('QA'), ('RE'), ('RO'), ('RS'),
  ('RU'), ('RW'), ('SA'), ('SB'), ('SC'), ('SD'), ('SE'), ('SG'), ('SH'), ('SI'),
  ('SJ'), ('SK'), ('SL'), ('SM'), ('SN'), ('SO'), ('SR'), ('SS'), ('ST'), ('SV'),
  ('SX'), ('SY'), ('SZ'), ('TC'), ('TD'), ('TF'), ('TG'), ('TH'), ('TJ'), ('TK'),
  ('TL'), ('TM'), ('TN'), ('TO'), ('TR'), ('TT'), ('TV'), ('TW'), ('TZ'), ('UA'),
  ('UG'), ('UM'), ('US'), ('UY'), ('UZ'), ('VA'), ('VC'), ('VE'), ('VG'), ('VI'),
  ('VN'), ('VU'), ('WF'), ('WS'), ('YE'), ('YT'), ('ZA'), ('ZM'), ('ZW');

CREATE TRIGGER iso_3166_alpha2_country_codes_immutable_update
BEFORE UPDATE ON iso_3166_alpha2_country_codes
BEGIN
  SELECT RAISE(ABORT, 'iso_country_codes_immutable');
END;

CREATE TRIGGER iso_3166_alpha2_country_codes_immutable_delete
BEFORE DELETE ON iso_3166_alpha2_country_codes
BEGIN
  SELECT RAISE(ABORT, 'iso_country_codes_immutable');
END;

-- Country columns were introduced as nullable in 0031. Invalid values that
-- may have been written during the staged rollout become explicit unknowns;
-- compatible values and legacy NULLs remain unchanged.
UPDATE shops
SET merchant_country_code = NULL
WHERE merchant_country_code IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM iso_3166_alpha2_country_codes
    WHERE code = shops.merchant_country_code
  );

UPDATE shops
SET business_country_code = NULL
WHERE business_country_code IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM iso_3166_alpha2_country_codes
    WHERE code = shops.business_country_code
  );

CREATE TRIGGER shops_country_code_insert_guard
BEFORE INSERT ON shops
WHEN (NEW.merchant_country_code IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM iso_3166_alpha2_country_codes WHERE code = NEW.merchant_country_code
      ))
  OR (NEW.business_country_code IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM iso_3166_alpha2_country_codes WHERE code = NEW.business_country_code
      ))
BEGIN
  SELECT RAISE(ABORT, 'shop_country_code_invalid');
END;

CREATE TRIGGER shops_country_code_update_guard
BEFORE UPDATE OF merchant_country_code, business_country_code ON shops
WHEN (NEW.merchant_country_code IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM iso_3166_alpha2_country_codes WHERE code = NEW.merchant_country_code
      ))
  OR (NEW.business_country_code IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM iso_3166_alpha2_country_codes WHERE code = NEW.business_country_code
      ))
BEGIN
  SELECT RAISE(ABORT, 'shop_country_code_invalid');
END;

CREATE TRIGGER shops_currency_insert_guard
BEFORE INSERT ON shops
WHEN NEW.currency NOT IN ('USD', 'EUR', 'JPY', 'VND')
BEGIN
  SELECT RAISE(ABORT, 'shop_currency_unsupported');
END;

CREATE TRIGGER shops_currency_unsupported_update_guard
BEFORE UPDATE OF currency ON shops
WHEN NEW.currency NOT IN ('USD', 'EUR', 'JPY', 'VND')
BEGIN
  SELECT RAISE(ABORT, 'shop_currency_unsupported');
END;

CREATE TRIGGER shops_currency_variant_mismatch_guard
BEFORE UPDATE OF currency ON shops
WHEN EXISTS (
  SELECT 1
  FROM product_variants
  WHERE product_variants.shop_id = OLD.id
    AND product_variants.currency <> NEW.currency
)
BEGIN
  SELECT RAISE(ABORT, 'shop_currency_variant_mismatch');
END;

CREATE TRIGGER product_variants_currency_insert_shop_guard
BEFORE INSERT ON product_variants
WHEN NOT EXISTS (
  SELECT 1 FROM shops
  WHERE shops.id = NEW.shop_id
    AND shops.currency = NEW.currency
)
BEGIN
  SELECT RAISE(ABORT, 'variant_currency_shop_mismatch');
END;

CREATE TRIGGER product_variants_currency_update_shop_guard
BEFORE UPDATE OF currency, shop_id ON product_variants
WHEN NOT EXISTS (
  SELECT 1 FROM shops
  WHERE shops.id = NEW.shop_id
    AND shops.currency = NEW.currency
)
BEGIN
  SELECT RAISE(ABORT, 'variant_currency_shop_mismatch');
END;

-- Create unsupported-currency guards last so they take precedence over the
-- broader tenant-match guard when both predicates are false.
CREATE TRIGGER product_variants_currency_insert_unsupported_guard
BEFORE INSERT ON product_variants
WHEN NEW.currency NOT IN ('USD', 'EUR', 'JPY', 'VND')
BEGIN
  SELECT RAISE(ABORT, 'variant_currency_unsupported');
END;

CREATE TRIGGER product_variants_currency_update_unsupported_guard
BEFORE UPDATE OF currency, shop_id ON product_variants
WHEN NEW.currency NOT IN ('USD', 'EUR', 'JPY', 'VND')
BEGIN
  SELECT RAISE(ABORT, 'variant_currency_unsupported');
END;
