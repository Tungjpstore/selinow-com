import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { createHash } from "node:crypto";

import { afterEach, describe, expect, it } from "vitest";

import {
  cancelAutomationTask,
  createAutomationTask,
  getAutomationTask,
  listAutomationTasks,
  resumeAutomationTask,
} from "../../src/lib/automation/api-service";
import { hmacToken } from "../../src/lib/core/crypto";
import type { AppBindings } from "../../src/lib/platform/bindings";

class SqliteStatement {
  private values: SQLInputValue[] = [];

  constructor(private readonly database: DatabaseSync, private readonly sql: string) {}

  bind(...values: unknown[]): this {
    this.values = values as SQLInputValue[];
    return this;
  }

  includesSql(fragment: string): boolean {
    return this.sql.includes(fragment);
  }

  first<T>(): Promise<T | null> {
    return Promise.resolve((this.database.prepare(this.sql).get(...this.values) as T | undefined) ?? null);
  }

  all(): Promise<{ results: Record<string, SQLInputValue>[] }> {
    return Promise.resolve({ results: this.database.prepare(this.sql).all(...this.values) });
  }

  runSync(): { meta: { changes: number } } {
    const result = this.database.prepare(this.sql).run(...this.values);
    return { meta: { changes: Number(result.changes) } };
  }

  run(): Promise<{ meta: { changes: number } }> {
    return Promise.resolve(this.runSync());
  }
}

type SqliteBatchResult = Array<{ meta: { changes: number } }>;
type SqliteBatchInterceptor = (input: {
  execute: () => Promise<SqliteBatchResult>;
  statements: readonly SqliteStatement[];
}) => Promise<SqliteBatchResult>;

class SqliteD1 {
  constructor(
    readonly database: DatabaseSync,
    private readonly interceptBatch?: SqliteBatchInterceptor,
  ) {}

  prepare(sql: string): SqliteStatement {
    return new SqliteStatement(this.database, sql);
  }

  batch(statements: SqliteStatement[]): Promise<SqliteBatchResult> {
    const execute = (): Promise<SqliteBatchResult> => {
      this.database.exec("BEGIN IMMEDIATE");
      try {
        const results = statements.map((statement) => statement.runSync());
        this.database.exec("COMMIT");
        return Promise.resolve(results);
      } catch (error) {
        this.database.exec("ROLLBACK");
        return Promise.reject(error instanceof Error ? error : new Error("sqlite_batch_failed"));
      }
    };
    return this.interceptBatch === undefined
      ? execute()
      : this.interceptBatch({ execute, statements });
  }
}

const databases: DatabaseSync[] = [];
const NOW = "2026-07-26T00:00:00.000Z";
const BEFORE_GRACE = "2026-07-25T23:59:00.000Z";
const LATER = "2026-07-26T00:05:00.000Z";
const OLD = "2026-06-25T00:00:00.000Z";
const FUTURE = "2026-07-26T00:06:00.000Z";

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

function createDatabase(interceptBatch?: SqliteBatchInterceptor): SqliteD1 {
  const database = new DatabaseSync(":memory:");
  databases.push(database);
  database.exec("PRAGMA foreign_keys = ON");
  for (const filename of readdirSync(join(process.cwd(), "migrations"))
    .filter((name) => /^\d{4}_.+\.sql$/u.test(name))
    .sort()) {
    database.exec(readFileSync(join(process.cwd(), "migrations", filename), "utf8"));
  }
  database.exec(`
    INSERT INTO plans (id, code, name, feature_flags_json, limits_json, created_at, updated_at)
      VALUES ('plan_automation', 'business', 'Business',
        '{"storefront":true,"telegram":true,"customDomain":true}', '{}', '${NOW}', '${NOW}');
    INSERT INTO platform_users (id, email_normalized, display_name, status, created_at, updated_at)
      VALUES ('usr_automation_a', 'automation-a@example.com', 'Automation A', 'active', '${NOW}', '${NOW}');
    INSERT INTO platform_users (id, email_normalized, display_name, status, created_at, updated_at)
      VALUES ('usr_automation_b', 'automation-b@example.com', 'Automation B', 'active', '${NOW}', '${NOW}');
    INSERT INTO platform_users (id, email_normalized, display_name, status, created_at, updated_at) VALUES
      ('usr_automation_manager', 'automation-manager@example.com', 'Automation Manager', 'active', '${NOW}', '${NOW}'),
      ('usr_automation_support', 'automation-support@example.com', 'Automation Support', 'active', '${NOW}', '${NOW}'),
      ('usr_automation_viewer', 'automation-viewer@example.com', 'Automation Viewer', 'active', '${NOW}', '${NOW}');
    INSERT INTO shops (
      id, public_id, slug, name, status, default_locale, currency, timezone,
      readiness_version, created_at, updated_at
    ) VALUES
      ('shp_automation_a', 'shop_automation_a', 'automation-a', 'Automation A',
        'draft', 'vi', 'VND', 'Asia/Ho_Chi_Minh', 1, '${NOW}', '${NOW}'),
      ('shp_automation_b', 'shop_automation_b', 'automation-b', 'Automation B',
        'draft', 'vi', 'VND', 'Asia/Ho_Chi_Minh', 1, '${NOW}', '${NOW}');
    INSERT INTO shop_members (shop_id, user_id, role, status, created_at, updated_at) VALUES
      ('shp_automation_a', 'usr_automation_a', 'owner', 'active', '${NOW}', '${NOW}'),
      ('shp_automation_b', 'usr_automation_b', 'owner', 'active', '${NOW}', '${NOW}'),
      ('shp_automation_a', 'usr_automation_manager', 'manager', 'active', '${NOW}', '${NOW}'),
      ('shp_automation_a', 'usr_automation_support', 'support', 'active', '${NOW}', '${NOW}'),
      ('shp_automation_a', 'usr_automation_viewer', 'viewer', 'active', '${NOW}', '${NOW}');
    INSERT INTO shop_subscriptions (id, shop_id, plan_id, state, current_period_end, created_at, updated_at) VALUES
      ('sub_automation_a', 'shp_automation_a', 'plan_automation', 'active', '2099-01-01T00:00:00.000Z', '${NOW}', '${NOW}'),
      ('sub_automation_b', 'shp_automation_b', 'plan_automation', 'active', '2099-01-01T00:00:00.000Z', '${NOW}', '${NOW}');
  `);
  return new SqliteD1(database, interceptBatch);
}

function env(database: SqliteD1): AppBindings {
  return {
    APP_ENV: "local",
    IDENTIFIER_HMAC_SECRET: "automation-identifier-secret",
    PLATFORM_DB: database as unknown as D1Database,
    SESSION_SECRET: "automation-session-secret",
  } as AppBindings;
}

function sha256JsonHex(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function insertTask(
  database: SqliteD1,
  input: {
    capabilityCode: string;
    id: string;
    inputReference: string;
    shopId?: string;
    status?: "waiting_user" | "waiting_provider" | "pending";
    version?: number;
  },
): void {
  const shopId = input.shopId ?? "shp_automation_a";
  const idempotencyHash = createHash("sha256").update(`idempotency:${input.id}`).digest("hex");
  const requestHash = createHash("sha256").update(`request:${input.id}`).digest("hex");
  database.database.prepare(`
    INSERT INTO automation_tasks (
      id, shop_id, capability_code, status, idempotency_key_hash, request_hash,
      input_reference, attempt_count, next_attempt_at, lease_token, lease_expires_at,
      last_safe_error_code, audit_log_id, consent_evidence_reference, action_reference,
      version, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 0, NULL, NULL, NULL, NULL, NULL, NULL, NULL, ?, ?, ?)
  `).run(
    input.id,
    shopId,
    input.capabilityCode,
    input.status ?? "waiting_user",
    idempotencyHash,
    requestHash,
    input.inputReference,
    input.version ?? 1,
    NOW,
    NOW,
  );
}

function insertTelegramIntegration(
  database: SqliteD1,
  timestamp: string,
  input: {
    createdByUserId?: string;
    credentialId?: string;
    integrationId?: string;
    shopId?: string;
    suffix?: string;
  } = {},
): void {
  const suffix = input.suffix ?? "a";
  const shopId = input.shopId ?? "shp_automation_a";
  // Generic channel IDs have an 8-character minimum; keep legacy references
  // stable while using IDs that satisfy the projected connection schema.
  const integrationId = input.integrationId ?? "tgint_a0";
  const credentialId = input.credentialId ?? "tgcred_a";
  const createdByUserId = input.createdByUserId ?? "usr_automation_a";
  database.database.prepare(`
    INSERT INTO telegram_integrations (
      id, public_id, webhook_public_id, shop_id, status, webhook_status,
      active_credential_id, bot_id, last_checked_at, last_health_update_at,
      created_at, updated_at
    ) VALUES (?, ?, ?, ?, 'active', 'verified', ?, ?, ?, ?, ?, ?)
  `).run(
    integrationId,
    `tg_public_${suffix}`,
    `tg_webhook_${suffix}`,
    shopId,
    credentialId,
    `bot_${suffix}`,
    timestamp,
    timestamp,
    timestamp,
    timestamp,
  );
  database.database.prepare(`
    INSERT INTO telegram_credentials (
      id, shop_id, integration_id, status, version, key_version,
      bot_token_ciphertext_b64, bot_token_iv_b64, webhook_secret_ciphertext_b64,
      webhook_secret_iv_b64, token_fingerprint, webhook_secret_digest,
      activated_at, created_by_user_id, created_at
    ) VALUES (?, ?, ?, 'active', 1, 'v1', ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    credentialId,
    shopId,
    integrationId,
    `ciphertext-telegram-${suffix}`,
    `iv-telegram-${suffix}`,
    `ciphertext-secret-${suffix}`,
    `iv-secret-${suffix}`,
    `fingerprint-telegram-${suffix}`,
    `digest-telegram-${suffix}`,
    timestamp,
    createdByUserId,
    timestamp,
  );
}

function insertPaymentIntegration(
  database: SqliteD1,
  timestamp: string,
  input: {
    createdByUserId?: string;
    credentialId?: string;
    integrationId?: string;
    shopId?: string;
    suffix?: string;
  } = {},
): void {
  const suffix = input.suffix ?? "a";
  const shopId = input.shopId ?? "shp_automation_a";
  const integrationId = input.integrationId ?? "payint_a";
  const credentialId = input.credentialId ?? "paycred_a";
  const createdByUserId = input.createdByUserId ?? "usr_automation_a";
  database.database.prepare(`
    INSERT INTO payment_integrations (
      id, public_id, webhook_public_id, shop_id, provider, status, webhook_status,
      active_credential_id, connected_at, created_at, updated_at,
      last_checked_at, last_webhook_verified_at, provider_identity_fingerprint
    ) VALUES (?, ?, ?, ?, 'payos', 'active', 'verified', NULL, ?, ?, ?, ?, ?, ?)
  `).run(
    integrationId,
    `pay_public_${suffix}`,
    `pay_webhook_${suffix}`,
    shopId,
    timestamp,
    timestamp,
    timestamp,
    timestamp,
    timestamp,
    `provider-owner-${suffix}`,
  );
  database.database.prepare(`
    INSERT INTO payment_credentials (
      id, shop_id, integration_id, provider, status, version, key_version,
      client_id_ciphertext_b64, client_id_iv_b64, api_key_ciphertext_b64, api_key_iv_b64,
      checksum_key_ciphertext_b64, checksum_key_iv_b64, credential_fingerprint,
      provider_ownership_fingerprint, activated_at, created_by_user_id, created_at
    ) VALUES (?, ?, ?, 'payos', 'active', 1, 'v1', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    credentialId,
    shopId,
    integrationId,
    `client-ciphertext-${suffix}`,
    `client-iv-${suffix}-1234`,
    `api-ciphertext-${suffix}`,
    `api-iv-${suffix}-1234`,
    `checksum-ciphertext-${suffix}`,
    `checksum-iv-${suffix}-1234`,
    `credential-fingerprint-${suffix}`,
    `provider-ownership-${suffix}`,
    timestamp,
    createdByUserId,
    timestamp,
  );
  database.database.prepare("UPDATE payment_integrations SET active_credential_id = ? WHERE id = ? AND shop_id = ?")
    .run(credentialId, integrationId, shopId);
}

function insertDomain(
  database: SqliteD1,
  timestamp: string,
  input: { domainId?: string; hostname?: string; shopId?: string; suffix?: string } = {},
): void {
  const suffix = input.suffix ?? "a";
  const shopId = input.shopId ?? "shp_automation_a";
  const domainId = input.domainId ?? "dom_a";
  const hostname = input.hostname ?? `shop-${suffix}.example.com`;
  const validationMetadataJson = JSON.stringify({
    turnstile: {
      checkedAt: new Date().toISOString(),
      hostname,
      mode: "operator_managed",
      source: "cloudflare_widget_domains",
      status: "active",
    },
  });
  database.database.prepare(`
    INSERT INTO shop_domains (
      id, shop_id, hostname_normalized, type, status, is_primary,
      cloudflare_hostname_id, hostname_status, ssl_status, validation_metadata_json,
      last_checked_at, activated_at, created_at, updated_at, dns_status,
      next_check_at, check_attempts, lease_token, lease_expires_at,
      last_safe_error_code, deleted_at, delete_requested_at, version, ownership_verified_at
    ) VALUES (?, ?, ?, 'custom', 'active', 0, ?, 'active', 'active', ?, ?, ?, ?, ?,
      'active', NULL, 0, NULL, NULL, NULL, NULL, NULL, 1, ?)
  `).run(
    domainId,
    shopId,
    hostname,
    `cf-host-${suffix}`,
    validationMetadataJson,
    timestamp,
    timestamp,
    timestamp,
    timestamp,
    timestamp,
  );
}

function taskView(task: { task: { [key: string]: unknown } }): { [key: string]: unknown } {
  return task.task;
}

describe("tenant-facing automation service", () => {
  it("creates only the two generic seller capabilities, hashes task inputs and audits replay", async () => {
    const database = createDatabase();
    const bindings = env(database);
    const created = await createAutomationTask({
      capabilityCode: "shop.provision",
      env: bindings,
      idempotencyKey: "automation-create-0001",
      requestId: "request-automation-create",
      runtime: { now: () => new Date(NOW) },
      shopPublicId: "shop_automation_a",
      userId: "usr_automation_a",
    });
    expect(created.replayed).toBe(false);
    expect(created.task.status).toBe("succeeded");
    expect(created.task).not.toHaveProperty("inputReference");
    expect(created.task).not.toHaveProperty("leaseToken");
    const stored = database.database.prepare("SELECT input_reference, idempotency_key_hash, request_hash FROM automation_tasks").get() as {
      idempotency_key_hash: string;
      input_reference: string;
      request_hash: string;
    };
    expect(stored.input_reference).toBe("d1:shop/shp_automation_a");
    expect(stored.idempotency_key_hash).toMatch(/^[a-f0-9]{64}$/u);
    expect(stored.request_hash).toMatch(/^[a-f0-9]{64}$/u);
    expect(database.database.prepare("SELECT action FROM audit_logs WHERE resource_type = 'automation_task'").get()).toEqual({ action: "automation.task_created" });

    const replay = await createAutomationTask({
      capabilityCode: "shop.provision",
      env: bindings,
      idempotencyKey: "automation-create-0001",
      requestId: "request-automation-replay",
      runtime: { now: () => new Date(NOW) },
      shopPublicId: "shop_automation_a",
      userId: "usr_automation_a",
    });
    expect(replay.replayed).toBe(true);
    expect(replay.task).toEqual(created.task);

    await expect(createAutomationTask({
      capabilityCode: "domain.platform.provision",
      env: bindings,
      idempotencyKey: "automation-create-0001",
      requestId: "request-automation-cross-capability",
      runtime: { now: () => new Date(NOW) },
      shopPublicId: "shop_automation_a",
      userId: "usr_automation_a",
    })).rejects.toMatchObject({ code: "idempotency_conflict", status: 409 });
    expect(database.database.prepare(`
      SELECT COUNT(*) AS count
      FROM automation_tasks
      WHERE idempotency_key_hash = ?
    `).get(stored.idempotency_key_hash)).toEqual({ count: 1 });
    await expect(createAutomationTask({
      capabilityCode: "telegram.bot.create",
      env: bindings,
      idempotencyKey: "automation-context-0001",
      requestId: "request-automation-context",
      shopPublicId: "shop_automation_a",
      userId: "usr_automation_a",
    })).rejects.toMatchObject({ code: "automation_capability_context_required", status: 409 });
  });

  it("fails closed for BOLA and keeps list projections bounded to the tenant", async () => {
    const database = createDatabase();
    const bindings = env(database);
    database.database.prepare(`
      INSERT INTO shop_members (shop_id, user_id, role, status, created_at, updated_at)
      VALUES ('shp_automation_b', 'usr_automation_a', 'viewer', 'active', ?, ?)
    `).run(NOW, NOW);
    insertTask(database, { capabilityCode: "domain.custom.domain_connect", id: "aut_private_a", inputReference: "d1:domain/dom_a" });
    insertTask(database, {
      capabilityCode: "domain.custom.domain_connect",
      id: "aut_private_b",
      inputReference: "d1:domain/dom_b",
      shopId: "shp_automation_b",
    });
    await expect(getAutomationTask({
      env: bindings,
      shopPublicId: "shop_automation_a",
      taskId: "aut_private_a",
      userId: "usr_automation_b",
    })).rejects.toMatchObject({ code: "authorization_denied", status: 403 });
    await expect(getAutomationTask({
      env: bindings,
      shopPublicId: "shop_automation_a",
      taskId: "aut_private_b",
      userId: "usr_automation_a",
    })).rejects.toMatchObject({ code: "automation_task_not_found", status: 404 });
    await expect(getAutomationTask({
      env: bindings,
      shopPublicId: "shop_automation_b",
      taskId: "aut_private_a",
      userId: "usr_automation_a",
    })).rejects.toMatchObject({ code: "automation_task_not_found", status: 404 });
    const listedA = await listAutomationTasks({
      env: bindings,
      limit: 100,
      runtime: { now: () => new Date(NOW) },
      shopPublicId: "shop_automation_a",
      userId: "usr_automation_a",
    });
    const listedB = await listAutomationTasks({
      env: bindings,
      limit: 100,
      runtime: { now: () => new Date(NOW) },
      shopPublicId: "shop_automation_b",
      userId: "usr_automation_a",
    });
    expect(listedA.tasks.map((task) => task.id)).toEqual(["aut_private_a"]);
    expect(listedB.tasks.map((task) => task.id)).toEqual(["aut_private_b"]);
    expect(listedA.tasks[0]).not.toHaveProperty("requestHash");
    expect(listedA.tasks[0]).not.toHaveProperty("actionReference");
  });

  it.each([
    { mutationAllowed: true, role: "owner", userId: "usr_automation_a" },
    { mutationAllowed: true, role: "manager", userId: "usr_automation_manager" },
    { mutationAllowed: false, role: "support", userId: "usr_automation_support" },
    { mutationAllowed: false, role: "viewer", userId: "usr_automation_viewer" },
  ])("enforces automation read and mutation permissions for $role", async ({ mutationAllowed, role, userId }) => {
    const database = createDatabase();
    const bindings = env(database);
    const taskId = `aut_role_${role}`;
    insertTask(database, {
      capabilityCode: "shop.provision",
      id: taskId,
      inputReference: "d1:shop/shp_automation_a",
    });

    const read = await listAutomationTasks({
      env: bindings,
      runtime: { now: () => new Date(NOW) },
      shopPublicId: "shop_automation_a",
      userId,
    });
    expect(read.tasks).toHaveLength(1);

    const mutation = cancelAutomationTask({
      env: bindings,
      expectedVersion: 1,
      idempotencyKey: `automation-role-${role}`,
      reasonCode: "role_matrix",
      requestId: `request-automation-role-${role}`,
      runtime: { now: () => new Date(NOW) },
      shopPublicId: "shop_automation_a",
      taskId,
      userId,
    });

    if (mutationAllowed) {
      await expect(mutation).resolves.toMatchObject({ replayed: false, task: { status: "canceled" } });
    } else {
      await expect(mutation).rejects.toMatchObject({ code: "authorization_denied", status: 403 });
    }
  });

  it("keeps manager mutation rights capability-scoped", async () => {
    const database = createDatabase();
    const bindings = env(database);
    insertTask(database, {
      capabilityCode: "domain.custom.domain_connect",
      id: "aut_role_domain_manager",
      inputReference: "d1:domain/dom_manager",
    });
    insertTask(database, {
      capabilityCode: "domain.custom.domain_connect",
      id: "aut_role_domain_owner",
      inputReference: "d1:domain/dom_owner",
    });

    await expect(createAutomationTask({
      capabilityCode: "shop.provision",
      env: bindings,
      idempotencyKey: "automation-manager-shop",
      requestId: "request-automation-manager-shop",
      runtime: { now: () => new Date(NOW) },
      shopPublicId: "shop_automation_a",
      userId: "usr_automation_manager",
    })).resolves.toMatchObject({ task: { capabilityCode: "shop.provision" } });
    await expect(createAutomationTask({
      capabilityCode: "domain.platform.provision",
      env: bindings,
      idempotencyKey: "automation-manager-domain",
      requestId: "request-automation-manager-domain",
      runtime: { now: () => new Date(NOW) },
      shopPublicId: "shop_automation_a",
      userId: "usr_automation_manager",
    })).rejects.toMatchObject({ code: "authorization_denied", status: 403 });
    await expect(cancelAutomationTask({
      env: bindings,
      expectedVersion: 1,
      idempotencyKey: "automation-manager-domain-cancel",
      reasonCode: "role_matrix",
      requestId: "request-automation-manager-domain-cancel",
      runtime: { now: () => new Date(NOW) },
      shopPublicId: "shop_automation_a",
      taskId: "aut_role_domain_manager",
      userId: "usr_automation_manager",
    })).rejects.toMatchObject({ code: "authorization_denied", status: 403 });
    await expect(cancelAutomationTask({
      env: bindings,
      expectedVersion: 1,
      idempotencyKey: "automation-owner-domain-cancel",
      reasonCode: "role_matrix",
      requestId: "request-automation-owner-domain-cancel",
      runtime: { now: () => new Date(NOW) },
      shopPublicId: "shop_automation_a",
      taskId: "aut_role_domain_owner",
      userId: "usr_automation_a",
    })).resolves.toMatchObject({ task: { status: "canceled" } });
  });

  it("records server-only consent with an opaque hash and consumes it once", async () => {
    const database = createDatabase();
    const bindings = env(database);
    insertTask(database, { capabilityCode: "domain.custom.domain_connect", id: "aut_consent_a", inputReference: "d1:domain/dom_a" });
    const before = await getAutomationTask({
      env: bindings,
      runtime: { now: () => new Date(NOW) },
      shopPublicId: "shop_automation_a",
      taskId: "aut_consent_a",
      userId: "usr_automation_a",
    });
    expect(taskView(before).continuation).toEqual({ kind: "approval_granted" });
    expect(taskView(before)).not.toHaveProperty("evidenceToken");

    const resumed = await resumeAutomationTask({
      env: bindings,
      expectedVersion: 1,
      idempotencyKey: "automation-consent-0001",
      requestId: "request-automation-consent",
      runtime: { now: () => new Date(NOW) },
      shopPublicId: "shop_automation_a",
      taskId: "aut_consent_a",
      userId: "usr_automation_a",
    });
    expect(resumed.task.status).toBe("retryable");
    const challenge = database.database.prepare(`
      SELECT id, token_hash, status, kind, audit_log_id
      FROM automation_evidence_challenges
      WHERE task_id = 'aut_consent_a'
    `).get() as { id: string; token_hash: string; status: string; kind: string; audit_log_id: string };
    expect(challenge.token_hash).toMatch(/^[a-f0-9]{64}$/u);
    expect(challenge.status).toBe("consumed");
    expect(challenge.kind).toBe("approval_granted");
    expect(database.database.prepare("SELECT action, resource_type, resource_id FROM audit_logs WHERE id = ?").get(challenge.audit_log_id)).toEqual({
      action: "automation.evidence_consumed",
      resource_type: "automation_evidence",
      resource_id: challenge.id,
    });
    database.database.prepare(`
      UPDATE automation_tasks
      SET status = 'failed', next_attempt_at = NULL,
        last_safe_error_code = 'automation_test_advanced', version = 3, updated_at = ?
      WHERE id = 'aut_consent_a' AND version = 2
    `).run(LATER);
    const replay = await resumeAutomationTask({
      env: bindings,
      expectedVersion: 1,
      idempotencyKey: "automation-consent-0001",
      requestId: "request-automation-consent-replay",
      runtime: { now: () => new Date(NOW) },
      shopPublicId: "shop_automation_a",
      taskId: "aut_consent_a",
      userId: "usr_automation_a",
    });
    expect(replay.replayed).toBe(true);
    expect(replay.task).toEqual(resumed.task);
    expect(database.database.prepare("SELECT COUNT(*) AS count FROM automation_evidence_challenges WHERE task_id = 'aut_consent_a'").get()).toEqual({ count: 1 });
    await expect(resumeAutomationTask({
      env: bindings,
      evidenceToken: "client-supplied-token-should-fail",
      expectedVersion: 2,
      idempotencyKey: "automation-consent-0002",
      requestId: "request-automation-consent-client-token",
      shopPublicId: "shop_automation_a",
      taskId: "aut_consent_a",
      userId: "usr_automation_a",
    })).rejects.toMatchObject({ code: "automation_evidence_server_only", status: 400 });
  });

  it("rotates a consumed challenge when recovering before the immutable task event", async () => {
    const database = createDatabase();
    const bindings = env(database);
    const taskId = "aut_consent_recovery";
    const idempotencyKey = "automation-consent-recovery";
    const namespace = `automation.resume.v2:shp_automation_a:${taskId}`;
    const keyHash = await hmacToken(bindings.SESSION_SECRET, "automation-control-idempotency-v2", idempotencyKey);
    const requestHash = sha256JsonHex({ expectedVersion: 1, shopId: "shp_automation_a", taskId });
    insertTask(database, { capabilityCode: "domain.custom.domain_connect", id: taskId, inputReference: "d1:domain/dom_a" });
    database.database.prepare(`
      INSERT INTO idempotency_records (
        actor_user_id, namespace, key_hash, request_hash, response_json, created_at, expires_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      "usr_automation_a",
      namespace,
      keyHash,
      requestHash,
      JSON.stringify({
        auditId: "aud_consent_old",
        challengeId: "aech_consent_old",
        expectedVersion: 1,
        state: "processing",
        taskId,
      }),
      NOW,
      "2026-07-27T00:00:00.000Z",
    );
    database.database.prepare(`
      INSERT INTO automation_evidence_challenges (
        id, task_id, shop_id, actor_user_id, kind, token_hash, status,
        audit_log_id, expires_at, consumed_at, created_at, updated_at
      ) VALUES ('aech_consent_old', ?, 'shp_automation_a', 'usr_automation_a',
        'approval_granted', ?, 'issued', NULL, '2026-07-26T00:10:00.000Z', NULL, ?, ?)
    `).run(taskId, "c".repeat(64), BEFORE_GRACE, BEFORE_GRACE);
    database.database.prepare(`
      INSERT INTO audit_logs (
        id, shop_id, actor_type, actor_id, action, resource_type,
        resource_id, safe_metadata_json, request_id, created_at
      ) VALUES ('aud_consent_old', 'shp_automation_a', 'user', 'usr_automation_a',
        'automation.evidence_consumed', 'automation_evidence', 'aech_consent_old',
        '{}', 'request-old-consent', ?)
    `).run(BEFORE_GRACE);
    database.database.prepare(`
      UPDATE automation_evidence_challenges
      SET status = 'consumed', audit_log_id = 'aud_consent_old', consumed_at = ?, updated_at = ?
      WHERE id = 'aech_consent_old'
    `).run(BEFORE_GRACE, BEFORE_GRACE);

    const recovered = await resumeAutomationTask({
      env: bindings,
      expectedVersion: 1,
      idempotencyKey,
      requestId: "request-automation-consent-recovery",
      runtime: { now: () => new Date(NOW) },
      shopPublicId: "shop_automation_a",
      taskId,
      userId: "usr_automation_a",
    });
    expect(recovered.replayed).toBe(true);
    expect(recovered.task.status).toBe("retryable");
    expect(database.database.prepare("SELECT COUNT(*) AS count FROM automation_evidence_challenges WHERE task_id = ?").get(taskId)).toEqual({ count: 2 });
    const event = database.database.prepare("SELECT evidence_reference FROM automation_task_events WHERE task_id = ? AND task_version = 2").get(taskId) as { evidence_reference: string };
    expect(event.evidence_reference).toMatch(/^audit:automation-evidence\//u);
    expect(event.evidence_reference).not.toContain("aech_consent_old");
    const stored = database.database.prepare("SELECT response_json FROM idempotency_records WHERE actor_user_id = 'usr_automation_a' AND namespace = ? AND key_hash = ?").get(namespace, keyHash) as { response_json: string };
    expect(JSON.parse(stored.response_json)).toMatchObject({ state: "completed", task: { id: taskId } });
  });

  it("returns busy when a concurrent resume consumed the anchor before writing its event", async () => {
    const database = createDatabase();
    const bindings = env(database);
    const taskId = "aut_consent_consumed_busy";
    const idempotencyKey = "automation-consent-consumed-busy";
    const namespace = `automation.resume.v2:shp_automation_a:${taskId}`;
    const keyHash = await hmacToken(bindings.SESSION_SECRET, "automation-control-idempotency-v2", idempotencyKey);
    const requestHash = sha256JsonHex({ expectedVersion: 1, shopId: "shp_automation_a", taskId });
    insertTask(database, { capabilityCode: "domain.custom.domain_connect", id: taskId, inputReference: "d1:domain/dom_a" });
    database.database.prepare(`
      INSERT INTO idempotency_records (
        actor_user_id, namespace, key_hash, request_hash, response_json, created_at, expires_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      "usr_automation_a",
      namespace,
      keyHash,
      requestHash,
      JSON.stringify({
        auditId: "aud_consent_consumed_busy",
        challengeId: "aech_consent_consumed_busy",
        expectedVersion: 1,
        state: "processing",
        taskId,
      }),
      NOW,
      "2026-07-27T00:00:00.000Z",
    );
    database.database.prepare(`
      INSERT INTO automation_evidence_challenges (
        id, task_id, shop_id, actor_user_id, kind, token_hash, status,
        audit_log_id, expires_at, consumed_at, created_at, updated_at
      ) VALUES ('aech_consent_consumed_busy', ?, 'shp_automation_a', 'usr_automation_a',
        'approval_granted', ?, 'issued', NULL, '2026-07-26T00:10:00.000Z', NULL, ?, ?)
    `).run(taskId, "e".repeat(64), NOW, NOW);
    database.database.prepare(`
      INSERT INTO audit_logs (
        id, shop_id, actor_type, actor_id, action, resource_type,
        resource_id, safe_metadata_json, request_id, created_at
      ) VALUES ('aud_consent_consumed_busy', 'shp_automation_a', 'user', 'usr_automation_a',
        'automation.evidence_consumed', 'automation_evidence', 'aech_consent_consumed_busy',
        '{}', 'request-consent-consumed-busy', ?)
    `).run(NOW);
    database.database.prepare(`
      UPDATE automation_evidence_challenges
      SET status = 'consumed', audit_log_id = 'aud_consent_consumed_busy',
        consumed_at = ?, updated_at = ?
      WHERE id = 'aech_consent_consumed_busy'
    `).run(NOW, NOW);

    await expect(resumeAutomationTask({
      env: bindings,
      expectedVersion: 1,
      idempotencyKey,
      requestId: "request-automation-consumed-busy-retry",
      runtime: { now: () => new Date(NOW) },
      shopPublicId: "shop_automation_a",
      taskId,
      userId: "usr_automation_a",
    })).rejects.toMatchObject({ code: "automation_idempotency_busy", status: 409 });
    expect(database.database.prepare(`
      SELECT COUNT(*) AS total,
        SUM(CASE WHEN status = 'consumed' THEN 1 ELSE 0 END) AS consumed
      FROM automation_evidence_challenges
      WHERE task_id = ?
    `).get(taskId)).toEqual({ consumed: 1, total: 1 });
    expect(database.database.prepare("SELECT COUNT(*) AS count FROM automation_task_events WHERE task_id = ? AND task_version = 2").get(taskId)).toEqual({ count: 0 });
  });

  it("serializes two live resume calls when the replay caller consumes the anchor first", async () => {
    let releaseFirstEvidenceBatch: () => void = () => {};
    const firstEvidenceBatchReleased = new Promise<void>((resolve) => {
      releaseFirstEvidenceBatch = resolve;
    });
    let markFirstEvidenceBatchBlocked: () => void = () => {};
    const firstEvidenceBatchBlocked = new Promise<void>((resolve) => {
      markFirstEvidenceBatchBlocked = resolve;
    });
    let evidenceBatchCount = 0;
    let taskEventBatchCount = 0;
    const database = createDatabase(({ execute, statements }) => {
      const isEvidenceBatch = statements.some((statement) => statement.includesSql("INSERT INTO automation_evidence_challenges"));
      if (isEvidenceBatch) {
        evidenceBatchCount += 1;
        if (evidenceBatchCount === 1) {
          markFirstEvidenceBatchBlocked();
          return firstEvidenceBatchReleased.then(execute);
        }
      }
      const isTaskEventBatch = statements.some((statement) => statement.includesSql("INSERT INTO automation_task_events"));
      if (isTaskEventBatch) {
        taskEventBatchCount += 1;
        const result = execute();
        if (taskEventBatchCount === 2) releaseFirstEvidenceBatch();
        return result;
      }
      return execute();
    });
    const bindings = env(database);
    const taskId = "aut_consent_live_race";
    insertTask(database, { capabilityCode: "domain.custom.domain_connect", id: taskId, inputReference: "d1:domain/dom_a" });
    const resume = (requestId: string) => resumeAutomationTask({
      env: bindings,
      expectedVersion: 1,
      idempotencyKey: "automation-consent-live-race",
      requestId,
      runtime: { now: () => new Date(NOW) },
      shopPublicId: "shop_automation_a",
      taskId,
      userId: "usr_automation_a",
    });

    const ownerMutation = resume("request-automation-live-race-a");
    await firstEvidenceBatchBlocked;
    const releaseFallback = setTimeout(releaseFirstEvidenceBatch, 2_000);
    const settled = await Promise.allSettled([
      ownerMutation,
      resume("request-automation-live-race-b"),
    ]);
    const fulfilled = settled.filter((result) => result.status === "fulfilled");
    const rejected = settled.filter((result) => result.status === "rejected");
    expect(fulfilled).toHaveLength(2);
    expect(rejected).toHaveLength(0);
    const results = fulfilled.map((result) => result.value);
    clearTimeout(releaseFallback);
    expect(results.map((result) => result.replayed).sort()).toEqual([false, true]);
    expect(results[0]?.task).toEqual(results[1]?.task);
    expect(results[0]).toMatchObject({ task: { status: "retryable", version: 3 } });
    expect(database.database.prepare(`
      SELECT COUNT(*) AS total,
        SUM(CASE WHEN status = 'consumed' THEN 1 ELSE 0 END) AS consumed
      FROM automation_evidence_challenges
      WHERE task_id = ?
    `).get(taskId)).toEqual({ consumed: 1, total: 1 });
    expect(database.database.prepare("SELECT COUNT(*) AS count FROM automation_task_events WHERE task_id = ? AND task_version = 2").get(taskId)).toEqual({ count: 1 });
    expect(evidenceBatchCount).toBe(2);
    expect(taskEventBatchCount).toBe(2);
  });

  it("binds provider checks to exact tenant resources and freshness", async () => {
    const database = createDatabase();
    const bindings = env(database);
    insertTelegramIntegration(database, NOW);
    insertTask(database, {
      capabilityCode: "telegram.bot.create",
      id: "aut_provider_a",
      inputReference: "d1:telegram-integration/tgint_a0",
      status: "waiting_provider",
    });
    const resumed = await resumeAutomationTask({
      env: bindings,
      expectedVersion: 1,
      idempotencyKey: "automation-provider-0001",
      requestId: "request-automation-provider",
      runtime: { now: () => new Date(NOW) },
      shopPublicId: "shop_automation_a",
      taskId: "aut_provider_a",
      userId: "usr_automation_a",
    });
    expect(resumed.task.status).toBe("retryable");
    const event = database.database.prepare("SELECT evidence_reference FROM automation_task_events WHERE task_id = 'aut_provider_a' AND task_version = 2").get() as { evidence_reference: string };
    expect(event.evidence_reference).toMatch(/^audit:automation-evidence\//u);
    const audit = database.database.prepare("SELECT safe_metadata_json FROM audit_logs WHERE action = 'automation.evidence_consumed'").get() as { safe_metadata_json: string };
    expect(audit.safe_metadata_json).toContain("telegram-integration/tgint_a0");

    insertTask(database, {
      capabilityCode: "telegram.bot.create",
      id: "aut_provider_skew",
      inputReference: "d1:telegram-integration/tgint_a0",
      status: "waiting_provider",
    });
    database.database.prepare("UPDATE telegram_integrations SET last_health_update_at = ? WHERE id = 'tgint_a0'").run(LATER);
    await expect(resumeAutomationTask({
      env: bindings,
      expectedVersion: 1,
      idempotencyKey: "automation-provider-skew",
      requestId: "request-automation-provider-skew",
      runtime: { now: () => new Date(NOW) },
      shopPublicId: "shop_automation_a",
      taskId: "aut_provider_skew",
      userId: "usr_automation_a",
    })).resolves.toMatchObject({ task: { status: "retryable" } });

    insertTask(database, {
      capabilityCode: "telegram.bot.create",
      id: "aut_provider_stale",
      inputReference: "d1:telegram-integration/tgint_a0",
      status: "waiting_provider",
    });
    database.database.prepare("UPDATE telegram_integrations SET last_health_update_at = ? WHERE id = 'tgint_a0'").run(OLD);
    await expect(resumeAutomationTask({
      env: bindings,
      expectedVersion: 1,
      idempotencyKey: "automation-provider-stale",
      requestId: "request-automation-provider-stale",
      runtime: { now: () => new Date(NOW) },
      shopPublicId: "shop_automation_a",
      taskId: "aut_provider_stale",
      userId: "usr_automation_a",
    })).rejects.toMatchObject({ code: "automation_provider_evidence_pending", status: 409 });

    insertPaymentIntegration(database, NOW);
    insertTask(database, {
      capabilityCode: "payments.payos.channel_create",
      id: "aut_payment_a",
      inputReference: "d1:payment-integration/payint_a",
      status: "waiting_provider",
    });
    await expect(resumeAutomationTask({
      env: bindings,
      expectedVersion: 1,
      idempotencyKey: "automation-payment-0001",
      requestId: "request-automation-payment",
      runtime: { now: () => new Date(NOW) },
      shopPublicId: "shop_automation_a",
      taskId: "aut_payment_a",
      userId: "usr_automation_a",
    })).resolves.toMatchObject({ task: { status: "retryable" } });

    insertDomain(database, NOW);
    insertTask(database, {
      capabilityCode: "domain.custom.manual_dns",
      id: "aut_domain_a",
      inputReference: "d1:domain/dom_a",
      status: "waiting_provider",
    });
    await expect(resumeAutomationTask({
      env: bindings,
      expectedVersion: 1,
      idempotencyKey: "automation-domain-0001",
      requestId: "request-automation-domain",
      runtime: { now: () => new Date(NOW) },
      shopPublicId: "shop_automation_a",
      taskId: "aut_domain_a",
      userId: "usr_automation_a",
    })).resolves.toMatchObject({ task: { status: "retryable" } });

    database.database.prepare("UPDATE telegram_integrations SET last_health_update_at = ? WHERE id = 'tgint_a0'").run(FUTURE);
    await expect(resumeAutomationTask({
      env: bindings,
      expectedVersion: 1,
      idempotencyKey: "automation-provider-future",
      requestId: "request-automation-provider-future",
      runtime: { now: () => new Date(NOW) },
      shopPublicId: "shop_automation_a",
      taskId: "aut_provider_stale",
      userId: "usr_automation_a",
    })).rejects.toMatchObject({ code: "automation_provider_evidence_pending", status: 409 });
  });

  it.each([
    ["missing", "{}"],
    ["stale", JSON.stringify({ turnstile: { checkedAt: OLD, hostname: "shop-a.example.com", mode: "operator_managed", source: "cloudflare_widget_domains", status: "active" } })],
  ])("rejects %s Turnstile evidence for custom-domain automation", async (_case, validationMetadataJson) => {
    const database = createDatabase();
    insertDomain(database, NOW);
    database.database.exec("DROP TRIGGER shop_domains_turnstile_active_update_guard");
    database.database.prepare(`
      UPDATE shop_domains
      SET validation_metadata_json = ?
      WHERE id = 'dom_a' AND shop_id = 'shp_automation_a'
    `).run(validationMetadataJson);
    insertTask(database, {
      capabilityCode: "domain.custom.manual_dns",
      id: "aut_domain_unadmitted",
      inputReference: "d1:domain/dom_a",
      status: "waiting_provider",
    });

    await expect(resumeAutomationTask({
      env: env(database),
      expectedVersion: 1,
      idempotencyKey: "automation-domain-unadmitted",
      requestId: "request-automation-domain-unadmitted",
      runtime: { now: () => new Date(NOW) },
      shopPublicId: "shop_automation_a",
      taskId: "aut_domain_unadmitted",
      userId: "usr_automation_a",
    })).rejects.toMatchObject({ code: "automation_provider_evidence_pending", status: 409 });
  });

  it("does not rotate an active issued challenge while another resume is processing", async () => {
    const database = createDatabase();
    const bindings = env(database);
    const taskId = "aut_consent_busy";
    const idempotencyKey = "automation-consent-busy";
    const namespace = `automation.resume.v2:shp_automation_a:${taskId}`;
    const keyHash = await hmacToken(bindings.SESSION_SECRET, "automation-control-idempotency-v2", idempotencyKey);
    const requestHash = sha256JsonHex({ expectedVersion: 1, shopId: "shp_automation_a", taskId });
    insertTask(database, { capabilityCode: "domain.custom.domain_connect", id: taskId, inputReference: "d1:domain/dom_a" });
    database.database.prepare(`
      INSERT INTO idempotency_records (
        actor_user_id, namespace, key_hash, request_hash, response_json, created_at, expires_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      "usr_automation_a",
      namespace,
      keyHash,
      requestHash,
      JSON.stringify({
        auditId: "aud_consent_busy",
        challengeId: "aech_consent_busy",
        expectedVersion: 1,
        state: "processing",
        taskId,
      }),
      NOW,
      "2026-07-27T00:00:00.000Z",
    );
    database.database.prepare(`
      INSERT INTO automation_evidence_challenges (
        id, task_id, shop_id, actor_user_id, kind, token_hash, status,
        audit_log_id, expires_at, consumed_at, created_at, updated_at
      ) VALUES ('aech_consent_busy', ?, 'shp_automation_a', 'usr_automation_a',
        'approval_granted', ?, 'issued', NULL, '2026-07-26T00:10:00.000Z', NULL, ?, ?)
    `).run(taskId, "b".repeat(64), NOW, NOW);

    await expect(resumeAutomationTask({
      env: bindings,
      expectedVersion: 1,
      idempotencyKey,
      requestId: "request-automation-consent-busy",
      runtime: { now: () => new Date(NOW) },
      shopPublicId: "shop_automation_a",
      taskId,
      userId: "usr_automation_a",
    })).rejects.toMatchObject({ code: "automation_idempotency_busy", status: 409 });
    expect(database.database.prepare("SELECT status FROM automation_evidence_challenges WHERE id = 'aech_consent_busy'").get()).toEqual({ status: "issued" });
  });

  it("revokes an expired issued challenge before rotating the anchor", async () => {
    const database = createDatabase();
    const bindings = env(database);
    const taskId = "aut_consent_expired";
    const idempotencyKey = "automation-consent-expired";
    const namespace = `automation.resume.v2:shp_automation_a:${taskId}`;
    const keyHash = await hmacToken(bindings.SESSION_SECRET, "automation-control-idempotency-v2", idempotencyKey);
    const requestHash = sha256JsonHex({ expectedVersion: 1, shopId: "shp_automation_a", taskId });
    insertTask(database, { capabilityCode: "domain.custom.domain_connect", id: taskId, inputReference: "d1:domain/dom_a" });
    database.database.prepare(`
      INSERT INTO idempotency_records (
        actor_user_id, namespace, key_hash, request_hash, response_json, created_at, expires_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      "usr_automation_a",
      namespace,
      keyHash,
      requestHash,
      JSON.stringify({
        auditId: "aud_consent_expired",
        challengeId: "aech_consent_expired",
        expectedVersion: 1,
        state: "processing",
        taskId,
      }),
      NOW,
      "2026-07-27T00:00:00.000Z",
    );
    database.database.prepare(`
      INSERT INTO automation_evidence_challenges (
        id, task_id, shop_id, actor_user_id, kind, token_hash, status,
        audit_log_id, expires_at, consumed_at, created_at, updated_at
      ) VALUES ('aech_consent_expired', ?, 'shp_automation_a', 'usr_automation_a',
        'approval_granted', ?, 'issued', NULL, '2026-07-25T00:10:00.000Z', NULL, ?, ?)
    `).run(taskId, "d".repeat(64), NOW, NOW);

    const resumed = await resumeAutomationTask({
      env: bindings,
      expectedVersion: 1,
      idempotencyKey,
      requestId: "request-automation-consent-expired",
      runtime: { now: () => new Date(NOW) },
      shopPublicId: "shop_automation_a",
      taskId,
      userId: "usr_automation_a",
    });
    expect(resumed).toMatchObject({ replayed: true, task: { status: "retryable" } });
    expect(database.database.prepare("SELECT status FROM automation_evidence_challenges WHERE id = 'aech_consent_expired'").get()).toEqual({ status: "revoked" });
    expect(database.database.prepare("SELECT COUNT(*) AS count FROM automation_evidence_challenges WHERE task_id = ?").get(taskId)).toEqual({ count: 2 });
  });

  it("rejects cross-tenant provider references and enforces the 100-open-task quota", async () => {
    const database = createDatabase();
    const bindings = env(database);
    insertTelegramIntegration(database, NOW, {
      createdByUserId: "usr_automation_b",
      credentialId: "tgcred_b0",
      integrationId: "tgint_b0",
      shopId: "shp_automation_b",
      suffix: "b0",
    });
    insertTask(database, {
      capabilityCode: "telegram.bot.create",
      id: "aut_cross_tenant",
      inputReference: "d1:telegram-integration/tgint_b0",
      status: "waiting_provider",
    });
    await expect(resumeAutomationTask({
      env: bindings,
      expectedVersion: 1,
      idempotencyKey: "automation-cross-tenant",
      requestId: "request-automation-cross-tenant",
      runtime: { now: () => new Date(NOW) },
      shopPublicId: "shop_automation_a",
      taskId: "aut_cross_tenant",
      userId: "usr_automation_a",
    })).rejects.toMatchObject({ code: "automation_provider_evidence_pending", status: 409 });

    for (let index = 0; index < 99; index += 1) {
      const suffix = String(index);
      insertTask(database, {
        capabilityCode: "domain.custom.domain_connect",
        id: `aut_quota_${suffix}`,
        inputReference: `d1:domain/domain_${suffix}`,
      });
    }
    await expect(createAutomationTask({
      capabilityCode: "shop.provision",
      env: bindings,
      idempotencyKey: "automation-quota-0001",
      requestId: "request-automation-quota",
      runtime: { now: () => new Date(NOW) },
      shopPublicId: "shop_automation_a",
      userId: "usr_automation_a",
    })).rejects.toMatchObject({ code: "automation_task_limit_reached", status: 429 });
  });

  it("replays an existing create at quota and keeps the ceiling tenant-local", async () => {
    const database = createDatabase();
    const bindings = env(database);
    const created = await createAutomationTask({
      capabilityCode: "shop.provision",
      env: bindings,
      idempotencyKey: "automation-quota-replay",
      requestId: "request-automation-quota-replay-create",
      runtime: { now: () => new Date(NOW) },
      shopPublicId: "shop_automation_a",
      userId: "usr_automation_a",
    });
    for (let index = 0; index < 100; index += 1) {
      const suffix = index.toString().padStart(3, "0");
      insertTask(database, {
        capabilityCode: "domain.custom.domain_connect",
        id: `aut_quota_replay_${suffix}`,
        inputReference: `d1:domain/quota_replay_${suffix}`,
      });
    }

    const replay = await createAutomationTask({
      capabilityCode: "shop.provision",
      env: bindings,
      idempotencyKey: "automation-quota-replay",
      requestId: "request-automation-quota-replay-repeat",
      runtime: { now: () => new Date(NOW) },
      shopPublicId: "shop_automation_a",
      userId: "usr_automation_a",
    });
    const independent = await createAutomationTask({
      capabilityCode: "shop.provision",
      env: bindings,
      idempotencyKey: "automation-quota-replay",
      requestId: "request-automation-quota-independent",
      runtime: { now: () => new Date(NOW) },
      shopPublicId: "shop_automation_b",
      userId: "usr_automation_b",
    });

    expect(replay).toEqual({ replayed: true, task: created.task });
    expect(independent).toMatchObject({ replayed: false, task: { status: "succeeded" } });
    expect(database.database.prepare(`
      SELECT COUNT(*) AS count
      FROM automation_tasks
      WHERE shop_id = 'shp_automation_a'
        AND status NOT IN ('succeeded', 'failed', 'canceled')
    `).get()).toEqual({ count: 100 });
    expect(database.database.prepare(`
      SELECT COUNT(*) AS count
      FROM audit_logs
      WHERE action = 'automation.task_created' AND resource_id = ?
    `).get(created.task.id)).toEqual({ count: 1 });
  });

  it("binds Telegram, PayOS and domain evidence to valid resources in shop B", async () => {
    const database = createDatabase();
    const bindings = env(database);
    insertTelegramIntegration(database, NOW, {
      createdByUserId: "usr_automation_b",
      credentialId: "tgcred_b",
      integrationId: "tgint_b0",
      shopId: "shp_automation_b",
      suffix: "b",
    });
    insertPaymentIntegration(database, NOW, {
      createdByUserId: "usr_automation_b",
      credentialId: "paycred_b",
      integrationId: "payint_b",
      shopId: "shp_automation_b",
      suffix: "b",
    });
    insertDomain(database, NOW, {
      domainId: "dom_b",
      hostname: "shop-b.example.com",
      shopId: "shp_automation_b",
      suffix: "b",
    });
    insertTask(database, {
      capabilityCode: "telegram.bot.create",
      id: "aut_provider_b",
      inputReference: "d1:telegram-integration/tgint_b0",
      shopId: "shp_automation_b",
      status: "waiting_provider",
    });
    insertTask(database, {
      capabilityCode: "payments.payos.channel_create",
      id: "aut_payment_cross_tenant",
      inputReference: "d1:payment-integration/payint_b",
      status: "waiting_provider",
    });
    insertTask(database, {
      capabilityCode: "domain.custom.manual_dns",
      id: "aut_domain_cross_tenant",
      inputReference: "d1:domain/dom_b",
      status: "waiting_provider",
    });
    insertTask(database, {
      capabilityCode: "payments.payos.channel_create",
      id: "aut_payment_b",
      inputReference: "d1:payment-integration/payint_b",
      shopId: "shp_automation_b",
      status: "waiting_provider",
    });
    insertTask(database, {
      capabilityCode: "domain.custom.manual_dns",
      id: "aut_domain_b",
      inputReference: "d1:domain/dom_b",
      shopId: "shp_automation_b",
      status: "waiting_provider",
    });

    await expect(resumeAutomationTask({
      env: bindings,
      expectedVersion: 1,
      idempotencyKey: "automation-payment-cross-tenant",
      requestId: "request-automation-payment-cross-tenant",
      runtime: { now: () => new Date(NOW) },
      shopPublicId: "shop_automation_a",
      taskId: "aut_payment_cross_tenant",
      userId: "usr_automation_a",
    })).rejects.toMatchObject({ code: "automation_provider_evidence_pending", status: 409 });
    await expect(resumeAutomationTask({
      env: bindings,
      expectedVersion: 1,
      idempotencyKey: "automation-domain-cross-tenant",
      requestId: "request-automation-domain-cross-tenant",
      runtime: { now: () => new Date(NOW) },
      shopPublicId: "shop_automation_a",
      taskId: "aut_domain_cross_tenant",
      userId: "usr_automation_a",
    })).rejects.toMatchObject({ code: "automation_provider_evidence_pending", status: 409 });

    const telegram = await resumeAutomationTask({
      env: bindings,
      expectedVersion: 1,
      idempotencyKey: "automation-provider-shop-b",
      requestId: "request-automation-provider-shop-b",
      runtime: { now: () => new Date(NOW) },
      shopPublicId: "shop_automation_b",
      taskId: "aut_provider_b",
      userId: "usr_automation_b",
    });
    const payment = await resumeAutomationTask({
      env: bindings,
      expectedVersion: 1,
      idempotencyKey: "automation-payment-shop-b",
      requestId: "request-automation-payment-shop-b",
      runtime: { now: () => new Date(NOW) },
      shopPublicId: "shop_automation_b",
      taskId: "aut_payment_b",
      userId: "usr_automation_b",
    });
    const domain = await resumeAutomationTask({
      env: bindings,
      expectedVersion: 1,
      idempotencyKey: "automation-domain-shop-b",
      requestId: "request-automation-domain-shop-b",
      runtime: { now: () => new Date(NOW) },
      shopPublicId: "shop_automation_b",
      taskId: "aut_domain_b",
      userId: "usr_automation_b",
    });

    expect(telegram).toMatchObject({ replayed: false, task: { id: "aut_provider_b", status: "retryable" } });
    expect(payment).toMatchObject({ replayed: false, task: { id: "aut_payment_b", status: "retryable" } });
    expect(domain).toMatchObject({ replayed: false, task: { id: "aut_domain_b", status: "retryable" } });
    const evidenceMetadata = (taskId: string) => {
      const audit = database.database.prepare(`
        SELECT al.safe_metadata_json
        FROM automation_evidence_challenges AS aec
        INNER JOIN audit_logs AS al ON al.id = aec.audit_log_id
        WHERE aec.shop_id = 'shp_automation_b' AND aec.task_id = ?
      `).get(taskId) as { safe_metadata_json: string };
      return JSON.parse(audit.safe_metadata_json) as Record<string, unknown>;
    };
    expect(evidenceMetadata("aut_provider_b")).toMatchObject({ providerReference: "d1:telegram-integration/tgint_b0" });
    expect(evidenceMetadata("aut_payment_b")).toMatchObject({ providerReference: "d1:payment-integration/payint_b" });
    expect(evidenceMetadata("aut_domain_b")).toMatchObject({ providerReference: "d1:domain/dom_b" });
  });

  it("replays a reserved cancel after the immutable task event already exists", async () => {
    const database = createDatabase();
    const bindings = env(database);
    const taskId = "aut_cancel_recovery";
    const idempotencyKey = "automation-cancel-recovery";
    const namespace = `automation.cancel.v2:shp_automation_a:${taskId}`;
    const keyHash = await hmacToken(bindings.SESSION_SECRET, "automation-control-idempotency-v2", idempotencyKey);
    const requestHash = sha256JsonHex({
      expectedVersion: 1,
      reasonCode: "by_user",
      shopId: "shp_automation_a",
      taskId,
    });
    insertTask(database, { capabilityCode: "domain.custom.domain_connect", id: taskId, inputReference: "d1:domain/dom_a" });
    database.database.prepare(`
      INSERT INTO idempotency_records (
        actor_user_id, namespace, key_hash, request_hash, response_json, created_at, expires_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      "usr_automation_a",
      namespace,
      keyHash,
      requestHash,
      JSON.stringify({
        auditId: "aud_cancel_recovery",
        challengeId: null,
        expectedVersion: 1,
        state: "processing",
        taskId,
      }),
      NOW,
      "2026-07-27T00:00:00.000Z",
    );
    database.database.prepare(`
      INSERT INTO automation_task_events (
        id, task_id, shop_id, from_status, to_status, actor_role, actor_id,
        audit_log_id, safe_code, evidence_reference, action_reference, task_version, created_at
      ) VALUES ('aev_cancel_recovery', 'aut_cancel_recovery', 'shp_automation_a',
        'waiting_user', 'canceled', 'seller', 'usr_automation_a', NULL,
        'automation_canceled.by_user', NULL, 'action:automation-control/aud_cancel_recovery', 2, ?)
    `).run(NOW);
    database.database.prepare("UPDATE automation_tasks SET status = 'canceled', last_safe_error_code = 'automation_canceled.by_user', action_reference = 'action:automation-control/aud_cancel_recovery', version = 2, updated_at = ? WHERE id = 'aut_cancel_recovery'").run(NOW);
    const result = await cancelAutomationTask({
      env: bindings,
      expectedVersion: 1,
      idempotencyKey,
      reasonCode: "by_user",
      requestId: "request-automation-cancel-recovery",
      runtime: { now: () => new Date(NOW) },
      shopPublicId: "shop_automation_a",
      taskId: "aut_cancel_recovery",
      userId: "usr_automation_a",
    });
    expect(result.replayed).toBe(true);
    expect(result.task.status).toBe("canceled");
    const replay = await cancelAutomationTask({
      env: bindings,
      expectedVersion: 1,
      idempotencyKey,
      reasonCode: "by_user",
      requestId: "request-automation-cancel-recovery-replay",
      runtime: { now: () => new Date(NOW) },
      shopPublicId: "shop_automation_a",
      taskId: "aut_cancel_recovery",
      userId: "usr_automation_a",
    });
    expect(replay.replayed).toBe(true);
    expect(database.database.prepare("SELECT COUNT(*) AS count FROM audit_logs WHERE action = 'automation.task_canceled'").get()).toEqual({ count: 1 });
    await expect(cancelAutomationTask({
      env: bindings,
      expectedVersion: 1,
      idempotencyKey,
      reasonCode: "operator_request",
      requestId: "request-automation-cancel-conflict",
      runtime: { now: () => new Date(NOW) },
      shopPublicId: "shop_automation_a",
      taskId: "aut_cancel_recovery",
      userId: "usr_automation_a",
    })).rejects.toMatchObject({ code: "idempotency_conflict", status: 409 });
  });

  it("does not replay a stale cancel from a different idempotency key", async () => {
    const database = createDatabase();
    const bindings = env(database);
    insertTask(database, {
      capabilityCode: "shop.provision",
      id: "aut_cancel_stale",
      inputReference: "d1:shop/shp_automation_a",
    });
    await expect(cancelAutomationTask({
      env: bindings,
      expectedVersion: 1,
      idempotencyKey: "automation-cancel-first",
      reasonCode: "by_user",
      requestId: "request-automation-cancel-first",
      runtime: { now: () => new Date(NOW) },
      shopPublicId: "shop_automation_a",
      taskId: "aut_cancel_stale",
      userId: "usr_automation_a",
    })).resolves.toMatchObject({ replayed: false, task: { status: "canceled" } });
    await expect(cancelAutomationTask({
      env: bindings,
      expectedVersion: 1,
      idempotencyKey: "automation-cancel-second",
      reasonCode: "by_user",
      requestId: "request-automation-cancel-second",
      runtime: { now: () => new Date(NOW) },
      shopPublicId: "shop_automation_a",
      taskId: "aut_cancel_stale",
      userId: "usr_automation_a",
    })).rejects.toMatchObject({ code: "automation_version_conflict", status: 409 });
    expect(database.database.prepare("SELECT COUNT(*) AS count FROM audit_logs WHERE action = 'automation.task_canceled'").get()).toEqual({ count: 1 });
  });

  it("rejects cancel while an active worker lease is held", async () => {
    const database = createDatabase();
    const bindings = env(database);
    insertTask(database, {
      capabilityCode: "shop.provision",
      id: "aut_cancel_lease",
      inputReference: "d1:shop/shp_automation_a",
    });
    database.database.prepare(`
      UPDATE automation_tasks
      SET status = 'running', lease_token = 'lease-active-123456',
        lease_expires_at = ?, updated_at = ?
      WHERE id = 'aut_cancel_lease'
    `).run(FUTURE, NOW);
    await expect(cancelAutomationTask({
      env: bindings,
      expectedVersion: 1,
      idempotencyKey: "automation-cancel-lease",
      reasonCode: "by_user",
      requestId: "request-automation-cancel-lease",
      runtime: { now: () => new Date(NOW) },
      shopPublicId: "shop_automation_a",
      taskId: "aut_cancel_lease",
      userId: "usr_automation_a",
    })).rejects.toMatchObject({ code: "automation_cancel_conflict", status: 409 });
    expect(database.database.prepare("SELECT COUNT(*) AS count FROM audit_logs WHERE action = 'automation.task_canceled'").get()).toEqual({ count: 0 });
  });
});
