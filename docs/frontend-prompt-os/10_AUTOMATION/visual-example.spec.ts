import { test, expect } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.addStyleTag({ content: `*,*::before,*::after{animation:none!important;transition:none!important}` });
});

test('seller overview', async ({ page }) => {
  await page.goto('/app?fixture=visual-overview-healthy');
  await page.waitForLoadState('networkidle');
  await expect(page).toHaveScreenshot('seller-overview-healthy.png', { fullPage: true });
});
