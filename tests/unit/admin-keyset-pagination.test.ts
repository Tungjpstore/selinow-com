import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { encodeCreatedIdCursor, parseCreatedIdCursor } from "../../src/lib/core/pagination";
import { listActiveDeadLetters } from "../../src/lib/operations/dead-letters";
import { listActiveDeletionRequests } from "../../src/lib/operations/deletion";
import { listActiveIncidents } from "../../src/lib/operations/incidents";
import { listAdminPaymentRemediationRequests } from "../../src/lib/payments/remediation";
import type { AppBindings } from "../../src/lib/platform/bindings";

const NOW = new Date("2026-08-17T02:00:00.000Z");
const NOW_ISO = NOW.toISOString();

class SqliteStatement {
  constructor(
    private readonly database: DatabaseSync,
    private readonly sql: string,
    private readonly values: SQLInputValue[] = [],
  ) {}

  bind(...values: unknown[]) {
    const sqlValues = values.map((value): SQLInputValue => {
      if (value === null || typeof value === "string" || typeof value === "number"
        || typeof value === "bigint" || value instanceof Uint8Array) return value;
      throw new TypeError("unsupported_sqlite_binding");
    });
    return new SqliteStatement(this.database, this.sql, sqlValues);
  }

  first<T>(): Promise<T | null> {
    const row = this.database.prepare(this.sql).get(...this.values) as T | undefined;
    return Promise.resolve(row ?? null);
  }

  all(): Promise<{ results: unknown[] }> {
    const results = this.database.prepare(this.sql).all(...this.values);
    return Promise.resolve({ results });
  }

  run(): Promise<{ meta: { changes: number } }> {
    const result = this.database.prepare(this.sql).run(...this.values);
    return Promise.resolve({ meta: { changes: Number(result.changes) } });
  }
}

function applyMigrations(database: DatabaseSync): void {
  const directory = join(process.cwd(), "migrations");
  for (const filename of readdirSync(directory).filter((name) => /^\d{4}_.+\.sql$/u.test(name)).sort()) {
    database.exec(readFileSync(join(directory, filename), "utf8"));
  }
}

function bindings(database: DatabaseSync): AppBindings {
  const platformDb = {
    prepare(sql: string) {
      return new SqliteStatement(database, sql) as unknown as D1PreparedStatement;
    },
  };
  return { PLATFORM_DB: platformDb } as unknown as AppBindings;
}

function seedDeadLetter(database: DatabaseSync, id: string, createdAt: string): void {
  database.prepare(`
    INSERT INTO queue_dead_letters (
      id, shop_id, scope_key, queue_name, message_id, message_kind,
      reference_type, reference_id, failure_code, safe_envelope_json,
      status, provider_attempts, occurrence_count, first_seen_at,
      last_seen_at, retry_count, version, created_at, updated_at
    ) VALUES (?, NULL, 'platform', 'integration-staging', ?, 'integration',
      'none', NULL, 'queue_retries_exhausted', '{}', 'open', 1, 1, ?, ?, 0, 1, ?, ?)
  `).run(id, `message-${id}`, createdAt, createdAt, createdAt, createdAt);
}

function seedIncident(database: DatabaseSync, id: string, createdAt: string): void {
  database.prepare(`
    INSERT INTO operations_incidents (
      id, shop_id, scope_key, incident_key, category, severity, status,
      source_kind, source_ref, safe_context_json, occurrence_count,
      first_seen_at, last_seen_at, version, created_at, updated_at
    ) VALUES (?, NULL, 'platform', ?, 'system_health', 'low', 'open',
      'system', ?, '{}', 1, ?, ?, 1, ?, ?)
  `).run(id, `key-${id}`, `ref-${id}`, createdAt, createdAt, createdAt, createdAt);
}

function seedPlatformAdmin(database: DatabaseSync): void {
  database.prepare(`
    INSERT INTO platform_users (
      id, email_normalized, display_name, status, two_factor_enabled,
      two_factor_enabled_at, created_at, updated_at
    ) VALUES ('admin-ops', 'admin-ops@example.test', 'Ops Admin', 'active', 1, ?, ?, ?)
  `).run(NOW_ISO, NOW_ISO, NOW_ISO);
  database.prepare(`
    INSERT INTO platform_admins (user_id, role, status, created_at, updated_at)
    VALUES ('admin-ops', 'risk', 'active', ?, ?)
  `).run(NOW_ISO, NOW_ISO);
}

function seedShop(database: DatabaseSync, suffix: string): void {
  database.prepare(`
    INSERT INTO shops (
      id, public_id, slug, name, status, default_locale, currency, timezone,
      readiness_version, created_at, updated_at
    ) VALUES (?, ?, ?, ?, 'active', 'en', 'USD', 'UTC', 1, ?, ?)
  `).run(`shop-${suffix}`, `shop_public_${suffix}`, `shop-${suffix}`, `Shop ${suffix}`, NOW_ISO, NOW_ISO);
}

function seedDeletionRequest(database: DatabaseSync, id: string, shopSuffix: string, createdAt: string): void {
  const graceEndsAt = new Date(new Date(createdAt).getTime() + 30 * 24 * 60 * 60_000).toISOString();
  const retainUntil = new Date(new Date(createdAt).getTime() + 7 * 365 * 24 * 60 * 60_000).toISOString();
  database.prepare(`
    INSERT INTO shop_deletion_requests (
      id, shop_id, status, reason_code, requested_by_user_id, request_id,
      grace_ends_at, financial_records_retain_until, legal_hold_until,
      checkout_blocked_at, routing_removed_at, version, created_at, updated_at
    ) VALUES (?, ?, 'processing', 'seller_request', NULL, ?, ?, ?, NULL, ?, ?, 1, ?, ?)
  `).run(id, `shop-${shopSuffix}`, `request-${id}`, graceEndsAt, retainUntil, createdAt, createdAt, createdAt, createdAt);
}

function seedOrder(database: DatabaseSync, suffix: string): void {
  database.prepare(`
    INSERT INTO orders (
      id, public_id, shop_id, customer_id, order_number, source_channel, status,
      payment_status, fulfillment_status, subtotal_minor, discount_minor, total_minor,
      currency, locale, customer_email_masked, checkout_subject_hash, order_token_hash,
      expires_at, created_at, updated_at
    ) VALUES (?, ?, ?, NULL, ?, 'web', 'pending_payment', 'unpaid', 'reserved',
      1000, 0, 1000, 'USD', 'en', NULL, ?, ?, ?, ?, ?)
  `).run(
    `order-${suffix}`,
    `order_public_${suffix}`,
    `shop-${suffix}`,
    `SO-${suffix}`,
    `subject-${suffix}`,
    `token-${suffix}`,
    "2099-01-01T00:00:00.000Z",
    NOW_ISO,
    NOW_ISO,
  );
}

function seedPaymentChain(database: DatabaseSync, suffix: string, providerOrderCode: number): void {
  database.prepare(`
    INSERT OR IGNORE INTO platform_users (id, email_normalized, display_name, status, created_at, updated_at)
    VALUES (?, ?, ?, 'active', ?, ?)
  `).run(`seller-${suffix}`, `seller-${suffix}@example.test`, `Seller ${suffix}`, NOW_ISO, NOW_ISO);
  database.prepare(`
    INSERT OR IGNORE INTO shop_members (shop_id, user_id, role, status, created_at, updated_at)
    VALUES (?, ?, 'owner', 'active', ?, ?)
  `).run(`shop-${suffix}`, `seller-${suffix}`, NOW_ISO, NOW_ISO);
  database.prepare(`
    INSERT OR IGNORE INTO payment_integrations (
      id, public_id, webhook_public_id, shop_id, provider, status, webhook_status,
      created_at, updated_at
    ) VALUES (?, ?, ?, ?, 'payos', 'active', 'verified', ?, ?)
  `).run(`integration-${suffix}`, `integration_public_${suffix}`, `webhook_public_${suffix}`, `shop-${suffix}`, NOW_ISO, NOW_ISO);
  database.prepare(`
    INSERT OR IGNORE INTO payment_credentials (
      id, shop_id, integration_id, provider, status, version, key_version,
      client_id_ciphertext_b64, client_id_iv_b64, api_key_ciphertext_b64,
      api_key_iv_b64, checksum_key_ciphertext_b64, checksum_key_iv_b64,
      credential_fingerprint, created_by_user_id, created_at
    ) VALUES (?, ?, ?, 'payos', 'active', 1, 'v1',
      'cipher', 'iv', 'cipher', 'iv', 'cipher', 'iv', ?, 'admin-ops', ?)
  `).run(`credential-${suffix}`, `shop-${suffix}`, `integration-${suffix}`, `fingerprint-${suffix}`, NOW_ISO);
  database.prepare(`
    INSERT OR IGNORE INTO payment_attempts (
      id, public_id, shop_id, order_id, integration_id, credential_id, provider,
      provider_order_code, state, expected_amount_minor, currency, expected_description,
      expires_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, 'payos', ?, 'pending', 1000, 'USD', ?,
      '2099-01-01T00:00:00.000Z', ?, ?)
  `).run(
    `attempt-${suffix}`,
    `attempt_public_${suffix}`,
    `shop-${suffix}`,
    `order-${suffix}`,
    `integration-${suffix}`,
    `credential-${suffix}`,
    providerOrderCode,
    `SO-${suffix}`,
    NOW_ISO,
    NOW_ISO,
  );
}

function seedRemediationRequest(database: DatabaseSync, id: string, shopSuffix: string, createdAt: string): void {
  database.prepare(`
    INSERT INTO payment_exceptions (
      id, shop_id, order_id, payment_attempt_id, type, status, safe_evidence_json, created_at
    ) VALUES (?, ?, ?, ?, 'manual_review', 'open', '{}', ?)
  `).run(`pex-${id}`, `shop-${shopSuffix}`, `order-${shopSuffix}`, `attempt-${shopSuffix}`, createdAt);
  database.prepare(`
    INSERT INTO payment_remediation_requests (
      id, public_id, shop_id, order_id, payment_exception_id, requested_by_user_id,
      kind, status, amount_minor, currency, reason_code,
      idempotency_key_hash, request_hash, version, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, 'manual_review', 'requested', 0, 'USD',
      'buyer_requested', ?, ?, 1, ?, ?)
  `).run(id, id, `shop-${shopSuffix}`, `order-${shopSuffix}`, `pex-${id}`, `seller-${shopSuffix}`, `idem-${id}`, `hash-${id}`, createdAt, createdAt);
}

function lastRow(rows: Array<{ createdAt: string; id: string }>): { createdAt: string; id: string } {
  const last = rows.at(-1);
  if (last === undefined) throw new Error("page_empty");
  return last;
}

let database: DatabaseSync;
let env: AppBindings;

beforeEach(() => {
  database = new DatabaseSync(":memory:");
  applyMigrations(database);
  env = bindings(database);
});

afterEach(() => {
  database.close();
});

describe("admin keyset pagination", () => {
  it("walks dead letters page by page with no duplicates or gaps", async () => {
    const ids = ["dlq-a", "dlq-b", "dlq-c", "dlq-d", "dlq-e"] as const;
    ids.forEach((id, index) => {
      seedDeadLetter(
        database,
        id,
        new Date(NOW.getTime() + index * 60_000).toISOString(),
      );
    });

    const first = await listActiveDeadLetters({ env, limit: 2 });
    expect(first.items.map((item) => item.id)).toEqual(["dlq-e", "dlq-d"]);
    expect(first.hasMore).toBe(true);
    expect(first.nextCursor).not.toBeNull();

    const second = await listActiveDeadLetters({ cursor: first.nextCursor ?? null, env, limit: 2 });
    expect(second.items.map((item) => item.id)).toEqual(["dlq-c", "dlq-b"]);
    expect(second.hasMore).toBe(true);

    const third = await listActiveDeadLetters({ cursor: second.nextCursor ?? null, env, limit: 2 });
    expect(third.items.map((item) => item.id)).toEqual(["dlq-a"]);
    expect(third.hasMore).toBe(false);
    expect(third.nextCursor).toBeNull();

    const walked = [...first.items, ...second.items, ...third.items].map((item) => item.id);
    expect(new Set(walked).size).toBe(ids.length);
    expect([...walked].sort()).toEqual([...ids].sort());
  });

  it("breaks created_at ties deterministically by id without skipping rows", async () => {
    for (const id of ["dlq-tie-b", "dlq-tie-a", "dlq-tie-c"]) {
      seedDeadLetter(database, id, NOW_ISO);
    }
    const first = await listActiveDeadLetters({ env, limit: 2 });
    expect(first.items.map((item) => item.id)).toEqual(["dlq-tie-c", "dlq-tie-b"]);
    const second = await listActiveDeadLetters({ cursor: first.nextCursor ?? null, env, limit: 2 });
    expect(second.items.map((item) => item.id)).toEqual(["dlq-tie-a"]);
    expect(second.hasMore).toBe(false);
  });

  it("keeps backward compatibility when no cursor is supplied", async () => {
    for (let index = 0; index < 3; index += 1) {
      seedDeadLetter(database, `dlq-compat-${String(index)}`, new Date(NOW.getTime() + index * 1_000).toISOString());
    }
    const legacy = await listActiveDeadLetters({ env });
    expect(legacy.limit).toBe(100);
    expect(legacy.items).toHaveLength(3);
    expect(legacy.hasMore).toBe(false);
    expect(legacy.items.map((item) => item.id)).toEqual(["dlq-compat-2", "dlq-compat-1", "dlq-compat-0"]);
  });

  it("rejects malformed cursors and oversized limits fail-closed", async () => {
    await expect(listActiveDeadLetters({ cursor: "not-a-cursor", env }))
      .rejects.toMatchObject({ code: "validation_failed", issues: ["cursor_invalid"] });
    await expect(listActiveDeadLetters({
      cursor: encodeCreatedIdCursor({ createdAt: "not-a-date", id: "dlq-a" }),
      env,
    })).rejects.toMatchObject({ code: "validation_failed", issues: ["cursor_invalid"] });
    await expect(listActiveDeadLetters({ env, limit: 101 }))
      .rejects.toMatchObject({ code: "operations_validation_failed", issues: ["limit_invalid"] });
  });

  it("pages active incidents with the same cursor contract", async () => {
    ["inc-a", "inc-b", "inc-c"].forEach((id, index) => {
      seedIncident(
        database,
        id,
        new Date(NOW.getTime() + index * 60_000).toISOString(),
      );
    });
    const first = await listActiveIncidents({ env, limit: 2 });
    expect(first.items.map((item) => item.id)).toEqual(["inc-c", "inc-b"]);
    expect(first.hasMore).toBe(true);
    const second = await listActiveIncidents({ cursor: first.nextCursor ?? null, env, limit: 2 });
    expect(second.items.map((item) => item.id)).toEqual(["inc-a"]);
    expect(second.hasMore).toBe(false);
    expect(second.nextCursor).toBeNull();
  });

  it("walks active deletion requests page by page with no duplicates or gaps", async () => {
    seedPlatformAdmin(database);
    const ids = ["del-a", "del-b", "del-c", "del-d", "del-e"] as const;
    ids.forEach((id, index) => {
      seedShop(database, id);
      seedDeletionRequest(database, id, id, new Date(NOW.getTime() + index * 60_000).toISOString());
    });

    const first = await listActiveDeletionRequests({ env, limit: 2, userId: "admin-ops" });
    expect(first.canOperate).toBe(true);
    expect(first.requests.map((request) => request.deletionRequestId)).toEqual(["del-e", "del-d"]);
    expect(first.hasMore).toBe(true);
    expect(first.nextCursor).not.toBeNull();

    const second = await listActiveDeletionRequests({ cursor: first.nextCursor ?? null, env, limit: 2, userId: "admin-ops" });
    expect(second.requests.map((request) => request.deletionRequestId)).toEqual(["del-c", "del-b"]);
    expect(second.hasMore).toBe(true);

    const third = await listActiveDeletionRequests({ cursor: second.nextCursor ?? null, env, limit: 2, userId: "admin-ops" });
    expect(third.requests.map((request) => request.deletionRequestId)).toEqual(["del-a"]);
    expect(third.hasMore).toBe(false);
    expect(third.nextCursor).toBeNull();

    const walked = [...first.requests, ...second.requests, ...third.requests]
      .map((request) => request.deletionRequestId);
    expect(new Set(walked).size).toBe(ids.length);
    expect([...walked].sort()).toEqual([...ids].sort());
  });

  it("reports hasMore=false exactly when `limit` rows remain on deletion listings", async () => {
    seedPlatformAdmin(database);
    for (const id of ["del-b1", "del-b2", "del-b3", "del-b4"]) {
      seedShop(database, id);
      seedDeletionRequest(database, id, id, new Date(NOW.getTime() + 60_000).toISOString());
    }
    const first = await listActiveDeletionRequests({ env, limit: 2, userId: "admin-ops" });
    expect(first.hasMore).toBe(true);
    expect(first.nextCursor).not.toBeNull();
    // Exactly `limit` rows remain: the final page must be full yet terminal.
    const second = await listActiveDeletionRequests({ cursor: first.nextCursor ?? null, env, limit: 2, userId: "admin-ops" });
    expect(second.requests).toHaveLength(2);
    expect(second.hasMore).toBe(false);
    expect(second.nextCursor).toBeNull();
  });

  it("walks payment remediation requests page by page with no duplicates or gaps", async () => {
    seedPlatformAdmin(database);
    seedShop(database, "rem");
    seedOrder(database, "rem");
    seedPaymentChain(database, "rem", 801001);
    const ids = ["prem-a", "prem-b", "prem-c", "prem-d", "prem-e"] as const;
    ids.forEach((id, index) => {
      seedRemediationRequest(database, id, "rem", new Date(NOW.getTime() + index * 60_000).toISOString());
    });

    const first = await listAdminPaymentRemediationRequests({ env, limit: 2, userId: "admin-ops" });
    expect(first.map((request) => request.requestPublicId)).toEqual(["prem-e", "prem-d"]);

    const secondCursor = encodeCreatedIdCursor(lastRow(first));
    const second = await listAdminPaymentRemediationRequests({ cursor: secondCursor, env, limit: 2, userId: "admin-ops" });
    expect(second.map((request) => request.requestPublicId)).toEqual(["prem-c", "prem-b"]);

    const thirdCursor = encodeCreatedIdCursor(lastRow(second));
    const third = await listAdminPaymentRemediationRequests({ cursor: thirdCursor, env, limit: 2, userId: "admin-ops" });
    expect(third.map((request) => request.requestPublicId)).toEqual(["prem-a"]);

    const walked = [...first, ...second, ...third].map((request) => request.requestPublicId);
    expect(new Set(walked).size).toBe(ids.length);
    expect([...walked].sort()).toEqual([...ids].sort());
  });

  it("stops exactly at the boundary when precisely `limit` remediation rows remain", async () => {
    seedPlatformAdmin(database);
    seedShop(database, "rem-edge");
    seedOrder(database, "rem-edge");
    seedPaymentChain(database, "rem-edge", 801002);
    for (const id of ["prem-edge-1", "prem-edge-2"]) {
      seedRemediationRequest(database, id, "rem-edge", new Date(NOW.getTime() + 60_000).toISOString());
    }
    const first = await listAdminPaymentRemediationRequests({ env, limit: 2, userId: "admin-ops" });
    expect(first).toHaveLength(2);
    const probe = await listAdminPaymentRemediationRequests({
      cursor: encodeCreatedIdCursor(lastRow(first)),
      env,
      limit: 1,
      userId: "admin-ops",
    });
    expect(probe).toHaveLength(0);
  });

  it("normalizes cursor timestamps to the stored ISO shape before comparison", async () => {
    for (const id of ["dlq-norm-a", "dlq-norm-b"]) {
      seedDeadLetter(database, id, NOW_ISO);
    }
    seedDeadLetter(database, "dlq-norm-late", new Date(NOW.getTime() + 2 * 60_000).toISOString());
    // Same instant expressed with an explicit offset instead of the stored `Z` shape.
    const offsetCursor = encodeCreatedIdCursor({ createdAt: "2026-08-17T02:01:00.000+00:00", id: "dlq-norm-late" });
    const parsed = parseCreatedIdCursor(offsetCursor);
    expect(parsed).toEqual({ createdAt: "2026-08-17T02:01:00.000Z", id: "dlq-norm-late" });
    const page = await listActiveDeadLetters({ cursor: offsetCursor, env, limit: 10 });
    expect(page.items.map((item) => item.id)).toEqual(["dlq-norm-b", "dlq-norm-a"]);
  });
});
