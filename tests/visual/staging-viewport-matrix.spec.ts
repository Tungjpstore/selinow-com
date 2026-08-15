import { expect, test, type Page } from "@playwright/test";

import { signalVisualProduct } from "./staging-contract";

const routes = [
  {
    heading: "Công cụ sắc gọn cho một ngày làm việc sâu.",
    path: "/",
  },
  {
    heading: signalVisualProduct.heading,
    path: signalVisualProduct.path,
  },
] as const;

function isAllowedTurnstileMutation(requestUrl: URL, method: string): boolean {
  return method === "POST"
    && requestUrl.protocol === "https:"
    && requestUrl.hostname === "challenges.cloudflare.com"
    && requestUrl.pathname.startsWith("/cdn-cgi/challenge-platform/");
}

async function expectStablePage(page: Page, expectedWidth: number): Promise<void> {
  await page.evaluate(async () => document.fonts.ready);
  const geometry = await page.evaluate(() => ({
    bodyScrollWidth: document.body.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
    innerWidth: window.innerWidth,
    scrollWidth: document.documentElement.scrollWidth,
  }));

  expect(geometry.innerWidth).toBe(expectedWidth);
  expect(geometry.clientWidth).toBeLessThanOrEqual(geometry.innerWidth);
  expect(geometry.bodyScrollWidth).toBeLessThanOrEqual(geometry.innerWidth);
  expect(geometry.scrollWidth).toBeLessThanOrEqual(geometry.innerWidth);
}

test("public storefront remains stable across the PromptOS viewport matrix", async ({ page }, testInfo) => {
  const expectedWidth = testInfo.project.use.viewport?.width;
  if (typeof expectedWidth !== "number") throw new Error("viewport_matrix_width_missing");
  const storefrontOrigin = new URL(process.env.SELINOW_VISUAL_BASE_URL ?? "https://signal.staging.selinow.com").origin;

  const nonReadOnlyRequests: string[] = [];
  await page.route("**/*", async (route) => {
    const request = route.request();
    const requestUrl = new URL(request.url());
    if (request.method() === "GET" || request.method() === "HEAD"
      || isAllowedTurnstileMutation(requestUrl, request.method())) {
      await route.continue();
      return;
    }
    nonReadOnlyRequests.push(`${request.method()} ${requestUrl.origin === storefrontOrigin ? requestUrl.pathname : requestUrl.origin}`);
    await route.abort("blockedbyclient");
  });

  for (const route of routes) {
    const response = await page.goto(route.path);
    expect(response).not.toBeNull();
    expect(response?.request().method()).toBe("GET");
    expect(response?.ok()).toBe(true);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(route.heading);
    await expectStablePage(page, expectedWidth);
  }

  expect(nonReadOnlyRequests).toEqual([]);
});
