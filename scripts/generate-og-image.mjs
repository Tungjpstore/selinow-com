#!/usr/bin/env node
/**
 * Rasterize the landing v4 OG cover SVG master into the social PNG.
 *
 * Usage: node scripts/generate-og-image.mjs
 *
 * Loads the SVG in headless Chromium at exactly 1200x630 and screenshots it to
 * public/brand/selinow-og-cover-global.png. Exits non-zero with a clear message
 * when no browser is available — the previously shipped PNG is left untouched
 * so this script is always safe to fail.
 */
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const workspace = resolve(import.meta.dirname, "..");
const svgPath = resolve(workspace, "public/brand/selinow-kit/global/v4/og-cover.svg");
const pngPath = resolve(workspace, "public/brand/selinow-og-cover-global.png");

const svg = await readFile(svgPath, "utf8");

let chromium;
try {
  ({ chromium } = await import("@playwright/test"));
} catch {
  console.error("[generate-og-image] @playwright/test is not installed; skipping rasterization.");
  process.exit(1);
}

let browser;
try {
  browser = await chromium.launch();
} catch (error) {
  console.error(`[generate-og-image] Chromium is not available (${error instanceof Error ? error.message.split("\n")[0] : "unknown error"}); keeping the existing PNG.`);
  process.exit(1);
}

try {
  const page = await browser.newPage({ viewport: { height: 630, width: 1200 }, deviceScaleFactor: 1 });
  await page.setContent(`<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;padding:0;background:#0A0B12}svg{display:block}</style></head><body>${svg}</body></html>`, { waitUntil: "load" });
  await page.evaluate(() => document.fonts.ready);
  const png = await page.screenshot({ clip: { height: 630, width: 1200, x: 0, y: 0 }, type: "png" });
  await writeFile(pngPath, png);
  console.log(`[generate-og-image] wrote ${pngPath} (${png.length} bytes)`);
} finally {
  await browser.close();
}
