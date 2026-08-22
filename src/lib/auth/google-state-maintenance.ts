import type { AppBindings } from "../platform/bindings";

const GOOGLE_OAUTH_STATE_RETENTION_MS = 24 * 60 * 60_000;
const GOOGLE_OAUTH_STATE_PURGE_LIMIT = 500;

/** Removes expired pending challenges and terminal replay markers after retention. */
export async function purgeGoogleOAuthStates(
  env: Pick<AppBindings, "PLATFORM_DB">,
  now = new Date(),
): Promise<number> {
  const nowIso = now.toISOString();
  const retentionCutoff = new Date(now.getTime() - GOOGLE_OAUTH_STATE_RETENTION_MS).toISOString();
  const result = await env.PLATFORM_DB.prepare(`
    DELETE FROM auth_google_oauth_states
    WHERE id IN (
      SELECT id
      FROM auth_google_oauth_states
      WHERE (status = 'pending' AND expires_at <= ?)
        OR (status IN ('consumed', 'revoked') AND updated_at <= ?)
      ORDER BY
        CASE WHEN status = 'pending' THEN expires_at ELSE updated_at END,
        id
      LIMIT ?
    )
  `).bind(nowIso, retentionCutoff, GOOGLE_OAUTH_STATE_PURGE_LIMIT).run();
  return result.meta.changes;
}
