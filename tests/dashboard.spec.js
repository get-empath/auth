const { test, expect } = require('@playwright/test');
const { ORIGIN, USER, openPage, fake, signedInWith } = require('./helpers');

const BASE = { email: USER.email, firstName: 'Jordan', lastName: 'Rivera' };

test.describe('loading', () => {
  test('signed-out visitors go to /login', async ({ page }) => {
    await openPage(page);
    await fake.signOut(page);
    await expect(page).toHaveURL(`${ORIGIN}/login`);
  });

  test('shows placeholders until the user document arrives', async ({ page }) => {
    await openPage(page);
    await fake.signIn(page);
    const main = page.locator('#dashboard');
    await expect(main).toHaveAttribute('aria-busy', 'true');
    await expect(main).toHaveClass(/skeleton/);
    await expect(page.getByRole('link', { name: 'Download for macOS' })).toBeVisible();

    await fake.snapshot(page, { ...BASE, subscriptionStatus: 'active', plan: 'monthly' });
    await expect(main).not.toHaveAttribute('aria-busy');
    await expect(main).not.toHaveClass(/skeleton/);
  });

  test('reads the user document once, through one live listener', async ({ page }) => {
    await signedInWith(page, { ...BASE, subscriptionStatus: 'active', plan: 'monthly' });
    const calls = await fake.calls(page);
    const reads = calls.filter(([name]) => name === 'onSnapshot' || name === 'get');
    expect(reads).toEqual([['onSnapshot', 'users', USER.uid, { includeMetadataChanges: true }]]);
    expect(calls.find(([name]) => name === 'enablePersistence')).toBeTruthy();
  });

  test('renders a cached snapshot right away, then the server one', async ({ page }) => {
    await openPage(page);
    await fake.signIn(page);
    await fake.snapshot(page, { ...BASE, firstName: 'Cached', subscriptionStatus: 'pending' }, { fromCache: true });
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Welcome, Cached.');
    await fake.snapshot(page, { ...BASE, subscriptionStatus: 'active', plan: 'annual' });
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Welcome, Jordan.');
    await expect(page.locator('#plan-name')).toHaveText('Pro Annual');
  });

  test('shows a notice and retries when loading stalls', async ({ page }) => {
    await page.clock.install();
    await openPage(page);
    await fake.signIn(page);
    await page.clock.runFor(10_001);
    const notice = page.getByRole('alert');
    await expect(notice).toContainText('taking longer than usual');

    await page.getByRole('button', { name: 'Try again' }).click();
    await expect(notice).toBeHidden();
    await fake.snapshot(page, { ...BASE, subscriptionStatus: 'active', plan: 'monthly' });
    await expect(page.locator('#plan-name')).toHaveText('Pro Monthly');
    expect(await page.evaluate(() => window.__fake.activeListeners())).toBe(1);
  });

  test('no timeout notice when cached data is already on screen', async ({ page }) => {
    await page.clock.install();
    await openPage(page);
    await fake.signIn(page);
    await fake.snapshot(page, { ...BASE, subscriptionStatus: 'active', plan: 'monthly' }, { fromCache: true });
    await page.clock.runFor(10_001);
    await expect(page.getByRole('alert')).toBeHidden();
  });

  test('permission errors tell the user to sign in again', async ({ page }) => {
    await openPage(page);
    await fake.signIn(page);
    await fake.fail(page, 'permission-denied');
    await expect(page.getByRole('alert')).toContainText('Access denied');
  });
});

test.describe('subscription states', () => {
  test('active monthly', async ({ page }) => {
    await signedInWith(page, {
      ...BASE, subscriptionStatus: 'active', plan: 'monthly',
      subscriptionActivatedAt: '2026-03-04T12:00:00Z', fastspringCustomerId: 'fs-1'
    });
    await expect(page.locator('#status-text')).toHaveText('Active');
    await expect(page.locator('#plan-name')).toHaveText('Pro Monthly');
    await expect(page.locator('#plan-details')).toContainText('$7.99/month');
    await expect(page.locator('#activation-date-text')).toHaveText('March 4, 2026');
    const manage = page.getByRole('link', { name: 'Manage billing' });
    await expect(manage).toHaveAttribute('href', 'https://empath.onfastspring.com/account');
    await expect(page.locator('#upgrade-btn')).toBeHidden();
  });

  test('active annual', async ({ page }) => {
    await signedInWith(page, { ...BASE, subscriptionStatus: 'active', plan: 'annual' });
    await expect(page.locator('#plan-name')).toHaveText('Pro Annual');
    await expect(page.locator('#plan-details')).toContainText('$79.99/year');
    await expect(page.locator('#activation-row')).toBeHidden();
  });

  test('active with an unknown plan id', async ({ page }) => {
    await signedInWith(page, { ...BASE, subscriptionStatus: 'active', plan: 'lifetime' });
    await expect(page.locator('#plan-name')).toHaveText('Pro Plan');
  });

  test('trial links to billing and names the first charge', async ({ page }) => {
    await signedInWith(page, { ...BASE, subscriptionStatus: 'trial', nextChargeDate: '2026-11-18T12:00:00Z' });
    await expect(page.locator('#status-text')).toHaveText('Free trial');
    await expect(page.locator('#plan-details')).toContainText('Billing starts November 18, 2026');
    await expect(page.getByRole('link', { name: 'Manage billing' }))
      .toHaveAttribute('href', 'https://empath.onfastspring.com/account');
  });

  for (const status of [undefined, 'none', 'free']) {
    test(`no plan (${status ?? 'missing'}) offers checkout`, async ({ page }) => {
      await signedInWith(page, { ...BASE, subscriptionStatus: status });
      await expect(page.locator('#status-text')).toHaveText('No active plan');
      const choose = page.getByRole('link', { name: 'Choose a plan' });
      const href = new URL(await choose.getAttribute('href'), ORIGIN);
      expect(href.pathname).toBe('/checkout');
      expect(Object.fromEntries(href.searchParams)).toEqual({
        displayName: 'Jordan', plan: 'monthly', source: 'dashboard_upgrade'
      });
      await expect(page.locator('#manage-billing-btn')).toBeHidden();
    });
  }

  test('enterprise accounts go to the enterprise checkout', async ({ page }) => {
    await signedInWith(page, { ...BASE, createdVia: 'enterprise_signup' });
    const href = await page.getByRole('link', { name: 'Choose a plan' }).getAttribute('href');
    expect(href).toMatch(/^\/enterprise\/checkout\?/);
  });

  test('without a first name, checkout uses the email name', async ({ page }) => {
    await signedInWith(page, { email: USER.email, subscriptionStatus: 'none' });
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Welcome.');
    const href = await page.getByRole('link', { name: 'Choose a plan' }).getAttribute('href');
    expect(href).toContain('displayName=jordan');
  });

  test('canceled offers reactivation', async ({ page }) => {
    await signedInWith(page, { ...BASE, subscriptionStatus: 'canceled' });
    await expect(page.locator('#status-text')).toHaveText('Canceled');
    const href = await page.getByRole('link', { name: 'Reactivate' }).getAttribute('href');
    expect(href).toContain('source=dashboard_reactivate');
  });

  test('pending has no actions', async ({ page }) => {
    await signedInWith(page, { ...BASE, subscriptionStatus: 'pending' });
    await expect(page.locator('#plan-name')).toHaveText('Subscription pending');
    await expect(page.locator('#manage-billing-btn')).toBeHidden();
    await expect(page.locator('#upgrade-btn')).toBeHidden();
  });

  test('unknown status', async ({ page }) => {
    await signedInWith(page, { ...BASE, subscriptionStatus: 'weird' });
    await expect(page.locator('#status-text')).toHaveText('Unknown status');
  });

  test('a webhook update refreshes every field live', async ({ page }) => {
    await signedInWith(page, { ...BASE, subscriptionStatus: 'pending' });
    // Same status, new name: the old listener ignored the plan here.
    await fake.snapshot(page, { ...BASE, firstName: 'Jo', subscriptionStatus: 'pending' });
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Welcome, Jo.');
    // New status and new email together: the old listener dropped the email.
    await fake.snapshot(page, { ...BASE, email: 'new@example.com', subscriptionStatus: 'active', plan: 'monthly' });
    await expect(page.locator('#plan-name')).toHaveText('Pro Monthly');
    await expect(page.locator('#user-email')).toHaveText('new@example.com');
  });
});

test.describe('missing user document', () => {
  test('a cache miss alone does not create the document', async ({ page }) => {
    await openPage(page);
    await fake.signIn(page);
    await fake.snapshot(page, null, { fromCache: true });
    const calls = await fake.calls(page);
    expect(calls.some(([name]) => name === 'set')).toBe(false);
  });

  test('a server miss creates it without entitlement fields', async ({ page }) => {
    await openPage(page);
    await fake.signIn(page);
    await fake.snapshot(page, null);
    await expect.poll(async () => (await fake.calls(page)).filter(([n]) => n === 'set').length).toBe(1);
    const [, collection, id, data, options] = (await fake.calls(page)).find(([n]) => n === 'set');
    expect([collection, id, options]).toEqual(['users', USER.uid, { merge: true }]);
    expect(data).toMatchObject({ email: USER.email, firstName: 'Jordan', lastName: 'Rivera', createdVia: 'dashboard_auto_create' });
    for (const key of ['subscriptionStatus', 'plan', 'fastspringCustomerId', 'nextChargeDate']) {
      expect(data).not.toHaveProperty(key);
    }
  });
});

test.describe('editing the account', () => {
  test.beforeEach(async ({ page }) => {
    await signedInWith(page, { ...BASE, subscriptionStatus: 'active', plan: 'monthly' });
  });

  test('saves a new first name', async ({ page }) => {
    await page.getByRole('button', { name: 'Edit first name' }).click();
    const input = page.getByRole('textbox', { name: 'First name' });
    await expect(input).toHaveValue('Jordan');
    await input.fill('  Sam  ');
    await page.getByRole('button', { name: 'Save' }).click();
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Welcome, Sam.');
    await expect(input).toBeHidden();
    const update = (await fake.calls(page)).find(([n]) => n === 'update');
    expect(update).toEqual(['update', 'users', USER.uid, { firstName: 'Sam' }]);
  });

  test('Enter saves and Escape cancels', async ({ page }) => {
    await page.getByRole('button', { name: 'Edit last name' }).click();
    const input = page.getByRole('textbox', { name: 'Last name' });
    await input.fill('Lee');
    await input.press('Enter');
    await expect(page.locator('[data-field="lastName"] [data-role="value"]')).toHaveText('Lee');

    await page.getByRole('button', { name: 'Edit last name' }).click();
    await input.fill('Nope');
    await input.press('Escape');
    await expect(page.locator('[data-field="lastName"] [data-role="value"]')).toHaveText('Lee');
    await expect(page.getByRole('button', { name: 'Edit last name' })).toBeFocused();
  });

  test('rejects an empty value inline', async ({ page }) => {
    await page.getByRole('button', { name: 'Edit first name' }).click();
    await page.getByRole('textbox', { name: 'First name' }).fill('   ');
    await page.getByRole('button', { name: 'Save' }).click();
    await expect(page.locator('[data-field="firstName"] [data-role="error"]')).toHaveText('This field can’t be empty.');
    expect((await fake.calls(page)).some(([n]) => n === 'update')).toBe(false);
  });

  test('a failed save shows an error and keeps the input', async ({ page }) => {
    await fake.set(page, 'updateShouldFail', true);
    await page.getByRole('button', { name: 'Edit first name' }).click();
    await page.getByRole('textbox', { name: 'First name' }).fill('Sam');
    await page.getByRole('button', { name: 'Save' }).click();
    await expect(page.locator('[data-field="firstName"] [data-role="error"]')).toContainText('Couldn’t save');
    await expect(page.getByRole('textbox', { name: 'First name' })).toHaveValue('Sam');
  });

  test('a live update does not overwrite a field being edited', async ({ page }) => {
    await page.getByRole('button', { name: 'Edit first name' }).click();
    await page.getByRole('textbox', { name: 'First name' }).fill('Typing');
    await fake.snapshot(page, { ...BASE, firstName: 'Server', subscriptionStatus: 'active', plan: 'monthly' });
    await expect(page.getByRole('textbox', { name: 'First name' })).toHaveValue('Typing');
  });
});

test.describe('signing out', () => {
  test('goes to /login', async ({ page }) => {
    await signedInWith(page, { ...BASE, subscriptionStatus: 'active', plan: 'monthly' });
    await page.getByRole('button', { name: 'Sign out' }).click();
    await expect(page).toHaveURL(`${ORIGIN}/login`);
  });

  test('stops the listener, then signOut, terminate, clearPersistence in order', async ({ page }) => {
    await signedInWith(page, { ...BASE, subscriptionStatus: 'active', plan: 'monthly' });
    await page.getByRole('button', { name: 'Sign out' }).click();
    await expect(page).toHaveURL(`${ORIGIN}/login`);
    const log = await page.evaluate(() => JSON.parse(sessionStorage.getItem('signOutLog')));
    expect(log).toEqual([
      { step: 'signOut', activeListeners: 0 },
      { step: 'terminate', activeListeners: 0 },
      { step: 'clearPersistence', activeListeners: 0 }
    ]);
  });
});

test.describe('brand and layout', () => {
  test('gradient stops moving under reduced motion', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await signedInWith(page, { ...BASE, subscriptionStatus: 'active', plan: 'monthly' });
    const animation = await page.locator('.p1').evaluate((el) => getComputedStyle(el).animationName);
    expect(animation).toBe('none');
  });

  test('gradient moves by default', async ({ page }) => {
    await signedInWith(page, { ...BASE, subscriptionStatus: 'active', plan: 'monthly' });
    const animation = await page.locator('.p1').evaluate((el) => getComputedStyle(el).animationName);
    expect(animation).toBe('swirl');
  });

  test('no horizontal scroll', async ({ page }) => {
    await signedInWith(page, { ...BASE, email: 'a-very-long-address-for-testing@example-company.com', subscriptionStatus: 'active', plan: 'monthly' });
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow).toBeLessThanOrEqual(0);
  });
});
