import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const REPO_ROOT = path.resolve(__dirname, "../..");

/**
 * Every mutation of telegram_integrations must stay tenant- and
 * lifecycle-fenced. The recurring bug class this audit locks down: a new
 * code path adds an `UPDATE telegram_integrations ... WHERE id = ?` without
 * the shop/generation/status guards the rest of the subsystem relies on.
 *
 * New statements that legitimately need a different guard shape must be
 * added to ALLOWED_UNLIFECYCLED with a written justification.
 */
const AUDITED_FILES = [
  "src/lib/operations/deletion.ts",
  "src/lib/telegram/integrations.ts",
  "src/lib/telegram/webhooks.ts",
];

const ALLOWED_UNLIFECYCLED: ReadonlyArray<{ file: string; reason: string; snippet: string }> = [
  {
    // Marks the safe-error code after a provider menu sync failure. It must
    // reach the integration even when it is degraded/disabled, so the guard
    // shape is deliberately ownership-only (id + shop_id).
    file: "src/lib/telegram/integrations.ts",
    reason: "best-effort health marker; must record failures on any owned integration state",
    snippet: "last_safe_error_code = 'telegram_menu_update_failed'",
  },
];

function extractUpdateStatements(source: string): Array<{ sql: string; index: number }> {
  const statements: Array<{ sql: string; index: number }> = [];
  const pattern = /UPDATE\s+telegram_integrations/gu;
  for (let match = pattern.exec(source); match !== null; match = pattern.exec(source)) {
    const start = match.index;
    // Every statement in this codebase is prepared then immediately bound, so
    // the first `.bind(` after the keyword ends the mutation's SQL text.
    const bindIndex = source.indexOf(".bind(", start);
    const end = bindIndex === -1 ? Math.min(start + 1600, source.length) : Math.min(bindIndex, start + 1600);
    statements.push({ index: start, sql: source.slice(start, end) });
  }
  return statements;
}

function statementBody(sql: string): string {
  // Trim at the closing of the statement to keep allowlist matching stable.
  return sql.replace(/\s+/gu, " ");
}

describe("telegram_integrations mutation fencing audit", () => {
  for (const relativeFile of AUDITED_FILES) {
    it(`fences every UPDATE telegram_integrations in ${relativeFile}`, () => {
      const source = readFileSync(path.join(REPO_ROOT, relativeFile), "utf8");
      const statements = extractUpdateStatements(source);
      expect(statements.length).toBeGreaterThan(0);

      for (const { sql } of statements) {
        const body = statementBody(sql);
        const isAllowed = ALLOWED_UNLIFECYCLED.some((entry) => entry.file === relativeFile && body.includes(entry.snippet));
        if (isAllowed) continue;
        expect(body, `mutation must be tenant-scoped: ${body.slice(0, 160)}`).toContain("shop_id = ?");
        const hasLifecycleGuard = body.includes("generation_state")
          || body.includes("active_credential_id")
          || body.includes("channel_connection_id")
          || body.includes("status");
        expect(hasLifecycleGuard, `mutation must carry a lifecycle guard (generation_state | active_credential_id | channel_connection_id | status): ${body.slice(0, 160)}`).toBe(true);
      }
    });
  }

  it("bounds the generation drain check by the update claim staleness window", () => {
    const source = readFileSync(path.join(REPO_ROOT, "src/lib/telegram/integrations.ts"), "utf8");
    expect(source).toContain("TELEGRAM_UPDATE_CLAIM_STALE_MS");
    const drainStart = source.indexOf("SET generation_state = 'draining'");
    expect(drainStart).toBeGreaterThan(-1);
    const drainSql = statementBody(source.slice(drainStart, drainStart + 1200));
    expect(drainSql).toContain("telegram_updates.status = 'processing'");
    expect(drainSql).toContain("AND telegram_updates.updated_at > ?");
  });

  it("falls back to the default preset when stored menu template state is null", () => {
    const commerce = readFileSync(path.join(REPO_ROOT, "src/lib/telegram/commerce.ts"), "utf8");
    expect(commerce).toContain('configRow.templatePreset ?? "license_vault"');
    expect(commerce).toContain("default:");
  });

  it("never hardcodes a platform domain in the Telegram menu button path", () => {
    const source = readFileSync(path.join(REPO_ROOT, "src/lib/telegram/integrations.ts"), "utf8");
    expect(source).not.toContain("selinow.com");
    expect(source).toContain("shopStorefrontHostname");
  });
});
