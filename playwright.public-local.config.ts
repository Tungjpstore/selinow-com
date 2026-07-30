import { defineConfig } from "@playwright/test";

import { validateLocalPublicBrowserBaseUrl } from "./scripts/lib/local-public-browser-gate.mjs";

const baseURL = validateLocalPublicBrowserBaseUrl(
  process.env.SELINOW_PUBLIC_BROWSER_BASE_URL ?? "http://localhost:4321",
);

export default defineConfig({
  expect: {
    toHaveScreenshot: {
      animations: "disabled",
      caret: "hide",
      maxDiffPixelRatio: 0.005,
      scale: "css",
      threshold: 0.2,
    },
  },
  fullyParallel: false,
  outputDir: "./test-results/public-local",
  preserveOutput: "never",
  projects: [
    {
      name: "public-desktop-1440",
      testMatch: /local-public\.spec\.ts$/u,
      use: { viewport: { height: 1024, width: 1440 } },
    },
    {
      name: "public-mobile-390",
      testMatch: /local-public\.spec\.ts$/u,
      use: { viewport: { height: 844, width: 390 } },
    },
  ],
  reporter: [
    ["list"],
    ["./scripts/playwright-safe-failure-reporter.mjs", {
      outputPath: "test-results/public-local-safe-failures.json",
    }],
  ],
  retries: 0,
  testDir: "./tests/visual",
  timeout: 45_000,
  use: {
    actionTimeout: 10_000,
    baseURL,
    channel: "chrome",
    colorScheme: "light",
    contextOptions: { reducedMotion: "reduce" },
    launchOptions: {
      args: ["--host-resolver-rules=MAP localhost 127.0.0.1,MAP app.localhost 127.0.0.1,MAP signal.localhost 127.0.0.1,MAP api.localhost 127.0.0.1"],
    },
    locale: "vi-VN",
    navigationTimeout: 15_000,
    screenshot: "off",
    serviceWorkers: "block",
    timezoneId: "Asia/Ho_Chi_Minh",
    trace: "off",
    video: "off",
  },
  workers: 1,
});
