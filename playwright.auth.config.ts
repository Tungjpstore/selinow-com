import { defineConfig } from "@playwright/test";

import { validateLocalBrowserBaseUrl } from "./scripts/lib/local-auth-browser-gate.mjs";

const baseURL = validateLocalBrowserBaseUrl(
  process.env.SELINOW_AUTH_BROWSER_BASE_URL ?? "http://app.localhost:4321",
);

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
  outputDir: "./test-results/authenticated",
  preserveOutput: "never",
  projects: [
    {
      name: "desktop",
      testMatch: /local-authenticated\.spec\.ts$/u,
      use: { viewport: { height: 1024, width: 1440 } },
    },
    {
      name: "mobile",
      testMatch: /local-authenticated\.spec\.ts$/u,
      use: { viewport: { height: 844, width: 390 } },
    },
    {
      name: "kit-auth-desktop-1440",
      testMatch: /local-authenticated-viewport-matrix\.spec\.ts$/u,
      use: { viewport: { height: 1024, width: 1440 } },
    },
    {
      name: "kit-auth-tablet-768",
      testMatch: /local-authenticated-viewport-matrix\.spec\.ts$/u,
      use: { viewport: { height: 1024, width: 768 } },
    },
    {
      name: "kit-auth-mobile-390",
      testMatch: /local-authenticated-viewport-matrix\.spec\.ts$/u,
      use: { viewport: { height: 844, width: 390 } },
    },
    {
      name: "kit-auth-minimum-320",
      testMatch: /local-authenticated-viewport-matrix\.spec\.ts$/u,
      use: { viewport: { height: 844, width: 320 } },
    },
  ],
  reporter: [
    ["list"],
    ["./scripts/playwright-safe-failure-reporter.mjs"],
  ],
  retries: 0,
  testDir: "./tests/authenticated",
  timeout: 45_000,
  use: {
    actionTimeout: 10_000,
    baseURL,
    channel: "chrome",
    colorScheme: "light",
    contextOptions: { reducedMotion: "reduce" },
    locale: "vi-VN",
    launchOptions: {
      args: ["--host-resolver-rules=MAP app.localhost 127.0.0.1,MAP api.localhost 127.0.0.1"],
    },
    navigationTimeout: 15_000,
    screenshot: "off",
    serviceWorkers: "block",
    timezoneId: "Asia/Ho_Chi_Minh",
    trace: "off",
    video: "off",
  },
  workers: 1,
});
