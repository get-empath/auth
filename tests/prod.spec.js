// Smoke test of the live dashboard against real Firebase. Runs only when
// PROD_URL is set:
//   PROD_URL=https://auth.get-empath.com npx playwright test prod --project=chromium
// The signed-in checks also need a test account that already has a user
// document: EMPATH_TEST_EMAIL and EMPATH_TEST_PASSWORD. Nothing here writes
// to the account.
const { test, expect } = require('@playwright/test');

const PROD_URL = process.env.PROD_URL;
const EMAIL = process.env.EMPATH_TEST_EMAIL;
const PASSWORD = process.env.EMPATH_TEST_PASSWORD;

test.skip(!PROD_URL, 'set PROD_URL to run against production');

test('serves the new dashboard', async ({ request }) => {
  const res = await request.get(`${PROD_URL}/dashboard`);
  expect(res.status()).toBe(200);
  const html = await res.text();
  expect(html).toContain('class="panel"');
  expect(html).toContain('includeMetadataChanges');
  expect(html).not.toContain('.get();');
});

test('signed out, it sends you to /login without script errors', async ({ page }) => {
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`${PROD_URL}/dashboard`);
  await expect(page).toHaveURL(/\/login$/, { timeout: 15_000 });
  expect(errors).toEqual([]);
});

test.describe('signed in', () => {
  test.skip(!EMAIL || !PASSWORD, 'set EMPATH_TEST_EMAIL and EMPATH_TEST_PASSWORD');

  test('loads the account, then signs out cleanly', async ({ page }) => {
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));

    await page.goto(`${PROD_URL}/login`);
    await page.locator('#email').fill(EMAIL);
    await page.locator('#password').fill(PASSWORD);
    await page.locator('#submit-btn').click();
    await expect(page).toHaveURL(/\/dashboard$/, { timeout: 20_000 });

    const started = Date.now();
    await expect(page.locator('#dashboard')).not.toHaveAttribute('aria-busy', { timeout: 15_000 });
    console.log(`Account data rendered ${Date.now() - started} ms after reaching /dashboard`);

    await expect(page.locator('#user-email')).toHaveText(EMAIL, { ignoreCase: true });
    await expect(page.locator('#status-text')).not.toHaveText(/Loading|Unknown status/);
    await expect(page.getByRole('alert')).toBeHidden();

    // A reload should paint from the local cache.
    await page.reload();
    const reloadStart = Date.now();
    await expect(page.locator('#dashboard')).not.toHaveAttribute('aria-busy', { timeout: 15_000 });
    console.log(`Reload rendered ${Date.now() - reloadStart} ms after load`);

    await page.getByRole('button', { name: 'Sign out' }).click();
    await expect(page).toHaveURL(/\/login$/, { timeout: 15_000 });
    expect(errors).toEqual([]);
  });
});
