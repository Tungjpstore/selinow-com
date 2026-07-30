import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { createMarketingTranslator } from "../../src/lib/i18n/catalogs/marketing";

const workspaceSurfaces = [
  "ActionQueue",
  "ReadinessRail",
  "HealthRail",
  "ActivityLedger",
] as const;

const primitiveSurfaces = [
  "ConfirmDialog",
  "SecretField",
  "ToastRegion",
  "Skeleton",
  "Drawer",
] as const;

describe("shared surface localization", () => {
  it("keeps reusable workspace copy caller-overridable with English fallbacks", async () => {
    const sources = await Promise.all(
      workspaceSurfaces.map((name) => readFile(`src/components/workspace/${name}.astro`, "utf8")),
    );

    expect(sources[0]).toContain("severityLabels?: Partial<Record<Severity, string>>");
    expect(sources[0]).toContain('emptyLabel = "No actions require attention right now."');
    expect(sources[1]).toContain("statusLabels?: Partial<Record<StepStatus, string>>");
    expect(sources[2]).toContain("statusLabels?: Partial<Record<Health, string>>");
    expect(sources[3]).toContain('emptyLabel = "No activity in this scope yet."');

    for (const source of sources) {
      expect(source).not.toMatch(/[À-ỹ]/u);
    }
  });

  it("keeps primitive defaults safe while accepting localized labels from callers", async () => {
    const [dialog, secret, toast, skeleton, drawer] = await Promise.all(
      primitiveSurfaces.map((name) => readFile(`src/components/primitives/${name}.astro`, "utf8")),
    );

    expect(dialog).toContain("pendingLabel?: string");
    expect(dialog).toContain("root.dataset.slnPendingLabel");
    expect(secret).toContain('placeholder = "Enter a new value"');
    expect(toast).toContain('label = "Notifications"');
    expect(skeleton).toContain('label = "Loading"');
    expect(drawer).toContain("closeLabel?: string");
    expect(drawer).toContain("aria-label={closeLabel}");

    for (const source of [dialog, secret, toast, skeleton, drawer]) {
      expect(source).not.toMatch(/[À-ỹ]/u);
    }
  });

  it("sources both mobile-menu states from localized server copy", async () => {
    const [header, navigation] = await Promise.all([
      readFile("src/components/marketing/MarketingHeader.astro", "utf8"),
      readFile("src/scripts/marketing/navigation.ts", "utf8"),
    ]);

    expect(header).toContain('data-marketing-menu-close-label={t("marketing.header.menu_close")}');
    expect(header).toContain('data-marketing-menu-open-label={t("marketing.header.menu_open")}');
    expect(navigation).toContain("trigger.dataset.marketingMenuCloseLabel");
    expect(navigation).toContain("trigger.dataset.marketingMenuOpenLabel");
    expect(navigation).not.toMatch(/[À-ỹ]/u);
    expect(createMarketingTranslator("en")("marketing.header.menu_close")).toBe("Close menu");
    expect(createMarketingTranslator("vi-VN")("marketing.header.menu_close")).toBe("Đóng menu");
  });
});
