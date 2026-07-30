import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

const NOW = "2026-07-26T07:00:00.000Z";
const HASH = "a".repeat(64);
const REQUEST_HASH = "b".repeat(64);

function applyMigrationsThrough(database: DatabaseSync, maximum: number): void {
  const directory = join(process.cwd(), "migrations");
  for (const filename of readdirSync(directory)
    .filter((name) => /^\d{4}_.+\.sql$/u.test(name) && Number(name.slice(0, 4)) <= maximum)
    .sort()) {
    database.exec(readFileSync(join(directory, filename), "utf8"));
  }
}

function insertShop(database: DatabaseSync): void {
  database.prepare(`
    INSERT INTO shops (
      id, public_id, slug, name, status, default_locale, currency,
      timezone, readiness_version, created_at, updated_at
    ) VALUES (
      'shop-a', 'shop_public_a', 'shop-a', 'Shop A', 'active', 'vi', 'VND',
      'Asia/Ho_Chi_Minh', 1, ?, ?
    )
  `).run(NOW, NOW);
}

function insertTask(database: DatabaseSync, id: string, capabilityCode: string): void {
  database.prepare(`
    INSERT INTO automation_tasks (
      id, shop_id, capability_code, status, idempotency_key_hash,
      request_hash, input_reference, created_at, updated_at
    ) VALUES (?, 'shop-a', ?, 'pending', ?, ?, ?, ?, ?)
  `).run(id, capabilityCode, HASH, REQUEST_HASH, `d1:test/${id}`, NOW, NOW);
}

describe("automation create idempotency scope migration", () => {
  let database: DatabaseSync;

  beforeEach(() => {
    database = new DatabaseSync(":memory:");
    database.exec("PRAGMA foreign_keys = ON");
    applyMigrationsThrough(database, 23);
    insertShop(database);
  });

  afterEach(() => {
    database.close();
  });

  it("keeps the old guard when legacy cross-capability duplicates block the stronger index", () => {
    insertTask(database, "task-legacy-a", "shop.provision");
    insertTask(database, "task-legacy-b", "domain.platform.provision");

    const migration = readFileSync(
      join(process.cwd(), "migrations/0024_automation_create_idempotency_scope.sql"),
      "utf8",
    );
    expect(() => {
      database.exec(migration);
    }).toThrow(/UNIQUE constraint failed/u);
    expect(database.prepare(`
      SELECT name FROM sqlite_master
      WHERE type = 'index' AND name = 'idx_automation_tasks_shop_idempotency'
    `).get()).toEqual({ name: "idx_automation_tasks_shop_idempotency" });
    expect(database.prepare(`
      SELECT name FROM sqlite_master
      WHERE type = 'index' AND name = 'idx_automation_tasks_shop_create_idempotency'
    `).get()).toBeUndefined();
  });

  it("keeps both conflict targets so the previous Worker remains rollback-compatible", () => {
    insertTask(database, "task-compatible-a", "shop.provision");

    database.exec(readFileSync(
      join(process.cwd(), "migrations/0024_automation_create_idempotency_scope.sql"),
      "utf8",
    ));

    expect(database.prepare(`
      SELECT name FROM sqlite_master
      WHERE type = 'index' AND name IN (
        'idx_automation_tasks_shop_idempotency',
        'idx_automation_tasks_shop_create_idempotency'
      ) ORDER BY name
    `).all()).toEqual([
      { name: "idx_automation_tasks_shop_create_idempotency" },
      { name: "idx_automation_tasks_shop_idempotency" },
    ]);
  });
});
