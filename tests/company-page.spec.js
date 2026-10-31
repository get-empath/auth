const { test, expect } = require('@playwright/test');
const { ORIGIN, openPage, fake } = require('./helpers');

const DOWNLOAD_URL = 'https://get-empath.com/download';

// The seat is claimed: a success screen linking to download, not a redirect
async function expectVerified(page, email) {
  await expect(page.getByRole('heading', { name: /^You’re in/ })).toBeVisible();
  await expect(page.locator('#done-email')).toHaveText(email);
  await expect(page.locator('#done-pill')).toHaveText('Seat active');
  // The confirmed screen replaces the sign-up page
  await expect(page.getByRole('heading', { name: 'Your Empath seat is ready.' })).toBeHidden();
  await expect(page.getByRole('link', { name: 'Download Empath for Mac' })).toHaveAttribute('href', DOWNLOAD_URL);
  await expect(page.getByRole('heading', { name: 'Setting up your seat…' })).toBeHidden();
  expect(page.url()).not.toContain('get-empath.com/download');
}
const SEATS_FULL = 'Your organization has reached its maximum number of Empath seats. Please reach out to your admin to add more.';

// One page (org.html) serves every company; each entry is one of its paths
const COMPANIES = [
  { path: '/gofundme', orgId: 'gofundme', name: 'GoFundMe', domain: 'gofundme.com' },
  { path: '/tennischannel', orgId: 'tennischannel', name: 'Tennis Channel', domain: 'tennischannel.com' }
];

async function fillSignup(page, email) {
  await page.getByLabel('First name').fill('Alex');
  await page.getByLabel('Last name').fill('Kim');
  await page.getByLabel('Work email').fill(email);
  await page.getByLabel(/^Password/).fill('secret123');
  await page.getByLabel('Confirm password').fill('secret123');
}

for (const c of COMPANIES) {
  const EMAIL = `alex@${c.domain}`;
  const LOGIN = `/login?next=${encodeURIComponent(c.path)}`;
  const ALEX = { uid: 'uid-alex', email: EMAIL, displayName: 'Alex Kim', emailVerified: true };
  const joined = () => ({ orgId: c.orgId, orgName: c.name, planLabel: `${c.name} Enterprise plan`, alreadyMember: false });
  const openJoin = (page, functions = {}, query = '') =>
    openPage(page, c.path + query, { functions: { joinOrg: joined, resendJoinVerification: () => ({ sent: true }), ...functions } });

  test.describe(c.path, () => {
    test("shows this company's name and domain throughout", async ({ page }) => {
      await openJoin(page);
      await expect(page).toHaveTitle(`Empath for ${c.name}`);
      await expect(page.locator('.wordmark')).toHaveText(`Empath × ${c.name}`);
      await expect(page.locator('.eyebrow')).toHaveText(`For the ${c.name} team`);
      await expect(page.locator('.lede')).toHaveText(`${c.name} has Empath for its team. Launch any iOS or Android device in seconds, capture flows without effort, and see how competitors' apps work.`);
      await expect(page.locator('.steps li').first()).toHaveText(`1Create your account with your @${c.domain} email`);
      // The card's text is one flex item, so the domain stays inline
      const lines = await page.locator('.steps li').first().locator(':scope > *').count();
      expect(lines).toBe(2);
      await expect(page.getByLabel('Work email')).toHaveAttribute('placeholder', `you@${c.domain}`);
      await expect(page.locator('#email-hint')).toHaveText(`Must be your @${c.domain} address.`);
    });

    test('creates the account, asks for the email to be confirmed, and never shows checkout', async ({ page }) => {
      await openJoin(page);
      await expect(page.getByRole('heading', { name: 'Your Empath seat is ready.' })).toBeVisible();
      await expect(page.getByText(/choose your plan/i)).toHaveCount(0);

      await fillSignup(page, EMAIL);
      await page.getByRole('button', { name: 'Create account' }).click();

      await expect(page.getByRole('heading', { name: 'Check your inbox' })).toBeVisible();
      await expect(page.locator('#verify-email')).toHaveText(EMAIL);
      const calls = await fake.calls(page);
      const write = calls.find(([n, col]) => n === 'set' && col === 'users');
      expect(write[3]).toMatchObject({ createdVia: 'org_join', joinOrgId: c.orgId, email: EMAIL });
      expect(write[3]).not.toHaveProperty('orgId');
      expect(page.functionCalls.some((call) => call.name === 'joinOrg')).toBe(false);
    });

    test('once confirmed, it takes the seat and shows the verified screen', async ({ page }) => {
      await openJoin(page);
      await fillSignup(page, EMAIL);
      await page.getByRole('button', { name: 'Create account' }).click();
      await expect(page.getByRole('heading', { name: 'Check your inbox' })).toBeVisible();

      await page.evaluate(() => { window.__fake.user.emailVerified = true; });
      await page.getByRole('button', { name: "I've confirmed it" }).click();
      await expectVerified(page, EMAIL);

      const join = page.functionCalls.find((call) => call.name === 'joinOrg');
      expect(join).toMatchObject({ data: { orgId: c.orgId }, authorization: 'Bearer id-token-uid-new' });
    });

    test('arriving from the verification link (already verified) shows the verified screen', async ({ page }) => {
      await openJoin(page);
      await fake.signIn(page, ALEX);
      await expectVerified(page, EMAIL);
    });

    test('picks up confirmation from another tab on its own', async ({ page }) => {
      await page.clock.install();
      await openJoin(page);
      await fake.signIn(page, { ...ALEX, emailVerified: false });
      await expect(page.getByRole('heading', { name: 'Check your inbox' })).toBeVisible();

      await page.evaluate(() => { window.__fake.user.emailVerified = true; });
      await page.clock.runFor(5100);
      await expectVerified(page, EMAIL);
    });

    test('a full organization shows the admin message', async ({ page }) => {
      await openJoin(page, { joinOrg: () => { throw { status: 429, reason: 'org-seats-full', message: SEATS_FULL }; } });
      await fake.signIn(page, ALEX);
      await expect(page.getByRole('alert')).toHaveText(SEATS_FULL);
      await expect(page.getByRole('heading', { name: 'Setting up your seat…' })).toBeHidden();
    });

    test('other domains are turned away before an account is made', async ({ page }) => {
      await openJoin(page);
      await fillSignup(page, 'alex@gmail.com');
      await page.getByRole('button', { name: 'Create account' }).click();
      await expect(page.getByRole('alert')).toHaveText(`Use your @${c.domain} work email.`);
      expect((await fake.calls(page)).some(([n]) => n === 'createUser')).toBe(false);
    });

    test('signed in with a personal address: explains and offers to switch', async ({ page }) => {
      await openJoin(page);
      await fake.signIn(page, { uid: 'uid-p', email: 'alex@gmail.com', emailVerified: true });
      await expect(page.getByRole('alert')).toContainText(`This page is for @${c.domain} addresses.`);
      expect(page.functionCalls.some((call) => call.name === 'joinOrg')).toBe(false);
      await page.getByRole('link', { name: 'Use a different account' }).click();
      await expect(page.getByRole('heading', { name: 'Create your account' })).toBeVisible();
    });

    test('resend asks the server for a new link', async ({ page }) => {
      await openJoin(page);
      await fake.signIn(page, { ...ALEX, emailVerified: false });
      await page.getByRole('button', { name: 'Resend the link' }).click();
      await expect(page.getByRole('alert')).toContainText(`Sent. Check ${EMAIL}`);
      expect(page.functionCalls.find((call) => call.name === 'resendJoinVerification').authorization).toBe('Bearer id-token-uid-alex');
    });

    test('an existing account is sent to sign in and back here', async ({ page }) => {
      await openJoin(page);
      await page.evaluate(() => { window.__fake.createUserError = 'auth/email-already-in-use'; });
      await fillSignup(page, EMAIL);
      await page.getByRole('button', { name: 'Create account' }).click();
      await expect(page.getByRole('link', { name: 'Sign in instead' })).toHaveAttribute('href', LOGIN);
    });

    test('the confirmation link confirms the address and claims the seat in one click, then shows the verified screen', async ({ page }) => {
      await openJoin(page, {}, '?mode=verifyEmail&oobCode=code-123');
      await fake.signIn(page, { ...ALEX, emailVerified: false });
      expect(await fake.calls(page)).toContainEqual(['applyActionCode', 'code-123']);
      await expect(page).toHaveURL(`${ORIGIN}${c.path}`);

      await page.evaluate(() => window.__fake.confirmCode());
      await expectVerified(page, EMAIL);
      expect(page.functionCalls.find((call) => call.name === 'joinOrg')).toMatchObject({ data: { orgId: c.orgId } });
    });

    test('the confirmation link opened signed out confirms, then asks to sign in', async ({ page }) => {
      await openJoin(page, {}, '?mode=verifyEmail&oobCode=code-123');
      await page.evaluate(() => window.__fake.confirmCode());
      await fake.signOut(page);
      await expect(page.getByRole('alert')).toContainText('Your email is confirmed.');
      await expect(page.getByRole('alert').getByRole('link', { name: 'Sign in' })).toHaveAttribute('href', LOGIN);
      expect(page.functionCalls.some((call) => call.name === 'joinOrg')).toBe(false);
    });

    test('an expired or used confirmation link says so and offers a new one', async ({ page }) => {
      await openJoin(page, {}, '?mode=verifyEmail&oobCode=used');
      await fake.signIn(page, { ...ALEX, emailVerified: false });
      await page.evaluate(() => window.__fake.rejectCode('auth/invalid-action-code'));
      await expect(page.getByRole('heading', { name: 'Check your inbox' })).toBeVisible();
      await expect(page.getByRole('alert')).toContainText('That confirmation link has expired or was already used.');
      expect(page.functionCalls.some((call) => call.name === 'joinOrg')).toBe(false);
    });

    test(`sign-in links come back to ${c.path}, and login allows it`, async ({ page }) => {
      await openJoin(page);
      const signInLinks = page.getByRole('link', { name: 'Sign in', exact: true });
      // Just the header's: the form has no "Already have an account?" line
      await expect(signInLinks).toHaveCount(1);
      for (const link of await signInLinks.all()) await expect(link).toHaveAttribute('href', LOGIN);

      await openPage(page, LOGIN);
      await expect(page.locator('#signup-link')).toHaveAttribute('href', c.path);
      await fake.signIn(page, ALEX);
      await expect(page).toHaveURL(`${ORIGIN}${c.path}`);
    });
  });
}

test("another company's domain is refused on /tennischannel", async ({ page }) => {
  await openPage(page, '/tennischannel');
  await fillSignup(page, 'alex@gofundme.com');
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page.getByRole('alert')).toHaveText('Use your @tennischannel.com work email.');
});

test('the company page at a path with no company goes to /signup', async ({ page }) => {
  await openPage(page, '/org');
  await expect(page).toHaveURL(`${ORIGIN}/signup`);
});
