import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { adminCatalogs } from "../../src/lib/i18n/catalogs/admin";

describe("admin appeals review surface", () => {
  it("wires the audited remediation list and guarded review controls", async () => {
    const [page, script, layout] = await Promise.all([
      readFile("src/pages/admin/appeals.astro", "utf8"),
      readFile("src/scripts/dashboard/admin-appeals.ts", "utf8"),
      readFile("src/layouts/AdminLayout.astro", "utf8"),
    ]);
    expect(page).toContain("listAdminPaymentRemediationRequests");
    expect(page).toContain("data-admin-appeals");
    expect(page).toContain("data-appeal-decision=\"provider_pending\"");
    expect(page).toContain("admin.appeals.read_only_note");
    expect(script).toContain("/api/admin/appeals/");
    expect(script).toContain("X-CSRF-Token");
    expect(script).toContain("Idempotency-Key");
    expect(script).toContain("expectedVersion");
    expect(layout).toContain('path: "/admin/appeals"');
  });

  it("admits terminal decisions only for role-gated provider_pending rows and requires a failure code", async () => {
    const [page, script] = await Promise.all([
      readFile("src/pages/admin/appeals.astro", "utf8"),
      readFile("src/scripts/dashboard/admin-appeals.ts", "utf8"),
    ]);
    // Island admission covers all four decisions.
    expect(script).toContain('"provider_pending", "rejected", "completed", "failed"');
    expect(script).toContain("isDecision(decision)");
    // failed decisions must carry a sanitized failureCode in the PATCH body.
    expect(script).toContain("sanitizeFailureCode");
    expect(script).toContain("{ decision, expectedVersion, failureCode }");
    expect(script).toContain('pending.decision === "failed"');
    // Page renders terminal buttons only for owner/risk on provider_pending rows.
    expect(page).toContain('canReview && request.status === "provider_pending"');
    expect(page).toContain("data-appeal-decision=\"completed\"");
    expect(page).toContain("data-appeal-decision=\"failed\"");
    expect(page).toContain("data-appeal-failure-code-input");
    // Role gate stays owner/risk.
    expect(page).toContain('const canReview = adminRole === "owner" || adminRole === "risk";');
  });

  it("stores per-decision idempotency keys on each appeal row so retries never replay a consumed key", async () => {
    const script = await readFile("src/scripts/dashboard/admin-appeals.ts", "utf8");
    // One storage slot per row AND decision, keyed by the decision suffix.
    expect(script).toContain("const storageKey = `idempotencyKey_${decision}`;");
    expect(script).toContain("const existing = row.dataset[storageKey];");
    expect(script).toContain("row.dataset[storageKey] = key;");
    // Keys embed the decision so distinct decisions never share a consumed key.
    expect(script).toContain("const key = `appeal_${decision}_${crypto.randomUUID()}`;");
    // The cached key is the one sent to the guarded review endpoint.
    expect(script).toContain('"Idempotency-Key": keyFor(row, decision)');
    // All four decision-suffixed storage slots derive from the decision set.
    expect(script).toContain('const DECISIONS: readonly Decision[] = ["provider_pending", "rejected", "completed", "failed"];');
    for (const decision of ["provider_pending", "rejected", "completed", "failed"]) {
      expect(script).toContain(`"${decision}"`);
    }
  });

  it("keeps the review copy bilingual", () => {
    for (const key of [
      "admin.appeals.title",
      "admin.appeals.description",
      "admin.appeals.status.requested",
      "admin.appeals.status.provider_pending",
      "admin.appeals.approve",
      "admin.appeals.reject",
      "admin.appeals.error_conflict",
      "admin.appeals.read_only_note",
      "admin.appeals.terminal.complete",
      "admin.appeals.terminal.mark_failed",
      "admin.appeals.terminal.confirm_complete",
      "admin.appeals.terminal.confirm_failed",
      "admin.appeals.terminal.failure_code_label",
      "admin.appeals.terminal.failure_code_required",
      "admin.appeals.terminal.error_forbidden",
    ]) {
      expect(adminCatalogs.en[key as keyof typeof adminCatalogs.en]).toBeTypeOf("string");
      expect(adminCatalogs["vi-VN"][key as keyof typeof adminCatalogs["vi-VN"]]).toBeTypeOf("string");
    }
  });
});
