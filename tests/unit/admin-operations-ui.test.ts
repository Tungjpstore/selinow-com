import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { adminCatalogs } from "../../src/lib/i18n/catalogs/admin";

describe("admin operations PromptOS surface", () => {
  it("keeps the protected navigation honest about backend coverage", async () => {
    const shell = await readFile("src/layouts/AdminLayout.astro", "utf8");
    expect(shell).toContain('t("admin.layout.nav.shops")');
    expect(shell).toContain('t("admin.layout.nav.reports")');
    expect(shell).toContain('t("admin.layout.nav.orders")');
    expect(shell).toContain('t("admin.layout.nav.appeals")');
    expect(shell).toContain('t("admin.layout.nav.operations")');
    expect(shell).toContain('t("admin.layout.nav.audit")');
    expect(adminCatalogs.en["admin.layout.nav.detail.no_investigation_api"]).toBe("Investigation API unavailable");
    expect(adminCatalogs["vi-VN"]["admin.layout.nav.detail.no_investigation_api"]).toBe("Chưa có API điều tra");
  });

  it("renders safe queue evidence and all protected action states", async () => {
    const [admin, systems, moderation, operations, operationsApi] = await Promise.all([
      readFile("src/pages/admin/index.astro", "utf8"),
      readFile("src/pages/admin/operations.astro", "utf8"),
      readFile("src/scripts/dashboard/admin-operations.ts", "utf8"),
      readFile("src/scripts/dashboard/system-operations.ts", "utf8"),
      readFile("src/pages/api/admin/operations/index.ts", "utf8"),
    ]);

    for (const source of [admin, systems]) {
      expect(source).toContain("authorization_denied");
      expect(source).toContain("no-store");
      expect(source).toContain("admin.common.reload");
    }
    expect(admin).toContain("admin.overview.reports.empty_title");
    expect(admin).toContain("data-report-status=\"triaged\"");
    expect(admin).toContain("data-action-kind=");
    expect(admin).toContain("data-manual-action-form");
    expect(admin).toContain("data-copy={JSON.stringify(clientCopy)}");
    expect(systems).toContain("data-rotation-create-form");
    expect(systems).toContain("data-rotation-process");
    expect(systems).toContain("max=\"100\"");
    expect(systems).toContain("listActiveDeletionRequests");
    expect(systems).toContain("data-deletion-legal-hold-form");
    expect(systems).toContain("data-shop-public-id");
    expect(systems).toContain("LEGAL_HOLD");
    expect(systems).toContain("RELEASE_HOLD");
    expect(systems).toContain("admin.operations.deletion.support");
    expect(systems).toContain('t("admin.operations.rotation.details")');
    expect(systems).not.toContain("Xem run details");
    expect(systems).not.toMatch(/name="(?:shopId|requestedByUserId|requestId|leaseToken|providerPayload|secretMaterialDestroyedJson)"/);
    expect(operationsApi).toContain("deletionOverview");
    expect(operationsApi).toContain("listActiveDeletionRequests({ env, userId: auth.userId })");
    expect(moderation).toContain("Idempotency-Key");
    expect(moderation).toContain("recent_auth_required");
    expect(moderation).toContain("window.confirm");
    expect(moderation).toContain('JSON.parse(root.dataset.copy ?? "{}")');
    expect(moderation).toContain("DEFAULT_COPY");
    for (const key of [
      "admin.overview.client.confirm.suspend_target",
      "admin.overview.client.error.authorization_denied",
      "admin.overview.client.error.csrf_missing",
      "admin.overview.client.error.generic",
      "admin.overview.client.error.moderation_state_conflict",
      "admin.overview.client.error.recent_auth_required",
      "admin.overview.client.feedback.applying",
      "admin.overview.client.feedback.applied",
      "admin.overview.client.manual.confirm",
      "admin.overview.client.manual.error.generic",
      "admin.overview.client.manual.error.moderation_state_conflict",
      "admin.overview.client.manual.error.recent_auth_required",
      "admin.overview.client.manual.feedback.applied",
      "admin.overview.client.manual.feedback.verifying",
      "admin.overview.client.manual.product_id_required",
      "admin.overview.client.reference.code",
      "admin.overview.client.reference.request",
    ]) {
      expect(moderation).toContain(key);
      expect(admin).toContain(key);
      expect(adminCatalogs.en[key as keyof typeof adminCatalogs.en]).toBeTypeOf("string");
      expect(adminCatalogs["vi-VN"][key as keyof typeof adminCatalogs["vi-VN"]]).toBeTypeOf("string");
    }
    expect(moderation).not.toMatch(/[À-ỹĐđ]/u);
    expect(operations).toContain("Idempotency-Key");
    expect(operations).toContain("operations_incident_conflict");
    expect(operations).toContain("shop_deletion_legal_hold_conflict");
    expect(operations).toContain("form.setAttribute(\"aria-busy\", \"true\")");
    expect(operations).toContain("control.disabled = false");
    expect(operations).toContain("delete legalHoldForm.dataset.idempotencyKey");
    expect(operations).toContain("legalHoldForm.getAttribute(\"aria-busy\") !== \"true\"");
    expect(operations).toContain("expectedConfirmation");
    expect(operations).toContain("window.confirm");
    expect(operations).not.toMatch(/name="[^"]*(?:ciphertext|plaintext|license)[^"]*"/i);
    expect(systems).toContain("listAdminOrderInvestigations");
    expect(systems).toContain("listAdminAuditEntries");
    expect(systems).toContain("data-admin-investigation-bridge");
    expect(systems).toContain("/admin/investigations?tab=orders");
    expect(systems).toContain("/admin/investigations?tab=audit");
    expect(systems).toContain("investigationUnavailable");
  });
});
