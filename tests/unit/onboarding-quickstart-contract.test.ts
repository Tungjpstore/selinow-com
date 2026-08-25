import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

describe("onboarding quickstart API contracts", () => {
  it("creates custom products through the authenticated products endpoint", async () => {
    const script = await readFile("src/scripts/dashboard/onboarding-quickstart.ts", "utf8");

    expect(script).toContain("/products`");
    expect(script).not.toContain("/catalog/products`");
  });

  it("connects PayOS through the canonical payment integration contract", async () => {
    const script = await readFile("src/scripts/dashboard/onboarding-quickstart.ts", "utf8");

    expect(script).toMatch(/\/payments\/payos`, \{[\s\S]{0,250}method: "PUT"/u);
    expect(script).not.toContain("/integrations/payos`");
  });

  it("updates onboarding settings with the route-supported method", async () => {
    const script = await readFile("src/scripts/dashboard/onboarding-quickstart.ts", "utf8");

    expect(script).toContain("/onboarding/settings`");
    expect(script).toMatch(/\/onboarding\/settings`,[\s\S]{0,600}method: "PUT"/u);
    expect(script).toContain("policyAttestationVersion !== null && policyAttestationInput?.checked === true");
    expect(script).toContain("attestationVersion: attestationAccepted ? policyAttestationVersion : null");
  });

  it("fails the quickstart publish UI closed while platform policy is unpublished", async () => {
    const [page, shell, step, script] = await Promise.all([
      readFile("src/pages/onboarding.astro", "utf8"),
      readFile("src/components/dashboard/onboarding/OnboardingShell.astro", "utf8"),
      readFile("src/components/dashboard/onboarding/OnboardingStepLaunch.astro", "utf8"),
      readFile("src/scripts/dashboard/onboarding-quickstart.ts", "utf8"),
    ]);

    expect(page).toContain("CURRENT_POLICY_ATTESTATION_VERSION");
    expect(shell).toContain("data-policy-attestation-published");
    expect(step).toContain("Mở bán đang chờ chính sách nền tảng");
    expect(step).toContain("bắt buộc trước khi mở bán");
    expect(step).not.toContain("(không bắt buộc)");
    expect(script).toContain("publishBtn.disabled = policyAttestationVersion === null");
  });

  it("keeps existing-shop mutations on their canonical route methods and persists the profile", async () => {
    const [script, profileRoute] = await Promise.all([
      readFile("src/scripts/dashboard/onboarding-quickstart.ts", "utf8"),
      readFile("src/pages/api/app/shops/[shopPublicId].ts", "utf8"),
    ]);

    expect(script).toMatch(/\/onboarding\/channels`, \{[\s\S]{0,450}method: "PUT"/u);
    expect(script).toContain("/api/app/shops/${encodeURIComponent(activeShopPublicId)}");
    expect(script).toMatch(/\/api\/app\/shops\/\$\{encodeURIComponent\(activeShopPublicId\)\}`, \{[\s\S]{0,500}method: "PATCH"/u);
    expect(script).not.toMatch(/settings`,[\s\S]{0,500}\.catch\(\(\) => undefined\)/u);
    expect(profileRoute).toContain('"name", "slug"');
    expect(profileRoute).toContain("normalizeSlug(body.slug)");
  });

  it("preserves an allow-listed pricing plan through new-shop creation", async () => {
    const [page, shell, script] = await Promise.all([
      readFile("src/pages/onboarding.astro", "utf8"),
      readFile("src/components/dashboard/onboarding/OnboardingShell.astro", "utf8"),
      readFile("src/scripts/dashboard/onboarding-quickstart.ts", "utf8"),
    ]);

    expect(page).toContain('Astro.url.searchParams.get("plan")');
    expect(page).toContain("PUBLIC_PLAN_CODES");
    expect(shell).toContain('data-requested-plan-code={requestedPlanCode ?? ""}');
    expect(script).toContain('root.dataset.requestedPlanCode === "pro" ? "pro" : "starter"');
    expect(script).not.toContain('new URLSearchParams(window.location.search).get("plan")');
    expect(script).toContain("planCode: requestedPlanCode");
    expect(script).not.toContain('planCode: "starter"');
  });

  it("uses stable per-step intent keys for retries instead of timestamp keys", async () => {
    const [script, seedRoute] = await Promise.all([
      readFile("src/scripts/dashboard/onboarding-quickstart.ts", "utf8"),
      readFile("src/pages/api/app/shops/[shopPublicId]/onboarding/seed-preset.ts", "utf8"),
    ]);

    expect(script).toContain("sessionStorage");
    expect(script).toContain("stableIntentKey");
    expect(script).toContain("crypto.subtle.digest");
    expect(script).toContain("namespace.slice(0, 40)");
    expect(script).not.toMatch(/Idempotency-Key.*Date\.now\(\)/u);
    expect(script).toContain('"Idempotency-Key": shopIntentKey');
    expect(seedRoute).toContain('request.headers.get("Idempotency-Key")');
  });

  it("keeps required store identity visible and manual preset summaries truthful", async () => {
    const script = await readFile("src/scripts/dashboard/onboarding-quickstart.ts", "utf8");

    expect(script).toContain("nameInput.setCustomValidity");
    expect(script).toContain("nameInput.focus()");
    expect(script).toContain('nameInput.setAttribute("aria-invalid", "true")');
    expect(script).toContain("seedData.product?.fulfillmentType === \"manual\"");
  });

  it("publishes with the latest numeric storefront settings version", async () => {
    const script = await readFile("src/scripts/dashboard/onboarding-quickstart.ts", "utf8");

    expect(script).toContain("let storefrontVersion = resume?.storefrontVersion ?? 1;");
    expect(script).toContain("expectedVersion: storefrontVersion, templateId: chosenTemplate");
    expect(script).toContain("storefrontVersion = settingsVersion;");
    expect(script).toContain("JSON.stringify({ expectedVersion: storefrontVersion })");
    expect(script).not.toContain("JSON.stringify({}), method: \"POST\"");
    expect(script).toContain("publishedProjection(res.data)");
    expect(script).not.toContain("finally {\n        publishBtn.disabled = false;\n        completeAndCelebrate();");
  });
});
