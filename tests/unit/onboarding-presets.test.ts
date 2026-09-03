import { describe, expect, it } from "vitest";
import { ONBOARDING_PRODUCT_PRESETS, getOnboardingPresetById, presetsForVertical } from "../../src/lib/onboarding/presets";

describe("onboarding presets", () => {
  it("defines standard digital product presets without bundled license plaintext", () => {
    expect(ONBOARDING_PRODUCT_PRESETS.filter((preset) => preset.vertical === "digital").length).toBeGreaterThanOrEqual(5);

    const win11 = getOnboardingPresetById("win11pro");
    expect(win11?.title).toContain("Windows 11");
    expect(win11).not.toHaveProperty("sampleKeys");
    expect(win11?.fulfillmentType).toBe("license_key");
    expect(win11?.vertical).toBe("digital");

    const canva = getOnboardingPresetById("canva-pro");
    expect(canva?.priceMinor).toBeGreaterThan(0);

    const spotify = getOnboardingPresetById("spotify-premium");
    expect(spotify).not.toBeNull();

    const steam = getOnboardingPresetById("steam-wallet");
    expect(steam).not.toBeNull();
    expect(steam?.vertical).toBe("digital");

    const ebook = getOnboardingPresetById("ebook-course");
    expect(ebook?.fulfillmentType).toBe("manual");
  });

  it("scopes presets per selling vertical (OB-A2)", () => {
    const digital = presetsForVertical("digital");
    const physical = presetsForVertical("physical");
    const booking = presetsForVertical("booking");

    expect(digital.length).toBeGreaterThanOrEqual(5);
    expect(physical.length).toBeGreaterThanOrEqual(3);
    expect(booking.length).toBeGreaterThanOrEqual(3);

    // Every preset carries its vertical and only appears in its own bucket.
    for (const preset of ONBOARDING_PRODUCT_PRESETS) {
      expect(["digital", "physical", "booking"]).toContain(preset.vertical);
      expect(presetsForVertical(preset.vertical).some((candidate) => candidate.id === preset.id)).toBe(true);
    }
    // No source-controlled preset may carry plaintext inventory into a shop.
    for (const preset of ONBOARDING_PRODUCT_PRESETS) {
      expect(preset).not.toHaveProperty("sampleKeys");
    }
  });

  it("returns null for unknown preset ids", () => {
    expect(getOnboardingPresetById("non_existent_preset")).toBeNull();
  });
});
