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
    ]) {
      expect(adminCatalogs.en[key as keyof typeof adminCatalogs.en]).toBeTypeOf("string");
      expect(adminCatalogs["vi-VN"][key as keyof typeof adminCatalogs["vi-VN"]]).toBeTypeOf("string");
    }
  });
});
