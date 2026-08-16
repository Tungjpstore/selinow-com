#!/usr/bin/env node
/**
 * Landing v4 visual + layout smoke check (dev-time only).
 *
 * Usage: node scripts/landing-visual-check.mjs [baseOrigin]
 *
 * Captures screenshots of the marketing surfaces at the required breakpoints
 * (1440/768/390/320) in EN and VI, asserts no horizontal overflow, and reports
 * page console errors. Writes PNGs to test-results/landing-v4/.
 */
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";

const origin = process.argv[2] ?? "http://localhost:4330";
const outDir = resolve(import.meta.dirname, "../test-results/landing-v4");
await mkdir(outDir, { recursive: true });

const { chromium } = await import("@playwright/test");
const browser = await chromium.launch();
const findings = [];

const targets = [
  { name: "landing-en", path: "/" },
  { name: "landing-vi", path: "/?lang=vi-VN" },
  { name: "pricing-en", path: "/pricing" },
  { name: "pricing-vi", path: "/pricing?lang=vi-VN" },
  { name: "solutions-en", path: "/solutions" },
  { name: "solutions-vi", path: "/solutions?lang=vi-VN" },
  { name: "solution-detail-en", path: "/solutions/telegram-commerce" },
  { name: "solution-detail-vi", path: "/solutions/license-key-inventory?lang=vi-VN" },
  { name: "solution-delivery-en", path: "/solutions/digital-product-delivery" },
  { name: "legal-en", path: "/legal" },
  { name: "privacy-en", path: "/privacy" },
  { name: "support-en", path: "/support" },
];
const viewports = [
  { width: 1440, height: 1024 },
  { width: 768, height: 1024 },
  { width: 390, height: 844 },
  { width: 320, height: 568 },
];

for (const target of targets) {
  for (const viewport of viewports) {
    const page = await browser.newPage({ viewport });
    const errors = [];
    page.on("console", (message) => {
      if (message.type() === "error") errors.push(message.text());
    });
    page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));
    await page.goto(`${origin}${target.path}`, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(1200);
    // Exercise scroll so reveal/scroll-linked effects activate.
    await page.evaluate(() => window.scrollTo(0, Math.round(document.body.scrollHeight * 0.5)));
    await page.waitForTimeout(500);
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(400);

    const overflow = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
    }));
    const label = `${target.name}-${viewport.width}`;
    if (overflow.scrollWidth > overflow.clientWidth + 1) {
      findings.push(`OVERFLOW ${label}: scrollWidth ${overflow.scrollWidth} > clientWidth ${overflow.clientWidth}`);
    }
    if (errors.length > 0) {
      findings.push(`CONSOLE-ERRORS ${label}: ${errors.slice(0, 3).join(" | ")}`);
    }
    await page.screenshot({ path: resolve(outDir, `${label}.png`) });
    await page.close();
  }
}

await browser.close();
if (findings.length === 0) {
  console.log(`[landing-visual-check] OK — ${targets.length * viewports.length} captures, no overflow, no console errors. Output: ${outDir}`);
} else {
  for (const finding of findings) console.error(`[landing-visual-check] ${finding}`);
  process.exitCode = 1;
}
