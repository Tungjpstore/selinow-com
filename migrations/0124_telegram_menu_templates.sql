PRAGMA foreign_keys = ON;

-- Extend telegram_integrations with industry-specific menu template configuration
ALTER TABLE telegram_integrations
  ADD COLUMN template_preset TEXT NOT NULL DEFAULT 'license_vault' CHECK (
    template_preset IN ('license_vault', 'gaming_topup', 'subscription_slots', 'mini_app_hybrid', 'vip_community')
  );

ALTER TABLE telegram_integrations
  ADD COLUMN welcome_message_custom TEXT;

ALTER TABLE telegram_integrations
  ADD COLUMN support_handle TEXT;

ALTER TABLE telegram_integrations
  ADD COLUMN menu_config_json TEXT;

CREATE INDEX idx_telegram_integrations_template
  ON telegram_integrations(shop_id, template_preset);
