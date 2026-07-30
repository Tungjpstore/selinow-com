import { describe, expect, it } from "vitest";

import {
  analyzeInventoryImport,
  createInventoryImportPlan,
  createInventoryPreviewToken,
  verifyInventoryPreviewToken,
} from "../../src/lib/catalog/import-preview";

const INPUT = {
  filename: null,
  hmacSecret: "inventory-fingerprint-secret",
  shopId: "shop-a",
  source: "paste" as const,
  variantId: "variant-a",
};

describe("inventory import preview", () => {
  it("reports safe accepted, rejected and duplicate counts without returning plaintext", async () => {
    const secret = "SENSITIVE-LICENSE-KEY";
    const existing = "ALREADY-IN-STOCK";
    const analysis = await analyzeInventoryImport({
      ...INPUT,
      data: `${secret}\nbad\u0001key\n${secret}\n${existing}\n`,
    });
    const existingFingerprint = analysis.entries.find((entry) => entry.plaintext === existing)?.fingerprint;
    expect(existingFingerprint).toBeTypeOf("string");
    const plan = createInventoryImportPlan(analysis, new Set([existingFingerprint ?? ""]));
    const token = await createInventoryPreviewToken({
      analysis,
      now: new Date("2026-07-26T00:00:00.000Z"),
      plan,
      sessionSecret: "session-secret",
      shopId: INPUT.shopId,
      source: INPUT.source,
      userId: "user-a",
      variantId: INPUT.variantId,
    });
    const response = { ...plan.summary, ...token };

    expect(response).toMatchObject({ acceptedCount: 1, duplicateCount: 2, rejectedCount: 1, totalCount: 4 });
    expect(JSON.stringify(response)).not.toContain(secret);
    expect(JSON.stringify(response)).not.toContain(existing);
  });

  it("binds the signed preview to payload, actor, tenant, variant and current duplicate state", async () => {
    const analysis = await analyzeInventoryImport({ ...INPUT, data: "KEY-A\nKEY-B" });
    const plan = createInventoryImportPlan(analysis, new Set());
    const { previewToken } = await createInventoryPreviewToken({
      analysis,
      now: new Date("2026-07-26T00:00:00.000Z"),
      plan,
      sessionSecret: "session-secret",
      shopId: INPUT.shopId,
      source: INPUT.source,
      userId: "user-a",
      variantId: INPUT.variantId,
    });
    const verification = {
      analysis,
      now: new Date("2026-07-26T00:01:00.000Z"),
      plan,
      previewToken,
      sessionSecret: "session-secret",
      shopId: INPUT.shopId,
      source: INPUT.source,
      userId: "user-a",
      variantId: INPUT.variantId,
    };

    await expect(verifyInventoryPreviewToken(verification)).resolves.toBeUndefined();
    await expect(verifyInventoryPreviewToken({ ...verification, shopId: "shop-b" })).rejects.toMatchObject({ code: "inventory_preview_mismatch" });
    await expect(verifyInventoryPreviewToken({ ...verification, userId: "user-b" })).rejects.toMatchObject({ code: "inventory_preview_mismatch" });
    await expect(verifyInventoryPreviewToken({ ...verification, variantId: "variant-b" })).rejects.toMatchObject({ code: "inventory_preview_mismatch" });

    const changedAnalysis = await analyzeInventoryImport({ ...INPUT, data: "KEY-A\nKEY-C" });
    await expect(verifyInventoryPreviewToken({
      ...verification,
      analysis: changedAnalysis,
      plan: createInventoryImportPlan(changedAnalysis, new Set()),
    })).rejects.toMatchObject({ code: "inventory_preview_mismatch" });

    const stalePlan = createInventoryImportPlan(analysis, new Set([analysis.entries[0]?.fingerprint ?? ""]));
    await expect(verifyInventoryPreviewToken({ ...verification, plan: stalePlan })).rejects.toMatchObject({ code: "inventory_preview_mismatch" });
  });

  it("rejects tampered and expired preview tokens without exposing input", async () => {
    const plaintext = "DO-NOT-ECHO";
    const analysis = await analyzeInventoryImport({ ...INPUT, data: plaintext });
    const plan = createInventoryImportPlan(analysis, new Set());
    const { previewToken } = await createInventoryPreviewToken({
      analysis,
      now: new Date("2026-07-26T00:00:00.000Z"),
      plan,
      sessionSecret: "session-secret",
      shopId: INPUT.shopId,
      source: INPUT.source,
      userId: "user-a",
      variantId: INPUT.variantId,
    });
    const verification = {
      analysis,
      plan,
      previewToken,
      sessionSecret: "session-secret",
      shopId: INPUT.shopId,
      source: INPUT.source,
      userId: "user-a",
      variantId: INPUT.variantId,
    };

    const tamperedSuffix = previewToken.endsWith("a") ? "b" : "a";
    await expect(verifyInventoryPreviewToken({ ...verification, previewToken: `${previewToken.slice(0, -1)}${tamperedSuffix}` })).rejects.toMatchObject({ code: "inventory_preview_invalid" });
    let expired: unknown;
    try {
      await verifyInventoryPreviewToken({ ...verification, now: new Date("2026-07-26T00:16:00.000Z") });
    } catch (error) {
      expired = error;
    }
    expect(expired).toMatchObject({ code: "inventory_preview_expired" });
    expect(JSON.stringify(expired)).not.toContain(plaintext);
  });
});
