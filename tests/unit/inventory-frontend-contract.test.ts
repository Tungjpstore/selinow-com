import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

describe("inventory frontend contract", () => {
  it("evaluates health against each variant threshold and exposes safe filters", async () => {
    const [page, script] = await Promise.all([
      readFile("src/pages/app/inventory.astro", "utf8"),
      readFile("src/scripts/dashboard/inventory.ts", "utf8"),
    ]);

    expect(page).toContain("const thresholdOf =");
    expect(page).toContain("stock <= thresholdOf(variant)");
    expect(page).not.toContain("variants[0]?.lowStockThreshold");
    expect(page).toContain('data-inventory-filter="low"');
    expect(page).toContain('data-inventory-filter="out"');
    expect(page).toContain("data-inventory-health={health}");
    expect(page).toContain('t("dashboard.inventory.ledger.record_count")');
    expect(script).toContain('querySelectorAll<HTMLElement>("[data-inventory-health]")');
    expect(script).toContain("row.hidden = !visible");
  });

  it("binds preview and idempotency state to the current import form context", async () => {
    const script = await readFile("src/scripts/dashboard/inventory.ts", "utf8");

    expect(script).toContain("const invalidatePreview =");
    expect(script).toContain("previewToken = null");
    expect(script).toContain("idempotencyKey = null");
    expect(script).toContain('form.addEventListener("input", handlePreviewContextChange)');
    expect(script).toContain('form.addEventListener("change", handlePreviewContextChange)');
    expect(script).toContain('target.name === "variantId"');
    expect(script).toContain('target.name === "source"');
    expect(script).toContain("const tokenForRequest = previewToken");
    expect(script).toContain("const keyForRequest = idempotencyKey");
  });

  it("erases plaintext and locks every dialog control around requests", async () => {
    const [page, script] = await Promise.all([
      readFile("src/pages/app/inventory.astro", "utf8"),
      readFile("src/scripts/dashboard/inventory.ts", "utf8"),
    ]);

    expect(page).toContain('data-import-form aria-busy="false"');
    expect(script).toContain("const eraseImportForm =");
    expect(script).toContain('form.elements.namedItem("data")');
    expect(script).toContain('data.delete("data")');
    expect(script).toContain('requestBody.data = ""');
    expect(script.match(/catch \(error\) \{[\s\S]*?eraseImportForm\(\);[\s\S]*?invalidatePreview\(\);/gu)).toHaveLength(2);
    expect(script).toContain('dialog.addEventListener("cancel"');
    expect(script).toContain('dialog.addEventListener("close", resetDialogState)');
    expect(script).toContain("if (pendingAction !== null) return false");
    expect(script).toContain('form.setAttribute("aria-busy", "true")');
    expect(script).toContain("control.disabled = true");
    expect(script).toContain('lockDialog("preview")');
    expect(script).toContain('lockDialog("import")');
  });

  it("clears onboarding inventory plaintext after an import error", async () => {
    const script = await readFile("src/scripts/dashboard/onboarding.ts", "utf8");

    expect(script).toMatch(/catch \(error\) \{\n {8}if \(!selectionIsCurrent\(state, shop\.publicId, selectionEpoch\)\) return;\n {8}if \(inventoryData !== null\) inventoryData\.value = "";\n {8}updateLocalInventoryPreview\(root\);\n {8}invalidateInventoryPreview\(root, state, copy\("onboarding\.feedback\.import_expired"/u);
  });

  it("clears onboarding inventory plaintext after a preview error", async () => {
    const script = await readFile("src/scripts/dashboard/onboarding.ts", "utf8");

    expect(script).toMatch(/catch \(error\) \{\n {8}if \(!selectionIsCurrent\(state, shop\.publicId, selectionEpoch\)\) return;\n {8}if \(inventoryData !== null\) inventoryData\.value = "";\n {8}updateLocalInventoryPreview\(root\);\n {8}invalidateInventoryPreview\(root, state, copy\("onboarding\.feedback\.inventory_preview_failed"/u);
  });

  it("maps safe API errors and reports authoritative import counts", async () => {
    const [page, script] = await Promise.all([
      readFile("src/pages/app/inventory.astro", "utf8"),
      readFile("src/scripts/dashboard/inventory.ts", "utf8"),
    ]);

    expect(page).toContain('t("dashboard.inventory.forbidden.description")');
    expect(page).not.toContain("Bạn vẫn có thể xem sức khỏe kho");
    expect(script).toContain("class InventoryApiError extends Error");
    expect(script).toContain("recent_auth_required:");
    expect(script).toContain("safeRequestId(object.requestId)");
    expect(script).toContain('t("dashboard.inventory.client.request_id"');
    expect(script).toContain("counts.acceptedCount");
    expect(script).toContain("counts.duplicateCount");
    expect(script).toContain("counts.rejectedCount");
    expect(script).toContain("result.replayed === true");
    expect(script).not.toContain("Preview thất bại (${error.message})");
  });
});
