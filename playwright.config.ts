import { defineConfig } from "@playwright/test";

export default defineConfig({
  expect: {
    toHaveScreenshot: {
      animations: "disabled",
      caret: "hide",
      maxDiffPixelRatio: 0.002,
      scale: "css",
      threshold: 0.2,
    },
  },
  fullyParallel: false,
  projects: [
    {
      name: "desktop",
      testMatch: /staging-(?:accessibility|public)\.spec\.ts$/u,
      use: { viewport: { height: 900, width: 1280 } },
    },
    {
      name: "mobile",
      testMatch: /staging-(?:accessibility|public)\.spec\.ts$/u,
      use: { viewport: { height: 844, width: 390 } },
    },
    {
      name: "kit-desktop-1440",
      testMatch: /staging-viewport-matrix\.spec\.ts$/u,
      use: { viewport: { height: 1024, width: 1440 } },
    },
    {
      name: "kit-tablet-768",
      testMatch: /staging-viewport-matrix\.spec\.ts$/u,
      use: { viewport: { height: 1024, width: 768 } },
    },
    {
      name: "kit-mobile-390",
      testMatch: /staging-viewport-matrix\.spec\.ts$/u,
      use: { viewport: { height: 844, width: 390 } },
    },
    {
      name: "kit-minimum-320",
      testMatch: /staging-viewport-matrix\.spec\.ts$/u,
      use: { viewport: { height: 844, width: 320 } },
    },
  ],
  reporter: [["list"], ["html", { open: "never" }]],
  retries: 0,
  testDir: "./tests/visual",
  timeout: 30_000,
  use: {
    baseURL: process.env.SELINOW_VISUAL_BASE_URL ?? "https://signal.staging.selinow.com",
    channel: "chrome",
    colorScheme: "light",
    contextOptions: { reducedMotion: "reduce" },
    locale: "vi-VN",
    screenshot: "only-on-failure",
    serviceWorkers: "block",
    timezoneId: "Asia/Ho_Chi_Minh",
    trace: "retain-on-failure",
  },
  workers: 1,
});
