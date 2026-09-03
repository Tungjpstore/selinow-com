import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { getCatalogParity } from "../../src/lib/i18n/catalog";
import { systemCatalogs } from "../../src/lib/i18n/catalogs/system";

const primitives = [
  "Button",
  "IconButton",
  "LinkButton",
  "Input",
  "SecretField",
  "SelectField",
  "Alert",
  "ConfirmDialog",
  "Drawer",
  "ToastRegion",
  "Skeleton",
] as const;

const states = [
  "EmptyState",
  "PermissionState",
  "PlanLimitState",
  "SuspendedState",
] as const;

describe("PromptOS frontend foundation", () => {
  it("provides the required typed primitive and state component manifest", async () => {
    const files = await Promise.all([
      ...primitives.map((name) => readFile(`src/components/primitives/${name}.astro`, "utf8")),
      ...states.map((name) => readFile(`src/components/states/${name}.astro`, "utf8")),
    ]);

    expect(files).toHaveLength(primitives.length + states.length);
    for (const source of files) expect(source).toContain("interface Props");
  });

  it("keeps fields labelled, secret values unprefilled and async feedback explicit", async () => {
    const [input, secret, select, alert, toast] = await Promise.all([
      readFile("src/components/primitives/Input.astro", "utf8"),
      readFile("src/components/primitives/SecretField.astro", "utf8"),
      readFile("src/components/primitives/SelectField.astro", "utf8"),
      readFile("src/components/primitives/Alert.astro", "utf8"),
      readFile("src/components/primitives/ToastRegion.astro", "utf8"),
    ]);

    for (const source of [input, secret, select]) {
      expect(source).toContain("aria-describedby={describedBy}");
      expect(source).toContain("aria-label={label}");
      expect(source).toContain('class="sln-field__label"');
    }
    expect(secret).not.toMatch(/interface Props[\s\S]*\bvalue\??:/u);
    expect(secret).not.toContain("value={");
    expect(secret).toContain("The current value is not shown again");
    expect(alert).toContain('aria-atomic="true"');
    expect(toast).toContain("aria-live={politeness}");
  });

  it("preserves dialog focus, drawer scroll lock and loading button width", async () => {
    const [dialog, drawer, primitivesCss] = await Promise.all([
      readFile("src/components/primitives/ConfirmDialog.astro", "utf8"),
      readFile("src/components/primitives/Drawer.astro", "utf8"),
      readFile("src/styles/primitives.css", "utf8"),
    ]);

    expect(dialog).toContain("dialog.showModal()");
    expect(dialog).toContain("trigger.focus()");
    expect(dialog).toContain('value="confirm"');
    expect(dialog).toContain("if (pending) return;");
    expect(dialog).toContain("event.preventDefault()");
    expect(dialog).toContain("detail: { complete, fail }");
    expect(dialog).toContain('dialog.setAttribute("aria-busy", String(value))');
    expect(drawer).toContain('document.documentElement.dataset.slnScrollLock = "true"');
    expect(drawer).toContain("delete document.documentElement.dataset.slnScrollLock");
    expect(drawer).toContain("trigger.focus()");
    expect(primitivesCss).toContain('.sln-button[data-loading="true"] .sln-button__content { visibility: hidden; }');
  });

  it("keeps canonical workspace states, roles and contrast-safe control boundaries", async () => {
    const [statePanel, workspaceState, primitivesCss, dataTable, login, tokens] = await Promise.all([
      readFile("src/components/states/StatePanel.astro", "utf8"),
      readFile("src/components/states/WorkspaceState.astro", "utf8"),
      readFile("src/styles/primitives.css", "utf8"),
      readFile("src/components/workspace/DataTable.astro", "utf8"),
      readFile("src/pages/login.astro", "utf8"),
      readFile("src/styles/selinow-tokens.css", "utf8"),
    ]);

    for (const state of ["blocked", "empty", "error", "forbidden", "loading", "plan_limited", "success", "suspended", "waiting_provider", "waiting_user", "warning"]) {
      expect(statePanel).toContain(`| "${state}"`);
    }
    expect(statePanel).toContain('["blocked", "error", "forbidden", "suspended"]');
    expect(workspaceState).toContain("state?: State;");
    expect(workspaceState).toContain('info: "empty"');
    expect(primitivesCss).toContain('border-color: var(--sln-slate-500)');
    expect(dataTable).toContain("color: var(--sln-text-secondary)");
    expect(login).toContain("color: var(--sln-success-text)");
    expect(login).toContain("color: var(--sln-danger-text)");
    expect(tokens).toContain("--sln-state-danger: #dc2626;");
    expect(tokens).not.toContain("--selinow-");
  });

  it("uses localized canonical payment and fulfillment copy", async () => {
    const [payment, fulfillment] = await Promise.all([
      readFile("src/components/commerce/PaymentState.astro", "utf8"),
      readFile("src/components/commerce/FulfillmentState.astro", "utf8"),
    ]);

    for (const key of [
      "status.payment.unpaid",
      "status.payment.pending",
      "status.payment.paid",
      "status.payment.failed",
      "status.payment.expired",
      "status.payment.canceled",
    ]) expect(payment).toContain(key);
    for (const key of [
      "status.fulfillment.unfulfilled",
      "status.fulfillment.processing",
      "status.fulfillment.fulfilled",
      "status.fulfillment.failed",
      "status.fulfillment.manual_review",
      "status.fulfillment.canceled",
    ]) expect(fulfillment).toContain(key);

    expect(systemCatalogs.en["status.payment.paid"]).toBe("Payment confirmed");
    expect(systemCatalogs["vi-VN"]["status.payment.paid"]).toBe("Đã xác nhận thanh toán");
    expect(systemCatalogs.en["status.fulfillment.fulfilled"]).toBe("Delivered");
    expect(systemCatalogs["vi-VN"]["status.fulfillment.fulfilled"]).toBe("Đã giao hàng");
    expect(getCatalogParity(systemCatalogs)).toEqual({
      extra: { en: [], "vi-VN": [] },
      missing: { en: [], "vi-VN": [] },
    });
  });

  it("imports canonical foundation styles in every surface layout", async () => {
    const layouts = await Promise.all([
      "AppLayout",
      "PlatformLayout",
      "StorefrontLayout",
      "AdminLayout",
    ].map((name) => readFile(`src/layouts/${name}.astro`, "utf8")));

    for (const layout of layouts) {
      expect(layout).toContain('import "../styles/selinow-tokens.css";');
      expect(layout).toContain('import "../styles/base.css";');
      expect(layout).toContain('import "../styles/primitives.css";');
      expect(layout).toContain('import "../styles/selinow-a11y.css";');
    }
  });

  it("provides the 320px and responsive record-list contracts without raw colors", async () => {
    const [base, primitivesCss, dataTable] = await Promise.all([
      readFile("src/styles/base.css", "utf8"),
      readFile("src/styles/primitives.css", "utf8"),
      readFile("src/components/workspace/DataTable.astro", "utf8"),
    ]);

    expect(base).toContain("min-width: 320px;");
    expect(dataTable).toContain("content: attr(data-label);");
    expect(dataTable).toContain("@media (max-width: 720px)");
    for (const source of [base, primitivesCss, dataTable]) {
      expect(source).not.toMatch(/#[0-9a-f]{3,8}\b/iu);
      expect(source).not.toMatch(/rgba?\(/iu);
    }
  });
});
