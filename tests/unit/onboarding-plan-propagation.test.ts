import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("onboarding plan and premium-template propagation", () => {
  it("accepts only public plan codes for fresh shop creation", () => {
    const page = readFileSync("src/pages/onboarding.astro", "utf8");
    const shell = readFileSync("src/components/dashboard/onboarding/OnboardingShell.astro", "utf8");
    const quickstart = readFileSync("src/scripts/dashboard/onboarding-quickstart.ts", "utf8");

    expect(page).toContain('Astro.url.searchParams.get("plan")');
    expect(page).toContain("PUBLIC_PLAN_CODES");
    expect(page).toContain("includeCanceledForBillingRecovery: true");
    expect(page).toContain('const validRequestedPlanCode = (PUBLIC_PLAN_CODES as readonly string[]).includes');
    expect(page).toContain('billingUrl.searchParams.set("manage", "plan")');
    expect(page).toContain('billingUrl.searchParams.set("target", validRequestedPlanCode)');
    expect(page).toContain("selectedShop !== undefined && validRequestedPlanCode !== null");
    expect(page).not.toContain("selectedShop.planCode !== validRequestedPlanCode");
    expect(page).toContain("const requestedPlanCode = selectedShop === undefined");
    expect(page).toContain('const creationPlanCode: PublicPlanCode = requestedPlanCode ?? "starter"');
    expect(page).toContain("creationPremiumTemplatesEntitled");
    expect(page).toContain("PREMIUM_STOREFRONT_TEMPLATES_FEATURE");
    expect(page).toContain("sellablePublicPlanHasFeature(env, creationPlanCode");
    expect(page).not.toContain('creationPlanCode === "pro"');
    expect(page).toContain("requestedPlanCode={requestedPlanCode}");
    expect(shell).toContain('data-requested-plan-code={requestedPlanCode ?? ""}');
    expect(quickstart).toContain('root.dataset.requestedPlanCode === "pro" ? "pro" : "starter"');
    expect(quickstart).toContain("planCode: requestedPlanCode");
    expect(quickstart).not.toContain('planCode: "starter"');
  });

  it("routes every existing-shop pricing CTA through billing, including same-plan recovery", () => {
    const page = readFileSync("src/pages/onboarding.astro", "utf8");
    const quickstart = readFileSync("src/scripts/dashboard/onboarding-quickstart.ts", "utf8");
    const existingMarker = quickstart.indexOf("// Existing shop: update channels + template through their endpoints.");
    const createBranch = quickstart.slice(
      quickstart.indexOf("if (!activeShopPublicId)"),
      existingMarker,
    );
    const existingBranch = quickstart.slice(existingMarker, quickstart.indexOf("activeShopSlug = slug", existingMarker));

    expect(page).toContain("selectedShop === undefined");
    expect(createBranch).toContain("planCode: requestedPlanCode");
    expect(existingBranch).not.toContain("planCode");
    expect(existingBranch).toContain("/onboarding/channels");
    expect(existingBranch).toContain("/settings");
    expect(page).toContain('new URL("/app/billing", Astro.url.origin)');
  });

  it("locks premium radios in initial HTML and safely falls back from a locked persisted selection", () => {
    const shell = readFileSync("src/components/dashboard/onboarding/OnboardingShell.astro", "utf8");
    const storeStep = readFileSync("src/components/dashboard/onboarding/OnboardingStepStore.astro", "utf8");
    const quickstart = readFileSync("src/scripts/dashboard/onboarding-quickstart.ts", "utf8");

    expect(shell).toContain("premiumTemplatesEntitled={premiumTemplatesEntitled}");
    expect(storeStep).toContain("!persistedTemplate.premium || premiumTemplatesEntitled");
    expect(storeStep).toContain("const locked = tpl.premium && !premiumTemplatesEntitled");
    expect(storeStep).toContain('aria-disabled={locked ? "true" : undefined}');
    expect(storeStep).toContain('data-template-locked={locked ? "true" : "false"}');
    expect(storeStep).toContain("disabled={locked}");
    expect(quickstart).toContain('card.setAttribute("aria-disabled", "true")');
    expect(quickstart).toContain("radio.disabled = true");
    expect(quickstart).toContain("radio.checked = false");
    expect(quickstart).toContain("templates.find((tpl) => !tpl.premium)");
  });
});
