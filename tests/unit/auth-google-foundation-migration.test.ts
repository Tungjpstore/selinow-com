import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import { purgeGoogleOAuthStates } from "../../src/lib/auth/google-state-maintenance";
import { findCompoundSelectLimitViolations } from "../helpers/d1-migration-guard";

const NOW = new Date("2026-08-22T12:00:00.000Z");
const HASH_A = "A".repeat(43);
const HASH_B = "B".repeat(43);
const HASH_C = "C".repeat(43);
const CIPHERTEXT = "D".repeat(80);
const IV = "E".repeat(16);

class SqliteStatement {
  constructor(
    private readonly database: DatabaseSync,
    private readonly sql: string,
    private readonly values: SQLInputValue[] = [],
  ) {}

  bind(...values: unknown[]): SqliteStatement {
    return new SqliteStatement(this.database, this.sql, values.map((value): SQLInputValue => {
      if (value === null || typeof value === "string" || typeof value === "number"
        || typeof value === "bigint" || value instanceof Uint8Array) return value;
      throw new TypeError("unsupported_sqlite_binding");
    }));
  }

  run(): Promise<{ meta: { changes: number } }> {
    const result = this.database.prepare(this.sql).run(...this.values);
    return Promise.resolve({ meta: { changes: Number(result.changes) } });
  }
}

class SqliteD1 {
  constructor(readonly database: DatabaseSync) {}

  prepare(sql: string): SqliteStatement {
    return new SqliteStatement(this.database, sql);
  }
}

const databases: DatabaseSync[] = [];

function createDatabase(): DatabaseSync {
  const database = new DatabaseSync(":memory:");
  database.exec("PRAGMA foreign_keys = ON");
  const directory = join(process.cwd(), "migrations");
  for (const filename of readdirSync(directory)
    .filter((name) => /^\d{4}_.+\.sql$/u.test(name))
    .sort()) {
    database.exec(readFileSync(join(directory, filename), "utf8"));
  }
  database.exec(`
    INSERT INTO platform_users (id, email_normalized, display_name, status, created_at, updated_at)
    VALUES
      ('usr-google-a', 'google-a@example.test', 'Google A', 'active', '${NOW.toISOString()}', '${NOW.toISOString()}'),
      ('usr-google-b', 'google-b@example.test', 'Google B', 'active', '${NOW.toISOString()}', '${NOW.toISOString()}');
  `);
  databases.push(database);
  return database;
}

function insertPending(database: DatabaseSync, input: {
  createdAt?: string;
  expiresAt?: string;
  flow?: "link" | "login" | "register";
  id: string;
  initiatedUserId?: string | null;
  stateHash?: string;
}): void {
  const createdAt = input.createdAt ?? NOW.toISOString();
  const expiresAt = input.expiresAt ?? new Date(NOW.getTime() + 10 * 60_000).toISOString();
  database.prepare(`
    INSERT INTO auth_google_oauth_states (
      id, flow, initiated_user_id, state_lookup_hash, nonce_hash,
      browser_binding_hash, redirect_uri, return_to,
      code_verifier_ciphertext_b64, code_verifier_iv_b64, key_version,
      status, expires_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'v1', 'pending', ?, ?, ?)
  `).run(
    input.id,
    input.flow ?? "login",
    input.initiatedUserId ?? null,
    input.stateHash ?? HASH_A,
    HASH_B,
    HASH_C,
    "https://app.selinow.com/api/auth/google/callback",
    "/app",
    CIPHERTEXT,
    IV,
    expiresAt,
    createdAt,
    createdAt,
  );
}

afterEach(() => {
  while (databases.length > 0) {
    databases.pop()?.close();
  }
});

describe("Google authentication foundation migration", () => {
  it("preserves existing admission rows while adding the Google start action", () => {
    const database = new DatabaseSync(":memory:");
    databases.push(database);
    const directory = join(process.cwd(), "migrations");
    for (const filename of readdirSync(directory)
      .filter((name) => /^\d{4}_.+\.sql$/u.test(name) && name < "0112_google_auth_foundation.sql")
      .sort()) {
      database.exec(readFileSync(join(directory, filename), "utf8"));
    }
    database.prepare(`
      INSERT INTO auth_request_admissions (
        id, action, requester_hash, subject_hash, delivery_permitted,
        window_started_at, window_ends_at, created_at
      ) VALUES (?, 'shop_create', ?, ?, 1, ?, ?, ?)
    `).run(
      "adm-before-google",
      "requester_hash_before_google",
      "subject_hash_before_google",
      "2026-08-22T11:00:00.000Z",
      "2026-08-22T11:15:00.000Z",
      "2026-08-22T11:00:00.000Z",
    );

    database.exec(readFileSync(join(directory, "0112_google_auth_foundation.sql"), "utf8"));
    expect(database.prepare(`
      SELECT action, requester_hash AS requesterHash, subject_hash AS subjectHash
      FROM auth_request_admissions WHERE id = 'adm-before-google'
    `).get()).toEqual({
      action: "shop_create",
      requesterHash: "requester_hash_before_google",
      subjectHash: "subject_hash_before_google",
    });
    expect(database.prepare(`
      INSERT INTO auth_request_admissions (
        id, action, requester_hash, subject_hash, delivery_permitted,
        window_started_at, window_ends_at, created_at
      ) VALUES (?, 'google_oauth_start', ?, ?, 1, ?, ?, ?)
    `).run(
      "adm-google-start",
      "requester_hash_google_start",
      "subject_hash_google_start",
      "2026-08-22T12:00:00.000Z",
      "2026-08-22T12:15:00.000Z",
      "2026-08-22T12:00:00.000Z",
    ).changes).toBe(1);
    expect(database.prepare(`
      SELECT name FROM sqlite_schema
      WHERE type = 'table' AND name = 'auth_request_admissions_legacy_0112'
    `).get()).toBeUndefined();
  });

  it("creates the global identity/state contract without provider plaintext", () => {
    const database = createDatabase();
    const tables = database.prepare(`
      SELECT name FROM sqlite_master
      WHERE type = 'table' AND name LIKE 'auth_google_%'
      ORDER BY name
    `).all();
    expect(tables).toEqual([
      { name: "auth_google_identities" },
      { name: "auth_google_oauth_states" },
    ]);

    const identityColumns = database.prepare("PRAGMA table_info(auth_google_identities)").all()
      .map((row) => (row as { name: string }).name);
    expect(identityColumns).not.toEqual(expect.arrayContaining(["email", "raw_sub", "access_token", "refresh_token"]));

    database.prepare(`
      INSERT INTO auth_google_identities (
        id, user_id, subject_hash, subject_key_version, created_at,
        last_authenticated_at, updated_at
      ) VALUES (?, ?, ?, 'v1', ?, ?, ?)
    `).run("goid-google-a", "usr-google-a", HASH_A, NOW.toISOString(), NOW.toISOString(), NOW.toISOString());

    expect(() => database.prepare(`
      INSERT INTO auth_google_identities (
        id, user_id, subject_hash, subject_key_version, created_at,
        last_authenticated_at, updated_at
      ) VALUES (?, ?, ?, 'v1', ?, ?, ?)
    `).run("goid-google-b", "usr-google-b", HASH_A, NOW.toISOString(), NOW.toISOString(), NOW.toISOString()))
      .toThrow(/UNIQUE constraint failed/u);
  });

  it("enforces one-use state transitions and link ownership", () => {
    const database = createDatabase();
    expect(() => {
      insertPending(database, {
        flow: "link",
        id: "goauth-invalid-link",
        initiatedUserId: null,
      });
    }).toThrow(/CHECK constraint failed/u);

    insertPending(database, {
      flow: "link",
      id: "goauth-link",
      initiatedUserId: "usr-google-a",
    });
    const consumedAt = new Date(NOW.getTime() + 60_000).toISOString();
    const first = database.prepare(`
      UPDATE auth_google_oauth_states
      SET status = 'consumed', nonce_hash = NULL, browser_binding_hash = NULL,
        code_verifier_ciphertext_b64 = NULL, code_verifier_iv_b64 = NULL,
        consumed_at = ?, updated_at = ?, version = version + 1
      WHERE id = ? AND status = 'pending' AND expires_at > ? AND version = 1
    `).run(consumedAt, consumedAt, "goauth-link", NOW.toISOString());
    expect(first.changes).toBe(1);

    const replay = database.prepare(`
      UPDATE auth_google_oauth_states
      SET status = 'consumed', nonce_hash = NULL, browser_binding_hash = NULL,
        code_verifier_ciphertext_b64 = NULL, code_verifier_iv_b64 = NULL,
        consumed_at = ?, updated_at = ?, version = version + 1
      WHERE id = ? AND status = 'pending' AND expires_at > ? AND version = 1
    `).run(consumedAt, consumedAt, "goauth-link", NOW.toISOString());
    expect(replay.changes).toBe(0);

    expect(database.prepare(`
      SELECT initiated_user_id AS initiatedUserId, key_version AS keyVersion,
        nonce_hash AS nonceHash, code_verifier_ciphertext_b64 AS verifier
      FROM auth_google_oauth_states WHERE id = 'goauth-link'
    `).get()).toEqual({
      initiatedUserId: "usr-google-a",
      keyVersion: "v1",
      nonceHash: null,
      verifier: null,
    });
    expect(() => database.prepare(`
      UPDATE auth_google_oauth_states
      SET return_to = '/other', updated_at = ?, version = version + 1
      WHERE id = 'goauth-link'
    `).run(new Date(NOW.getTime() + 120_000).toISOString())).toThrow("auth_google_oauth_state_transition_invalid");
  });

  it("purges only bounded expired or retained state rows", async () => {
    const database = createDatabase();
    const oldCreated = new Date(NOW.getTime() - 48 * 60 * 60_000).toISOString();
    const expiredAt = new Date(NOW.getTime() - 47 * 60 * 60_000).toISOString();
    for (let index = 0; index < 505; index += 1) {
      insertPending(database, {
        createdAt: oldCreated,
        expiresAt: expiredAt,
        id: `goauth-expired-${String(index).padStart(3, "0")}`,
        stateHash: `${String(index).padStart(3, "0")}${"A".repeat(40)}`,
      });
    }
    insertPending(database, { id: "goauth-fresh", stateHash: HASH_C });

    const deleted = await purgeGoogleOAuthStates(
      { PLATFORM_DB: new SqliteD1(database) as unknown as D1Database },
      NOW,
    );
    expect(deleted).toBe(500);
    expect(database.prepare("SELECT COUNT(*) AS count FROM auth_google_oauth_states").get())
      .toEqual({ count: 6 });
    expect(database.prepare("SELECT status FROM auth_google_oauth_states WHERE id = 'goauth-fresh'").get())
      .toEqual({ status: "pending" });
  });

  it("keeps migration 0112 within the D1 compound SELECT limit", () => {
    const sql = readFileSync(join(process.cwd(), "migrations/0112_google_auth_foundation.sql"), "utf8");
    expect(findCompoundSelectLimitViolations(sql)).toEqual([]);
  });
});
