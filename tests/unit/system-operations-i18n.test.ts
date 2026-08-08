import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

describe("system operations client localization", () => {
  it("uses a filtered SSR copy payload with complete English fallbacks", async () => {
    const source = await readFile("src/scripts/dashboard/system-operations.ts", "utf8");
    const fallbackBlock = source.match(/const ENGLISH_COPY = \{([\s\S]*?)\} as const;/u)?.[1] ?? "";
    const fallbackKeys = [...fallbackBlock.matchAll(/^ {2}"([^"]+)":/gmu)]
      .map((match) => match[1])
      .filter((key): key is string => key !== undefined);

    expect(fallbackKeys).toHaveLength(46);
    expect(new Set(fallbackKeys).size).toBe(fallbackKeys.length);
    expect(source).toContain("root.dataset.copy");
    expect(source).toContain("copy[key] ?? ENGLISH_COPY[key]");
    expect(source).toContain("Object.hasOwn(ENGLISH_COPY, key)");
    expect(source).not.toMatch(/window\.confirm\(\s*["'`]/u);
    expect(Array.from(source).some((character) => character.charCodeAt(0) > 127)).toBe(false);
  });

  it("keeps every client-visible operation state behind the copy helper", async () => {
    const source = await readFile("src/scripts/dashboard/system-operations.ts", "utf8");
    const expectedKeys = [
      "deletion.action_invalid",
      "deletion.confirm_release",
      "deletion.confirm_set",
      "deletion.confirmation_invalid",
      "deletion.hold_released",
      "deletion.hold_releasing",
      "deletion.hold_set",
      "deletion.hold_setting",
      "deletion.hold_until_invalid",
      "deletion.version_invalid",
      "error.authentication_required",
      "error.authorization_denied",
      "error.csrf_invalid",
      "error.csrf_missing",
      "error.generic",
      "error.idempotency_conflict",
      "error.operations_incident_conflict",
      "error.operations_state_conflict",
      "error.operations_validation_failed",
      "error.recent_auth_required",
      "error.reference_code",
      "error.reference_request",
      "error.resource_not_found",
      "error.rotation_operation_pending",
      "error.rotation_state_conflict",
      "error.shop_deletion_legal_hold_conflict",
      "error.shop_deletion_not_found",
      "error.validation_failed",
      "operation.confirm_replay",
      "operation.confirm_resolve",
      "operation.replaying",
      "operation.updated",
      "operation.updating",
      "rotation.batch_invalid",
      "rotation.confirm_global",
      "rotation.confirm_live",
      "rotation.created",
      "rotation.creating",
      "rotation.processed",
      "rotation.processing",
      "rotation.shop_required",
      "payos.client_id_required",
      "payos.fingerprint_copied",
      "payos.fingerprint_copy_failed",
      "payos.fingerprint_created",
      "payos.fingerprint_creating",
    ];

    for (const key of expectedKeys) expect(source).toContain(`"${key}"`);
    expect(source).toContain("text(copy, \"deletion.confirmation_invalid\"");
    expect(source).toContain("text(copy, \"error.reference_request\"");
    expect(source).toContain("text(copy, \"operation.confirm_replay\"");
  });

  it("wires every client key from the admin translator into the operations root", async () => {
    const [page, source] = await Promise.all([
      readFile("src/pages/admin/operations.astro", "utf8"),
      readFile("src/scripts/dashboard/system-operations.ts", "utf8"),
    ]);
    const fallbackBlock = source.match(/const ENGLISH_COPY = \{([\s\S]*?)\} as const;/u)?.[1] ?? "";
    const fallbackKeys = [...fallbackBlock.matchAll(/^ {2}"([^"]+)":/gmu)]
      .map((match) => match[1])
      .filter((key): key is string => key !== undefined);

    expect(page).toContain("data-copy={JSON.stringify(operationsClientCopy)}");
    for (const key of fallbackKeys) {
      expect(page).toContain(`"${key}": t("admin.operations.client.${key}")`);
    }
  });
});
