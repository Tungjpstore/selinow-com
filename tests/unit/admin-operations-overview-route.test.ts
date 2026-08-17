import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { join } from "node:path";

import { beforeEach, describe, expect, it, vi } from "vitest";

const dependencies = vi.hoisted(() => ({
  authenticate: vi.fn(),
  env: {} as unknown as AppBindings,
}));

vi.mock("../../src/lib/auth/session", () => ({
  authenticateRequest: dependencies.authenticate,
}));

vi.mock("../../src/lib/platform/bindings", () => ({
  getBindings: () => dependencies.env,
}));

import type { AppBindings } from "../../src/lib/platform/bindings";
import { GET } from "../../src/pages/api/admin/operations/overview/index";

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

function seed(database: DatabaseSync): void {
  database.exec(`
    INSERT INTO platform_users (id, email_normalized, display_name, status, created_at, updated_at) VALUES
      ('admin-enrolled', 'enrolled@example.test', 'Enrolled Admin', 'active', '${NOW_ISO}', '${NOW_ISO}'),
      ('admin-unenrolled', 'unenrolled@example.test', 'Unenrolled Admin', 'active', '${NOW_ISO}', '${NOW_ISO}'),
      ('ordinary-user', 'ordinary@example.test', 'Ordinary User', 'active', '${NOW_ISO}', '${NOW_ISO}');
    UPDATE platform_users SET two_factor_enabled = 1, two_factor_enabled_at = '${NOW_ISO}'
    WHERE id = 'admin-enrolled';
    INSERT INTO platform_admins (user_id, role, status, created_at, updated_at) VALUES
      ('admin-enrolled', 'owner', 'active', '${NOW_ISO}', '${NOW_ISO}'),
      ('admin-unenrolled', 'risk', 'active', '${NOW_ISO}', '${NOW_ISO}');
    INSERT INTO shops (id, public_id, slug, name, status, default_locale, currency, timezone, readiness_version, created_at, updated_at) VALUES
      ('shop-overview-a', 'shop_public_overview_a', 'overview-a', 'Overview A', 'active', 'en', 'USD', 'UTC', 1, '${NOW_ISO}', '${NOW_ISO}'),
      ('shop-overview-b', 'shop_public_overview_b', 'overview-b', 'Overview B', 'active', 'en', 'USD', 'UTC', 1, '${NOW_ISO}', '${NOW_ISO}');
    INSERT INTO plans (id, code, name, feature_flags_json, limits_json, created_at, updated_at)
    VALUES ('plan-overview', 'business', 'Business', '{}', '{}', '${NOW_ISO}', '${NOW_ISO}');
    INSERT INTO shop_subscriptions (id, shop_id, plan_id, state, current_period_end, created_at, updated_at) VALUES
      ('sub-overview-a', 'shop-overview-a', 'plan-overview', 'active', '2099-01-01T00:00:00.000Z', '${NOW_ISO}', '${NOW_ISO}'),
      ('sub-overview-b', 'shop-overview-b', 'plan-overview', 'past_due', '2099-01-01T00:00:00.000Z', '${NOW_ISO}', '${NOW_ISO}');
  `);
  const deadLetter = (id: string, status: string, offsetSeconds: number) => database.prepare(`
    INSERT INTO queue_dead_letters (
      id, shop_id, scope_key, queue_name, message_id, message_kind,
      reference_type, reference_id, failure_code, safe_envelope_json,
      status, provider_attempts, occurrence_count, first_seen_at,
      last_seen_at, retry_count, version, created_at, updated_at
    ) VALUES (?, NULL, 'platform', 'integration-staging', ?, 'integration',
      'none', NULL, 'queue_retries_exhausted', '{}', ?, 1, 1, ?, ?, 0, 1, ?, ?)
  `).run(
    id,
    `message-${id}`,
    status,
    NOW_ISO,
    NOW_ISO,
    new Date(NOW.getTime() + offsetSeconds * 1_000).toISOString(),
    NOW_ISO,
  );
  deadLetter("dlq-overview-open-a", "open", 1);
  deadLetter("dlq-overview-open-b", "open", 2);
  deadLetter("dlq-overview-retry", "open", 3);
  deadLetter("dlq-overview-resolved", "open", 4);
  database.exec(`
    UPDATE queue_dead_letters
    SET status = 'retry_requested', retry_requested_at = '${NOW_ISO}'
    WHERE id = 'dlq-overview-retry';
    UPDATE queue_dead_letters
    SET status = 'resolved', resolved_at = '${NOW_ISO}'
    WHERE id = 'dlq-overview-resolved';
  `);
  database.exec(`
    INSERT INTO operations_incidents (
      id, shop_id, scope_key, incident_key, category, severity, status,
      source_kind, source_ref, safe_context_json, occurrence_count,
      first_seen_at, last_seen_at, version, created_at, updated_at
    ) VALUES
      ('inc-overview-open', NULL, 'platform', 'overview-open', 'system_health', 'low', 'open',
        'system', 'overview-open', '{}', 1, '${NOW_ISO}', '${NOW_ISO}', 1, '${NOW_ISO}', '${NOW_ISO}'),
      ('inc-overview-ack', NULL, 'platform', 'overview-ack', 'system_health', 'low', 'open',
        'system', 'overview-ack', '{}', 1, '${NOW_ISO}', '${NOW_ISO}', 1, '${NOW_ISO}', '${NOW_ISO}'),
      ('inc-overview-resolved', NULL, 'platform', 'overview-resolved', 'system_health', 'low', 'open',
        'system', 'overview-resolved', '{}', 1, '${NOW_ISO}', '${NOW_ISO}', 1, '${NOW_ISO}', '${NOW_ISO}');
    UPDATE operations_incidents SET status = 'acknowledged', acknowledged_at = '${NOW_ISO}'
    WHERE id = 'inc-overview-ack';
    UPDATE operations_incidents SET status = 'resolved', resolved_at = '${NOW_ISO}'
    WHERE id = 'inc-overview-resolved';
  `);
}

function context(userId: string) {
  dependencies.authenticate.mockReset();
  dependencies.authenticate.mockResolvedValue({ userId });
  return {
    locals: { requestId: "request-overview-route" },
    request: new Request("https://app.test/api/admin/operations/overview"),
  } as never;
}

describe("admin operations overview endpoint", () => {
  let database: DatabaseSync;

  beforeEach(() => {
    database = new DatabaseSync(":memory:");
    applyMigrations(database);
    seed(database);
    dependencies.env = bindings(database);
  });

  it("returns bounded platform counts for an enrolled admin with no-store caching", async () => {
    const response = await GET(context("admin-enrolled"));
    expect(response).toBeInstanceOf(Response);
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    await expect(response.json()).resolves.toEqual({
      deadLetters: { open: 2, retryRequested: 1 },
      deliveryJobs: { deadLetter: 0, failed: 0 },
      incidents: { acknowledged: 1, open: 1 },
      ok: true,
      paymentExceptions: { open: 0 },
      providerHealth: { payosActive: 0, telegramActive: 0, telegramRecentlyChecked: 0 },
      remediationRequests: { providerPending: 0, requested: 0 },
      requestId: "request-overview-route",
      subscriptions: { byState: { active: 1, past_due: 1 } },
    });
  });

  it("surfaces admin_two_factor_required for admins without confirmed 2FA", async () => {
    const response = await GET(context("admin-unenrolled"));
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      code: "admin_two_factor_required",
      requestId: "request-overview-route",
    });
  });

  it("denies non-admin users with authorization_denied", async () => {
    const response = await GET(context("ordinary-user"));
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      code: "authorization_denied",
      requestId: "request-overview-route",
    });
  });
});
