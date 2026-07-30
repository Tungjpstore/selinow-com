import { AppError } from "../core/errors";
import { createId, createOpaqueToken } from "../core/ids";
import {
  decryptGeneratedLicenseArtifact,
  decryptGeneratedLicenseProviderSecrets,
  encryptGeneratedLicenseArtifact,
  encryptGeneratedLicenseProviderSecrets,
  type EncryptedGeneratedLicenseArtifact,
  type EncryptedGeneratedLicenseProviderSecrets,
} from "../commerce/generated-license-crypto";
import { decryptInventoryKey, encryptInventoryKey } from "../crypto/inventory";
import { resolveActiveEncryptionKey, resolveEncryptionKey } from "../crypto/keyring";
import { decryptPayOSCredentials, encryptPayOSCredentials, type EncryptedPayOSCredentials } from "../payments/crypto";
import type { AppBindings } from "../platform/bindings";
import {
  decryptTelegramChatId,
  decryptTelegramCredential,
  encryptTelegramChatId,
  encryptTelegramCredential,
  type EncryptedTelegramCredential,
} from "../telegram/crypto";

export type RotationKeyFamily =
  | "generated_license_artifacts"
  | "generated_license_credentials"
  | "inventory"
  | "payment_credentials"
  | "telegram_credentials"
  | "telegram_recipient_ids";

type RotationResourceType =
  | "generated_license_artifact"
  | "generated_license_credential"
  | "inventory_key"
  | "payment_credential"
  | "telegram_credential"
  | "telegram_recipient";

type RotationRunRow = {
  dryRun: number;
  id: string;
  keyFamily: RotationKeyFamily;
  leaseToken: string | null;
  requestId: string;
  requestedByUserId: string | null;
  shopId: string | null;
  sourceKeyVersion: string;
  status: string;
  targetKeyVersion: string;
};

type RotationItemRow = {
  attempts: number;
  id: string;
  resourceId: string;
  resourceType: RotationResourceType;
  shopId: string | null;
};

type ResourceDescriptor = {
  keyFamily: "credential" | "inventory";
  resourceType: RotationResourceType;
  table:
    | "generated_license_artifacts"
    | "generated_license_provider_credentials"
    | "inventory_keys"
    | "payment_credentials"
    | "telegram_credentials"
    | "telegram_recipients";
};

export type RotationResult = {
  completed: boolean;
  failedItems: number;
  oldVersionRows: number;
  processedItems: number;
  runId: string;
  status: string;
  totalItems: number;
};

const RUN_SELECT = `
  SELECT id, shop_id AS shopId, key_family AS keyFamily,
    source_key_version AS sourceKeyVersion, target_key_version AS targetKeyVersion,
    status, dry_run AS dryRun, lease_token AS leaseToken, request_id AS requestId,
    requested_by_user_id AS requestedByUserId
  FROM encryption_rotation_runs
  WHERE id = ?
  LIMIT 1
`;

const ACTIVE_RUN_STATUSES = "'planned', 'running', 'paused'";

function descriptorFor(family: RotationKeyFamily): ResourceDescriptor {
  if (family === "generated_license_artifacts") {
    return { keyFamily: "inventory", resourceType: "generated_license_artifact", table: "generated_license_artifacts" };
  }
  if (family === "generated_license_credentials") {
    return { keyFamily: "credential", resourceType: "generated_license_credential", table: "generated_license_provider_credentials" };
  }
  if (family === "inventory") return { keyFamily: "inventory", resourceType: "inventory_key", table: "inventory_keys" };
  if (family === "payment_credentials") return { keyFamily: "credential", resourceType: "payment_credential", table: "payment_credentials" };
  if (family === "telegram_credentials") return { keyFamily: "credential", resourceType: "telegram_credential", table: "telegram_credentials" };
  return { keyFamily: "credential", resourceType: "telegram_recipient", table: "telegram_recipients" };
}

async function countOldRows(env: AppBindings, run: RotationRunRow, descriptor: ResourceDescriptor): Promise<number> {
  const row = await env.PLATFORM_DB.prepare(`
    SELECT COUNT(*) AS count
    FROM ${descriptor.table}
    WHERE key_version = ? AND (? IS NULL OR shop_id = ?)
  `).bind(run.sourceKeyVersion, run.shopId, run.shopId).first<{ count: number }>();
  return row?.count ?? 0;
}

async function loadRun(env: AppBindings, runId: string): Promise<RotationRunRow> {
  const run = await env.PLATFORM_DB.prepare(RUN_SELECT).bind(runId).first<RotationRunRow>();
  if (run === null) throw new AppError("rotation_run_not_found", 404);
  return run;
}

function assertTargetIsActive(env: AppBindings, descriptor: ResourceDescriptor, targetKeyVersion: string): void {
  const active = resolveActiveEncryptionKey(env, descriptor.keyFamily);
  if (active.version !== targetKeyVersion) throw new AppError("rotation_target_not_active", 409);
}

async function assertNoOverlappingActiveRun(env: AppBindings, run: RotationRunRow): Promise<void> {
  const overlap = await env.PLATFORM_DB.prepare(`
    SELECT id FROM encryption_rotation_runs
    WHERE id != ? AND key_family = ? AND status IN (${ACTIVE_RUN_STATUSES})
      AND (shop_id IS NULL OR ? IS NULL OR shop_id = ?)
    LIMIT 1
  `).bind(run.id, run.keyFamily, run.shopId, run.shopId).first<{ id: string }>();
  if (overlap !== null) throw new AppError("rotation_run_overlap", 409);
}

type RotationAuditInput = {
  action: "encryption_rotation.completed" | "encryption_rotation.created";
  env: AppBindings;
  failedItems: number;
  oldVersionRows: number;
  processedItems: number;
  run: RotationRunRow;
  status: string;
  totalItems: number;
  writtenAt: string;
};

function rotationAuditStatement(input: RotationAuditInput): D1PreparedStatement {
  const metadata = JSON.stringify({
    dryRun: input.run.dryRun === 1,
    failedItems: input.failedItems,
    keyFamily: input.run.keyFamily,
    oldVersionRows: input.oldVersionRows,
    processedItems: input.processedItems,
    scope: input.run.shopId === null ? "global" : "shop",
    sourceKeyVersion: input.run.sourceKeyVersion,
    status: input.status,
    targetKeyVersion: input.run.targetKeyVersion,
    totalItems: input.totalItems,
  });
  return input.env.PLATFORM_DB.prepare(`
    INSERT INTO audit_logs (
      id, shop_id, actor_type, actor_id, action, resource_type, resource_id,
      safe_metadata_json, request_id, source_kind, correlation_id, operation_id,
      retention_class, created_at
    )
    SELECT ?, ?, ?, ?, ?, 'encryption_rotation_run', ?, ?, ?, 'application', ?, ?, 'security', ?
    WHERE EXISTS (SELECT 1 FROM encryption_rotation_runs WHERE id = ?)
      AND NOT EXISTS (
      SELECT 1 FROM audit_logs
      WHERE action = ? AND resource_type = 'encryption_rotation_run' AND resource_id = ?
    )
  `).bind(
    createId("aud"),
    input.run.shopId,
    input.run.requestedByUserId === null ? "system" : "user",
    input.run.requestedByUserId,
    input.action,
    input.run.id,
    metadata,
    input.run.requestId,
    input.run.requestId,
    input.run.id,
    input.writtenAt,
    input.run.id,
    input.action,
    input.run.id,
  );
}

async function writeRotationAudit(input: RotationAuditInput): Promise<void> {
  await rotationAuditStatement(input).run();
}

export async function createEncryptionRotation(input: {
  dryRun: boolean;
  env: AppBindings;
  keyFamily: RotationKeyFamily;
  requestId: string;
  requestedByUserId?: string | null;
  runId?: string;
  shopId?: string | null;
  sourceKeyVersion: string;
  targetKeyVersion: string;
}): Promise<RotationResult> {
  if (input.sourceKeyVersion === input.targetKeyVersion) throw new AppError("rotation_version_unchanged", 400);
  const descriptor = descriptorFor(input.keyFamily);
  resolveEncryptionKey(input.env, descriptor.keyFamily, input.sourceKeyVersion);
  resolveEncryptionKey(input.env, descriptor.keyFamily, input.targetKeyVersion);
  if (!input.dryRun) assertTargetIsActive(input.env, descriptor, input.targetKeyVersion);
  const now = new Date().toISOString();
  const runId = input.runId ?? createId("rot");
  const shopId = input.shopId ?? null;
  const scopeKey = shopId === null ? "global" : `shop:${shopId}`;
  const provisional: RotationRunRow = {
    dryRun: input.dryRun ? 1 : 0,
    id: runId,
    keyFamily: input.keyFamily,
    leaseToken: null,
    requestId: input.requestId,
    requestedByUserId: input.requestedByUserId ?? null,
    shopId,
    sourceKeyVersion: input.sourceKeyVersion,
    status: input.dryRun ? "completed" : "planned",
    targetKeyVersion: input.targetKeyVersion,
  };
  const totalItems = await countOldRows(input.env, provisional, descriptor);
  const runStatement = input.env.PLATFORM_DB.prepare(`
    INSERT INTO encryption_rotation_runs (
      id, shop_id, scope_key, key_family, source_key_version, target_key_version,
      status, dry_run, total_items, processed_items, failed_items,
      requested_by_user_id, request_id, completed_at, created_at, updated_at
    )
    SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?, ?, ?, ?
    WHERE ? = 1 OR NOT EXISTS (
      SELECT 1 FROM encryption_rotation_runs
      WHERE key_family = ? AND status IN (${ACTIVE_RUN_STATUSES})
        AND (shop_id IS NULL OR ? IS NULL OR shop_id = ?)
    )
  `).bind(
    runId,
    shopId,
    scopeKey,
    input.keyFamily,
    input.sourceKeyVersion,
    input.targetKeyVersion,
    provisional.status,
    provisional.dryRun,
    totalItems,
    input.requestedByUserId ?? null,
    input.requestId,
    input.dryRun ? now : null,
    now,
    now,
    provisional.dryRun,
    input.keyFamily,
    shopId,
    shopId,
  );
  const createdAudit: RotationAuditInput = {
    action: "encryption_rotation.created",
    env: input.env,
    failedItems: 0,
    oldVersionRows: totalItems,
    processedItems: 0,
    run: provisional,
    status: provisional.status,
    totalItems,
    writtenAt: now,
  };
  const statements = [runStatement, rotationAuditStatement(createdAudit)];
  if (input.dryRun) statements.push(rotationAuditStatement({
    action: "encryption_rotation.completed",
    env: input.env,
    failedItems: 0,
    oldVersionRows: totalItems,
    processedItems: 0,
    run: provisional,
    status: provisional.status,
    totalItems,
    writtenAt: now,
  }));
  const [created] = await input.env.PLATFORM_DB.batch(statements);
  if (created?.meta.changes !== 1) throw new AppError("rotation_run_overlap", 409);
  return {
    completed: input.dryRun,
    failedItems: 0,
    oldVersionRows: totalItems,
    processedItems: 0,
    runId,
    status: provisional.status,
    totalItems,
  };
}

async function seedItems(env: AppBindings, run: RotationRunRow, descriptor: ResourceDescriptor, nowIso: string): Promise<void> {
  await env.PLATFORM_DB.prepare(`
    UPDATE encryption_rotation_items
    SET status = 'pending', lease_token = NULL, lease_expires_at = NULL,
      last_safe_error_code = NULL, processed_at = NULL, version = version + 1, updated_at = ?
    WHERE run_id = ? AND resource_type = ? AND status IN ('completed', 'skipped')
      AND EXISTS (
        SELECT 1 FROM ${descriptor.table} AS resource
        WHERE resource.id = encryption_rotation_items.resource_id
          AND resource.key_version = ?
          AND (? IS NULL OR resource.shop_id = ?)
      )
  `).bind(nowIso, run.id, descriptor.resourceType, run.sourceKeyVersion, run.shopId, run.shopId).run();
  const rows = await env.PLATFORM_DB.prepare(`
    SELECT resource.id, resource.shop_id AS shopId
    FROM ${descriptor.table} AS resource
    WHERE resource.key_version = ? AND (? IS NULL OR resource.shop_id = ?)
      AND NOT EXISTS (
        SELECT 1 FROM encryption_rotation_items item
        WHERE item.run_id = ? AND item.resource_type = ? AND item.resource_id = resource.id
      )
    ORDER BY resource.id
    LIMIT 100
  `).bind(run.sourceKeyVersion, run.shopId, run.shopId, run.id, descriptor.resourceType).all<{ id: string; shopId: string }>();
  if (rows.results.length === 0) return;
  await env.PLATFORM_DB.batch(rows.results.map((row) => env.PLATFORM_DB.prepare(`
    INSERT OR IGNORE INTO encryption_rotation_items (
      id, run_id, shop_id, resource_type, resource_id, status, attempts,
      source_key_version, target_key_version, version, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, 'pending', 0, ?, ?, 1, ?, ?)
  `).bind(createId("roi"), run.id, row.shopId, descriptor.resourceType, row.id, run.sourceKeyVersion, run.targetKeyVersion, nowIso, nowIso)));
}

async function claimItem(env: AppBindings, run: RotationRunRow, runLeaseToken: string, now: Date): Promise<{ item: RotationItemRow; leaseToken: string } | null> {
  const candidate = await env.PLATFORM_DB.prepare(`
    SELECT id, shop_id AS shopId, resource_type AS resourceType,
      resource_id AS resourceId, attempts
    FROM encryption_rotation_items
    WHERE run_id = ? AND status = 'pending'
      AND (lease_token IS NULL OR lease_expires_at IS NULL OR lease_expires_at <= ?)
    ORDER BY CASE status WHEN 'pending' THEN 0 ELSE 1 END, updated_at, id
    LIMIT 1
  `).bind(run.id, now.toISOString()).first<RotationItemRow>();
  if (candidate === null) return null;
  const leaseToken = createOpaqueToken(18);
  const claimed = await env.PLATFORM_DB.prepare(`
    UPDATE encryption_rotation_items
    SET status = 'processing', attempts = attempts + 1, lease_token = ?, lease_expires_at = ?,
        last_safe_error_code = NULL, version = version + 1, updated_at = ?
    WHERE id = ? AND run_id = ? AND status = 'pending'
      AND (lease_token IS NULL OR lease_expires_at IS NULL OR lease_expires_at <= ?)
      AND EXISTS (
        SELECT 1 FROM encryption_rotation_runs run
        WHERE run.id = ? AND run.lease_token = ? AND run.status = 'running'
      )
  `).bind(
    leaseToken,
    new Date(now.getTime() + 60_000).toISOString(),
    now.toISOString(),
    candidate.id,
    run.id,
    now.toISOString(),
    run.id,
    runLeaseToken,
  ).run();
  return claimed.meta.changes === 1
    ? { item: { ...candidate, attempts: candidate.attempts + 1 }, leaseToken }
    : null;
}

async function finishItem(env: AppBindings, item: RotationItemRow, leaseToken: string, status: "completed" | "failed" | "manual_review" | "skipped", nowIso: string, errorCode: string | null): Promise<void> {
  await env.PLATFORM_DB.prepare(`
    UPDATE encryption_rotation_items
    SET status = ?, last_safe_error_code = ?, processed_at = ?, lease_token = NULL,
        lease_expires_at = NULL, version = version + 1, updated_at = ?
    WHERE id = ? AND lease_token = ? AND status = 'processing'
  `).bind(status, errorCode, nowIso, nowIso, item.id, leaseToken).run();
}

async function rotateInventory(env: AppBindings, run: RotationRunRow, item: RotationItemRow, itemLeaseToken: string, nowIso: string): Promise<"completed" | "skipped"> {
  const row = await env.PLATFORM_DB.prepare(`
    SELECT id, shop_id AS shopId, variant_id AS variantId, key_version AS keyVersion,
      ciphertext_b64 AS ciphertextB64, iv_b64 AS ivB64
    FROM inventory_keys WHERE id = ? AND (? IS NULL OR shop_id = ?) LIMIT 1
  `).bind(item.resourceId, run.shopId, run.shopId).first<{ ciphertextB64: string; id: string; ivB64: string; keyVersion: string; shopId: string; variantId: string }>();
  if (row === null || row.keyVersion === run.targetKeyVersion) return "skipped";
  if (row.keyVersion !== run.sourceKeyVersion) return "skipped";
  const source = resolveEncryptionKey(env, "inventory", row.keyVersion);
  const target = resolveEncryptionKey(env, "inventory", run.targetKeyVersion);
  const plaintext = await decryptInventoryKey({ ...row, kek: source.kek, keyVersion: source.version });
  const encrypted = await encryptInventoryKey({ hmacSecret: env.IDENTIFIER_HMAC_SECRET, keyVersion: target.version, kek: target.kek, plaintext, shopId: row.shopId, variantId: row.variantId });
  const changed = await env.PLATFORM_DB.prepare(`
    UPDATE inventory_keys SET ciphertext_b64 = ?, iv_b64 = ?, key_version = ?
    WHERE id = ? AND shop_id = ? AND key_version = ?
      AND EXISTS (
        SELECT 1 FROM encryption_rotation_items item
        WHERE item.id = ? AND item.lease_token = ? AND item.status = 'processing' AND item.lease_expires_at > ?
      )
  `).bind(encrypted.ciphertextB64, encrypted.ivB64, target.version, row.id, row.shopId, source.version, item.id, itemLeaseToken, nowIso).run();
  if (changed.meta.changes !== 1) throw new AppError("rotation_fence_lost", 409);
  return "completed";
}

type PaymentCredentialResource = EncryptedPayOSCredentials & {
  id: string;
  integrationId: string;
  keyVersion: string;
  shopId: string;
};

async function rotatePaymentCredential(env: AppBindings, run: RotationRunRow, item: RotationItemRow, itemLeaseToken: string, nowIso: string): Promise<"completed" | "skipped"> {
  const row = await env.PLATFORM_DB.prepare(`
    SELECT id, shop_id AS shopId, integration_id AS integrationId, key_version AS keyVersion,
      client_id_ciphertext_b64 AS clientIdCiphertextB64, client_id_iv_b64 AS clientIdIvB64,
      api_key_ciphertext_b64 AS apiKeyCiphertextB64, api_key_iv_b64 AS apiKeyIvB64,
      checksum_key_ciphertext_b64 AS checksumKeyCiphertextB64, checksum_key_iv_b64 AS checksumKeyIvB64,
      credential_fingerprint AS fingerprint
    FROM payment_credentials WHERE id = ? AND (? IS NULL OR shop_id = ?) LIMIT 1
  `).bind(item.resourceId, run.shopId, run.shopId).first<PaymentCredentialResource>();
  if (row === null || row.keyVersion === run.targetKeyVersion) return "skipped";
  if (row.keyVersion !== run.sourceKeyVersion) return "skipped";
  const source = resolveEncryptionKey(env, "credential", row.keyVersion);
  const target = resolveEncryptionKey(env, "credential", run.targetKeyVersion);
  const plaintext = await decryptPayOSCredentials(row, { credentialId: row.id, integrationId: row.integrationId, kek: source.kek, keyVersion: source.version, shopId: row.shopId });
  const encrypted = await encryptPayOSCredentials(plaintext, { credentialId: row.id, hmacSecret: env.IDENTIFIER_HMAC_SECRET, integrationId: row.integrationId, kek: target.kek, keyVersion: target.version, shopId: row.shopId });
  const changed = await env.PLATFORM_DB.prepare(`
    UPDATE payment_credentials SET key_version = ?, client_id_ciphertext_b64 = ?, client_id_iv_b64 = ?,
      api_key_ciphertext_b64 = ?, api_key_iv_b64 = ?, checksum_key_ciphertext_b64 = ?, checksum_key_iv_b64 = ?
    WHERE id = ? AND shop_id = ? AND key_version = ?
      AND EXISTS (SELECT 1 FROM encryption_rotation_items item WHERE item.id = ? AND item.lease_token = ? AND item.status = 'processing' AND item.lease_expires_at > ?)
  `).bind(target.version, encrypted.clientIdCiphertextB64, encrypted.clientIdIvB64, encrypted.apiKeyCiphertextB64, encrypted.apiKeyIvB64, encrypted.checksumKeyCiphertextB64, encrypted.checksumKeyIvB64, row.id, row.shopId, source.version, item.id, itemLeaseToken, nowIso).run();
  if (changed.meta.changes !== 1) throw new AppError("rotation_fence_lost", 409);
  return "completed";
}

type TelegramCredentialResource = EncryptedTelegramCredential & {
  id: string;
  integrationId: string;
  keyVersion: string;
  shopId: string;
};

async function rotateTelegramCredential(env: AppBindings, run: RotationRunRow, item: RotationItemRow, itemLeaseToken: string, nowIso: string): Promise<"completed" | "skipped"> {
  const row = await env.PLATFORM_DB.prepare(`
    SELECT id, shop_id AS shopId, integration_id AS integrationId, key_version AS keyVersion,
      bot_token_ciphertext_b64 AS botTokenCiphertextB64, bot_token_iv_b64 AS botTokenIvB64,
      webhook_secret_ciphertext_b64 AS webhookSecretCiphertextB64, webhook_secret_iv_b64 AS webhookSecretIvB64,
      token_fingerprint AS tokenFingerprint, webhook_secret_digest AS webhookSecretDigest
    FROM telegram_credentials WHERE id = ? AND (? IS NULL OR shop_id = ?) LIMIT 1
  `).bind(item.resourceId, run.shopId, run.shopId).first<TelegramCredentialResource>();
  if (row === null || row.keyVersion === run.targetKeyVersion) return "skipped";
  if (row.keyVersion !== run.sourceKeyVersion) return "skipped";
  const source = resolveEncryptionKey(env, "credential", row.keyVersion);
  const target = resolveEncryptionKey(env, "credential", run.targetKeyVersion);
  const plaintext = await decryptTelegramCredential(row, { credentialId: row.id, integrationId: row.integrationId, kek: source.kek, keyVersion: source.version, shopId: row.shopId });
  const encrypted = await encryptTelegramCredential({ ...plaintext, credentialId: row.id, hmacSecret: env.IDENTIFIER_HMAC_SECRET, integrationId: row.integrationId, kek: target.kek, keyVersion: target.version, shopId: row.shopId });
  const changed = await env.PLATFORM_DB.prepare(`
    UPDATE telegram_credentials SET key_version = ?, bot_token_ciphertext_b64 = ?, bot_token_iv_b64 = ?,
      webhook_secret_ciphertext_b64 = ?, webhook_secret_iv_b64 = ?
    WHERE id = ? AND shop_id = ? AND key_version = ?
      AND EXISTS (SELECT 1 FROM encryption_rotation_items item WHERE item.id = ? AND item.lease_token = ? AND item.status = 'processing' AND item.lease_expires_at > ?)
  `).bind(target.version, encrypted.botTokenCiphertextB64, encrypted.botTokenIvB64, encrypted.webhookSecretCiphertextB64, encrypted.webhookSecretIvB64, row.id, row.shopId, source.version, item.id, itemLeaseToken, nowIso).run();
  if (changed.meta.changes !== 1) throw new AppError("rotation_fence_lost", 409);
  return "completed";
}

async function rotateTelegramRecipient(env: AppBindings, run: RotationRunRow, item: RotationItemRow, itemLeaseToken: string, nowIso: string): Promise<"completed" | "skipped"> {
  const row = await env.PLATFORM_DB.prepare(`
    SELECT id, shop_id AS shopId, integration_id AS integrationId, customer_identity_id AS identityId,
      key_version AS keyVersion, chat_id_ciphertext_b64 AS ciphertextB64, chat_id_iv_b64 AS ivB64
    FROM telegram_recipients WHERE id = ? AND (? IS NULL OR shop_id = ?) LIMIT 1
  `).bind(item.resourceId, run.shopId, run.shopId).first<{ ciphertextB64: string; id: string; identityId: string; integrationId: string; ivB64: string; keyVersion: string; shopId: string }>();
  if (row === null || row.keyVersion === run.targetKeyVersion) return "skipped";
  if (row.keyVersion !== run.sourceKeyVersion) return "skipped";
  const source = resolveEncryptionKey(env, "credential", row.keyVersion);
  const target = resolveEncryptionKey(env, "credential", run.targetKeyVersion);
  const chatId = await decryptTelegramChatId(row, { identityId: row.identityId, integrationId: row.integrationId, kek: source.kek, keyVersion: source.version, shopId: row.shopId });
  const encrypted = await encryptTelegramChatId({ chatId, hmacSecret: env.IDENTIFIER_HMAC_SECRET, identityId: row.identityId, integrationId: row.integrationId, kek: target.kek, keyVersion: target.version, shopId: row.shopId });
  const changed = await env.PLATFORM_DB.prepare(`
    UPDATE telegram_recipients SET key_version = ?, chat_id_ciphertext_b64 = ?, chat_id_iv_b64 = ?
    WHERE id = ? AND shop_id = ? AND key_version = ?
      AND EXISTS (SELECT 1 FROM encryption_rotation_items item WHERE item.id = ? AND item.lease_token = ? AND item.status = 'processing' AND item.lease_expires_at > ?)
  `).bind(target.version, encrypted.ciphertextB64, encrypted.ivB64, row.id, row.shopId, source.version, item.id, itemLeaseToken, nowIso).run();
  if (changed.meta.changes !== 1) throw new AppError("rotation_fence_lost", 409);
  return "completed";
}

type GeneratedLicenseCredentialResource = EncryptedGeneratedLicenseProviderSecrets & {
  connectionId: string;
  id: string;
  shopId: string;
  status: string;
  version: number;
};

async function rotateGeneratedLicenseCredential(env: AppBindings, run: RotationRunRow, item: RotationItemRow, itemLeaseToken: string, nowIso: string): Promise<"completed" | "skipped"> {
  const row = await env.PLATFORM_DB.prepare(`
    SELECT id, shop_id AS shopId, connection_id AS connectionId,
      key_version AS keyVersion, endpoint_ciphertext_b64 AS endpointCiphertextB64,
      endpoint_iv_b64 AS endpointIvB64, credential_ciphertext_b64 AS credentialCiphertextB64,
      credential_iv_b64 AS credentialIvB64, endpoint_fingerprint AS endpointFingerprint,
      credential_fingerprint AS credentialFingerprint, status, version
    FROM generated_license_provider_credentials
    WHERE id = ? AND (? IS NULL OR shop_id = ?) LIMIT 1
  `).bind(item.resourceId, run.shopId, run.shopId).first<GeneratedLicenseCredentialResource>();
  if (row === null || row.keyVersion === run.targetKeyVersion) return "skipped";
  if (row.keyVersion !== run.sourceKeyVersion) return "skipped";
  const source = resolveEncryptionKey(env, "credential", row.keyVersion);
  const target = resolveEncryptionKey(env, "credential", run.targetKeyVersion);
  const plaintext = await decryptGeneratedLicenseProviderSecrets(row, {
    connectionId: row.connectionId,
    credentialId: row.id,
    kek: source.kek,
    keyVersion: source.version,
    shopId: row.shopId,
  });
  const encrypted = await encryptGeneratedLicenseProviderSecrets({
    ...plaintext,
    connectionId: row.connectionId,
    credentialId: row.id,
    hmacSecret: env.IDENTIFIER_HMAC_SECRET,
    kek: target.kek,
    keyVersion: target.version,
    shopId: row.shopId,
  });
  const changed = await env.PLATFORM_DB.prepare(`
    UPDATE generated_license_provider_credentials
    SET key_version = ?, endpoint_ciphertext_b64 = ?, endpoint_iv_b64 = ?,
      credential_ciphertext_b64 = ?, credential_iv_b64 = ?,
      endpoint_fingerprint = ?, credential_fingerprint = ?,
      version = version + 1, updated_at = ?
    WHERE id = ? AND shop_id = ? AND key_version = ?
      AND EXISTS (
        SELECT 1 FROM encryption_rotation_items item
        WHERE item.id = ? AND item.lease_token = ? AND item.status = 'processing'
          AND item.lease_expires_at > ?
      )
  `).bind(
    target.version,
    encrypted.endpointCiphertextB64,
    encrypted.endpointIvB64,
    encrypted.credentialCiphertextB64,
    encrypted.credentialIvB64,
    encrypted.endpointFingerprint,
    encrypted.credentialFingerprint,
    nowIso,
    row.id,
    row.shopId,
    source.version,
    item.id,
    itemLeaseToken,
    nowIso,
  ).run();
  if (changed.meta.changes !== 1) throw new AppError("rotation_fence_lost", 409);
  return "completed";
}

type GeneratedLicenseArtifactResource = EncryptedGeneratedLicenseArtifact & {
  artifactId: string;
  requestId: string;
  shopId: string;
  status: string;
};

async function rotateGeneratedLicenseArtifact(env: AppBindings, run: RotationRunRow, item: RotationItemRow, itemLeaseToken: string, nowIso: string): Promise<"completed" | "skipped"> {
  const row = await env.PLATFORM_DB.prepare(`
    SELECT id AS artifactId, shop_id AS shopId, request_id AS requestId,
      key_version AS keyVersion, ciphertext_b64 AS ciphertextB64, iv_b64 AS ivB64,
      artifact_fingerprint AS artifactFingerprint, format, status
    FROM generated_license_artifacts
    WHERE id = ? AND (? IS NULL OR shop_id = ?) LIMIT 1
  `).bind(item.resourceId, run.shopId, run.shopId).first<GeneratedLicenseArtifactResource>();
  if (row === null || row.keyVersion === run.targetKeyVersion) return "skipped";
  if (row.keyVersion !== run.sourceKeyVersion) return "skipped";
  const source = resolveEncryptionKey(env, "inventory", row.keyVersion);
  const target = resolveEncryptionKey(env, "inventory", run.targetKeyVersion);
  const plaintext = await decryptGeneratedLicenseArtifact(row, {
    artifactId: row.artifactId,
    format: row.format,
    kek: source.kek,
    keyVersion: source.version,
    requestId: row.requestId,
    shopId: row.shopId,
  });
  const encrypted = await encryptGeneratedLicenseArtifact({
    artifactId: row.artifactId,
    format: row.format,
    hmacSecret: env.IDENTIFIER_HMAC_SECRET,
    kek: target.kek,
    keyVersion: target.version,
    plaintext,
    requestId: row.requestId,
    shopId: row.shopId,
  });
  const changed = await env.PLATFORM_DB.prepare(`
    UPDATE generated_license_artifacts
    SET ciphertext_b64 = ?, iv_b64 = ?, key_version = ?,
      artifact_fingerprint = ?
    WHERE id = ? AND shop_id = ? AND key_version = ?
      AND EXISTS (
        SELECT 1 FROM encryption_rotation_items item
        WHERE item.id = ? AND item.lease_token = ? AND item.status = 'processing'
          AND item.lease_expires_at > ?
      )
  `).bind(
    encrypted.ciphertextB64,
    encrypted.ivB64,
    target.version,
    encrypted.artifactFingerprint,
    row.artifactId,
    row.shopId,
    source.version,
    item.id,
    itemLeaseToken,
    nowIso,
  ).run();
  if (changed.meta.changes !== 1) throw new AppError("rotation_fence_lost", 409);
  return "completed";
}

async function rotateItem(env: AppBindings, run: RotationRunRow, item: RotationItemRow, leaseToken: string, nowIso: string): Promise<"completed" | "skipped"> {
  if (item.resourceType === "generated_license_credential") return rotateGeneratedLicenseCredential(env, run, item, leaseToken, nowIso);
  if (item.resourceType === "generated_license_artifact") return rotateGeneratedLicenseArtifact(env, run, item, leaseToken, nowIso);
  if (item.resourceType === "inventory_key") return rotateInventory(env, run, item, leaseToken, nowIso);
  if (item.resourceType === "payment_credential") return rotatePaymentCredential(env, run, item, leaseToken, nowIso);
  if (item.resourceType === "telegram_credential") return rotateTelegramCredential(env, run, item, leaseToken, nowIso);
  return rotateTelegramRecipient(env, run, item, leaseToken, nowIso);
}

async function summarizeRun(env: AppBindings, run: RotationRunRow, descriptor: ResourceDescriptor): Promise<Omit<RotationResult, "runId" | "status" | "completed">> {
  const counts = await env.PLATFORM_DB.prepare(`
    SELECT COUNT(*) AS totalItems,
      SUM(CASE WHEN status IN ('completed', 'skipped') THEN 1 ELSE 0 END) AS processedItems,
      SUM(CASE WHEN status IN ('failed', 'manual_review') THEN 1 ELSE 0 END) AS failedItems
    FROM encryption_rotation_items WHERE run_id = ?
  `).bind(run.id).first<{ failedItems: number | null; processedItems: number | null; totalItems: number }>();
  return {
    failedItems: counts?.failedItems ?? 0,
    oldVersionRows: await countOldRows(env, run, descriptor),
    processedItems: counts?.processedItems ?? 0,
    totalItems: counts?.totalItems ?? 0,
  };
}

function classifyRotationItemFailure(error: unknown, attempts: number): { errorCode: string; status: "failed" | "manual_review" } {
  if (error instanceof AppError && error.code === "rotation_fence_lost") {
    return { errorCode: "encryption_rotation_fence_lost", status: "failed" };
  }
  if (error instanceof AppError && [
    "configuration_invalid",
    "credential_decryption_failed",
    "encryption_key_version_unavailable",
    "inventory_decryption_failed",
  ].includes(error.code)) {
    return { errorCode: "encryption_rotation_manual_review", status: "manual_review" };
  }
  return attempts >= 3
    ? { errorCode: "encryption_rotation_manual_review", status: "manual_review" }
    : { errorCode: "encryption_rotation_retryable", status: "failed" };
}

export async function processEncryptionRotation(input: {
  env: AppBindings;
  limit?: number;
  now?: Date;
  runId: string;
}): Promise<RotationResult> {
  const now = input.now ?? new Date();
  const nowIso = now.toISOString();
  let run = await loadRun(input.env, input.runId);
  const descriptor = descriptorFor(run.keyFamily);
  if (run.dryRun === 1) {
    const oldVersionRows = await countOldRows(input.env, run, descriptor);
    const status = run.status === "canceled" ? "canceled" : "completed";
    if (status === "completed") await input.env.PLATFORM_DB.prepare(`
      UPDATE encryption_rotation_runs SET status = 'completed', total_items = ?, completed_at = ?, version = version + 1, updated_at = ?
      WHERE id = ? AND dry_run = 1 AND status != 'canceled'
    `).bind(oldVersionRows, nowIso, nowIso, run.id).run();
    if (status === "completed") await writeRotationAudit({ action: "encryption_rotation.completed", env: input.env, failedItems: 0, oldVersionRows, processedItems: 0, run, status, totalItems: oldVersionRows, writtenAt: nowIso });
    return { completed: status === "completed", failedItems: 0, oldVersionRows, processedItems: 0, runId: run.id, status, totalItems: oldVersionRows };
  }
  if (run.status === "canceled") {
    const summary = await summarizeRun(input.env, run, descriptor);
    return { ...summary, completed: false, runId: run.id, status: run.status };
  }
  if (run.status === "completed") {
    const summary = await summarizeRun(input.env, run, descriptor);
    if (summary.oldVersionRows === 0) {
      await writeRotationAudit({ action: "encryption_rotation.completed", env: input.env, run, status: run.status, writtenAt: nowIso, ...summary });
      return { ...summary, completed: true, runId: run.id, status: run.status };
    }
    assertTargetIsActive(input.env, descriptor, run.targetKeyVersion);
    resolveEncryptionKey(input.env, descriptor.keyFamily, run.sourceKeyVersion);
    await assertNoOverlappingActiveRun(input.env, run);
    const reopened = await input.env.PLATFORM_DB.prepare(`
      UPDATE encryption_rotation_runs
      SET status = 'planned', completed_at = NULL, last_safe_error_code = 'rotation_source_rows_reappeared',
        version = version + 1, updated_at = ?
      WHERE id = ? AND status = 'completed'
        AND NOT EXISTS (
          SELECT 1 FROM encryption_rotation_runs overlap
          WHERE overlap.id != encryption_rotation_runs.id
            AND overlap.key_family = encryption_rotation_runs.key_family
            AND overlap.status IN (${ACTIVE_RUN_STATUSES})
            AND (overlap.shop_id IS NULL OR encryption_rotation_runs.shop_id IS NULL OR overlap.shop_id = encryption_rotation_runs.shop_id)
        )
    `).bind(nowIso, run.id).run();
    if (reopened.meta.changes !== 1) {
      await assertNoOverlappingActiveRun(input.env, run);
      throw new AppError("rotation_run_busy", 409);
    }
    run = { ...run, status: "planned" };
  }

  assertTargetIsActive(input.env, descriptor, run.targetKeyVersion);
  resolveEncryptionKey(input.env, descriptor.keyFamily, run.sourceKeyVersion);
  await assertNoOverlappingActiveRun(input.env, run);

  const runLeaseToken = createOpaqueToken(18);
  const claimed = await input.env.PLATFORM_DB.prepare(`
    UPDATE encryption_rotation_runs
    SET status = 'running', lease_token = ?, lease_expires_at = ?, started_at = COALESCE(started_at, ?),
      last_safe_error_code = NULL, version = version + 1, updated_at = ?
    WHERE id = ? AND dry_run = 0 AND status IN ('planned', 'running', 'paused', 'failed')
      AND (lease_token IS NULL OR lease_expires_at IS NULL OR lease_expires_at <= ?)
  `).bind(runLeaseToken, new Date(now.getTime() + 120_000).toISOString(), nowIso, nowIso, run.id, nowIso).run();
  if (claimed.meta.changes !== 1) throw new AppError("rotation_run_busy", 409);
  run = { ...run, leaseToken: runLeaseToken, status: "running" };

  await seedItems(input.env, run, descriptor, nowIso);
  await input.env.PLATFORM_DB.prepare(`
    UPDATE encryption_rotation_items
    SET status = 'pending', lease_token = NULL, lease_expires_at = NULL, version = version + 1, updated_at = ?
    WHERE run_id = ? AND (
      status = 'failed' OR (status = 'processing' AND lease_expires_at <= ?)
    )
  `).bind(nowIso, run.id, nowIso).run();
  const limit = Math.min(100, Math.max(1, input.limit ?? 25));
  for (let index = 0; index < limit; index += 1) {
    const claimedItem = await claimItem(input.env, run, runLeaseToken, now);
    if (claimedItem === null) break;
    try {
      const status = await rotateItem(input.env, run, claimedItem.item, claimedItem.leaseToken, nowIso);
      await finishItem(input.env, claimedItem.item, claimedItem.leaseToken, status, nowIso, null);
    } catch (error) {
      const failure = classifyRotationItemFailure(error, claimedItem.item.attempts);
      await finishItem(input.env, claimedItem.item, claimedItem.leaseToken, failure.status, nowIso, failure.errorCode);
    }
  }

  await seedItems(input.env, run, descriptor, nowIso);
  const summary = await summarizeRun(input.env, run, descriptor);
  const completed = summary.oldVersionRows === 0 && summary.failedItems === 0;
  const status = completed ? "completed" : summary.failedItems > 0 ? "paused" : "running";
  const updated = await input.env.PLATFORM_DB.prepare(`
    UPDATE encryption_rotation_runs
    SET status = ?, total_items = ?, processed_items = ?, failed_items = ?,
      completed_at = CASE WHEN ? = 'completed' THEN ? ELSE NULL END,
      lease_token = NULL, lease_expires_at = NULL, version = version + 1, updated_at = ?
    WHERE id = ? AND lease_token = ? AND status = 'running'
  `).bind(status, summary.totalItems, summary.processedItems, summary.failedItems, status, nowIso, nowIso, run.id, runLeaseToken).run();
  if (updated.meta.changes !== 1) throw new AppError("rotation_run_lease_lost", 409);
  if (completed) await writeRotationAudit({ action: "encryption_rotation.completed", env: input.env, run, status, writtenAt: nowIso, ...summary });
  return { ...summary, completed, runId: run.id, status };
}
