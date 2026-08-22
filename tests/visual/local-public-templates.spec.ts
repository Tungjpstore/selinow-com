import { expect, test, type ConsoleMessage, type Page } from "@playwright/test";

/**
 * Storefront template visual regression (CD5 / VR2): every shipped template
 * renders its fixture storefront home + product detail at the two release
 * viewports, plus cart/checkout shells on one physical (aurora) and one
 * booking (serenity) representative. Baselines live next to this spec; recapture
 * only on the agreed capture machine (`--update-snapshots`).
 */

type TemplateFixture = {
  host: string;
  id: string;
  productSlug: string;
};

const fixtures: readonly TemplateFixture[] = [
  { host: "signal.localhost", id: "swift", productSlug: "signal-editor-lifetime" },
  { host: "pulse.localhost", id: "pulse", productSlug: "neon-racer-key" },
  { host: "desk.localhost", id: "desk", productSlug: "notes-suite-license" },
  { host: "aurora.localhost", id: "aurora", productSlug: "linen-overshirt" },
  { host: "metro.localhost", id: "metro", productSlug: "usbc-hub-7in1" },
  { host: "bustle.localhost", id: "bustle", productSlug: "kitchen-organizer" },
  { host: "serenity.localhost", id: "serenity", productSlug: "glow-facial-60" },
  { host: "craft.localhost", id: "craft", productSlug: "signature-cut" },
  { host: "clinic.localhost", id: "clinic", productSlug: "general-checkup" },
];

function originFor(host: string): string {
  return process.env.SELINOW_PUBLIC_BROWSER_BASE_URL?.replace("localhost", host) ?? `http://${host}:4321`;
}

function redactRuntimeMessage(value: string): string {
  return value.replace(/([?&](?:code|csrf|session|token)=)[^&\s]+/giu, "$1[redacted]");
}

function recordConsoleIssue(issues: string[], message: ConsoleMessage): void {
  if (message.type() !== "error" && message.type() !== "warning") return;
  issues.push(`${message.type()}: ${redactRuntimeMessage(message.text())}`);
}

async function expectStableWidth(page: Page, expectedWidth: number): Promise<void> {
  await page.evaluate(async () => document.fonts.ready);
  const geometry = await page.evaluate(() => {
    const wide = [...document.querySelectorAll<HTMLElement>("*")]
      .filter((element) => element.scrollWidth > document.documentElement.clientWidth + 1)
      .slice(0, 6)
      .map((element) => ({ className: element.className, scrollWidth: element.scrollWidth, tag: element.tagName }));
    return {
      bodyScrollWidth: document.body.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
      scrollWidth: document.documentElement.scrollWidth,
      wide,
    };
  });
  expect(geometry.clientWidth, JSON.stringify(geometry.wide)).toBeLessThanOrEqual(expectedWidth);
  expect(geometry.bodyScrollWidth, JSON.stringify(geometry.wide)).toBeLessThanOrEqual(expectedWidth);
  expect(geometry.scrollWidth, JSON.stringify(geometry.wide)).toBeLessThanOrEqual(expectedWidth);
}

for (const fixture of fixtures) {
  test(`template-${fixture.id} home renders its own language`, async ({ page }, testInfo) => {
    const issues: string[] = [];
    page.on("console", (message) => { recordConsoleIssue(issues, message); });
    page.on("pageerror", (error) => issues.push(`pageerror: ${redactRuntimeMessage(error.message)}`));
    const response = await page.goto(`${originFor(fixture.host)}/`);
    expect(response?.status()).toBe(200);
    await expect(page.locator("html")).toHaveAttribute("data-storefront-template", fixture.id);
    const expectedWidth = testInfo.project.use.viewport?.width;
    if (typeof expectedWidth === "number") await expectStableWidth(page, expectedWidth);
    await expect(page.locator("vite-error-overlay, astro-dev-toolbar")).toHaveCount(0);
    expect(issues).toEqual([]);
    await expect(page).toHaveScreenshot(`template-${fixture.id}-home.png`, { fullPage: true });
  });

  test(`template-${fixture.id} product detail keeps the purchase contract`, async ({ page }, testInfo) => {
    const issues: string[] = [];
    page.on("console", (message) => { recordConsoleIssue(issues, message); });
    page.on("pageerror", (error) => issues.push(`pageerror: ${redactRuntimeMessage(error.message)}`));
    const response = await page.goto(`${originFor(fixture.host)}/products/${fixture.productSlug}`);
    expect(response?.status()).toBe(200);
    await expect(page.locator("#detail-add")).toBeVisible();
    await expect(page.locator('input[name="variant"]').first()).toBeAttached();
    const expectedWidth = testInfo.project.use.viewport?.width;
    if (typeof expectedWidth === "number") await expectStableWidth(page, expectedWidth);
    // Give the snapshot re-verify poll a beat, then freeze the settled state.
    await page.waitForTimeout(600);
    expect(issues).toEqual([]);
    await expect(page).toHaveScreenshot(`template-${fixture.id}-detail.png`, { fullPage: true });
  });
}

const moneyShells: readonly TemplateFixture[] = [
  { host: "aurora.localhost", id: "aurora", productSlug: "" },
  { host: "serenity.localhost", id: "serenity", productSlug: "" },
];

for (const shell of moneyShells) {
  for (const [path, label] of [["/cart", "cart"], ["/checkout", "checkout"]] as const) {
    test(`template-${shell.id} ${label} shell stays on the shared money frame`, async ({ page }) => {
      const response = await page.goto(`${originFor(shell.host)}${path}`);
      expect(response?.status()).toBe(200);
      await expect(page.locator("main")).toBeVisible();
      await page.waitForTimeout(600);
      await expect(page).toHaveScreenshot(`template-${shell.id}-${label}.png`, { fullPage: true });
    });
  }
}
