import { describe, expect, it } from "vitest";
import { ONBOARDING_PRODUCT_PRESETS, getOnboardingPresetById } from "../../src/lib/onboarding/presets";

describe("onboarding presets", () => {
  it("defines standard digital product presets with sample keys", () => {
    expect(ONBOARDING_PRODUCT_PRESETS.length).toBeGreaterThanOrEqual(5);

    const win11 = getOnboardingPresetById("win11pro");
    expect(win11).toBeDefined();
    expect(win11?.title).toContain("Windows 11");
    expect(win11?.sampleKeys.length).toBeGreaterThan(0);
    expect(win11?.fulfillmentType).toBe("license_key");

    const canva = getOnboardingPresetById("canva-pro");
    expect(canva).toBeDefined();
    expect(canva?.priceMinor).toBeGreaterThan(0);

    const spotify = getOnboardingPresetById("spotify-premium");
    expect(spotify).toBeDefined();

    const steam = getOnboardingPresetById("steam-wallet");
    expect(steam).toBeDefined();

    const ebook = getOnboardingPresetById("ebook-course");
    expect(ebook).toBeDefined();
    expect(ebook?.fulfillmentType).toBe("manual");
  });

  it("returns null for unknown preset ids", () => {
    expect(getOnboardingPresetById("non_existent_preset")).toBeNull();
  });
});
