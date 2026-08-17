import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { adminCatalogs } from "../../src/lib/i18n/catalogs/admin";

describe("admin ops control center surface", () => {
  it("renders every overview section as a safe placeholder card with drill-down links", async () => {
    const admin = await readFile("src/pages/admin/index.astro", "utf8");
    expect(admin).toContain("data-ops-overview");
    expect(admin).toContain("data-copy={JSON.stringify(opsClientCopy)}");
    expect(admin).toContain("data-subscription-labels={JSON.stringify(opsSubscriptionLabels)}");
    // Every contract section from GET /api/admin/operations/overview is represented.
    for (const metric of [
      "deadLetters.open",
      "deadLetters.retryRequested",
      "paymentExceptions.open",
      "remediationRequests.requested",
      "remediationRequests.providerPending",
      "incidents.open",
      "incidents.acknowledged",
      "deliveryJobs.failed",
      "deliveryJobs.deadLetter",
      "providerHealth.payosActive",
      "providerHealth.telegramActive",
      "providerHealth.telegramRecentlyChecked",
    ]) {
      expect(admin).toContain(`data-ops-value="${metric}"`);
    }
    for (const card of ["deadLetters", "paymentExceptions", "remediationRequests", "incidents", "deliveryJobs", "subscriptions", "providers"]) {
      expect(admin).toContain(`data-ops-card="${card}"`);
    }
    expect(admin).toContain("data-ops-subscriptions");
    // Omitted sections render as the unknown placeholder, never NaN.
    expect(admin).toContain("{opsUnknown}");
    // Toolbar, refresh control, and bilingual 2FA enrollment banner.
    expect(admin).toContain("data-ops-refresh");
    expect(admin).toContain("data-ops-status");
    expect(admin).toContain('aria-live="polite"');
    expect(admin).toContain("data-ops-2fa");
    expect(admin).toContain('href="/app/security"');
    // Drill-down links reach the dedicated consoles.
    expect(admin).toContain('href="/admin/operations"');
    expect(admin).toContain('href="/admin/appeals"');
    expect(admin).toContain('href="/admin/investigations"');
    expect(admin).toContain('import "../../scripts/dashboard/admin-ops-overview"');
    // Existing moderation content stays integrated below the ops grid.
    expect(admin).toContain('id="reports"');
    expect(admin).toContain("data-manual-action-form");
    // Tabular figures for counts.
    expect(admin).toContain("font-variant-numeric:tabular-nums");
    // Reduced motion is respected.
    expect(admin).toContain("prefers-reduced-motion: reduce");
  });

  it("keeps the overview island honest about refresh cadence, hidden-tab pause, and 2FA gating", async () => {
    const island = await readFile("src/scripts/dashboard/admin-ops-overview.ts", "utf8");
    expect(island).toContain('const OVERVIEW_ENDPOINT = "/api/admin/operations/overview"');
    expect(island).toContain("const REFRESH_INTERVAL_MS = 30_000");
    expect(island).toContain("visibilitychange");
    expect(island).toContain("document.hidden");
    expect(island).toContain("DEFAULT_COPY");
    // Counts never become NaN: every value passes the finite guard.
    expect(island).toContain("Number.isFinite(value)");
    expect(island).toContain("Intl.NumberFormat");
    // Omitted sections resolve to null and render the unknown placeholder.
    expect(island).toContain("resolveSection(body, section)");
    expect(island).toContain("body.subscriptions === undefined");
    // 2FA enforcement surfaces the bilingual enrollment hint and pauses polling.
    expect(island).toContain('safeError.message === "admin_two_factor_required"');
    expect(island).toContain("twoFactorBlocked = true");
    expect(island).toContain("admin.ops.client.error.two_factor_required");
    expect(island).toContain("admin.ops.client.error.two_factor_hint");
    // Subscription states are allowlisted before rendering.
    expect(island).toContain("SAFE_STATE_PATTERN.test(state)");
    expect(island).not.toMatch(/[À-ỹĐđ]/u);
  });

  it("wires the audit browser filters to the native endpoint contract", async () => {
    const page = await readFile("src/pages/admin/investigations.astro", "utf8");
    // Filters match the existing GET /api/admin/investigations/audit params.
    expect(page).toContain('<input type="hidden" name="tab" value="audit"');
    expect(page).toContain('name="action"');
    expect(page).toContain('name="resourceType"');
    expect(page).toContain('name="shopPublicId"');
    expect(page).toContain("sanitizeAuditFilter");
    expect(page).toContain('pattern="[a-z0-9_.:-]{2,64}"');
    expect(page).toContain("listAdminAuditEntries");
    expect(page).toContain("action: auditAction || null");
    expect(page).toContain("resourceType: auditResourceType || null");
    // Pagination keeps the active filters and offers a way back to the first page.
    expect(page).toContain("action: auditAction, resourceType: auditResourceType, shopPublicId, cursor: auditResult.nextCursor");
    expect(page).toContain('t("admin.investigations.first")');
    expect(page).toContain("admin.investigations.pagination_aria");
    // Empty state stays in place for filtered queries.
    expect(page).toContain("admin.investigations.empty_title");
  });

  it("keeps the ops control center and audit filter copy bilingual", () => {
    for (const key of [
      "admin.investigations.filter.action",
      "admin.investigations.filter.resource_type",
      "admin.investigations.filter.audit_help",
      "admin.investigations.first",
      "admin.investigations.pagination_aria",
      "admin.ops.section.eyebrow",
      "admin.ops.section.title",
      "admin.ops.section.description",
      "admin.ops.toolbar.auto",
      "admin.ops.toolbar.refresh",
      "admin.ops.toolbar.refreshing",
      "admin.ops.client.updated",
      "admin.ops.client.loading",
      "admin.ops.client.refreshed",
      "admin.ops.client.paused",
      "admin.ops.client.error.generic",
      "admin.ops.client.error.two_factor_required",
      "admin.ops.client.error.two_factor_hint",
      "admin.ops.client.error.two_factor_link",
      "admin.ops.client.state.unknown",
      "admin.ops.card.dead_letters",
      "admin.ops.card.dead_letters.open",
      "admin.ops.card.dead_letters.retry_requested",
      "admin.ops.card.payment_exceptions",
      "admin.ops.card.payment_exceptions.open",
      "admin.ops.card.remediation",
      "admin.ops.card.remediation.requested",
      "admin.ops.card.remediation.provider_pending",
      "admin.ops.card.incidents",
      "admin.ops.card.incidents.open",
      "admin.ops.card.incidents.acknowledged",
      "admin.ops.card.delivery_jobs",
      "admin.ops.card.delivery_jobs.failed",
      "admin.ops.card.delivery_jobs.dead_letter",
      "admin.ops.card.subscriptions",
      "admin.ops.card.providers",
      "admin.ops.card.providers.payos_active",
      "admin.ops.card.providers.telegram_active",
      "admin.ops.card.providers.telegram_recent",
      "admin.ops.tone.attention",
      "admin.ops.tone.watch",
      "admin.ops.tone.nominal",
      "admin.ops.tone.unknown",
      "admin.ops.subscriptions.state_other",
      "admin.ops.link.operations",
      "admin.ops.link.appeals",
      "admin.ops.link.investigations",
      "admin.ops.drill_aria",
    ]) {
      expect(adminCatalogs.en[key as keyof typeof adminCatalogs.en]).toBeTypeOf("string");
      expect(adminCatalogs["vi-VN"][key as keyof typeof adminCatalogs["vi-VN"]]).toBeTypeOf("string");
    }
  });
});
