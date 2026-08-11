import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { appendOrderNote, redactOrderNote } from "../../src/lib/commerce/order-notes";
import { appendOrderMessage, markOrderMessageDelivered, redactOrderMessage } from "../../src/lib/commerce/order-messages";
import { cancelChannelConnectorRequest, createChannelConnectorRequest, listChannelConnectorRequests } from "../../src/lib/channels/connector-requests";
import { listAdminAuditEntries, listAdminOrderInvestigations } from "../../src/lib/operations/admin-investigations";
import { createPaymentRemediationRequest, listAdminPaymentRemediationRequests, listSellerPaymentRemediationRequests, reviewPaymentRemediationRequest } from "../../src/lib/payments/remediation";
import type { AppBindings } from "../../src/lib/platform/bindings";
import { appendCustomerNote, executeBuyerPrivacyRequest, getSellerCustomer, redactCustomerNote, updateSellerCustomer } from "../../src/lib/tenants/customer-management";
import { createSubscriptionChangeRequest, listSellerBillingPlans, listSubscriptionChangeRequests } from "../../src/lib/tenants/billing-requests";
import { acceptMemberInvitation, issueMemberInvitation, listMemberInvitations, resendMemberInvitation, revokeMemberInvitation, suspendMember, updateMemberRole } from "../../src/lib/tenants/member-management";

const NOW = new Date("2026-08-02T04:00:00.000Z");
const SHOP_A = "shop-ops-a";
const SHOP_B = "shop-ops-b";
const SHOP_A_PUBLIC = "shop_00000000-0000-4000-8000-0000000000a1";
const SHOP_B_PUBLIC = "shop_00000000-0000-4000-8000-0000000000b1";
const OWNER_A = "ops-owner-a";
const MANAGER_A = "ops-manager-a";
const SUPPORT_A = "ops-support-a";
const VIEWER_A = "ops-viewer-a";
const INVITEE = "ops-invitee";
const OWNER_B = "ops-owner-b";
const ADMIN = "ops-admin";
const CUSTOMER_A = "cus_00000000-0000-4000-8000-0000000000a1";
const CUSTOMER_B = "cus_00000000-0000-4000-8000-0000000000b1";
const ORDER_A = "order-ops-a";
const ORDER_A_PUBLIC = "order_00000000-0000-4000-8000-0000000000a1";
const ORDER_B = "order-ops-b";
const ORDER_B_PUBLIC = "order_00000000-0000-4000-8000-0000000000b1";
const MEMBER_MANAGER = "mbr_00000000-0000-4000-8000-0000000000a1";
const MEMBER_OWNER = "mbr_00000000-0000-4000-8000-0000000000a2";

class SqliteStatement {
  constructor(
    private readonly database: DatabaseSync,
    private readonly sql: string,
    private readonly values: SQLInputValue[] = [],
  ) {}

  bind(...values: unknown[]): SqliteStatement {
    const sqlValues = values.map((value): SQLInputValue => {
      if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "bigint" || value instanceof Uint8Array) return value;
      throw new TypeError("unsupported_sqlite_binding");
    });
    return new SqliteStatement(this.database, this.sql, sqlValues);
  }

  first<T>(): Promise<T | null> {
    return Promise.resolve((this.database.prepare(this.sql).get(...this.values) as T | undefined) ?? null);
  }

  all(): Promise<{ results: unknown[] }> {
    return Promise.resolve({ results: this.database.prepare(this.sql).all(...this.values) });
  }

  run(): Promise<{ meta: { changes: number } }> {
    const result = this.database.prepare(this.sql).run(...this.values);
    return Promise.resolve({ meta: { changes: Number(result.changes) } });
  }
}

class SqliteD1 {
  private batchQueue = Promise.resolve();

  constructor(readonly database: DatabaseSync, private readonly beforeBatch?: () => Promise<void> | void) {}

  prepare(sql: string): SqliteStatement {
    return new SqliteStatement(this.database, sql);
  }

  batch(statements: SqliteStatement[]): Promise<Array<{ meta: { changes: number } }>> {
    const operation = this.batchQueue.then(async () => {
      await this.beforeBatch?.();
      this.database.exec("BEGIN IMMEDIATE");
      try {
        const results = [];
        for (const statement of statements) results.push(await statement.run());
        this.database.exec("COMMIT");
        return results;
      } catch (error) {
        this.database.exec("ROLLBACK");
        throw error;
      }
    });
    this.batchQueue = operation.then(() => undefined, () => undefined);
    return operation;
  }
}

function applyMigrations(database: DatabaseSync): void {
  for (const filename of readdirSync(join(process.cwd(), "migrations")).filter((name) => /^\d{4}_.+\.sql$/u.test(name)).sort()) {
    database.exec(readFileSync(join(process.cwd(), "migrations", filename), "utf8"));
  }
}

function env(database: SqliteD1, send = vi.fn(() => Promise.resolve())): AppBindings {
  return {
    APP_ENV: "local",
    DASHBOARD_ORIGIN: "https://dashboard.example.test",
    DEFAULT_CURRENCY: "USD",
    DEFAULT_LOCALE: "en",
    EMAIL: { send },
    EMAIL_FROM_ADDRESS: "no-reply@example.test",
    EMAIL_FROM_NAME: "Selinow",
    MAGIC_LINK_SECRET: "magic-secret",
    IDENTIFIER_HMAC_SECRET: "seller-operations-identifier-secret",
    PLATFORM_DB: database,
    SESSION_SECRET: "session-secret",
  } as unknown as AppBindings;
}

function seed(database: DatabaseSync): void {
  const now = NOW.toISOString();
  database.exec(`
    INSERT INTO plans (id, code, name, feature_flags_json, limits_json, created_at, updated_at)
    VALUES ('plan-ops', 'business', 'Business', '{}', '{}', '${now}', '${now}');
    INSERT INTO platform_users (id, email_normalized, display_name, status, created_at, updated_at) VALUES
      ('${OWNER_A}', 'owner-a@example.test', 'Owner A', 'active', '${now}', '${now}'),
      ('${MANAGER_A}', 'manager-a@example.test', 'Manager A', 'active', '${now}', '${now}'),
      ('${SUPPORT_A}', 'support-a@example.test', 'Support A', 'active', '${now}', '${now}'),
      ('${VIEWER_A}', 'viewer-a@example.test', 'Viewer A', 'active', '${now}', '${now}'),
      ('${INVITEE}', 'invitee@example.test', 'Invitee', 'active', '${now}', '${now}'),
      ('${OWNER_B}', 'owner-b@example.test', 'Owner B', 'active', '${now}', '${now}'),
      ('${ADMIN}', 'admin@example.test', 'Admin', 'active', '${now}', '${now}');
    INSERT INTO platform_admins (user_id, role, status, created_at, updated_at) VALUES ('${ADMIN}', 'support', 'active', '${now}', '${now}');
    INSERT INTO shops (id, public_id, slug, name, status, default_locale, currency, timezone, readiness_version, created_at, updated_at) VALUES
      ('${SHOP_A}', '${SHOP_A_PUBLIC}', 'ops-a', 'Operations A', 'active', 'en', 'USD', 'UTC', 1, '${now}', '${now}'),
      ('${SHOP_B}', '${SHOP_B_PUBLIC}', 'ops-b', 'Operations B', 'active', 'en', 'USD', 'UTC', 1, '${now}', '${now}');
    INSERT INTO shop_subscriptions (id, shop_id, plan_id, state, current_period_end, created_at, updated_at) VALUES
      ('sub-ops-a', '${SHOP_A}', 'plan-ops', 'active', '2099-01-01T00:00:00.000Z', '${now}', '${now}'),
      ('sub-ops-b', '${SHOP_B}', 'plan-ops', 'active', '2099-01-01T00:00:00.000Z', '${now}', '${now}');
    INSERT INTO shop_members (shop_id, user_id, role, status, created_at, updated_at, member_public_id) VALUES
      ('${SHOP_A}', '${OWNER_A}', 'owner', 'active', '${now}', '${now}', '${MEMBER_OWNER}'),
      ('${SHOP_A}', '${MANAGER_A}', 'manager', 'active', '${now}', '${now}', '${MEMBER_MANAGER}'),
      ('${SHOP_A}', '${SUPPORT_A}', 'support', 'active', '${now}', '${now}', 'mbr_00000000-0000-4000-8000-0000000000a3'),
      ('${SHOP_A}', '${VIEWER_A}', 'viewer', 'active', '${now}', '${now}', 'mbr_00000000-0000-4000-8000-0000000000a4'),
      ('${SHOP_B}', '${OWNER_B}', 'owner', 'active', '${now}', '${now}', 'mbr_00000000-0000-4000-8000-0000000000b1');
    INSERT INTO shop_customers (id, shop_id, email_normalized, display_name, locale, status, created_at, updated_at) VALUES
      ('${CUSTOMER_A}', '${SHOP_A}', 'buyer-a@example.test', 'Buyer A', 'en', 'active', '${now}', '${now}'),
      ('${CUSTOMER_B}', '${SHOP_B}', 'buyer-b@example.test', 'Buyer B', 'en', 'active', '${now}', '${now}');
    INSERT INTO orders (id, public_id, shop_id, customer_id, order_number, source_channel, status, payment_status, fulfillment_status, subtotal_minor, discount_minor, total_minor, currency, locale, customer_email_masked, checkout_subject_hash, order_token_hash, expires_at, created_at, updated_at)
    VALUES
      ('${ORDER_A}', '${ORDER_A_PUBLIC}', '${SHOP_A}', '${CUSTOMER_A}', 'OPS-A-1', 'web', 'processing', 'pending', 'unfulfilled', 1000, 0, 1000, 'USD', 'en', 'bu***@example.test', 'subject-a', 'token-a', '2026-08-02T05:00:00.000Z', '${now}', '${now}'),
      ('${ORDER_B}', '${ORDER_B_PUBLIC}', '${SHOP_B}', '${CUSTOMER_B}', 'OPS-B-1', 'web', 'processing', 'pending', 'unfulfilled', 2000, 0, 2000, 'USD', 'en', 'bu***@example.test', 'subject-b', 'token-b', '2026-08-02T05:00:00.000Z', '${now}', '${now}');
    INSERT INTO audit_logs (id, shop_id, actor_type, actor_id, action, resource_type, resource_id, safe_metadata_json, request_id, created_at) VALUES
      ('audit-ops-a', '${SHOP_A}', 'user', '${OWNER_A}', 'customer.updated', 'customer', '${CUSTOMER_A}', '{"safe":"ok","token":"do-not-show"}', 'request-a', '${now}');
  `);
}

describe("seller operations backend contracts", () => {
  let database: DatabaseSync;
  let d1: SqliteD1;
  let bindings: AppBindings;

  beforeEach(() => {
    database = new DatabaseSync(":memory:");
    database.exec("PRAGMA foreign_keys = ON");
    applyMigrations(database);
    seed(database);
    d1 = new SqliteD1(database);
    bindings = env(d1);
  });

  afterEach(() => { database.close(); });

  it("applies the seller-operations migration with optimistic versions and immutable note guards", () => {
    const customerColumns = database.prepare("PRAGMA table_info(shop_customers)").all() as Array<{ name: string }>;
    const memberColumns = database.prepare("PRAGMA table_info(shop_members)").all() as Array<{ name: string }>;
    const triggers = database.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger'").all() as Array<{ name: string }>;
    expect(customerColumns.map((column) => column.name)).toContain("version");
    expect(memberColumns.map((column) => column.name)).toEqual(expect.arrayContaining(["member_public_id", "version"]));
    expect(triggers.map((trigger) => trigger.name)).toEqual(expect.arrayContaining(["customer_notes_no_delete", "order_notes_no_delete", "customer_notes_redaction_guard", "order_notes_redaction_guard"]));
  });

  it("keeps buyer privacy export allowlisted, replay-safe and tenant-bound", async () => {
    const exported = await executeBuyerPrivacyRequest({
      customerPublicId: CUSTOMER_A,
      env: bindings,
      idempotencyKey: "privacy-export-a1",
      kind: "export",
      now: NOW,
      requestId: "request-privacy-export",
      shopPublicId: SHOP_A_PUBLIC,
      userId: OWNER_A,
    });
    expect(exported).toMatchObject({ safeResultCode: "export_ready", status: "completed" });
    expect(exported.projection?.customer.email).toBe("buyer-a@example.test");
    expect(JSON.stringify(exported.projection)).not.toContain("token-a");
    expect(JSON.stringify(exported.projection)).not.toContain("subject-a");
    expect(await executeBuyerPrivacyRequest({ customerPublicId: CUSTOMER_A, env: bindings, idempotencyKey: "privacy-export-a1", kind: "export", now: NOW, requestId: "request-privacy-replay", shopPublicId: SHOP_A_PUBLIC, userId: OWNER_A })).toEqual(exported);
    await expect(executeBuyerPrivacyRequest({ customerPublicId: CUSTOMER_A, env: bindings, idempotencyKey: "privacy-export-manager", kind: "export", now: NOW, requestId: "request-privacy-manager", shopPublicId: SHOP_A_PUBLIC, userId: MANAGER_A })).resolves.toMatchObject({ safeResultCode: "export_ready", status: "completed" });
    await expect(executeBuyerPrivacyRequest({ customerPublicId: CUSTOMER_A, env: bindings, idempotencyKey: "privacy-export-support", kind: "export", now: NOW, requestId: "request-privacy-support", shopPublicId: SHOP_A_PUBLIC, userId: SUPPORT_A })).rejects.toMatchObject({ code: "authorization_denied", status: 403 });
    await expect(executeBuyerPrivacyRequest({ customerPublicId: CUSTOMER_A, env: bindings, idempotencyKey: "privacy-export-cross", kind: "export", now: NOW, requestId: "request-privacy-cross", shopPublicId: SHOP_B_PUBLIC, userId: OWNER_B })).rejects.toMatchObject({ code: "customer_not_found" });
  });

  it("blocks active buyer deletion and anonymizes only after operational records settle", async () => {
    const blocked = await executeBuyerPrivacyRequest({ customerPublicId: CUSTOMER_A, env: bindings, idempotencyKey: "privacy-delete-blocked", kind: "anonymize", now: NOW, requestId: "request-privacy-blocked", shopPublicId: SHOP_A_PUBLIC, userId: OWNER_A });
    expect(blocked).toMatchObject({ safeResultCode: "active_records_blocked", status: "blocked" });
    expect(database.prepare("SELECT email_normalized AS email FROM shop_customers WHERE id = ?").get(CUSTOMER_A)).toEqual({ email: "buyer-a@example.test" });

    database.prepare("UPDATE orders SET status = 'completed', payment_status = 'paid', fulfillment_status = 'fulfilled' WHERE id = ?").run(ORDER_A);
    const note = await appendCustomerNote({ body: "Contains buyer-provided context", customerPublicId: CUSTOMER_A, env: bindings, idempotencyKey: "privacy-note-a1", now: NOW, requestId: "request-privacy-note", shopPublicId: SHOP_A_PUBLIC, userId: OWNER_A });
    const completed = await executeBuyerPrivacyRequest({ customerPublicId: CUSTOMER_A, env: bindings, idempotencyKey: "privacy-delete-complete", kind: "anonymize", now: NOW, requestId: "request-privacy-complete", shopPublicId: SHOP_A_PUBLIC, userId: OWNER_A });
    expect(completed).toMatchObject({ safeResultCode: "anonymized_financial_audit_retained", status: "completed" });
    expect(database.prepare("SELECT email_normalized AS email, display_name AS displayName, anonymized_at AS anonymizedAt FROM shop_customers WHERE id = ?").get(CUSTOMER_A)).toEqual({ email: null, displayName: null, anonymizedAt: NOW.toISOString() });
    expect(database.prepare("SELECT customer_email_masked AS email, customer_id AS customerId FROM orders WHERE id = ?").get(ORDER_A)).toEqual({ email: null, customerId: CUSTOMER_A });
    expect(database.prepare("SELECT body, status FROM customer_notes WHERE id = ?").get(note.notePublicId)).toEqual({ body: "[redacted]", status: "redacted" });

    await expect(updateSellerCustomer({
      customerPublicId: CUSTOMER_A,
      displayName: "Buyer Restored",
      env: bindings,
      expectedVersion: 2,
      idempotencyKey: "privacy-reactivate-blocked",
      locale: "en",
      now: NOW,
      requestId: "request-privacy-reactivate",
      shopPublicId: SHOP_A_PUBLIC,
      status: "active",
      userId: OWNER_A,
    })).rejects.toMatchObject({ code: "customer_anonymized", status: 409 });
    expect(() => database.prepare(`
      UPDATE shop_customers
      SET email_normalized = 'restored@example.test', display_name = 'Buyer Restored',
        status = 'active', anonymized_at = NULL, version = version + 1
      WHERE id = ?
    `).run(CUSTOMER_A)).toThrow(/customer_anonymized_immutable/u);
    expect(database.prepare(`
      SELECT email_normalized AS email, display_name AS displayName, status, anonymized_at AS anonymizedAt
      FROM shop_customers WHERE id = ?
    `).get(CUSTOMER_A)).toEqual({
      anonymizedAt: NOW.toISOString(),
      displayName: null,
      email: null,
      status: "blocked",
    });
  });

  it("rechecks active orders inside the anonymization mutation and leaves collateral untouched", async () => {
    const note = await appendCustomerNote({ body: "Must survive a blocked privacy race", customerPublicId: CUSTOMER_A, env: bindings, idempotencyKey: "privacy-race-note", now: NOW, requestId: "request-privacy-race-note", shopPublicId: SHOP_A_PUBLIC, userId: OWNER_A });
    database.prepare("UPDATE orders SET status = 'completed', payment_status = 'paid', fulfillment_status = 'fulfilled' WHERE id = ?").run(ORDER_A);
    let injected = false;
    const racingD1 = new SqliteD1(database, () => {
      if (injected) return;
      injected = true;
      database.prepare(`
        INSERT INTO orders (
          id, public_id, shop_id, customer_id, order_number, source_channel, status,
          payment_status, fulfillment_status, subtotal_minor, discount_minor, total_minor,
          currency, locale, customer_email_masked, checkout_subject_hash, order_token_hash,
          expires_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, 'web', 'processing', 'pending', 'unfulfilled', 500, 0,
          500, 'USD', 'en', 'bu***@example.test', 'privacy-race-subject',
          'privacy-race-token', '2026-08-02T05:00:00.000Z', ?, ?)
      `).run("order-privacy-race", "order_00000000-0000-4000-8000-0000000000c1", SHOP_A, CUSTOMER_A, "OPS-A-RACE", NOW.toISOString(), NOW.toISOString());
    });

    const blocked = await executeBuyerPrivacyRequest({
      customerPublicId: CUSTOMER_A,
      env: env(racingD1),
      idempotencyKey: "privacy-race-anonymize",
      kind: "anonymize",
      now: NOW,
      requestId: "request-privacy-race",
      shopPublicId: SHOP_A_PUBLIC,
      userId: OWNER_A,
    });

    expect(blocked).toMatchObject({ safeResultCode: "active_records_blocked", status: "blocked" });
    expect(database.prepare("SELECT email_normalized AS email, anonymized_at AS anonymizedAt FROM shop_customers WHERE id = ?").get(CUSTOMER_A)).toEqual({ anonymizedAt: null, email: "buyer-a@example.test" });
    expect(database.prepare("SELECT body, status FROM customer_notes WHERE id = ?").get(note.notePublicId)).toEqual({ body: "Must survive a blocked privacy race", status: "active" });
    expect(database.prepare("SELECT customer_email_masked AS email FROM orders WHERE id = ?").get(ORDER_A)).toEqual({ email: "bu***@example.test" });
    expect(database.prepare("SELECT status, retained_records_json AS retained FROM buyer_privacy_requests WHERE public_id = ?").get(blocked.privacyRequestPublicId)).toEqual({ retained: JSON.stringify({ activeOrderCount: 1 }), status: "blocked" });
  });

  it("allows only one concurrent anonymization authority for a customer", async () => {
    database.prepare("UPDATE orders SET status = 'completed', payment_status = 'paid', fulfillment_status = 'fulfilled' WHERE id = ?").run(ORDER_A);

    const attempts = await Promise.allSettled([
      executeBuyerPrivacyRequest({ customerPublicId: CUSTOMER_A, env: bindings, idempotencyKey: "privacy-concurrent-a", kind: "anonymize", now: NOW, requestId: "request-privacy-concurrent-a", shopPublicId: SHOP_A_PUBLIC, userId: OWNER_A }),
      executeBuyerPrivacyRequest({ customerPublicId: CUSTOMER_A, env: bindings, idempotencyKey: "privacy-concurrent-b", kind: "anonymize", now: NOW, requestId: "request-privacy-concurrent-b", shopPublicId: SHOP_A_PUBLIC, userId: OWNER_A }),
    ]);

    expect(attempts.filter((attempt) => attempt.status === "fulfilled")).toHaveLength(1);
    expect(attempts.filter((attempt) => attempt.status === "rejected")).toHaveLength(1);
    expect(attempts.find((attempt) => attempt.status === "rejected")).toMatchObject({ reason: { code: "privacy_request_conflict", status: 409 } });
    expect(database.prepare("SELECT COUNT(*) AS count FROM buyer_privacy_requests WHERE shop_id = ? AND customer_id = ? AND kind = 'anonymize' AND status = 'completed'").get(SHOP_A, CUSTOMER_A)).toEqual({ count: 1 });
    expect(database.prepare("SELECT COUNT(*) AS count FROM audit_logs WHERE shop_id = ? AND resource_id = ? AND action = 'customer.anonymized'").get(SHOP_A, CUSTOMER_A)).toEqual({ count: 1 });
  });

  it("keeps member mutations tenant-bound, owner-protected, versioned and replay-safe", async () => {
    const changed = await updateMemberRole({ env: bindings, expectedVersion: 1, idempotencyKey: "member-role-key-1", memberPublicId: MEMBER_MANAGER, newRole: "support", requestId: "request-role", shopPublicId: SHOP_A_PUBLIC, userId: OWNER_A, now: NOW });
    expect(changed).toMatchObject({ memberPublicId: MEMBER_MANAGER, role: "support", status: "active", version: 2 });
    const replay = await updateMemberRole({ env: bindings, expectedVersion: 1, idempotencyKey: "member-role-key-1", memberPublicId: MEMBER_MANAGER, newRole: "support", requestId: "request-role-retry", shopPublicId: SHOP_A_PUBLIC, userId: OWNER_A, now: NOW });
    expect(replay).toEqual(changed);
    await expect(updateMemberRole({ env: bindings, expectedVersion: 1, idempotencyKey: "member-role-key-2", memberPublicId: MEMBER_MANAGER, newRole: "viewer", requestId: "request-conflict", shopPublicId: SHOP_B_PUBLIC, userId: OWNER_B, now: NOW })).rejects.toMatchObject({ code: "resource_not_found" });
    await expect(suspendMember({ env: bindings, expectedVersion: 1, idempotencyKey: "member-suspend-owner", memberPublicId: MEMBER_OWNER, requestId: "request-owner", shopPublicId: SHOP_A_PUBLIC, userId: OWNER_A, now: NOW })).rejects.toMatchObject({ code: "owner_membership_protected" });
    await expect(updateMemberRole({ env: bindings, expectedVersion: 1, idempotencyKey: "member-role-stale", memberPublicId: MEMBER_MANAGER, newRole: "viewer", requestId: "request-stale", shopPublicId: SHOP_A_PUBLIC, userId: OWNER_A, now: NOW })).rejects.toMatchObject({ code: "version_conflict" });
  });

  it("persists and accepts email-bound invitations exactly once", async () => {
    const sent = vi.fn(() => Promise.resolve());
    const invitationEnv = env(d1, sent);
    const issued = await issueMemberInvitation({ email: "invitee@example.test", env: invitationEnv, idempotencyKey: "invite-key-0001", requestId: "request-invite", role: "viewer", shopPublicId: SHOP_A_PUBLIC, userId: OWNER_A, now: NOW });
    expect(issued.invitation.status).toBe("pending");
    expect(issued.debugAcceptToken).toBeTruthy();
    expect(sent).toHaveBeenCalledTimes(1);
    const invitations = await listMemberInvitations({ env: invitationEnv, shopPublicId: SHOP_A_PUBLIC, userId: OWNER_A });
    expect(invitations).toHaveLength(1);
    const accepted = await acceptMemberInvitation({ env: invitationEnv, requestId: "request-accept", token: issued.debugAcceptToken ?? "", userId: INVITEE, now: NOW });
    expect(accepted).toMatchObject({ role: "viewer", status: "active", version: 1 });
    await expect(acceptMemberInvitation({ env: invitationEnv, requestId: "request-accept-retry", token: issued.debugAcceptToken ?? "", userId: INVITEE, now: NOW })).rejects.toMatchObject({ code: "member_invitation_invalid" });
    expect(database.prepare("SELECT status FROM shop_member_invitations WHERE public_id = ?").get(issued.invitation.invitationPublicId)).toEqual({ status: "accepted" });
  });

  it("keeps invitation lifecycle replay-safe and tenant-bound", async () => {
    const issued = await issueMemberInvitation({ email: "invitee@example.test", env: bindings, idempotencyKey: "invite-lifecycle-1", requestId: "request-invite-life", role: "viewer", shopPublicId: SHOP_A_PUBLIC, userId: OWNER_A, now: NOW });
    await expect(issueMemberInvitation({ email: "invitee@example.test", env: bindings, idempotencyKey: "invite-lifecycle-2", requestId: "request-invite-pending", role: "support", shopPublicId: SHOP_A_PUBLIC, userId: OWNER_A, now: NOW })).rejects.toMatchObject({ code: "member_invitation_pending" });
    await expect(issueMemberInvitation({ email: "invitee@example.test", env: bindings, idempotencyKey: "invite-lifecycle-1", requestId: "request-invite-conflict", role: "support", shopPublicId: SHOP_A_PUBLIC, userId: OWNER_A, now: NOW })).rejects.toMatchObject({ code: "idempotency_conflict" });
    await expect(revokeMemberInvitation({ env: bindings, expectedVersion: 1, idempotencyKey: "invite-lifecycle-cross", invitationPublicId: issued.invitation.invitationPublicId, requestId: "request-invite-cross", shopPublicId: SHOP_B_PUBLIC, userId: OWNER_B, now: NOW })).rejects.toMatchObject({ code: "resource_not_found" });
    const revoked = await revokeMemberInvitation({ env: bindings, expectedVersion: 1, idempotencyKey: "invite-lifecycle-revoke", invitationPublicId: issued.invitation.invitationPublicId, requestId: "request-invite-revoke", shopPublicId: SHOP_A_PUBLIC, userId: OWNER_A, now: NOW });
    expect(revoked).toMatchObject({ invitationPublicId: issued.invitation.invitationPublicId, status: "revoked", version: 2 });
    expect(await revokeMemberInvitation({ env: bindings, expectedVersion: 1, idempotencyKey: "invite-lifecycle-revoke", invitationPublicId: issued.invitation.invitationPublicId, requestId: "request-invite-revoke-retry", shopPublicId: SHOP_A_PUBLIC, userId: OWNER_A, now: NOW })).toEqual(revoked);
    await expect(revokeMemberInvitation({ env: bindings, expectedVersion: 2, idempotencyKey: "invite-lifecycle-revoke-again", invitationPublicId: issued.invitation.invitationPublicId, requestId: "request-invite-revoke-again", shopPublicId: SHOP_A_PUBLIC, userId: OWNER_A, now: NOW })).rejects.toMatchObject({ code: "version_conflict" });
    await expect(resendMemberInvitation({ env: bindings, expectedVersion: 2, idempotencyKey: "invite-lifecycle-resend", invitationPublicId: issued.invitation.invitationPublicId, requestId: "request-invite-resend", shopPublicId: SHOP_A_PUBLIC, userId: OWNER_A, now: NOW })).rejects.toMatchObject({ code: "member_invitation_not_resendable" });
  });

  it("can explicitly resend a durable invitation after email-provider failure", async () => {
    const unavailable = env(d1, vi.fn(() => Promise.reject(new Error("mailbox_down"))));
    await expect(issueMemberInvitation({ email: "invitee@example.test", env: unavailable, idempotencyKey: "invite-provider-fail", requestId: "request-invite-fail", role: "viewer", shopPublicId: SHOP_A_PUBLIC, userId: OWNER_A, now: NOW })).rejects.toMatchObject({ code: "provider_unavailable" });
    const invitation = database.prepare("SELECT public_id AS publicId, version FROM shop_member_invitations WHERE email_normalized = 'invitee@example.test'").get() as { publicId: string; version: number };
    const delivered = vi.fn(() => Promise.resolve());
    const resent = await resendMemberInvitation({ env: env(d1, delivered), expectedVersion: invitation.version, idempotencyKey: "invite-resend-1", invitationPublicId: invitation.publicId, requestId: "request-invite-resend", shopPublicId: SHOP_A_PUBLIC, userId: OWNER_A, now: NOW });
    expect(resent).toMatchObject({ invitationPublicId: invitation.publicId, status: "pending", version: invitation.version + 1 });
    expect(delivered).toHaveBeenCalledTimes(1);
    database.prepare("UPDATE shop_member_invitations SET status = 'accepted', accepted_user_id = ?, accepted_at = ?, updated_at = ? WHERE public_id = ?").run(INVITEE, NOW.toISOString(), NOW.toISOString(), invitation.publicId);
    expect(await resendMemberInvitation({ env: env(d1, delivered), expectedVersion: invitation.version, idempotencyKey: "invite-resend-1", invitationPublicId: invitation.publicId, requestId: "request-invite-resend-retry", shopPublicId: SHOP_A_PUBLIC, userId: OWNER_A, now: NOW })).toMatchObject({ invitationPublicId: invitation.publicId, status: "accepted" });
  });

  it("supports customer updates and note redaction with tenant isolation and idempotency", async () => {
    const detail = await getSellerCustomer({ env: bindings, customerPublicId: CUSTOMER_A, shopPublicId: SHOP_A_PUBLIC, userId: OWNER_A });
    expect(detail).toMatchObject({ displayName: "Buyer A", orderCount: 1, publicId: CUSTOMER_A, version: 1 });
    const updated = await updateSellerCustomer({ customerPublicId: CUSTOMER_A, displayName: "Buyer Updated", env: bindings, expectedVersion: 1, idempotencyKey: "customer-update-1", locale: "vi", requestId: "request-customer", shopPublicId: SHOP_A_PUBLIC, status: "blocked", userId: OWNER_A, now: NOW });
    expect(updated).toMatchObject({ displayName: "Buyer Updated", locale: "vi-VN", status: "blocked", version: 2 });
    expect(await updateSellerCustomer({ customerPublicId: CUSTOMER_A, displayName: "Buyer Updated", env: bindings, expectedVersion: 1, idempotencyKey: "customer-update-1", locale: "vi", requestId: "request-customer-retry", shopPublicId: SHOP_A_PUBLIC, status: "blocked", userId: OWNER_A, now: NOW })).toEqual(updated);
    await expect(getSellerCustomer({ env: bindings, customerPublicId: CUSTOMER_A, shopPublicId: SHOP_B_PUBLIC, userId: OWNER_B })).rejects.toMatchObject({ code: "customer_not_found" });
    const note = await appendCustomerNote({ body: "Follow up after payment review", customerPublicId: CUSTOMER_A, env: bindings, idempotencyKey: "customer-note-1", requestId: "request-note", shopPublicId: SHOP_A_PUBLIC, userId: OWNER_A, now: NOW });
    expect(note.status).toBe("active");
    expect(await appendCustomerNote({ body: "Follow up after payment review", customerPublicId: CUSTOMER_A, env: bindings, idempotencyKey: "customer-note-1", requestId: "request-note-retry", shopPublicId: SHOP_A_PUBLIC, userId: OWNER_A, now: NOW })).toEqual(note);
    const redacted = await redactCustomerNote({ customerPublicId: CUSTOMER_A, env: bindings, expectedVersion: note.version, idempotencyKey: "customer-redact-1", notePublicId: note.notePublicId, requestId: "request-redact", shopPublicId: SHOP_A_PUBLIC, userId: OWNER_A, now: NOW });
    expect(redacted).toMatchObject({ body: "", status: "redacted", version: note.version + 1 });
    expect(await redactCustomerNote({ customerPublicId: CUSTOMER_A, env: bindings, expectedVersion: note.version, idempotencyKey: "customer-redact-1", notePublicId: note.notePublicId, requestId: "request-redact-retry", shopPublicId: SHOP_A_PUBLIC, userId: OWNER_A, now: NOW })).toEqual(redacted);
    expect(() => database.prepare("DELETE FROM customer_notes WHERE id = ?").run(note.notePublicId)).toThrow("customer_note_immutable");
  });

  it("rejects customer idempotency reuse and invalid mutation payloads", async () => {
    const updated = await updateSellerCustomer({ customerPublicId: CUSTOMER_A, displayName: "Buyer One", env: bindings, expectedVersion: 1, idempotencyKey: "customer-regression-1", locale: "en", requestId: "request-customer-regression", shopPublicId: SHOP_A_PUBLIC, status: "active", userId: OWNER_A, now: NOW });
    await expect(updateSellerCustomer({ customerPublicId: CUSTOMER_A, displayName: "Buyer Two", env: bindings, expectedVersion: 1, idempotencyKey: "customer-regression-1", locale: "en", requestId: "request-customer-regression-conflict", shopPublicId: SHOP_A_PUBLIC, status: "active", userId: OWNER_A, now: NOW })).rejects.toMatchObject({ code: "idempotency_conflict" });
    expect(updated).toMatchObject({ displayName: "Buyer One", version: 2 });
    await expect(updateSellerCustomer({ customerPublicId: CUSTOMER_A, displayName: "Buyer Invalid", env: bindings, expectedVersion: 2, idempotencyKey: "customer-regression-invalid-status", locale: "en", requestId: "request-customer-invalid-status", shopPublicId: SHOP_A_PUBLIC, status: "deleted", userId: OWNER_A, now: NOW })).rejects.toMatchObject({ code: "validation_failed" });
    await expect(appendCustomerNote({ body: "   ", customerPublicId: CUSTOMER_A, env: bindings, idempotencyKey: "customer-regression-empty-note", requestId: "request-customer-empty-note", shopPublicId: SHOP_A_PUBLIC, userId: OWNER_A, now: NOW })).rejects.toMatchObject({ code: "validation_failed" });
  });

  it("keeps order notes tenant-bound and redaction immutable", async () => {
    const note = await appendOrderNote({ body: "Investigate pending settlement", env: bindings, idempotencyKey: "order-note-1", orderPublicId: ORDER_A_PUBLIC, requestId: "request-order-note", shopPublicId: SHOP_A_PUBLIC, userId: OWNER_A, now: NOW });
    expect(note.status).toBe("active");
    await expect(appendOrderNote({ body: "Cross tenant", env: bindings, idempotencyKey: "order-note-cross", orderPublicId: ORDER_A_PUBLIC, requestId: "request-cross", shopPublicId: SHOP_B_PUBLIC, userId: OWNER_B, now: NOW })).rejects.toMatchObject({ code: "order_not_found" });
    const redacted = await redactOrderNote({ env: bindings, expectedVersion: note.version, idempotencyKey: "order-redact-1", notePublicId: note.notePublicId, orderPublicId: ORDER_A_PUBLIC, requestId: "request-order-redact", shopPublicId: SHOP_A_PUBLIC, userId: OWNER_A, now: NOW });
    expect(redacted).toMatchObject({ body: "", status: "redacted", version: 2 });
    expect(await redactOrderNote({ env: bindings, expectedVersion: note.version, idempotencyKey: "order-redact-1", notePublicId: note.notePublicId, orderPublicId: ORDER_A_PUBLIC, requestId: "request-order-redact-retry", shopPublicId: SHOP_A_PUBLIC, userId: OWNER_A, now: NOW })).toEqual(redacted);
    expect(database.prepare("SELECT body, status FROM order_notes WHERE id = ?").get(note.notePublicId)).toEqual({ body: "Investigate pending settlement", status: "redacted" });
  });

  it("keeps seller messages tenant-bound, replay-safe and provider-pending until evidence exists", async () => {
    const message = await appendOrderMessage({ body: "Your order is queued for review.", env: bindings, idempotencyKey: "order-message-1", orderPublicId: ORDER_A_PUBLIC, requestId: "request-message", shopPublicId: SHOP_A_PUBLIC, userId: OWNER_A, now: NOW });
    expect(message).toMatchObject({ channelCode: "web", status: "provider_pending", version: 1 });
    expect(await appendOrderMessage({ body: "Your order is queued for review.", env: bindings, idempotencyKey: "order-message-1", orderPublicId: ORDER_A_PUBLIC, requestId: "request-message-retry", shopPublicId: SHOP_A_PUBLIC, userId: OWNER_A, now: NOW })).toEqual(message);
    database.prepare("UPDATE orders SET status = 'canceled' WHERE id = ?").run(ORDER_A);
    expect(await appendOrderMessage({ body: "Your order is queued for review.", env: bindings, idempotencyKey: "order-message-1", orderPublicId: ORDER_A_PUBLIC, requestId: "request-message-retry-after-cancel", shopPublicId: SHOP_A_PUBLIC, userId: OWNER_A, now: NOW })).toEqual(message);
    database.prepare("UPDATE orders SET status = 'processing' WHERE id = ?").run(ORDER_A);
    await expect(appendOrderMessage({ body: "Cross tenant", env: bindings, idempotencyKey: "order-message-cross", orderPublicId: ORDER_A_PUBLIC, requestId: "request-message-cross", shopPublicId: SHOP_B_PUBLIC, userId: OWNER_B, now: NOW })).rejects.toMatchObject({ code: "order_not_found" });
    const redacted = await redactOrderMessage({ env: bindings, expectedVersion: message.version, idempotencyKey: "order-message-redact", messagePublicId: message.messagePublicId, orderPublicId: ORDER_A_PUBLIC, requestId: "request-message-redact", shopPublicId: SHOP_A_PUBLIC, userId: OWNER_A, now: NOW });
    expect(redacted).toMatchObject({ body: "", status: "redacted", version: 2 });
    expect(database.prepare("SELECT body, status FROM order_messages WHERE id = ?").get(message.messagePublicId)).toEqual({ body: "", status: "redacted" });
    expect(() => database.prepare("DELETE FROM order_messages WHERE id = ?").run(message.messagePublicId)).toThrow("order_message_immutable");
  });

  it("marks delivery only once for the owning tenant and only from provider_pending", async () => {
    const message = await appendOrderMessage({ body: "Delivery evidence arrives.", env: bindings, idempotencyKey: "order-message-delivery-1", orderPublicId: ORDER_A_PUBLIC, requestId: "request-message-delivery", shopPublicId: SHOP_A_PUBLIC, userId: OWNER_A, now: NOW });
    await expect(markOrderMessageDelivered({ env: bindings, messageId: message.messagePublicId, now: NOW, providerReference: "provider-reference-a", shopId: SHOP_B })).resolves.toBe(false);
    expect(database.prepare("SELECT status, version FROM order_messages WHERE id = ?").get(message.messagePublicId)).toEqual({ status: "provider_pending", version: 1 });

    await expect(markOrderMessageDelivered({ env: bindings, messageId: message.messagePublicId, now: NOW, providerReference: "provider-reference-a", shopId: SHOP_A })).resolves.toBe(true);
    await expect(markOrderMessageDelivered({ env: bindings, messageId: message.messagePublicId, now: NOW, providerReference: "provider-reference-a-replay", shopId: SHOP_A })).resolves.toBe(false);
    const deliveredRow = database.prepare(`
      SELECT status, version, sent_at AS sentAt, provider_reference_hash AS providerReferenceHash, body
      FROM order_messages WHERE id = ?
    `).get(message.messagePublicId) as { body: string; providerReferenceHash: string | null; sentAt: string | null; status: string; version: number };
    expect(deliveredRow.body).toBe("Delivery evidence arrives.");
    expect(deliveredRow.providerReferenceHash).toEqual(expect.any(String));
    expect(deliveredRow.sentAt).toBe(NOW.toISOString());
    expect(deliveredRow.status).toBe("sent");
    expect(deliveredRow.version).toBe(2);
    expect(database.prepare("SELECT provider_reference_hash AS providerReferenceHash FROM order_messages WHERE id = ?").get(message.messagePublicId))
      .not.toEqual({ providerReferenceHash: "provider-reference-a" });

    const redacted = await appendOrderMessage({ body: "Redact before delivery.", env: bindings, idempotencyKey: "order-message-delivery-2", orderPublicId: ORDER_A_PUBLIC, requestId: "request-message-delivery-2", shopPublicId: SHOP_A_PUBLIC, userId: OWNER_A, now: NOW });
    await redactOrderMessage({ env: bindings, expectedVersion: redacted.version, idempotencyKey: "order-message-delivery-redact", messagePublicId: redacted.messagePublicId, orderPublicId: ORDER_A_PUBLIC, requestId: "request-message-delivery-redact", shopPublicId: SHOP_A_PUBLIC, userId: OWNER_A, now: NOW });
    await expect(markOrderMessageDelivered({ env: bindings, messageId: redacted.messagePublicId, now: NOW, providerReference: "provider-reference-redacted", shopId: SHOP_A })).resolves.toBe(false);
    expect(database.prepare("SELECT status, body FROM order_messages WHERE id = ?").get(redacted.messagePublicId)).toEqual({ body: "", status: "redacted" });
  });

  it("fences redaction against a concurrent delivery claim", async () => {
    const message = await appendOrderMessage({ body: "Delivery and redaction race.", env: bindings, idempotencyKey: "order-message-contention-1", orderPublicId: ORDER_A_PUBLIC, requestId: "request-message-contention", shopPublicId: SHOP_A_PUBLIC, userId: OWNER_A, now: NOW });
    let releaseBatch!: () => void;
    let batchReached!: () => void;
    const batchReady = new Promise<void>((resolve) => { batchReached = resolve; });
    const allowBatch = new Promise<void>((resolve) => { releaseBatch = resolve; });
    const contentionBindings = env(new SqliteD1(database, async () => {
      batchReached();
      await allowBatch;
    }));
    const redaction = redactOrderMessage({ env: contentionBindings, expectedVersion: message.version, idempotencyKey: "order-message-contention-redact", messagePublicId: message.messagePublicId, orderPublicId: ORDER_A_PUBLIC, requestId: "request-message-contention-redact", shopPublicId: SHOP_A_PUBLIC, userId: OWNER_A, now: NOW });
    await batchReady;
    await expect(markOrderMessageDelivered({ env: contentionBindings, messageId: message.messagePublicId, now: NOW, providerReference: "provider-reference-contention", shopId: SHOP_A })).resolves.toBe(true);
    releaseBatch();
    await expect(redaction).rejects.toMatchObject({ code: "version_conflict", status: 409 });

    expect(database.prepare("SELECT status, body, version FROM order_messages WHERE id = ?").get(message.messagePublicId)).toEqual({ body: "Delivery and redaction race.", status: "sent", version: 2 });
    expect(database.prepare("SELECT COUNT(*) AS count FROM audit_logs WHERE action = 'order.message_redacted'").get()).toEqual({ count: 0 });
  });

  it("records expansion connector intent without claiming provider activation", async () => {
    const request = await createChannelConnectorRequest({
      channelCode: "whatsapp.cloud",
      env: bindings,
      idempotencyKey: "connector-request-1",
      providerCode: "whatsapp.cloud",
      requestId: "request-connector",
      shopPublicId: SHOP_A_PUBLIC,
      userId: OWNER_A,
      now: NOW,
    });
    expect(request).toMatchObject({ channelCode: "whatsapp.cloud", providerCode: "whatsapp.cloud", providerExecution: "provider_pending", status: "requested", version: 1 });
    expect(await createChannelConnectorRequest({ channelCode: "whatsapp.cloud", env: bindings, idempotencyKey: "connector-request-1", providerCode: "whatsapp.cloud", requestId: "request-connector-retry", shopPublicId: SHOP_A_PUBLIC, userId: OWNER_A, now: NOW })).toEqual(request);
    expect(await listChannelConnectorRequests({ env: bindings, shopPublicId: SHOP_A_PUBLIC, userId: OWNER_A })).toEqual([request]);
    await expect(createChannelConnectorRequest({ channelCode: "whatsapp.cloud", env: bindings, idempotencyKey: "connector-request-bad", providerCode: "telegram.mini_app", requestId: "request-connector-bad", shopPublicId: SHOP_A_PUBLIC, userId: OWNER_A, now: NOW })).rejects.toMatchObject({ code: "validation_failed" });
    const canceled = await cancelChannelConnectorRequest({ env: bindings, expectedVersion: 1, idempotencyKey: "connector-cancel-1", requestId: "request-connector-cancel", requestPublicId: request.requestPublicId, shopPublicId: SHOP_A_PUBLIC, userId: OWNER_A, now: NOW });
    expect(canceled).toMatchObject({ status: "canceled", version: 2 });
    expect(await cancelChannelConnectorRequest({ env: bindings, expectedVersion: 1, idempotencyKey: "connector-cancel-1", requestId: "request-connector-cancel-retry", requestPublicId: request.requestPublicId, shopPublicId: SHOP_A_PUBLIC, userId: OWNER_A, now: NOW })).toEqual(canceled);
    database.prepare(`INSERT INTO channel_connector_requests (
      id, public_id, shop_id, channel_code, provider_code, requested_by_user_id,
      status, provider_reference_hash, reviewed_by_user_id, reviewed_at,
      idempotency_key_hash, request_hash, created_at, updated_at, version
    ) VALUES (?, ?, ?, 'whatsapp.cloud', 'whatsapp.cloud', ?, 'active', ?, ?, ?, ?, ?, ?, ?, 1)`).run(
      "creq_active_projection_a", "creq_active_projection_a", SHOP_A, OWNER_A,
      "provider-reference-hash", OWNER_A, NOW.toISOString(), "active-idempotency-hash",
      "active-request-hash", NOW.toISOString(), NOW.toISOString(),
    );
    expect((await listChannelConnectorRequests({ env: bindings, shopPublicId: SHOP_A_PUBLIC, userId: OWNER_A })).find((entry) => entry.requestPublicId === "creq_active_projection_a")).toMatchObject({ providerExecution: "provider_pending", status: "provider_pending" });
    expect(() => database.prepare("DELETE FROM channel_connector_requests WHERE id = ?").run(request.requestPublicId)).toThrow("channel_connector_request_immutable");
  });

  it("normalizes concurrent connector creates to an idempotent winner or safe pending conflict", async () => {
    const results = await Promise.allSettled([
      createChannelConnectorRequest({
        channelCode: "discord.bot",
        env: bindings,
        idempotencyKey: "connector-race-a",
        providerCode: "discord.bot",
        requestId: "request-connector-race-a",
        shopPublicId: SHOP_A_PUBLIC,
        userId: OWNER_A,
        now: NOW,
      }),
      createChannelConnectorRequest({
        channelCode: "discord.bot",
        env: bindings,
        idempotencyKey: "connector-race-b",
        providerCode: "discord.bot",
        requestId: "request-connector-race-b",
        shopPublicId: SHOP_A_PUBLIC,
        userId: OWNER_A,
        now: NOW,
      }),
    ]);
    const fulfilled = results.filter((result): result is PromiseFulfilledResult<Awaited<ReturnType<typeof createChannelConnectorRequest>>> => result.status === "fulfilled");
    const rejected = results.filter((result): result is PromiseRejectedResult => result.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.reason).toMatchObject({ code: "channel_connector_pending", status: 409 });
    expect(database.prepare("SELECT COUNT(*) AS count FROM channel_connector_requests WHERE shop_id = ? AND provider_code = 'discord.bot'").get(SHOP_A)).toEqual({ count: 1 });
  });

  it("keeps connector requests isolated by tenant and rejects idempotency/state reuse", async () => {
    const requestA = await createChannelConnectorRequest({
      channelCode: "discord.bot",
      env: bindings,
      idempotencyKey: "connector-isolation-1",
      providerCode: "discord.bot",
      requestId: "request-isolation-a",
      shopPublicId: SHOP_A_PUBLIC,
      userId: OWNER_A,
      now: NOW,
    });
    const requestB = await createChannelConnectorRequest({
      channelCode: "discord.bot",
      env: bindings,
      idempotencyKey: "connector-isolation-1",
      providerCode: "discord.bot",
      requestId: "request-isolation-b",
      shopPublicId: SHOP_B_PUBLIC,
      userId: OWNER_B,
      now: NOW,
    });
    expect(requestB.requestPublicId).not.toBe(requestA.requestPublicId);
    expect(await listChannelConnectorRequests({ env: bindings, shopPublicId: SHOP_B_PUBLIC, userId: OWNER_B })).toEqual([requestB]);
    await expect(listChannelConnectorRequests({ env: bindings, shopPublicId: SHOP_B_PUBLIC, userId: OWNER_A })).rejects.toMatchObject({ code: "authorization_denied" });
    await expect(cancelChannelConnectorRequest({ env: bindings, expectedVersion: 1, idempotencyKey: "connector-cross-tenant", requestId: "request-cross-tenant", requestPublicId: requestA.requestPublicId, shopPublicId: SHOP_B_PUBLIC, userId: OWNER_B, now: NOW })).rejects.toMatchObject({ code: "channel_connector_request_not_found" });
    await expect(createChannelConnectorRequest({
      channelCode: "telegram.mini_app",
      env: bindings,
      idempotencyKey: "connector-isolation-1",
      providerCode: "telegram.mini_app",
      requestId: "request-isolation-conflict",
      shopPublicId: SHOP_A_PUBLIC,
      userId: OWNER_A,
      now: NOW,
    })).rejects.toMatchObject({ code: "idempotency_conflict" });
    const canceled = await cancelChannelConnectorRequest({ env: bindings, expectedVersion: 1, idempotencyKey: "connector-isolation-cancel", requestId: "request-isolation-cancel", requestPublicId: requestA.requestPublicId, shopPublicId: SHOP_A_PUBLIC, userId: OWNER_A, now: NOW });
    expect(canceled).toMatchObject({ status: "canceled", version: 2 });
    await expect(cancelChannelConnectorRequest({ env: bindings, expectedVersion: 2, idempotencyKey: "connector-isolation-cancel-new", requestId: "request-isolation-cancel-again", requestPublicId: requestA.requestPublicId, shopPublicId: SHOP_A_PUBLIC, userId: OWNER_A, now: NOW })).rejects.toMatchObject({ code: "channel_connector_state_conflict" });
    await expect(cancelChannelConnectorRequest({ env: bindings, expectedVersion: 1, idempotencyKey: "connector-isolation-stale", requestId: "request-isolation-stale", requestPublicId: requestB.requestPublicId, shopPublicId: SHOP_B_PUBLIC, userId: OWNER_B, now: NOW })).resolves.toMatchObject({ status: "canceled", version: 2 });

    const rawRequest = (id: string, shopId: string, providerCode: string, requestedByUserId: string) => database.prepare(`
      INSERT INTO channel_connector_requests (
        id, public_id, shop_id, channel_code, provider_code,
        requested_by_user_id, status, idempotency_key_hash, request_hash,
        created_at, updated_at, version
      ) VALUES (?, ?, ?, 'telegram.mini_app', ?, ?, 'requested', ?, ?, ?, ?, 1)
    `).run(id, id, shopId, providerCode, requestedByUserId, `${id}-key`, `${id}-request`, NOW.toISOString(), NOW.toISOString());
    expect(() => rawRequest("creq_scope_cross_tenant", SHOP_A, "telegram.mini_app", OWNER_B)).toThrow("channel_connector_request_scope_mismatch");
    expect(() => rawRequest("creq_scope_provider_pair", SHOP_A, "discord.bot", OWNER_A)).toThrow("channel_connector_request_scope_mismatch");
    expect(() => {
      database.exec(`UPDATE channel_connector_requests SET status = 'provider_pending', reviewed_by_user_id = '${OWNER_B}', reviewed_at = '${NOW.toISOString()}', version = version + 1 WHERE public_id = '${requestA.requestPublicId}'`);
    }).toThrow("channel_connector_request_reviewer_scope_mismatch");
    expect(() => rawRequest("creq_scope_unknown_channel", SHOP_A, "unknown.channel", OWNER_A)).toThrow("channel_connector_request_scope_mismatch");
    database.prepare("UPDATE shop_members SET status = 'suspended' WHERE shop_id = ? AND user_id = ?").run(SHOP_A, MANAGER_A);
    expect(() => rawRequest("creq_scope_inactive_requester", SHOP_A, "telegram.mini_app", MANAGER_A)).toThrow("channel_connector_request_scope_mismatch");
  });

  it("records billing changes without mutating the authoritative subscription", async () => {
    const plans = await listSellerBillingPlans({ env: bindings, shopPublicId: SHOP_A_PUBLIC, userId: OWNER_A });
    expect(plans.map((plan) => plan.code)).toEqual(["pro", "starter"]);
    await expect(createSubscriptionChangeRequest({ action: "change_plan", env: bindings, expectedSubscriptionVersion: 1, idempotencyKey: "billing-change-legacy", requestedPlanCode: "business", reasonCode: "seller_requested", requestId: "request-billing-legacy", shopPublicId: SHOP_A_PUBLIC, userId: OWNER_A, now: NOW })).rejects.toMatchObject({ code: "plan_not_found", status: 404 });
    const request = await createSubscriptionChangeRequest({ action: "change_plan", env: bindings, expectedSubscriptionVersion: 1, idempotencyKey: "billing-change-1", requestedPlanCode: "pro", reasonCode: "seller_requested", requestId: "request-billing", shopPublicId: SHOP_A_PUBLIC, userId: OWNER_A, now: NOW });
    expect(request).toMatchObject({ action: "change_plan", currentPlanCode: "business", requestedPlanCode: "pro", status: "requested", version: 1 });
    expect(await createSubscriptionChangeRequest({ action: "change_plan", env: bindings, expectedSubscriptionVersion: 1, idempotencyKey: "billing-change-1", requestedPlanCode: "pro", reasonCode: "seller_requested", requestId: "request-billing-retry", shopPublicId: SHOP_A_PUBLIC, userId: OWNER_A, now: NOW })).toEqual(request);
    database.prepare("UPDATE shop_subscriptions SET version = version + 1 WHERE shop_id = ?").run(SHOP_A);
    expect(await createSubscriptionChangeRequest({ action: "change_plan", env: bindings, expectedSubscriptionVersion: 1, idempotencyKey: "billing-change-1", requestedPlanCode: "pro", reasonCode: "seller_requested", requestId: "request-billing-retry-after-provider", shopPublicId: SHOP_A_PUBLIC, userId: OWNER_A, now: NOW })).toEqual(request);
    expect(database.prepare("SELECT plan_id, version FROM shop_subscriptions WHERE shop_id = ?").get(SHOP_A)).toEqual({ plan_id: "plan-ops", version: 2 });
    expect(await listSubscriptionChangeRequests({ env: bindings, shopPublicId: SHOP_A_PUBLIC, userId: OWNER_A })).toEqual([request]);
    await expect(createSubscriptionChangeRequest({ action: "cancel", env: bindings, expectedSubscriptionVersion: 1, idempotencyKey: "billing-change-1", reasonCode: "seller_requested", requestId: "request-billing-conflict", shopPublicId: SHOP_A_PUBLIC, userId: OWNER_A, now: NOW })).rejects.toMatchObject({ code: "idempotency_conflict" });
    await expect(createSubscriptionChangeRequest({ action: "cancel", env: bindings, expectedSubscriptionVersion: 1, idempotencyKey: "billing-change-pending", reasonCode: "seller_requested", requestId: "request-billing-pending", shopPublicId: SHOP_A_PUBLIC, userId: OWNER_A, now: NOW })).rejects.toMatchObject({ code: "billing_change_pending" });
    await expect(listSubscriptionChangeRequests({ env: bindings, shopPublicId: SHOP_B_PUBLIC, userId: OWNER_A })).rejects.toMatchObject({ code: "authorization_denied" });
    await expect(createSubscriptionChangeRequest({ action: "resume", env: bindings, expectedSubscriptionVersion: 1, idempotencyKey: "billing-change-resume", reasonCode: "seller_requested", requestId: "request-billing-resume", shopPublicId: SHOP_A_PUBLIC, userId: OWNER_A, now: NOW })).rejects.toMatchObject({ code: "billing_resume_provider_required" });
    await expect(createSubscriptionChangeRequest({ action: "cancel", env: bindings, expectedSubscriptionVersion: 1, idempotencyKey: "billing-manager", reasonCode: "seller_requested", requestId: "request-billing-manager", shopPublicId: SHOP_A_PUBLIC, userId: MANAGER_A, now: NOW })).rejects.toMatchObject({ code: "authorization_denied" });
  });

  it.each(["pending_payment", "suspended"] as const)("blocks direct billing change requests while subscription is %s", async (state) => {
    database.prepare("UPDATE shop_subscriptions SET state = ?, version = version + 1 WHERE shop_id = ?").run(state, SHOP_A);
    await expect(createSubscriptionChangeRequest({
      action: "change_plan",
      env: bindings,
      expectedSubscriptionVersion: 2,
      idempotencyKey: `billing-state-${state}`,
      requestedPlanCode: "pro",
      reasonCode: "seller_requested",
      requestId: `request-billing-state-${state}`,
      shopPublicId: SHOP_A_PUBLIC,
      userId: OWNER_A,
      now: NOW,
    })).rejects.toMatchObject({ code: "billing_change_requires_request", status: 409 });
  });

  it("keeps manual review requests auditable and rejects unsupported provider remediation", async () => {
    database.exec(`
      INSERT INTO payment_integrations (id, public_id, webhook_public_id, shop_id, provider, status, webhook_status, created_at, updated_at)
      VALUES ('pay-int-ops-a', 'payint_ops_a', 'webhook_ops_a', '${SHOP_A}', 'payos', 'active', 'verified', '${NOW.toISOString()}', '${NOW.toISOString()}');
      INSERT INTO payment_credentials (id, shop_id, integration_id, provider, status, version, key_version, client_id_ciphertext_b64, client_id_iv_b64, api_key_ciphertext_b64, api_key_iv_b64, checksum_key_ciphertext_b64, checksum_key_iv_b64, credential_fingerprint, created_by_user_id, created_at)
      VALUES ('pay-cred-ops-a', '${SHOP_A}', 'pay-int-ops-a', 'payos', 'active', 1, 'v1', 'x', 'x', 'x', 'x', 'x', 'x', 'fp-ops-a', '${OWNER_A}', '${NOW.toISOString()}');
      UPDATE payment_integrations SET active_credential_id = 'pay-cred-ops-a' WHERE id = 'pay-int-ops-a';
      INSERT INTO payment_attempts (id, public_id, shop_id, order_id, integration_id, credential_id, provider, provider_order_code, state, expected_amount_minor, currency, expected_description, expires_at, created_at, updated_at)
      VALUES ('pay-att-ops-a', 'payatt_ops_a', '${SHOP_A}', '${ORDER_A}', 'pay-int-ops-a', 'pay-cred-ops-a', 'payos', 771001, 'partial', 1000, 'USD', 'OPS-A-1', '2026-08-02T05:00:00.000Z', '${NOW.toISOString()}', '${NOW.toISOString()}');
      INSERT INTO payment_exceptions (id, shop_id, order_id, payment_attempt_id, type, status, safe_evidence_json, created_at)
      VALUES ('pex-ops-a', '${SHOP_A}', '${ORDER_A}', 'pay-att-ops-a', 'partial', 'open', '{"amount":500,"expectedAmount":1000}', '${NOW.toISOString()}');
    `);
    await expect(createPaymentRemediationRequest({ amountMinor: 500, currency: "USD", env: bindings, exceptionPublicId: "pex-ops-a", idempotencyKey: "payment-remediation-refund", kind: "partial_refund", reasonCode: "buyer_requested", requestId: "request-remediation-refund", shopPublicId: SHOP_A_PUBLIC, userId: OWNER_A, now: NOW })).rejects.toMatchObject({ code: "provider_unsupported", status: 503 });
    await expect(createPaymentRemediationRequest({ amountMinor: 1000, currency: "USD", env: bindings, exceptionPublicId: "pex-ops-a", idempotencyKey: "payment-remediation-refund-full", kind: "refund", reasonCode: "buyer_requested", requestId: "request-remediation-refund-full", shopPublicId: SHOP_A_PUBLIC, userId: OWNER_A, now: NOW })).rejects.toMatchObject({ code: "provider_unsupported", status: 503 });
    const request = await createPaymentRemediationRequest({ amountMinor: 0, currency: "USD", env: bindings, exceptionPublicId: "pex-ops-a", idempotencyKey: "payment-remediation-1", kind: "manual_review", reasonCode: "seller_requested", requestId: "request-remediation", shopPublicId: SHOP_A_PUBLIC, userId: OWNER_A, now: NOW });
    expect(request).toMatchObject({ amountMinor: 0, kind: "manual_review", status: "requested", version: 1 });
    const replay = await createPaymentRemediationRequest({ amountMinor: 0, currency: "USD", env: bindings, exceptionPublicId: "pex-ops-a", idempotencyKey: "payment-remediation-1", kind: "manual_review", reasonCode: "seller_requested", requestId: "request-remediation-retry", shopPublicId: SHOP_A_PUBLIC, userId: OWNER_A, now: NOW });
    expect(replay).toEqual(request);
    await expect(createPaymentRemediationRequest({ amountMinor: 0, currency: "USD", env: bindings, exceptionPublicId: "pex-ops-a", idempotencyKey: "payment-remediation-1", kind: "manual_review", reasonCode: "seller_followup", requestId: "request-remediation-conflict", shopPublicId: SHOP_A_PUBLIC, userId: OWNER_A, now: NOW })).rejects.toMatchObject({ code: "idempotency_conflict" });
    await expect(createPaymentRemediationRequest({ amountMinor: 0, currency: "USD", env: bindings, exceptionPublicId: "pex-ops-a", idempotencyKey: "payment-remediation-pending", kind: "manual_review", reasonCode: "seller_requested", requestId: "request-remediation-pending", shopPublicId: SHOP_A_PUBLIC, userId: OWNER_A, now: NOW })).rejects.toMatchObject({ code: "payment_remediation_pending" });
    await expect(listSellerPaymentRemediationRequests({ env: bindings, shopPublicId: SHOP_B_PUBLIC, userId: OWNER_B })).resolves.toEqual([]);
    const queue = await listAdminPaymentRemediationRequests({ env: bindings, status: "requested", userId: ADMIN });
    expect(queue).toEqual([expect.objectContaining({ requestPublicId: request.requestPublicId, shopPublicId: SHOP_A_PUBLIC })]);
    database.prepare("UPDATE platform_admins SET role = 'risk' WHERE user_id = ?").run(ADMIN);
    const reviewed = await reviewPaymentRemediationRequest({ decision: "provider_pending", env: bindings, expectedVersion: 1, idempotencyKey: "payment-review-1", requestPublicId: request.requestPublicId, requestId: "request-remediation-review", userId: ADMIN, now: NOW });
    expect(reviewed).toMatchObject({ status: "provider_pending", version: 2 });
    expect(await reviewPaymentRemediationRequest({ decision: "provider_pending", env: bindings, expectedVersion: 1, idempotencyKey: "payment-review-1", requestPublicId: request.requestPublicId, requestId: "request-remediation-review-retry", userId: ADMIN, now: NOW })).toEqual(reviewed);
    await expect(reviewPaymentRemediationRequest({ decision: "rejected", env: bindings, expectedVersion: 2, idempotencyKey: "payment-review-terminal", requestPublicId: request.requestPublicId, requestId: "request-remediation-terminal", userId: ADMIN, now: NOW })).rejects.toMatchObject({ code: "payment_remediation_state_conflict" });
    await expect(reviewPaymentRemediationRequest({ decision: "completed" as never, env: bindings, expectedVersion: 2, idempotencyKey: "payment-review-invalid", requestPublicId: request.requestPublicId, requestId: "request-remediation-invalid", userId: ADMIN, now: NOW })).rejects.toMatchObject({ code: "validation_failed" });
    expect(database.prepare("SELECT payment_status FROM orders WHERE id = ?").get(ORDER_A)).toEqual({ payment_status: "pending" });
    expect(() => database.prepare("DELETE FROM payment_remediation_requests WHERE id = ?").run(request.requestPublicId)).toThrow("payment_remediation_request_immutable");
  });

  it("allows only platform admins to inspect masked orders and safe audit metadata", async () => {
    await expect(listAdminOrderInvestigations({ env: bindings, filters: { cursor: null, limit: 25, paymentStatus: null, query: null, shopPublicId: null }, userId: OWNER_A })).rejects.toMatchObject({ code: "authorization_denied" });
    const orders = await listAdminOrderInvestigations({ env: bindings, filters: { cursor: null, limit: 25, paymentStatus: null, query: "OPS-A", shopPublicId: null }, userId: ADMIN });
    expect(orders.orders).toEqual([expect.objectContaining({ orderPublicId: ORDER_A_PUBLIC, shopPublicId: SHOP_A_PUBLIC, customerEmailMasked: "bu***@example.test" })]);
    const audit = await listAdminAuditEntries({ env: bindings, filters: { action: null, cursor: null, limit: 25, resourceType: null, shopPublicId: null }, userId: ADMIN });
    expect(audit.entries[0]?.metadata).toEqual({ safe: "ok" });
    expect(JSON.stringify(audit)).not.toContain("do-not-show");
    await expect(listAdminOrderInvestigations({ env: bindings, filters: { cursor: null, limit: 0, paymentStatus: null, query: null, shopPublicId: null }, userId: ADMIN })).rejects.toMatchObject({ code: "validation_failed" });
    await expect(listAdminOrderInvestigations({ env: bindings, filters: { cursor: null, limit: 25, paymentStatus: "paid%", query: null, shopPublicId: null }, userId: ADMIN })).rejects.toMatchObject({ code: "validation_failed" });
    await expect(listAdminOrderInvestigations({ env: bindings, filters: { cursor: "not-a-valid-cursor", limit: 25, paymentStatus: null, query: null, shopPublicId: null }, userId: ADMIN })).rejects.toMatchObject({ code: "validation_failed" });
    await expect(listAdminAuditEntries({ env: bindings, filters: { action: "bad action", cursor: null, limit: 25, resourceType: null, shopPublicId: null }, userId: ADMIN })).rejects.toMatchObject({ code: "validation_failed" });
    await expect(listAdminPaymentRemediationRequests({ env: bindings, status: "bad status", userId: ADMIN })).rejects.toMatchObject({ code: "validation_failed" });
  });
});
