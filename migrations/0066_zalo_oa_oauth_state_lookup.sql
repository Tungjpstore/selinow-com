PRAGMA foreign_keys = ON;

-- Public OAuth callbacks can resolve a state without trusting a browser-supplied
-- tenant or request identifier. The lookup value is a blind HMAC of raw state;
-- the tenant-bound state_hash remains the authorization proof.
-- Rows created before this migration have no recoverable raw state and remain
-- NULL here; revoke or let them expire before enabling the public callback.
ALTER TABLE channel_oauth_states ADD COLUMN state_lookup_hash TEXT;

CREATE UNIQUE INDEX idx_channel_oauth_states_lookup_hash
  ON channel_oauth_states(state_lookup_hash, provider_code)
  WHERE state_lookup_hash IS NOT NULL;

DROP TRIGGER IF EXISTS channel_oauth_states_identity_immutable;

CREATE TRIGGER channel_oauth_states_identity_immutable
BEFORE UPDATE ON channel_oauth_states
WHEN NEW.id != OLD.id
  OR NEW.shop_id != OLD.shop_id
  OR NEW.connector_request_id != OLD.connector_request_id
  OR NEW.request_id != OLD.request_id
  OR NEW.provider_code != OLD.provider_code
  OR NEW.app_id != OLD.app_id
  OR NEW.redirect_uri != OLD.redirect_uri
  OR NEW.state_hash != OLD.state_hash
  OR NEW.state_lookup_hash IS NOT OLD.state_lookup_hash
  OR NEW.code_verifier_ciphertext_b64 != OLD.code_verifier_ciphertext_b64
  OR NEW.code_verifier_iv_b64 != OLD.code_verifier_iv_b64
  OR NEW.key_version != OLD.key_version
  OR NEW.expires_at != OLD.expires_at
  OR NEW.created_at != OLD.created_at
  OR NEW.version != OLD.version + 1
  OR OLD.status IN ('consumed', 'revoked')
  OR NOT (OLD.status = 'pending' AND NEW.status IN ('pending', 'consumed', 'revoked'))
BEGIN
  SELECT RAISE(ABORT, 'channel_oauth_state_transition_invalid');
END;
