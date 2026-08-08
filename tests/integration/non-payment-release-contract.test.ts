import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { describe, expect, it } from "vitest";

import { evaluateProviderRuntimeAdmission } from "../../src/lib/channels/runtime-admission";
import { buildPlatformAdminBootstrapSql } from "../../scripts/lib/platform-admin-bootstrap.mjs";

const workspace = process.cwd();

function migrationNames(): string[] {
  return readdirSync(join(workspace, "migrations"))
    .filter((name) => /^\d{4}_[a-z0-9_]+\.sql$/u.test(name))
    .sort();
}

describe("non-payment release integration contracts", () => {
  it("keeps the numbered source ledger contiguous and replays it on isolated SQLite", () => {
    const names = migrationNames();
    expect(names.length).toBeGreaterThanOrEqual(86);
    names.forEach((name, index) => {
      expect(Number(name.slice(0, 4)), name).toBe(index + 1);
    });

    const database = new DatabaseSync(":memory:");
    try {
      for (const name of names) {
        database.exec(readFileSync(join(workspace, "migrations", name), "utf8"));
      }
      expect(database.prepare("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
      expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
      expect(database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'checkout_recovery_capabilities'").get()).toEqual({ name: "checkout_recovery_capabilities" });
      expect(database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'buyer_privacy_requests'").get()).toEqual({ name: "buyer_privacy_requests" });
      expect(database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'platform_admin_bootstrap_receipts'").get()).toEqual({ name: "platform_admin_bootstrap_receipts" });
    } finally {
      database.close();
    }
  });

  it("never creates a platform admin through migrations or production seed paths", () => {
    const migrationSource = migrationNames()
      .map((name) => readFileSync(join(workspace, "migrations", name), "utf8"))
      .join("\n");
    expect(migrationSource).not.toMatch(/INSERT\s+(?:OR\s+\w+\s+)?INTO\s+platform_admins\b/iu);

    const seedFiles = readdirSync(join(workspace, "seeds")).filter((name) => name.endsWith(".sql")).sort();
    const adminSeeds = seedFiles.filter((name) => /INSERT\s+(?:OR\s+\w+\s+)?INTO\s+platform_admins\b/iu.test(
      readFileSync(join(workspace, "seeds", name), "utf8"),
    ));
    expect(adminSeeds).toEqual(["0004_local_authenticated_browser.sql"]);
  });

  it("bootstraps exactly one active platform owner and rejects a second candidate", () => {
    const database = new DatabaseSync(":memory:");
    try {
      for (const name of migrationNames()) database.exec(readFileSync(join(workspace, "migrations", name), "utf8"));
      database.exec(`
        INSERT INTO platform_users (id, email_normalized, display_name, status, created_at, updated_at)
        VALUES
          ('admin_candidate_one', 'owner-one@example.test', 'Owner One', 'active', '2026-08-08T00:00:00.000Z', '2026-08-08T00:00:00.000Z'),
          ('admin_candidate_two', 'owner-two@example.test', 'Owner Two', 'active', '2026-08-08T00:00:00.000Z', '2026-08-08T00:00:00.000Z');
      `);
      database.exec(buildPlatformAdminBootstrapSql({
        requestId: "request-admin-bootstrap-one",
        userEmail: "owner-one@example.test",
        userId: "admin_candidate_one",
      }));
      database.exec(buildPlatformAdminBootstrapSql({
        requestId: "request-admin-bootstrap-two",
        userEmail: "owner-two@example.test",
        userId: "admin_candidate_two",
      }));

      expect(database.prepare("SELECT user_id AS userId, role, status FROM platform_admins").all()).toEqual([
        { role: "owner", status: "active", userId: "admin_candidate_one" },
      ]);
      expect(database.prepare("SELECT ceremony_key AS ceremonyKey, user_id AS userId FROM platform_admin_bootstrap_receipts").all()).toEqual([
        { ceremonyKey: "first_platform_admin", userId: "admin_candidate_one" },
      ]);
    } finally {
      database.close();
    }
  });

  it.each(["telegram.mini_app", "zalo.mini_app", "zalo.oa", "whatsapp.cloud", "discord.bot"])(
    "keeps expansion provider %s blocked without runtime proofs",
    (code) => {
      const result = evaluateProviderRuntimeAdmission({
        code,
        connectionStatus: "pending",
        credentialStatus: null,
        grantedCapabilities: new Set(),
        now: new Date("2026-08-08T12:00:00.000Z"),
        providerIdentityMatched: false,
        requiredCapabilities: ["conversation.outbound"],
        webhookVerifiedAt: null,
      });
      expect(result.status).toBe("blocked");
      expect(result.reasons).toEqual(expect.arrayContaining([
        "connection_not_active",
        "credential_not_active",
        "provider_identity_unverified",
        "required_capability_missing",
        "webhook_evidence_missing",
      ]));
      expect(JSON.stringify(result)).not.toMatch(/token|secret|ciphertext|credentialEnvelope/iu);
    },
  );
});
