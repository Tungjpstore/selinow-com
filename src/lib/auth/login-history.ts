import { hmacToken } from "../core/crypto";
import { createId } from "../core/ids";
import { loggerFor } from "../operations/logger";
import type { AppBindings } from "../platform/bindings";

export type LoginHistoryOutcome =
  | "account_locked"
  | "account_suspended"
  | "email_unverified"
  | "invalid_credentials"
  | "success"
  | "two_factor_failed"
  | "two_factor_required";

export type LoginHistoryEntry = {
  id: string;
  occurredAt: string;
  outcome: LoginHistoryOutcome;
};

const REQUESTER_HASH_PURPOSE = "login-history-requester:v1";
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;

/**
 * Records a login outcome for the account-security dashboard. This is
 * best-effort telemetry: a write failure is swallowed (after a warning log)
 * so login history never blocks or changes authentication behavior. Only an
 * HMAC digest of the requester address is stored, never the raw IP.
 */
export async function recordLoginHistory(input: {
  env: AppBindings;
  now?: Date;
  outcome: LoginHistoryOutcome;
  requesterAddress: string;
  userId: string;
}): Promise<void> {
  try {
    const now = input.now ?? new Date();
    const nowIso = now.toISOString();
    const trimmedAddress = input.requesterAddress.trim();
    const requesterHash = await hmacToken(
      input.env.IDENTIFIER_HMAC_SECRET,
      REQUESTER_HASH_PURPOSE,
      trimmedAddress.length > 0 && trimmedAddress.length <= 128 ? trimmedAddress : "unknown",
    );
    await input.env.PLATFORM_DB.prepare(`
      INSERT INTO auth_login_history (id, user_id, outcome, requester_hash, occurred_at, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).bind(createId("lgh"), input.userId, input.outcome, requesterHash, nowIso, nowIso).run();
  } catch {
    try {
      loggerFor(input.env).warn({ event: "auth.login_history_write_failed" });
    } catch {
      // Logging must never affect authentication behavior.
    }
  }
}

export async function listLoginHistory(input: {
  env: AppBindings;
  limit?: number;
  userId: string;
}): Promise<LoginHistoryEntry[]> {
  const requestedLimit = input.limit;
  const limit = Number.isSafeInteger(requestedLimit) && (requestedLimit as number) > 0
    ? Math.min(requestedLimit as number, MAX_LIMIT)
    : DEFAULT_LIMIT;
  const rows = await input.env.PLATFORM_DB.prepare(`
    SELECT id, outcome, occurred_at AS occurredAt
    FROM auth_login_history
    WHERE user_id = ?
    ORDER BY occurred_at DESC, id DESC
    LIMIT ?
  `).bind(input.userId, limit).all<LoginHistoryEntry>();
  return rows.results;
}
