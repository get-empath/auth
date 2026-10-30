const { test, expect } = require('@playwright/test');
const { ORIGIN, openPage, fake, signedInWith } = require('./helpers');

const TOKEN = 'tok_abc-123';
const INVITE_PATH = `/enterprise?invite=${TOKEN}`;
const INVITEE = { uid: 'uid-sam', email: 'sam@gofundme.com', displayName: 'Sam Lee' };
const SEATS_FULL = "Your company's Empath seats are all in use. Contact sales@get-empath.com to add more.";

const pendingInvite = () => ({ status: 'pending', email: INVITEE.email, orgName: 'GoFundMe' });
const accepted = () => ({ orgId: 'gofundme', orgName: 'GoFundMe', planLabel: 'GoFundMe Enterprise plan', alreadyMember: false });

function openInvite(page, functions = {}) {
  return openPage(page, INVITE_PATH, {
    functions: { getInvite: pendingInvite, acceptInvite: accepted, ...functions }
  });
}

async function fillSignup(page) {
  await page.getByLabel('First name').fill('Sam');
  await page.getByLabel('Last name').fill('Lee');
  await page.getByLabel('Password', { exact: false }).first().fill('secret123');
  await page.getByLabel('Confirm password').fill('secret123');
}

test.describe('invite sign-up', () => {
  test('pre-fills and locks the invited email', async ({ page }) => {
    await openInvite(page);
    const email = page.getByLabel('Email');
    await expect(email).toHaveValue(INVITEE.email);
    await expect(email).toHaveJSProperty('readOnly', true);
    await expect(page.getByText('GoFundMe invited sam@gofundme.com.')).toBeVisible();
    expect(page.functionCalls[0]).toMatchObject({ name: 'getInvite', data: { token: TOKEN }, authorization: null });
  });

  test('a new account claims the seat and never goes to checkout', async ({ page }) => {
    await openInvite(page);
    await expect(page.getByLabel('Email')).toHaveValue(INVITEE.email);
    await fillSignup(page);
    await page.getByRole('button', { name: 'Create Account' }).click();

    await expect(page.getByRole('heading', { name: 'You’re in.' })).toBeVisible();
    await expect(page.getByText('Your account is on the GoFundMe Enterprise plan.')).toBeVisible();
    await expect(page.getByRole('link', { name: 'Download Empath' })).toBeVisible();
    expect(page.url()).toBe(ORIGIN + INVITE_PATH);

    const accept = page.functionCalls.find((c) => c.name === 'acceptInvite');
    expect(accept).toMatchObject({ data: { token: TOKEN }, authorization: 'Bearer id-token-uid-new' });
    const calls = await fake.calls(page);
    expect(calls.find(([n]) => n === 'createUser')).toEqual(['createUser', INVITEE.email]);
    const write = calls.find(([n, c]) => n === 'set' && c === 'users');
    expect(write[3].createdVia).toBe('enterprise_invite');
    expect(write[3]).not.toHaveProperty('orgId');
    expect(page.functionCalls.filter((c) => c.name === 'acceptInvite')).toHaveLength(1);
  });

  test('an already signed-in invitee is accepted straight away', async ({ page }) => {
    await openInvite(page);
    await expect(page.getByLabel('Email')).toHaveValue(INVITEE.email);
    await fake.signIn(page, INVITEE);
    await expect(page.getByRole('heading', { name: 'You’re in.' })).toBeVisible();
  });

  test('sign-in links keep the token through /login', async ({ page }) => {
    await openInvite(page);
    const next = `/login?next=${encodeURIComponent(INVITE_PATH)}`;
    await expect(page.locator('#signin-link')).toHaveAttribute('href', next);
    await expect(page.locator('#header-signin-link')).toHaveAttribute('href', next);
  });

  test('login sends the invitee back to the invite, token intact', async ({ page }) => {
    await openPage(page, `/login?next=${encodeURIComponent(INVITE_PATH)}`, { functions: { getInvite: pendingInvite, acceptInvite: accepted } });
    await expect(page.locator('#signup-link')).toHaveAttribute('href', INVITE_PATH);
    await fake.signIn(page, INVITEE);
    await expect(page).toHaveURL(ORIGIN + INVITE_PATH);
  });

  test('login still refuses off-site next targets', async ({ page }) => {
    await openPage(page, `/login?next=${encodeURIComponent('https://evil.example/enterprise?invite=x')}`);
    await fake.signIn(page, INVITEE);
    await expect(page).toHaveURL(`${ORIGIN}/dashboard`);
  });

  test('signed in as someone else: explains, and offers to switch accounts', async ({ page }) => {
    await openInvite(page);
    await expect(page.getByLabel('Email')).toHaveValue(INVITEE.email);
    await fake.signIn(page, { uid: 'uid-x', email: 'other@example.com' });

    await expect(page.getByRole('alert')).toContainText('signed in as other@example.com, but this invite was sent to sam@gofundme.com');
    expect(page.functionCalls.some((c) => c.name === 'acceptInvite')).toBe(false);
    await page.getByRole('link', { name: 'Sign in with that address' }).click();
    await expect(page).toHaveURL(`${ORIGIN}/login?next=${encodeURIComponent(INVITE_PATH)}`);
  });

  for (const [status, text] of [
    ['expired', 'This invite has expired.'],
    ['revoked', 'This invite was revoked.'],
    ['not-found', 'This invite link isn’t valid.'],
    ['accepted', 'This invite has already been used.']
  ]) {
    test(`a ${status} invite shows a clear error and locks the form`, async ({ page }) => {
      await openInvite(page, { getInvite: () => ({ status }) });
      await expect(page.getByRole('alert')).toContainText(text);
      await expect(page.getByRole('button', { name: 'Create Account' })).toBeDisabled();
    });
  }

  for (const [reason, message] of [
    ['seats-full', SEATS_FULL],
    ['expired', 'This invite has expired. Ask your Empath admin for a new one.'],
    ['revoked', 'This invite was revoked. Ask your Empath admin for a new one.'],
    ['wrong-email', 'This invite was sent to a different email address. Sign in with that address to accept it.']
  ]) {
    test(`acceptInvite rejecting with ${reason} shows the server message`, async ({ page }) => {
      await openInvite(page, {
        acceptInvite: () => { throw { status: 400, reason, message }; }
      });
      await expect(page.getByLabel('Email')).toHaveValue(INVITEE.email);
      await fake.signIn(page, INVITEE);
      await expect(page.getByRole('alert')).toContainText(message);
      await expect(page.getByRole('heading', { name: 'You’re in.' })).toBeHidden();
    });
  }
});

test.describe('enterprise sign-up without an invite is closed', () => {
  test('/enterprise without an invite goes to the public sign-up', async ({ page }) => {
    await openPage(page, '/enterprise');
    await expect(page).toHaveURL(`${ORIGIN}/signup`);
    expect(page.functionCalls).toEqual([]);
  });

  test('/enterprise/checkout is no longer served', () => {
    const rewrites = require('../vercel.json').rewrites.map((r) => r.source);
    expect(rewrites).not.toContain('/enterprise/checkout');
    expect(rewrites).toContain('/enterprise');
  });

  test('login no longer sends anyone to the enterprise checkout', async ({ page }) => {
    await openPage(page, `/login?next=${encodeURIComponent('/enterprise/checkout?plan=annual')}`);
    await fake.signIn(page, INVITEE);
    await expect(page).toHaveURL(`${ORIGIN}/dashboard`);
  });

  test('an invite parameter on the personal signup is ignored', async ({ page }) => {
    await openPage(page, `/signup?invite=${TOKEN}`);
    await expect(page.getByLabel('Email')).toHaveJSProperty('readOnly', false);
    expect(page.functionCalls).toEqual([]);
  });
});

test.describe('invitees who already pay for Empath', () => {
  test('are told no company seat was needed', async ({ page }) => {
    await openInvite(page, { acceptInvite: () => ({ ...accepted(), personalPlan: true }) });
    await expect(page.getByLabel('Email')).toHaveValue(INVITEE.email);
    await fake.signIn(page, INVITEE);
    await expect(page.getByText(/already have Empath through your own subscription/)).toBeVisible();
  });
});

test.describe('dashboard for org members', () => {
  const MEMBER = { email: 'jordan@example.com', firstName: 'Jordan', orgId: 'gofundme', subscriptionStatus: 'none' };

  test('shows the plan label, with billing and upgrade links hidden', async ({ page }) => {
    await signedInWith(page, MEMBER);
    await fake.orgSnapshot(page, { name: 'GoFundMe', planLabel: 'GoFundMe Enterprise plan', subscriptionStatus: 'active' });

    await expect(page.locator('#plan-name')).toHaveText('GoFundMe Enterprise plan');
    await expect(page.locator('#status-text')).toHaveText('Active');
    await expect(page.locator('#plan-details')).toContainText('provided by GoFundMe');
    await expect(page.getByRole('link', { name: 'Manage billing' })).toBeHidden();
    await expect(page.locator('#upgrade-btn')).toBeHidden();

    const reads = (await fake.calls(page)).filter(([n]) => n === 'onSnapshot');
    expect(reads.map(([, c, id]) => `${c}/${id}`)).toEqual(['users/uid-123', 'orgs/gofundme']);
  });

  test('an unpaid org shows no access and still no checkout link', async ({ page }) => {
    await signedInWith(page, MEMBER);
    await fake.orgSnapshot(page, { name: 'GoFundMe', planLabel: 'GoFundMe Enterprise plan', subscriptionStatus: 'none' });

    await expect(page.locator('#status-text')).toHaveText('Not active');
    await expect(page.locator('#plan-details')).toContainText('Contact your Empath admin');
    await expect(page.locator('#upgrade-btn')).toBeHidden();
  });

  test('a canceled org shows when access ends', async ({ page }) => {
    await signedInWith(page, MEMBER);
    await fake.orgSnapshot(page, { name: 'GoFundMe', planLabel: 'GoFundMe Enterprise plan', subscriptionStatus: 'canceled', deactivationDate: '2099-03-01T12:00:00Z' });

    await expect(page.locator('#status-text')).toHaveText('Ending');
    await expect(page.locator('#plan-details')).toContainText('Access ends March 1, 2099');
    await expect(page.locator('#upgrade-btn')).toBeHidden();
  });

  test('billing links stay hidden while the org is loading', async ({ page }) => {
    await signedInWith(page, MEMBER);
    await expect(page.locator('#plan-name')).toHaveText('Company plan');
    await expect(page.locator('#upgrade-btn')).toBeHidden();
  });

  test('a member with their own active plan sees their own plan, with billing', async ({ page }) => {
    await signedInWith(page, { ...MEMBER, subscriptionStatus: 'active', plan: 'annual' });
    await fake.orgSnapshot(page, { name: 'GoFundMe', planLabel: 'GoFundMe Enterprise plan', subscriptionStatus: 'active' });
    await expect(page.locator('#plan-name')).toHaveText('Pro Annual');
    await expect(page.getByRole('link', { name: 'Manage billing' })).toBeVisible();
  });

  test('a non-member never subscribes to an org', async ({ page }) => {
    await signedInWith(page, { email: 'a@b.com', firstName: 'A', subscriptionStatus: 'none' });
    await expect(page.locator('#upgrade-btn')).toBeVisible();
    const reads = (await fake.calls(page)).filter(([n]) => n === 'onSnapshot');
    expect(reads).toHaveLength(1);
  });
});
