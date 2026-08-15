PRAGMA foreign_keys = ON;

-- Seller membership mutations use an optimistic version without exposing the
-- internal platform user id in dashboard URLs or response payloads.
ALTER TABLE shop_members
  ADD COLUMN version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0);

ALTER TABLE shop_members
  ADD COLUMN member_public_id TEXT;

ALTER TABLE shop_customers
  ADD COLUMN version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0);

CREATE UNIQUE INDEX idx_shop_members_public_id
  ON shop_members(member_public_id)
  WHERE member_public_id IS NOT NULL;

CREATE INDEX idx_shop_members_shop_status_role
  ON shop_members(shop_id, status, role, user_id);

CREATE TABLE shop_member_invitations (
  id TEXT PRIMARY KEY NOT NULL,
  public_id TEXT NOT NULL UNIQUE,
  shop_id TEXT NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  email_normalized TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('manager', 'support', 'viewer')),
  status TEXT NOT NULL CHECK (status IN ('pending', 'accepted', 'revoked', 'expired')),
  token_hash TEXT NOT NULL UNIQUE,
  invited_by_user_id TEXT NOT NULL REFERENCES platform_users(id) ON DELETE RESTRICT,
  accepted_user_id TEXT REFERENCES platform_users(id) ON DELETE SET NULL,
  expires_at TEXT NOT NULL,
  accepted_at TEXT,
  revoked_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  CHECK ((status = 'accepted') = (accepted_at IS NOT NULL AND accepted_user_id IS NOT NULL)),
  CHECK ((status = 'revoked') = (revoked_at IS NOT NULL)),
  CHECK (status != 'pending' OR (accepted_at IS NULL AND accepted_user_id IS NULL AND revoked_at IS NULL))
) STRICT;

CREATE UNIQUE INDEX idx_shop_member_invitations_pending_email
  ON shop_member_invitations(shop_id, email_normalized)
  WHERE status = 'pending';

CREATE INDEX idx_shop_member_invitations_shop_status
  ON shop_member_invitations(shop_id, status, created_at DESC, id);

CREATE INDEX idx_shop_member_invitations_expiry
  ON shop_member_invitations(status, expires_at, id);

CREATE TABLE customer_notes (
  id TEXT PRIMARY KEY NOT NULL,
  public_id TEXT NOT NULL UNIQUE,
  shop_id TEXT NOT NULL REFERENCES shops(id) ON DELETE RESTRICT,
  customer_id TEXT NOT NULL,
  author_user_id TEXT NOT NULL REFERENCES platform_users(id) ON DELETE RESTRICT,
  body TEXT NOT NULL CHECK (length(body) BETWEEN 1 AND 4000),
  status TEXT NOT NULL CHECK (status IN ('active', 'redacted')),
  redacted_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  UNIQUE (shop_id, id),
  FOREIGN KEY (shop_id, customer_id) REFERENCES shop_customers(shop_id, id) ON DELETE RESTRICT,
  CHECK ((status = 'redacted') = (redacted_at IS NOT NULL))
) STRICT;

CREATE INDEX idx_customer_notes_shop_customer
  ON customer_notes(shop_id, customer_id, status, created_at DESC, id);

CREATE TABLE order_notes (
  id TEXT PRIMARY KEY NOT NULL,
  public_id TEXT NOT NULL UNIQUE,
  shop_id TEXT NOT NULL REFERENCES shops(id) ON DELETE RESTRICT,
  order_id TEXT NOT NULL,
  author_user_id TEXT NOT NULL REFERENCES platform_users(id) ON DELETE RESTRICT,
  body TEXT NOT NULL CHECK (length(body) BETWEEN 1 AND 4000),
  status TEXT NOT NULL CHECK (status IN ('active', 'redacted')),
  redacted_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  UNIQUE (shop_id, id),
  FOREIGN KEY (shop_id, order_id) REFERENCES orders(shop_id, id) ON DELETE RESTRICT,
  CHECK ((status = 'redacted') = (redacted_at IS NOT NULL))
) STRICT;

CREATE INDEX idx_order_notes_shop_order
  ON order_notes(shop_id, order_id, status, created_at DESC, id);

CREATE INDEX idx_orders_admin_updated
  ON orders(updated_at DESC, public_id DESC, shop_id);

CREATE INDEX idx_audit_logs_admin_created
  ON audit_logs(created_at DESC, id DESC, shop_id);

CREATE TRIGGER customer_notes_no_delete
BEFORE DELETE ON customer_notes
BEGIN
  SELECT RAISE(ABORT, 'customer_note_immutable');
END;

CREATE TRIGGER order_notes_no_delete
BEFORE DELETE ON order_notes
BEGIN
  SELECT RAISE(ABORT, 'order_note_immutable');
END;

CREATE TRIGGER customer_notes_redaction_guard
BEFORE UPDATE ON customer_notes
WHEN NEW.id != OLD.id
  OR NEW.shop_id != OLD.shop_id
  OR NEW.customer_id != OLD.customer_id
  OR NEW.author_user_id != OLD.author_user_id
  OR NEW.body != OLD.body
  OR NEW.created_at != OLD.created_at
  OR NEW.version != OLD.version + 1
  OR OLD.status = 'redacted'
  OR NEW.status != 'redacted'
  OR NEW.redacted_at IS NULL
BEGIN
  SELECT RAISE(ABORT, 'customer_note_redaction_invalid');
END;

CREATE TRIGGER order_notes_redaction_guard
BEFORE UPDATE ON order_notes
WHEN NEW.id != OLD.id
  OR NEW.shop_id != OLD.shop_id
  OR NEW.order_id != OLD.order_id
  OR NEW.author_user_id != OLD.author_user_id
  OR NEW.body != OLD.body
  OR NEW.created_at != OLD.created_at
  OR NEW.version != OLD.version + 1
  OR OLD.status = 'redacted'
  OR NEW.status != 'redacted'
  OR NEW.redacted_at IS NULL
BEGIN
  SELECT RAISE(ABORT, 'order_note_redaction_invalid');
END;
