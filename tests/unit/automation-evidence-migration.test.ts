import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

const NOW = "2026-07-26T06:30:00.000Z";

function applyMigrations(database: DatabaseSync): void {
  const directory = join(process.cwd(), "migrations");
  for (const filename of readdirSync(directory).filter((name) => /^\d{4}_.+\.sql$/u.test(name)).sort()) {
    database.exec(readFileSync(join(directory, filename), "utf8"));
  }
}

function taskHash(index: number): string {
  return index.toString(16).padStart(64, "0");
}

function insertTask(database: DatabaseSync, input: {
  id: string;
  index: number;
  shopId?: string;
  status?: "canceled" | "failed" | "pending" | "succeeded";
}): void {
  database.prepare(`
    INSERT INTO automation_tasks (
      id, shop_id, capability_code, status, idempotency_key_hash,
      request_hash, input_reference, created_at, updated_at
    ) VALUES (?, ?, 'shop.provision', ?, ?, ?, ?, ?, ?)
  `).run(
    input.id,
    input.shopId ?? "shop-a",
    input.status ?? "pending",
    taskHash(input.index),
    "f".repeat(64),
    `d1:test/${input.id}`,
    NOW,
    NOW,
  );
}

describe("automation evidence migration", () => {
  let database: DatabaseSync;

  beforeEach(() => {
    database = new DatabaseSync(":memory:");
    database.exec("PRAGMA foreign_keys = ON");
    applyMigrations(database);
    database.exec(`
      INSERT INTO platform_users (id, email_normalized, display_name, status, created_at, updated_at)
      VALUES
        ('user-a', 'user-a@example.test', 'User A', 'active', '${NOW}', '${NOW}'),
        ('user-b', 'user-b@example.test', 'User B', 'active', '${NOW}', '${NOW}');
      INSERT INTO shops (
        id, public_id, slug, name, status, default_locale, currency,
        timezone, readiness_version, created_at, updated_at
      ) VALUES
        ('shop-a', 'shop_public_a', 'shop-a', 'Shop A', 'active', 'vi', 'VND',
          'Asia/Ho_Chi_Minh', 1, '${NOW}', '${NOW}'),
        ('shop-b', 'shop_public_b', 'shop-b', 'Shop B', 'active', 'vi', 'VND',
          'Asia/Ho_Chi_Minh', 1, '${NOW}', '${NOW}');
      INSERT INTO shop_members (shop_id, user_id, role, status, created_at, updated_at)
      VALUES
        ('shop-a', 'user-a', 'owner', 'active', '${NOW}', '${NOW}'),
        ('shop-b', 'user-b', 'owner', 'active', '${NOW}', '${NOW}');
    `);
    insertTask(database, { id: "task-evidence-a", index: 1 });
  });

  afterEach(() => {
    database.close();
  });

  it("binds issued and consumed evidence to an active actor, tenant and immutable audit row", () => {
    const insertChallenge = database.prepare(`
      INSERT INTO automation_evidence_challenges (
        id, task_id, shop_id, actor_user_id, kind, token_hash, status,
        audit_log_id, expires_at, consumed_at, created_at, updated_at
      ) VALUES (?, 'task-evidence-a', 'shop-a', ?, 'approval_granted', ?, ?, ?, ?, ?, ?, ?)
    `);

    expect(() => insertChallenge.run(
      "challenge-wrong-actor",
      "user-b",
      "a".repeat(64),
      "issued",
      null,
      "2026-07-26T06:40:00.000Z",
      null,
      NOW,
      NOW,
    )).toThrow(/automation_evidence_insert_invalid/u);

    database.prepare(`
      INSERT INTO audit_logs (
        id, shop_id, actor_type, actor_id, action, resource_type,
        resource_id, safe_metadata_json, request_id, created_at
      ) VALUES (
        'audit-direct-consume', 'shop-a', 'user', 'user-a',
        'automation.evidence_consumed', 'automation_evidence',
        'challenge-direct-consume', '{}', 'request-direct', ?
      )
    `).run(NOW);
    expect(() => insertChallenge.run(
      "challenge-direct-consume",
      "user-a",
      "b".repeat(64),
      "consumed",
      "audit-direct-consume",
      "2026-07-26T06:40:00.000Z",
      NOW,
      NOW,
      NOW,
    )).toThrow(/automation_evidence_insert_invalid/u);

    insertChallenge.run(
      "challenge-valid-a",
      "user-a",
      "c".repeat(64),
      "issued",
      null,
      "2026-07-26T06:40:00.000Z",
      null,
      NOW,
      NOW,
    );
    database.prepare(`
      INSERT INTO audit_logs (
        id, shop_id, actor_type, actor_id, action, resource_type,
        resource_id, safe_metadata_json, request_id, created_at
      ) VALUES (
        'audit-wrong-tenant', 'shop-b', 'user', 'user-b',
        'automation.evidence_consumed', 'automation_evidence',
        'challenge-valid-a', '{}', 'request-wrong-tenant', ?
      )
    `).run(NOW);
    expect(() => database.prepare(`
      UPDATE automation_evidence_challenges
      SET status = 'consumed', audit_log_id = 'audit-wrong-tenant',
        consumed_at = ?, updated_at = ?
      WHERE id = 'challenge-valid-a'
    `).run(NOW, NOW)).toThrow(/automation_evidence_transition_invalid/u);

    insertChallenge.run(
      "challenge-expired-a",
      "user-a",
      "d".repeat(64),
      "issued",
      null,
      "2026-07-26T06:31:00.000Z",
      null,
      NOW,
      NOW,
    );
    database.prepare(`
      INSERT INTO audit_logs (
        id, shop_id, actor_type, actor_id, action, resource_type,
        resource_id, safe_metadata_json, request_id, created_at
      ) VALUES (
        'audit-expired-consume', 'shop-a', 'user', 'user-a',
        'automation.evidence_consumed', 'automation_evidence',
        'challenge-expired-a', '{}', 'request-expired-consume', ?
      )
    `).run(NOW);
    expect(() => database.prepare(`
      UPDATE automation_evidence_challenges
      SET status = 'consumed', audit_log_id = 'audit-expired-consume',
        consumed_at = '2026-07-26T06:32:00.000Z', updated_at = '2026-07-26T06:32:00.000Z'
      WHERE id = 'challenge-expired-a'
    `).run()).toThrow(/automation_evidence/u);

    database.prepare(`
      INSERT INTO audit_logs (
        id, shop_id, actor_type, actor_id, action, resource_type,
        resource_id, safe_metadata_json, request_id, created_at
      ) VALUES (
        'audit-valid-consume', 'shop-a', 'user', 'user-a',
        'automation.evidence_consumed', 'automation_evidence',
        'challenge-valid-a', '{}', 'request-valid-consume', ?
      )
    `).run(NOW);
    database.prepare(`
      UPDATE automation_evidence_challenges
      SET status = 'consumed', audit_log_id = 'audit-valid-consume',
        consumed_at = ?, updated_at = ?
      WHERE id = 'challenge-valid-a'
    `).run(NOW, NOW);

    expect(() => database.prepare(`
      UPDATE automation_evidence_challenges
      SET consumed_at = '2026-07-26T06:31:00.000Z'
      WHERE id = 'challenge-valid-a'
    `).run()).toThrow(/automation_evidence_transition_invalid/u);
    expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  });

  it("enforces the open-task ceiling on inserts and terminal-to-open updates", () => {
    for (let index = 2; index <= 100; index += 1) {
      insertTask(database, { id: `task-open-${index.toString().padStart(3, "0")}`, index });
    }
    insertTask(database, { id: "task-terminal-101", index: 101, status: "canceled" });

    expect(() => {
      insertTask(database, { id: "task-open-101", index: 102 });
    })
      .toThrow(/automation_open_task_limit/u);
    expect(() => database.prepare(`
      UPDATE automation_tasks
      SET status = 'pending', updated_at = ?
      WHERE id = 'task-terminal-101' AND shop_id = 'shop-a'
    `).run(NOW)).toThrow(/automation_open_task_limit/u);
    insertTask(database, { id: "task-shop-b-open", index: 500, shopId: "shop-b" });
    expect(() => database.prepare(`
      UPDATE automation_tasks
      SET shop_id = 'shop-a', updated_at = ?
      WHERE id = 'task-shop-b-open' AND shop_id = 'shop-b'
    `).run(NOW)).toThrow(/automation_open_task_limit/u);
    expect(database.prepare(`
      SELECT COUNT(*) AS count
      FROM automation_tasks
      WHERE shop_id = 'shop-a'
        AND status NOT IN ('succeeded', 'failed', 'canceled')
    `).get()).toEqual({ count: 100 });
  });

  it("allows every terminal state above quota and terminal-to-open at the 99-task boundary", () => {
    for (let index = 2; index <= 99; index += 1) {
      insertTask(database, { id: `task-boundary-${index.toString().padStart(3, "0")}`, index });
    }
    insertTask(database, { id: "task-boundary-canceled", index: 100, status: "canceled" });
    insertTask(database, { id: "task-boundary-failed", index: 101, status: "failed" });
    insertTask(database, { id: "task-boundary-succeeded", index: 102, status: "succeeded" });

    database.prepare(`
      UPDATE automation_tasks
      SET status = 'pending', updated_at = ?
      WHERE id = 'task-boundary-canceled' AND shop_id = 'shop-a'
    `).run(NOW);

    expect(database.prepare(`
      SELECT status FROM automation_tasks
      WHERE id IN ('task-boundary-failed', 'task-boundary-succeeded')
      ORDER BY id
    `).all()).toEqual([{ status: "failed" }, { status: "succeeded" }]);
    expect(database.prepare(`
      SELECT COUNT(*) AS count FROM automation_tasks
      WHERE shop_id = 'shop-a'
        AND status NOT IN ('succeeded', 'failed', 'canceled')
    `).get()).toEqual({ count: 100 });
  });

  it("moves open tasks only when the destination has capacity and preserves failed rows", () => {
    insertTask(database, { id: "task-move-empty", index: 600 });
    database.prepare(`
      UPDATE automation_tasks SET shop_id = 'shop-b', updated_at = ?
      WHERE id = 'task-move-empty' AND shop_id = 'shop-a'
    `).run(NOW);
    expect(database.prepare("SELECT shop_id AS shopId, status FROM automation_tasks WHERE id = 'task-move-empty'").get())
      .toEqual({ shopId: "shop-b", status: "pending" });

    for (let index = 2; index <= 99; index += 1) {
      insertTask(database, { id: `task-move-destination-${index.toString().padStart(3, "0")}`, index });
    }
    insertTask(database, { id: "task-move-capacity", index: 601, shopId: "shop-b" });
    database.prepare(`
      UPDATE automation_tasks SET shop_id = 'shop-a', updated_at = ?
      WHERE id = 'task-move-capacity' AND shop_id = 'shop-b'
    `).run(NOW);

    insertTask(database, { id: "task-move-overflow", index: 602, shopId: "shop-b" });
    expect(() => database.prepare(`
      UPDATE automation_tasks SET shop_id = 'shop-a', updated_at = ?
      WHERE id = 'task-move-overflow' AND shop_id = 'shop-b'
    `).run(NOW)).toThrow(/automation_open_task_limit/u);
    expect(database.prepare("SELECT shop_id AS shopId, status FROM automation_tasks WHERE id = 'task-move-overflow'").get())
      .toEqual({ shopId: "shop-b", status: "pending" });

    insertTask(database, { id: "task-move-terminal", index: 603, shopId: "shop-b", status: "failed" });
    database.prepare(`
      UPDATE automation_tasks SET shop_id = 'shop-a', updated_at = ?
      WHERE id = 'task-move-terminal' AND shop_id = 'shop-b'
    `).run(NOW);
    expect(database.prepare("SELECT shop_id AS shopId, status FROM automation_tasks WHERE id = 'task-move-terminal'").get())
      .toEqual({ shopId: "shop-a", status: "failed" });
  });
});
