PRAGMA foreign_keys = OFF;

-- Extend the existing anonymous admission ledger without editing its applied
-- history. Google starts use the same global/requester/subject budget model.
DROP INDEX IF EXISTS idx_auth_request_admissions_window;
DROP INDEX IF EXISTS idx_auth_request_admissions_requester_window;
DROP INDEX IF EXISTS idx_auth_request_admissions_expiry;
DROP INDEX IF EXISTS idx_auth_request_admissions_subject_window;
ALTER TABLE auth_request_admissions RENAME TO auth_request_admissions_legacy_0112;

CREATE TABLE auth_request_admissions (
  id TEXT PRIMARY KEY NOT NULL,
  action TEXT NOT NULL CHECK (
    action IN ('google_oauth_start', 'magic_link_request', 'shop_create')
  ),
  requester_hash TEXT NOT NULL CHECK (length(requester_hash) BETWEEN 16 AND 128),
  window_started_at TEXT NOT NULL,
  window_ends_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  subject_hash TEXT CHECK (
    subject_hash IS NULL OR length(subject_hash) BETWEEN 16 AND 128
  ),
  delivery_permitted INTEGER NOT NULL DEFAULT 1 CHECK (delivery_permitted IN (0, 1)),
  CHECK (window_ends_at > window_started_at)
) STRICT;

INSERT INTO auth_request_admissions (
  id, action, requester_hash, window_started_at, window_ends_at, created_at,
  subject_hash, delivery_permitted
)
SELECT
  id, action, requester_hash, window_started_at, window_ends_at, created_at,
  subject_hash, delivery_permitted
FROM auth_request_admissions_legacy_0112;

DROP TABLE auth_request_admissions_legacy_0112;

CREATE INDEX idx_auth_request_admissions_window
  ON auth_request_admissions(action, window_started_at, id);

CREATE INDEX idx_auth_request_admissions_requester_window
  ON auth_request_admissions(action, requester_hash, window_started_at, id);

CREATE INDEX idx_auth_request_admissions_expiry
  ON auth_request_admissions(window_ends_at, id);

CREATE INDEX idx_auth_request_admissions_subject_window
  ON auth_request_admissions(action, subject_hash, window_started_at, id)
  WHERE subject_hash IS NOT NULL;

-- Google identities are platform-global account bindings. The provider
-- subject is stored only as a keyed digest; email is profile data, never the
-- durable identity or an automatic account-linking key.
CREATE TABLE auth_google_identities (
  id TEXT PRIMARY KEY NOT NULL CHECK (
    length(id) BETWEEN 8 AND 96
    AND substr(id, 1, 1) GLOB '[A-Za-z0-9]'
    AND id NOT GLOB '*[^A-Za-z0-9._:-]*'
  ),
  user_id TEXT NOT NULL REFERENCES platform_users(id) ON DELETE CASCADE,
  subject_hash TEXT NOT NULL CHECK (
    length(subject_hash) = 43
    AND subject_hash NOT GLOB '*[^A-Za-z0-9_-]*'
  ),
  subject_key_version TEXT NOT NULL DEFAULT 'v1' CHECK (subject_key_version = 'v1'),
  created_at TEXT NOT NULL,
  last_authenticated_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  CHECK (last_authenticated_at >= created_at),
  CHECK (updated_at >= last_authenticated_at)
) STRICT;

CREATE UNIQUE INDEX idx_auth_google_identities_subject
  ON auth_google_identities(subject_key_version, subject_hash);

CREATE UNIQUE INDEX idx_auth_google_identities_user
  ON auth_google_identities(user_id);

CREATE TRIGGER auth_google_identities_identity_immutable
BEFORE UPDATE ON auth_google_identities
WHEN NEW.id != OLD.id
  OR NEW.user_id != OLD.user_id
  OR NEW.subject_hash != OLD.subject_hash
  OR NEW.subject_key_version != OLD.subject_key_version
  OR NEW.created_at != OLD.created_at
  OR NEW.version != OLD.version + 1
  OR NEW.last_authenticated_at < OLD.last_authenticated_at
  OR NEW.updated_at <= OLD.updated_at
BEGIN
  SELECT RAISE(ABORT, 'auth_google_identity_transition_invalid');
END;

-- Authorization state is global because no tenant has been selected yet.
-- Raw state, nonce, browser binding and PKCE verifier never enter D1.
CREATE TABLE auth_google_oauth_states (
  id TEXT PRIMARY KEY NOT NULL CHECK (
    length(id) BETWEEN 8 AND 96
    AND substr(id, 1, 1) GLOB '[A-Za-z0-9]'
    AND id NOT GLOB '*[^A-Za-z0-9._:-]*'
  ),
  flow TEXT NOT NULL CHECK (flow IN ('link', 'login', 'register')),
  initiated_user_id TEXT REFERENCES platform_users(id) ON DELETE CASCADE,
  state_lookup_hash TEXT NOT NULL CHECK (
    length(state_lookup_hash) = 43
    AND state_lookup_hash NOT GLOB '*[^A-Za-z0-9_-]*'
  ),
  nonce_hash TEXT CHECK (
    nonce_hash IS NULL OR (
      length(nonce_hash) = 43
      AND nonce_hash NOT GLOB '*[^A-Za-z0-9_-]*'
    )
  ),
  browser_binding_hash TEXT CHECK (
    browser_binding_hash IS NULL OR (
      length(browser_binding_hash) = 43
      AND browser_binding_hash NOT GLOB '*[^A-Za-z0-9_-]*'
    )
  ),
  redirect_uri TEXT NOT NULL CHECK (length(redirect_uri) BETWEEN 12 AND 2048),
  return_to TEXT CHECK (
    return_to IS NULL OR (
      length(return_to) BETWEEN 1 AND 1024
      AND substr(return_to, 1, 1) = '/'
      AND substr(return_to, 1, 2) != '//'
      AND return_to NOT GLOB '*[[:space:]]*'
    )
  ),
  code_verifier_ciphertext_b64 TEXT CHECK (
    code_verifier_ciphertext_b64 IS NULL OR (
      length(code_verifier_ciphertext_b64) BETWEEN 64 AND 256
      AND code_verifier_ciphertext_b64 NOT GLOB '*[^A-Za-z0-9_-]*'
    )
  ),
  code_verifier_iv_b64 TEXT CHECK (
    code_verifier_iv_b64 IS NULL OR (
      length(code_verifier_iv_b64) = 16
      AND code_verifier_iv_b64 NOT GLOB '*[^A-Za-z0-9_-]*'
    )
  ),
  key_version TEXT NOT NULL CHECK (
    length(key_version) BETWEEN 2 AND 16
    AND key_version GLOB 'v[1-9]*'
    AND key_version NOT GLOB '*[^A-Za-z0-9_-]*'
  ),
  status TEXT NOT NULL CHECK (status IN ('pending', 'consumed', 'revoked')),
  expires_at TEXT NOT NULL,
  consumed_at TEXT,
  revoked_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  CHECK ((flow = 'link') = (initiated_user_id IS NOT NULL)),
  CHECK (expires_at > created_at),
  CHECK (updated_at >= created_at),
  CHECK (consumed_at IS NULL OR (consumed_at >= created_at AND consumed_at <= updated_at)),
  CHECK (revoked_at IS NULL OR (revoked_at >= created_at AND revoked_at <= updated_at)),
  CHECK (
    (status = 'pending'
      AND nonce_hash IS NOT NULL
      AND browser_binding_hash IS NOT NULL
      AND code_verifier_ciphertext_b64 IS NOT NULL
      AND code_verifier_iv_b64 IS NOT NULL
      AND consumed_at IS NULL
      AND revoked_at IS NULL)
    OR (status = 'consumed'
      AND nonce_hash IS NULL
      AND browser_binding_hash IS NULL
      AND code_verifier_ciphertext_b64 IS NULL
      AND code_verifier_iv_b64 IS NULL
      AND consumed_at IS NOT NULL
      AND revoked_at IS NULL)
    OR (status = 'revoked'
      AND nonce_hash IS NULL
      AND browser_binding_hash IS NULL
      AND code_verifier_ciphertext_b64 IS NULL
      AND code_verifier_iv_b64 IS NULL
      AND consumed_at IS NULL
      AND revoked_at IS NOT NULL)
  )
) STRICT;

CREATE UNIQUE INDEX idx_auth_google_oauth_states_lookup
  ON auth_google_oauth_states(state_lookup_hash);

CREATE INDEX idx_auth_google_oauth_states_expiry
  ON auth_google_oauth_states(status, expires_at, id);

CREATE INDEX idx_auth_google_oauth_states_retention
  ON auth_google_oauth_states(status, updated_at, id);

CREATE TRIGGER auth_google_oauth_states_pending_insert_guard
BEFORE INSERT ON auth_google_oauth_states
WHEN NEW.status != 'pending'
  OR NEW.version != 1
  OR NEW.updated_at != NEW.created_at
BEGIN
  SELECT RAISE(ABORT, 'auth_google_oauth_state_insert_invalid');
END;

-- A callback may consume or revoke a pending row exactly once. Terminalizing
-- the row also destroys the encrypted verifier and browser-bound challenges.
CREATE TRIGGER auth_google_oauth_states_transition_guard
BEFORE UPDATE ON auth_google_oauth_states
WHEN NEW.id != OLD.id
  OR NEW.flow != OLD.flow
  OR NEW.initiated_user_id IS NOT OLD.initiated_user_id
  OR NEW.state_lookup_hash != OLD.state_lookup_hash
  OR NEW.redirect_uri != OLD.redirect_uri
  OR NEW.return_to IS NOT OLD.return_to
  OR NEW.key_version != OLD.key_version
  OR NEW.expires_at != OLD.expires_at
  OR NEW.created_at != OLD.created_at
  OR OLD.status != 'pending'
  OR NEW.status NOT IN ('consumed', 'revoked')
  OR NEW.version != OLD.version + 1
  OR NEW.updated_at <= OLD.updated_at
BEGIN
  SELECT RAISE(ABORT, 'auth_google_oauth_state_transition_invalid');
END;

PRAGMA foreign_keys = ON;
