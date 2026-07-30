PRAGMA foreign_keys = ON;

-- Keep inferred/effective locale separate from a buyer's durable choice. The
-- bounded check prevents unsupported values from outranking safe fallbacks.
ALTER TABLE shop_customers
  ADD COLUMN preferred_locale TEXT CHECK (
    preferred_locale IS NULL OR preferred_locale IN ('en', 'vi-VN')
  );

