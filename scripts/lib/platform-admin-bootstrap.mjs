import process from "node:process";

import {
  assertProductionMigrationAdmission,
  assertProductionMigrationLedger,
} from "./db-admission.mjs";
import { assertFreshProductionContinuationEvidence } from "./backup.mjs";
import { buildPinnedCloudflareEnvironment, repositoryRoot } from "./platform.mjs";

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,95}$/u;
const SAFE_REQUEST_ID = /^[A-Za-z0-9._:-]{8,128}$/u;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u;
const REQUIRED_MIGRATION = "0086_platform_admin_bootstrap_receipt.sql";
const PRODUCTION_EVIDENCE_FRESHNESS_MS = 24 * 60 * 60_000;
const SAFE_ERROR_CODES = new Set([
  "platform_admin_bootstrap_argument_invalid",
  "platform_admin_bootstrap_confirmation_required",
  "platform_admin_bootstrap_environment_invalid",
  "platform_admin_bootstrap_exact_empty_state_required",
  "platform_admin_bootstrap_failed",
  "platform_admin_bootstrap_input_invalid",
  "platform_admin_bootstrap_migration_0086_required",
  "platform_admin_bootstrap_output_invalid",
  "platform_admin_bootstrap_production_admission_failed",
  "platform_admin_bootstrap_production_backup_restore_invalid",
  "platform_admin_bootstrap_user_email_invalid",
  "platform_admin_bootstrap_user_id_invalid",
  "production_confirmation_required",
  "production_release_manifest_duplicate",
  "production_release_manifest_path_invalid",
  "production_release_manifest_required",
]);

function sqlLiteral(value) {
  return `'${value.replaceAll("'", "''")}'`;
}

export function parsePlatformAdminBootstrapFlags(argv) {
  const flags = {
    confirm: false,
    confirmProduction: false,
    dryRun: false,
    environment: "",
    json: false,
    releaseManifestPath: null,
    userEmail: "",
    userId: "",
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--confirm-first-admin-bootstrap") flags.confirm = true;
    else if (argument === "--confirm-production") flags.confirmProduction = true;
    else if (argument === "--dry-run") flags.dryRun = true;
    else if (argument === "--json") flags.json = true;
    else if (argument === "--env") flags.environment = argv[++index] ?? "";
    else if (argument.startsWith("--env=")) flags.environment = argument.slice("--env=".length);
    else if (argument === "--release-manifest") {
      if (flags.releaseManifestPath !== null) throw new Error("production_release_manifest_duplicate");
      flags.releaseManifestPath = argv[++index] ?? "";
    } else if (argument.startsWith("--release-manifest=")) {
      if (flags.releaseManifestPath !== null) throw new Error("production_release_manifest_duplicate");
      flags.releaseManifestPath = argument.slice("--release-manifest=".length);
    }
    else if (argument === "--user-id") flags.userId = argv[++index] ?? "";
    else if (argument === "--user-email") flags.userEmail = (argv[++index] ?? "").trim().toLowerCase();
    else throw new Error("platform_admin_bootstrap_argument_invalid");
  }
  if (!new Set(["local", "staging", "production"]).has(flags.environment)) throw new Error("platform_admin_bootstrap_environment_invalid");
  if (!SAFE_ID.test(flags.userId)) throw new Error("platform_admin_bootstrap_user_id_invalid");
  if (flags.userEmail.length > 254 || !EMAIL.test(flags.userEmail)) throw new Error("platform_admin_bootstrap_user_email_invalid");
  if (flags.releaseManifestPath !== null && flags.releaseManifestPath.length === 0) throw new Error("production_release_manifest_path_invalid");
  if (flags.environment === "production" && !flags.confirmProduction) throw new Error("production_confirmation_required");
  if (!flags.dryRun && !flags.confirm) throw new Error("platform_admin_bootstrap_confirmation_required");
  if (flags.environment === "production" && !flags.dryRun && flags.releaseManifestPath === null) {
    throw new Error("production_release_manifest_required");
  }
  return flags;
}

export function assertPlatformAdminBootstrapMigrationLedger(migrationNames) {
  if (!Array.isArray(migrationNames) || !migrationNames.includes(REQUIRED_MIGRATION)) {
    throw new Error("platform_admin_bootstrap_migration_0086_required");
  }
  return { migrationName: REQUIRED_MIGRATION };
}

export function assertPlatformAdminBootstrapContinuationFreshness(evidence, now = new Date()) {
  const backupCompletedAt = new Date(evidence?.backup?.completedAt ?? "");
  const restoreCompletedAt = new Date(evidence?.restore?.completedAt ?? "");
  const nowTimestamp = now.getTime();
  const backupAge = nowTimestamp - backupCompletedAt.getTime();
  const restoreAge = nowTimestamp - restoreCompletedAt.getTime();
  if (
    !Number.isFinite(nowTimestamp)
    || !Number.isFinite(backupCompletedAt.getTime())
    || !Number.isFinite(restoreCompletedAt.getTime())
    || backupAge < 0
    || backupAge > PRODUCTION_EVIDENCE_FRESHNESS_MS
    || restoreAge < 0
    || restoreAge > PRODUCTION_EVIDENCE_FRESHNESS_MS
    || restoreCompletedAt < backupCompletedAt
  ) {
    throw new Error("platform_admin_bootstrap_production_backup_restore_invalid");
  }
  return evidence;
}

export function safePlatformAdminBootstrapErrorCode(error) {
  const message = error instanceof Error ? error.message : "platform_admin_bootstrap_failed";
  if (SAFE_ERROR_CODES.has(message)) return message;
  if (message.startsWith("production_") || message.startsWith("release_json_")) {
    return "platform_admin_bootstrap_production_admission_failed";
  }
  return "platform_admin_bootstrap_failed";
}

export function buildPlatformAdminBootstrapSql({ requestId, userEmail, userId }) {
  if (!SAFE_REQUEST_ID.test(requestId) || !SAFE_ID.test(userId) || userEmail.length > 254 || !EMAIL.test(userEmail)) {
    throw new Error("platform_admin_bootstrap_input_invalid");
  }
  const now = "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')";
  return `INSERT INTO platform_admin_bootstrap_receipts (ceremony_key, user_id, role, request_id, created_at)
SELECT 'first_platform_admin', id, 'owner', ${sqlLiteral(requestId)}, ${now}
FROM platform_users
WHERE id = ${sqlLiteral(userId)} AND email_normalized = ${sqlLiteral(userEmail)} AND status = 'active'
  AND (SELECT COUNT(*) FROM platform_admins) = 0
  AND (SELECT COUNT(*) FROM platform_admin_bootstrap_receipts) = 0;
UPDATE auth_sessions
SET status = 'revoked', revoked_at = ${now}
WHERE user_id = ${sqlLiteral(userId)} AND status = 'active' AND revoked_at IS NULL
  AND EXISTS (
    SELECT 1 FROM platform_admin_bootstrap_receipts
    WHERE ceremony_key = 'first_platform_admin' AND user_id = ${sqlLiteral(userId)}
  )
  AND (
    (SELECT COUNT(*) FROM platform_admins) = 0
    OR authenticated_at <= (
      SELECT created_at FROM platform_admins
      WHERE user_id = ${sqlLiteral(userId)} AND role = 'owner' AND status = 'active'
    )
  );
INSERT INTO platform_admins (user_id, role, status, created_at, updated_at)
SELECT user_id, 'owner', 'active', ${now}, ${now}
FROM platform_admin_bootstrap_receipts
WHERE ceremony_key = 'first_platform_admin' AND user_id = ${sqlLiteral(userId)}
  AND (SELECT COUNT(*) FROM platform_admins) = 0
  AND NOT EXISTS (
    SELECT 1 FROM auth_sessions
    WHERE user_id = ${sqlLiteral(userId)} AND status = 'active' AND revoked_at IS NULL
      AND authenticated_at <= platform_admin_bootstrap_receipts.created_at
  );
SELECT
  (SELECT COUNT(*) FROM platform_admins) AS adminCount,
  (SELECT COUNT(*) FROM platform_admins WHERE user_id = ${sqlLiteral(userId)} AND role = 'owner' AND status = 'active') AS candidateOwnerCount,
  (SELECT COUNT(*) FROM platform_admin_bootstrap_receipts WHERE ceremony_key = 'first_platform_admin' AND user_id = ${sqlLiteral(userId)}) AS receiptCount,
  (SELECT COUNT(*) FROM auth_sessions
    WHERE user_id = ${sqlLiteral(userId)} AND status = 'active' AND revoked_at IS NULL
      AND (
        (SELECT COUNT(*) FROM platform_admins
          WHERE user_id = ${sqlLiteral(userId)} AND role = 'owner' AND status = 'active') = 0
        OR authenticated_at <= (
          SELECT created_at FROM platform_admins
          WHERE user_id = ${sqlLiteral(userId)} AND role = 'owner' AND status = 'active'
        )
      )) AS candidatePreBootstrapActiveSessionCount;`;
}

export function parsePlatformAdminBootstrapOutput(output) {
  let value;
  try { value = JSON.parse(String(output)); } catch { throw new Error("platform_admin_bootstrap_output_invalid"); }
  const queue = [value];
  while (queue.length > 0) {
    const item = queue.shift();
    if (Array.isArray(item)) queue.push(...item);
    else if (item !== null && typeof item === "object") {
      const counts = [
        item.adminCount,
        item.candidateOwnerCount,
        item.receiptCount,
        item.candidatePreBootstrapActiveSessionCount,
      ];
      if (counts.every((count) => Number.isSafeInteger(count) && count >= 0)) {
        return {
          adminCount: item.adminCount,
          candidateOwnerCount: item.candidateOwnerCount,
          candidatePreBootstrapActiveSessionCount: item.candidatePreBootstrapActiveSessionCount,
          receiptCount: item.receiptCount,
        };
      }
      queue.push(...Object.values(item));
    }
  }
  throw new Error("platform_admin_bootstrap_output_invalid");
}

export async function runPlatformAdminBootstrap(input) {
  const { flags, requestId, runner } = input;
  if (flags.environment === "production") {
    if (flags.confirmProduction !== true) throw new Error("production_confirmation_required");
    if (!flags.dryRun && flags.confirm !== true) throw new Error("platform_admin_bootstrap_confirmation_required");
    if (!flags.dryRun && (typeof flags.releaseManifestPath !== "string" || flags.releaseManifestPath.length === 0)) {
      throw new Error("production_release_manifest_required");
    }
  }
  if (flags.dryRun) {
    const actions = [
      { code: "exact_empty_state_required", ok: true },
      { code: "owner_candidate_must_be_active", ok: true },
    ];
    if (flags.environment === "production") {
      actions.unshift(
        { code: "production_exact_account_identity_required", ok: true },
        { code: "production_release_manifest_required", ok: true },
        { code: "production_fresh_backup_restore_required", ok: true },
        { code: "production_migration_0086_required", ok: true },
      );
    }
    return { actions, environment: flags.environment, ok: true };
  }

  let runnerOptions;
  if (flags.environment === "production") {
    const root = input.repositoryRoot ?? repositoryRoot;
    const operatorEnvironment = input.environment ?? process.env;
    const now = input.now ?? new Date();
    const continuationEvidenceImplementation = input.productionContinuationEvidenceImplementation
      ?? assertFreshProductionContinuationEvidence;
    const productionAdmission = await (
      input.productionAdmissionImplementation ?? assertProductionMigrationAdmission
    )({
      assertContinuationEvidenceImplementation: async (options) => assertPlatformAdminBootstrapContinuationFreshness(
        await continuationEvidenceImplementation({ ...options, now }),
        now,
      ),
      environment: operatorEnvironment,
      manifestPath: flags.releaseManifestPath,
      operation: "seed",
      repositoryRoot: root,
      runWranglerImplementation: runner,
      workerSecretNames: input.workerSecretNames ?? [],
    });
    const pinnedEnvironment = buildPinnedCloudflareEnvironment(
      operatorEnvironment,
      productionAdmission.accountId,
    );
    const ledger = await (
      input.productionLedgerImplementation ?? assertProductionMigrationLedger
    )({
      environment: pinnedEnvironment,
      migrationNames: undefined,
      repositoryRoot: root,
      runWranglerImplementation: runner,
    });
    assertPlatformAdminBootstrapMigrationLedger(ledger?.migrationNames);
    runnerOptions = { cwd: root, env: pinnedEnvironment };
  }

  const target = flags.environment === "local" ? ["--local"] : ["--env", flags.environment, "--remote"];
  const sql = buildPlatformAdminBootstrapSql({ requestId, userEmail: flags.userEmail, userId: flags.userId });
  const result = parsePlatformAdminBootstrapOutput(runner([
    "d1", "execute", "PLATFORM_DB", ...target, "--command", sql, "--json",
  ], runnerOptions).stdout);
  if (
    result.adminCount !== 1
    || result.candidateOwnerCount !== 1
    || result.receiptCount !== 1
    || result.candidatePreBootstrapActiveSessionCount !== 0
  ) {
    throw new Error("platform_admin_bootstrap_exact_empty_state_required");
  }
  return {
    actions: [{ code: "first_platform_admin_created", ok: true }],
    environment: flags.environment,
    // Post-step note: console access stays fail-closed until the new admin
    // confirms two-factor enrollment (admin_two_factor_required guard).
    nextSteps: [{
      code: "admin_two_factor_enrollment_required_before_console_access",
      detail: "the new platform admin must enroll two-factor authentication before console access",
      ok: true,
    }],
    ok: true,
  };
}
