PRAGMA foreign_keys = ON;

-- Evidence is bound to the exact encrypted credential version that was used
-- for the probe. The application checks this before insert; keep direct-D1
-- maintenance paths from fabricating a credential lineage.
CREATE TRIGGER channel_provider_verification_credential_scope_insert_guard
BEFORE INSERT ON channel_provider_verification_evidence
WHEN NOT EXISTS (
  SELECT 1
  FROM channel_credentials AS credential
  WHERE credential.shop_id = NEW.shop_id
    AND credential.connection_id = NEW.connection_id
    AND credential.provider_code = NEW.provider_code
    AND credential.version = NEW.credential_version
    AND credential.credential_fingerprint = NEW.credential_fingerprint
    AND credential.status IN ('pending', 'active')
)
BEGIN
  SELECT RAISE(ABORT, 'channel_provider_verification_credential_scope_mismatch');
END;

-- A reviewed row is a tenant-owned decision, not caller-supplied metadata.
CREATE TRIGGER channel_provider_verification_reviewer_scope_insert_guard
BEFORE INSERT ON channel_provider_verification_evidence
WHEN NEW.reviewed_by_user_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1
    FROM shop_members AS member
    WHERE member.shop_id = NEW.shop_id
      AND member.user_id = NEW.reviewed_by_user_id
      AND member.status = 'active'
      AND member.role IN ('owner', 'manager')
  )
BEGIN
  SELECT RAISE(ABORT, 'channel_provider_verification_reviewer_scope_mismatch');
END;

-- Connection identity is the parent scope for receipts, identities, OAuth
-- state and verification evidence. Status remains mutable through the
-- existing lifecycle trigger, but tenant/channel/provider identity does not.
CREATE TRIGGER channel_connections_identity_immutable
BEFORE UPDATE OF shop_id, shop_channel_id, provider_code ON channel_connections
WHEN NEW.shop_id != OLD.shop_id
  OR NEW.shop_channel_id != OLD.shop_channel_id
  OR NEW.provider_code != OLD.provider_code
BEGIN
  SELECT RAISE(ABORT, 'channel_connection_identity_immutable');
END;
