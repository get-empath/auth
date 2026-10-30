const { test, expect } = require('@playwright/test');
const { ORIGIN, openPage, fake } = require('./helpers');

const DOWNLOAD = /^https:\/\/get-empath\.com\/download/;
const SEATS_FULL = 'Your organization has reached its maximum number of Empath seats. Please reach out to your admin to add more.';
const ALEX = { uid: 'uid-alex', email: 'alex@gofundme.com', displayName: 'Alex Kim', emailVerified: true };

const joined = () => ({ orgId: 'gofundme', orgName: 'GoFundMe', planLabel: 'GoFundMe Enterprise plan', alreadyMember: false });

function openJoin(page, functions = {}) {
  return openPage(page, '/gofundme', { functions: { joinOrg: joined, resendJoinVerification: () => ({ sent: true }), ...functions } });
}

async function fillSignup(page, email = 'alex@gofundme.com') {
  await page.getByLabel('First name').fill('Alex');
  await page.getByLabel('Last name').fill('Kim');
  await page.getByLabel('Work email').fill(email);
  await page.getByLabel(/^Password/).fill('secret123');
  await page.getByLabel('Confirm password').fill('secret123');
}

test.describe('/gofundme', () => {
  test('creates the account, asks for the email to be confirmed, and never shows checkout', async ({ page }) => {
    await openJoin(page);
    await expect(page.getByRole('heading', { name: 'Your Empath seat is ready.' })).toBeVisible();
    await expect(page.getByText(/choose your plan/i)).toHaveCount(0);

    await fillSignup(page);
    await page.getByRole('button', { name: 'Create account' }).click();

    await expect(page.getByRole('heading', { name: 'Check your inbox' })).toBeVisible();
    await expect(page.locator('#verify-email')).toHaveText('alex@gofundme.com');
    const calls = await fake.calls(page);
    const write = calls.find(([n, c]) => n === 'set' && c === 'users');
    expect(write[3]).toMatchObject({ createdVia: 'org_join', joinOrgId: 'gofundme', email: 'alex@gofundme.com' });
    expect(write[3]).not.toHaveProperty('orgId');
    expect(page.functionCalls.some((c) => c.name === 'joinOrg')).toBe(false);
  });

  test('once confirmed, it takes the seat and goes straight to download', async ({ page }) => {
    await openJoin(page);
    await fillSignup(page);
    await page.getByRole('button', { name: 'Create account' }).click();
    await expect(page.getByRole('heading', { name: 'Check your inbox' })).toBeVisible();

    await page.evaluate(() => { window.__fake.user.emailVerified = true; });
    const download = page.waitForRequest(DOWNLOAD);
    await page.getByRole('button', { name: "I've confirmed it" }).click();
    await download;

    const join = page.functionCalls.find((c) => c.name === 'joinOrg');
    expect(join).toMatchObject({ data: { orgId: 'gofundme' }, authorization: 'Bearer id-token-uid-new' });
  });

  test('arriving from the verification link (already verified) goes straight to download', async ({ page }) => {
    await openJoin(page);
    const download = page.waitForRequest(DOWNLOAD);
    await fake.signIn(page, ALEX);
    await download;
  });

  test('picks up confirmation from another tab on its own', async ({ page }) => {
    await page.clock.install();
    await openJoin(page);
    await fake.signIn(page, { ...ALEX, emailVerified: false });
    await expect(page.getByRole('heading', { name: 'Check your inbox' })).toBeVisible();

    const download = page.waitForRequest(DOWNLOAD);
    await page.evaluate(() => { window.__fake.user.emailVerified = true; });
    await page.clock.runFor(5100);
    await download;
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
    await expect(page.getByRole('alert')).toHaveText('Use your @gofundme.com work email.');
    expect((await fake.calls(page)).some(([n]) => n === 'createUser')).toBe(false);
  });

  test('signed in with a personal address: explains and offers to switch', async ({ page }) => {
    await openJoin(page);
    await fake.signIn(page, { uid: 'uid-p', email: 'alex@gmail.com', emailVerified: true });
    await expect(page.getByRole('alert')).toContainText('This page is for @gofundme.com addresses.');
    expect(page.functionCalls.some((c) => c.name === 'joinOrg')).toBe(false);
    await page.getByRole('link', { name: 'Use a different account' }).click();
    await expect(page.getByRole('heading', { name: 'Create your account' })).toBeVisible();
  });

  test('resend asks the server for a new link', async ({ page }) => {
    await openJoin(page);
    await fake.signIn(page, { ...ALEX, emailVerified: false });
    await page.getByRole('button', { name: 'Resend the link' }).click();
    await expect(page.getByRole('alert')).toContainText('Sent. Check alex@gofundme.com');
    expect(page.functionCalls.find((c) => c.name === 'resendJoinVerification').authorization).toBe('Bearer id-token-uid-alex');
  });

  test('sign-in links come back to /gofundme, and login allows it', async ({ page }) => {
    await openJoin(page);
    await expect(page.getByRole('link', { name: 'Sign in' }).first()).toHaveAttribute('href', '/login?next=%2Fgofundme');

    await openPage(page, '/login?next=%2Fgofundme');
    await expect(page.locator('#signup-link')).toHaveAttribute('href', '/gofundme');
    await fake.signIn(page, ALEX);
    await expect(page).toHaveURL(`${ORIGIN}/gofundme`);
  });
});
