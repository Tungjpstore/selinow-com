const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,95}$/u;
const SAFE_REQUEST_ID = /^[A-Za-z0-9._:-]{8,128}$/u;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u;

function sqlLiteral(value) {
  return `'${value.replaceAll("'", "''")}'`;
}

export function parsePlatformAdminBootstrapFlags(argv) {
  const flags = { confirm: false, dryRun: false, environment: "", json: false, userEmail: "", userId: "" };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--confirm-first-admin-bootstrap") flags.confirm = true;
    else if (argument === "--dry-run") flags.dryRun = true;
    else if (argument === "--json") flags.json = true;
    else if (argument === "--env") flags.environment = argv[++index] ?? "";
    else if (argument === "--user-id") flags.userId = argv[++index] ?? "";
    else if (argument === "--user-email") flags.userEmail = (argv[++index] ?? "").trim().toLowerCase();
    else throw new Error("platform_admin_bootstrap_argument_invalid");
  }
  if (!new Set(["local", "staging", "production"]).has(flags.environment)) throw new Error("platform_admin_bootstrap_environment_invalid");
  if (!SAFE_ID.test(flags.userId)) throw new Error("platform_admin_bootstrap_user_id_invalid");
  if (flags.userEmail.length > 254 || !EMAIL.test(flags.userEmail)) throw new Error("platform_admin_bootstrap_user_email_invalid");
  if (!flags.dryRun && !flags.confirm) throw new Error("platform_admin_bootstrap_confirmation_required");
  return flags;
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
INSERT INTO platform_admins (user_id, role, status, created_at, updated_at)
SELECT user_id, 'owner', 'active', ${now}, ${now}
FROM platform_admin_bootstrap_receipts
WHERE ceremony_key = 'first_platform_admin' AND user_id = ${sqlLiteral(userId)}
  AND (SELECT COUNT(*) FROM platform_admins) = 0;
SELECT
  (SELECT COUNT(*) FROM platform_admins) AS adminCount,
  (SELECT COUNT(*) FROM platform_admins WHERE user_id = ${sqlLiteral(userId)} AND role = 'owner' AND status = 'active') AS candidateOwnerCount,
  (SELECT COUNT(*) FROM platform_admin_bootstrap_receipts WHERE ceremony_key = 'first_platform_admin' AND user_id = ${sqlLiteral(userId)}) AS receiptCount;`;
}

export function parsePlatformAdminBootstrapOutput(output) {
  let value;
  try { value = JSON.parse(String(output)); } catch { throw new Error("platform_admin_bootstrap_output_invalid"); }
  const queue = [value];
  while (queue.length > 0) {
    const item = queue.shift();
    if (Array.isArray(item)) queue.push(...item);
    else if (item !== null && typeof item === "object") {
      if (Number(item.adminCount) >= 0 && Number(item.candidateOwnerCount) >= 0 && Number(item.receiptCount) >= 0) {
        return {
          adminCount: Number(item.adminCount),
          candidateOwnerCount: Number(item.candidateOwnerCount),
          receiptCount: Number(item.receiptCount),
        };
      }
      queue.push(...Object.values(item));
    }
  }
  throw new Error("platform_admin_bootstrap_output_invalid");
}

export function runPlatformAdminBootstrap({ flags, requestId, runner }) {
  if (flags.dryRun) {
    return { actions: [{ code: "exact_empty_state_required", ok: true }, { code: "owner_candidate_must_be_active", ok: true }], environment: flags.environment, ok: true };
  }
  const target = flags.environment === "local" ? ["--local"] : ["--env", flags.environment, "--remote"];
  const sql = buildPlatformAdminBootstrapSql({ requestId, userEmail: flags.userEmail, userId: flags.userId });
  const result = parsePlatformAdminBootstrapOutput(runner(["d1", "execute", "PLATFORM_DB", ...target, "--command", sql, "--json"]).stdout);
  if (result.adminCount !== 1 || result.candidateOwnerCount !== 1 || result.receiptCount !== 1) {
    throw new Error("platform_admin_bootstrap_exact_empty_state_required");
  }
  return { actions: [{ code: "first_platform_admin_created", ok: true }], environment: flags.environment, ok: true };
}
