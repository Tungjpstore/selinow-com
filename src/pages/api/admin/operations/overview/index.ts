import type { APIRoute } from "astro";

import { authenticateRequest } from "../../../../../lib/auth/session";
import { createCaughtErrorResponse } from "../../../../../lib/http/security";
import type { AppBindings } from "../../../../../lib/platform/bindings";
import { getBindings } from "../../../../../lib/platform/bindings";
import { requirePlatformAdminApiAccess } from "../../../../../lib/tenants/store";

const RECENT_HEALTH_WINDOW_MS = 24 * 60 * 60_000;

type StateCountRow = { count: number; status: string };

/**
 * Runs a bounded status-grouped COUNT and projects it into a record. Each query
 * filters on a leading status predicate so the 0105 platform-leading indexes back
 * it; result cardinality is bounded by the small status enum, never by tenant
 * rows. On any schema/query failure the section resolves to null so the caller
 * omits it instead of failing the whole overview (fail-closed per section).
 */
async function countGroupedByStatus(
  db: AppBindings["PLATFORM_DB"],
  sql: string,
  bindValues: readonly (number | string)[],
  keys: readonly { field: string; status: string }[],
): Promise<Record<string, number> | null> {
  try {
    const result = await db.prepare(sql).bind(...bindValues).all<StateCountRow>();
    const byStatus = new Map<string, number>();
    for (const row of result.results) byStatus.set(row.status, row.count);
    const output: Record<string, number> = {};
    for (const key of keys) output[key.field] = byStatus.get(key.status) ?? 0;
    return output;
  } catch {
    return null;
  }
}

async function countScalar(
  db: AppBindings["PLATFORM_DB"],
  sql: string,
  bindValues: readonly (number | string)[],
): Promise<number | null> {
  try {
    const row = await db.prepare(sql).bind(...bindValues).first<{ count: number }>();
    return row?.count ?? 0;
  } catch {
    return null;
  }
}

async function buildSubscriptionsByState(
  db: AppBindings["PLATFORM_DB"],
): Promise<Record<string, number> | null> {
  try {
    const result = await db.prepare(`
      SELECT latest.state AS status, COUNT(*) AS count
      FROM shops
      INNER JOIN shop_subscriptions AS latest
        ON latest.id = (
          SELECT candidate.id
          FROM shop_subscriptions AS candidate
          WHERE candidate.shop_id = shops.id
          ORDER BY candidate.created_at DESC, candidate.id DESC
          LIMIT 1
        )
      GROUP BY latest.state
    `).all<StateCountRow>();
    const output: Record<string, number> = {};
    for (const row of result.results) output[row.status] = row.count;
    return output;
  } catch {
    return null;
  }
}

async function buildProviderHealth(
  db: AppBindings["PLATFORM_DB"],
  recentSinceIso: string,
): Promise<Record<string, number> | null> {
  try {
    const [payosActive, telegramActive, telegramRecentlyChecked] = await Promise.all([
      db.prepare(`SELECT COUNT(*) AS count FROM payment_integrations WHERE status = 'active'`).first<{ count: number }>(),
      db.prepare(`SELECT COUNT(*) AS count FROM telegram_integrations WHERE status = 'active'`).first<{ count: number }>(),
      db.prepare(`
        SELECT COUNT(*) AS count
        FROM telegram_integrations
        WHERE last_checked_at IS NOT NULL AND last_checked_at >= ?
      `).bind(recentSinceIso).first<{ count: number }>(),
    ]);
    return {
      payosActive: payosActive?.count ?? 0,
      telegramActive: telegramActive?.count ?? 0,
      telegramRecentlyChecked: telegramRecentlyChecked?.count ?? 0,
    };
  } catch {
    return null;
  }
}

export const GET: APIRoute = async ({ locals, request }) => {
  try {
    const env = getBindings();
    const auth = await authenticateRequest(request, env);
    // Surfaces `admin_two_factor_required` (403) for admins without confirmed
    // 2FA and `authorization_denied` (403) for non-admins; fail-closed.
    await requirePlatformAdminApiAccess({ env, userId: auth.userId });

    const db = env.PLATFORM_DB;
    const recentSinceIso = new Date(Date.now() - RECENT_HEALTH_WINDOW_MS).toISOString();

    const [
      deadLetters,
      paymentExceptionsOpen,
      remediationRequests,
      incidents,
      deliveryJobs,
      subscriptionsByState,
      providerHealth,
    ] = await Promise.all([
      countGroupedByStatus(
        db,
        `SELECT status, COUNT(*) AS count FROM queue_dead_letters
         WHERE status IN ('open', 'retry_requested') GROUP BY status`,
        [],
        [
          { field: "open", status: "open" },
          { field: "retryRequested", status: "retry_requested" },
        ],
      ),
      countScalar(db, `SELECT COUNT(*) AS count FROM payment_exceptions WHERE status = 'open'`, []),
      countGroupedByStatus(
        db,
        `SELECT status, COUNT(*) AS count FROM payment_remediation_requests
         WHERE status IN ('requested', 'provider_pending') GROUP BY status`,
        [],
        [
          { field: "requested", status: "requested" },
          { field: "providerPending", status: "provider_pending" },
        ],
      ),
      countGroupedByStatus(
        db,
        `SELECT status, COUNT(*) AS count FROM operations_incidents
         WHERE status IN ('open', 'acknowledged') GROUP BY status`,
        [],
        [
          { field: "open", status: "open" },
          { field: "acknowledged", status: "acknowledged" },
        ],
      ),
      countGroupedByStatus(
        db,
        `SELECT status, COUNT(*) AS count FROM delivery_jobs
         WHERE status IN ('failed', 'dead_letter') GROUP BY status`,
        [],
        [
          { field: "failed", status: "failed" },
          { field: "deadLetter", status: "dead_letter" },
        ],
      ),
      buildSubscriptionsByState(db),
      buildProviderHealth(db, recentSinceIso),
    ]);

    const body: Record<string, unknown> = { ok: true, requestId: locals.requestId };
    if (deadLetters !== null) body.deadLetters = deadLetters;
    if (paymentExceptionsOpen !== null) body.paymentExceptions = { open: paymentExceptionsOpen };
    if (remediationRequests !== null) body.remediationRequests = remediationRequests;
    if (incidents !== null) body.incidents = incidents;
    if (deliveryJobs !== null) body.deliveryJobs = deliveryJobs;
    if (subscriptionsByState !== null) body.subscriptions = { byState: subscriptionsByState };
    if (providerHealth !== null) body.providerHealth = providerHealth;

    return Response.json(body, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    return createCaughtErrorResponse(error, locals.requestId);
  }
};
