import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

describe("customer workspace browser contract", () => {
  it("uses the tenant-bound detail and mutation routes without exposing raw identity", async () => {
    const [page, client] = await Promise.all([
      readFile("src/pages/app/customers.astro", "utf8"),
      readFile("src/scripts/dashboard/customers.ts", "utf8"),
    ]);

    expect(page).toContain("data-customers-root");
    expect(page).toContain("data-customer-public-id");
    expect(page).toContain("data-customer-version");
    expect(page).toContain("customer.emailMasked");
    expect(page).not.toContain("customer.email}");
    expect(page).toContain("data-customer-export");
    expect(page).toContain("data-customer-anonymize-form");
    expect(page).toContain('pattern="ANONYMIZE"');
    expect(page).toContain('shop.role === "owner" || shop.role === "manager"');

    expect(client).toContain("/customers/${encodeURIComponent(publicId)}");
    expect(client).toContain("/privacy`");
    expect(client).toContain("method: \"PATCH\"");
    expect(client).toContain("method: \"POST\"");
    expect(client).toContain("method: \"DELETE\"");
    expect(client).toContain("X-CSRF-Token");
    expect(client).toContain("Idempotency-Key");
    expect(client).toContain("expectedVersion");
    expect(client).toContain('confirmation !== "ANONYMIZE"');
    expect(client).toContain("new Blob");
    expect(client).toContain("privacyRequestPublicId");
    expect(client).toContain("requestId");
    expect(client).toContain('credentials: "same-origin"');
    expect(client).toContain("textContent");
    expect(client).not.toContain("innerHTML");
  });
});
