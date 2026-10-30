const { test, expect } = require('@playwright/test');
const { ORIGIN, openPage, fake } = require('./helpers');

const STAFF = { uid: 'uid-staff', email: 'ben@get-empath.com', emailVerified: true };

function gofundme(overrides = {}) {
  return {
    orgId: 'gofundme', name: 'GoFundMe', planLabel: 'GoFundMe Enterprise plan',
    subscriptionStatus: 'active', hasAccess: true, nextChargeDate: '2027-11-01T00:00:00.000Z', deactivationDate: null,
    seats: 25, seatsUsed: 2, pending: 1, seatsFree: 22,
    allowedDomains: ['gofundme.com'], joinPath: '/gofundme',
    fastspring: {
      subscriptionId: 'sub-gfm', quoteReference: 'QUOT1', lastWebhookEvent: 'subscription.charge.completed', lastWebhookTime: '2026-11-01T00:00:00.000Z',
      subscription: { state: 'active', quantity: 25, price: 80, priceDisplay: '$80.00', currency: 'USD', autoRenew: true, nextChargeDate: '2027-11-01T00:00:00.000Z' },
      lastCharge: { status: 'successful', total: 2000, currency: 'USD', reason: null, at: '2026-11-01T00:00:00.000Z' },
      quote: { quoteId: 'QUOT1', status: 'COMPLETED', orderStatus: 'COMPLETED', quoteUrl: 'https://empath.onfastspring.com/quote/Q1', invoiceUrl: 'javascript:alert(1)' }
    },
    members: [
      { uid: 'uid-a', email: 'ana@gofundme.com', name: 'Ana Ruiz' },
      { uid: 'uid-b', email: 'bo@gofundme.com', name: null }
    ],
    invites: [
      { inviteId: 'inv-1', email: 'cy@gofundme.com', status: 'pending', expiresAt: '2026-11-29T00:00:00.000Z', acceptedBy: null },
      { inviteId: 'inv-2', email: 'dee@gofundme.com', status: 'revoked', expiresAt: null, acceptedBy: null }
    ],
    ...overrides
  };
}

// A fake orgAdmin that records each call and answers from `state`
function fakeOrgAdmin(state) {
  state.calls = [];
  return ({ data, authorization }) => {
    state.calls.push({ ...data, authorization });
    if (state.denied) throw { code: 'PERMISSION_DENIED', message: 'This page is for Empath staff.' };
    switch (data.action) {
      case 'listOrgs': return [{ orgId: 'acme', name: 'Acme', seats: 5, seatsUsed: 0 }, { orgId: 'gofundme', name: 'GoFundMe', seats: 25, seatsUsed: 2 }];
      case 'getOrg': return data.orgId === 'gofundme' ? state.org : gofundme({ orgId: 'acme', name: 'Acme', planLabel: null, members: [], invites: [], fastspring: { subscription: null, lastCharge: null, quote: null } });
      case 'invite': return { results: data.emails.map((email) => (email.startsWith('full') ? { email, ok: false, error: 'Seats are all in use' } : { email, ok: true })) };
      case 'resend': return { email: 'cy@gofundme.com' };
      case 'revoke': return { ok: true };
      case 'removeMember': return { ok: true };
      default: throw { message: 'Unknown action' };
    }
  };
}

async function openAdmin(page, state, path = '/admin?org=gofundme') {
  await openPage(page, path, { functions: { orgAdmin: fakeOrgAdmin(state) } });
  await fake.signIn(page, STAFF);
}

test.describe('/admin', () => {
  test('signed-out visitors go to login and come back', async ({ page }) => {
    await openPage(page, '/admin');
    await fake.signOut(page);
    await expect(page).toHaveURL(`${ORIGIN}/login?next=%2Fadmin`);
  });

  test('non-staff are told so and see no data', async ({ page }) => {
    const state = { denied: true };
    await openAdmin(page, state);
    await expect(page.getByRole('alert')).toContainText('This page is for Empath staff.');
    await expect(page.locator('#org-view')).toBeHidden();
  });

  test('shows the org: status, seats, members and invites', async ({ page }) => {
    const state = { org: gofundme() };
    await openAdmin(page, state);

    await expect(page.locator('#org-name')).toHaveText('GoFundMe · GoFundMe Enterprise plan');
    await expect(page.locator('#org-status')).toHaveText('active · has access');
    await expect(page.locator('#stat-seats')).toHaveText('25');
    await expect(page.locator('#stat-used')).toHaveText('2');
    await expect(page.locator('#stat-free')).toHaveText('22');
    await expect(page.locator('#org-meta')).toContainText('verified @gofundme.com addresses join at /gofundme');
    await expect(page.locator('#members-body tr')).toHaveCount(2);
    await expect(page.locator('#invites-body tr').first()).toContainText('pending');
    // Only a pending invite can be revoked; a revoked one offers nothing
    await expect(page.locator('#invites-body tr').nth(1).getByRole('button')).toHaveCount(0);
    expect(state.calls.every((c) => c.authorization === 'Bearer id-token-uid-staff')).toBe(true);
  });

  test('shows what FastSpring reported, and only safe links', async ({ page }) => {
    const state = { org: gofundme() };
    await openAdmin(page, state);
    const facts = page.locator('#fs-facts');

    await expect(facts).toContainText('active · 25 seats');
    await expect(facts).toContainText('$80.00');
    await expect(facts).toContainText('successful · $2,000.00');
    await expect(facts).toContainText('COMPLETED');
    await expect(facts.getByRole('link', { name: 'Quote' })).toHaveAttribute('href', 'https://empath.onfastspring.com/quote/Q1');
    await expect(facts.getByRole('link', { name: 'Invoice' })).toHaveCount(0);
    await expect(page.locator('#fs-note')).toContainText('Change seats and quotes in the FastSpring app');
  });

  test('an org FastSpring has not reported on yet', async ({ page }) => {
    const state = { org: gofundme({ fastspring: { subscriptionId: null, quoteReference: 'QUOT1', lastWebhookEvent: null, lastWebhookTime: null, subscription: null, lastCharge: null, quote: null } }) };
    await openAdmin(page, state);
    await expect(page.locator('#fs-facts')).toContainText('No subscription yet');
    await expect(page.locator('#fs-note')).toContainText('nothing received yet');
  });

  test('switching company loads it and remembers it in the URL', async ({ page }) => {
    const state = { org: gofundme() };
    await openAdmin(page, state);
    await page.getByLabel('Company').selectOption('acme');
    await expect(page.locator('#org-name')).toHaveText('Acme');
    await expect(page).toHaveURL(/\?org=acme$/);
  });

  test('invites several addresses and keeps the ones that failed', async ({ page }) => {
    const state = { org: gofundme() };
    await openAdmin(page, state);
    await page.getByLabel(/Email addresses/).fill('New@GoFundMe.com, full@gofundme.com\nnew@gofundme.com');
    await page.getByRole('button', { name: 'Send invites' }).click();

    await expect(page.locator('#invite-results')).toContainText('new@gofundme.com: invited');
    await expect(page.locator('#invite-results')).toContainText('full@gofundme.com: Seats are all in use');
    await expect(page.getByLabel(/Email addresses/)).toHaveValue('full@gofundme.com');
    expect(state.calls.find((c) => c.action === 'invite')).toMatchObject({ orgId: 'gofundme', emails: ['new@gofundme.com', 'full@gofundme.com'] });
  });

  test('remove asks first, then frees the seat', async ({ page }) => {
    const state = { org: gofundme() };
    await openAdmin(page, state);

    page.once('dialog', (d) => d.dismiss());
    await page.locator('#members-body tr').first().getByRole('button', { name: 'Remove' }).click();
    expect(state.calls.some((c) => c.action === 'removeMember')).toBe(false);

    page.once('dialog', (d) => d.accept());
    await page.locator('#members-body tr').first().getByRole('button', { name: 'Remove' }).click();
    await expect(page.getByRole('alert')).toHaveText('Removed ana@gofundme.com. Their seat is free.');
    expect(state.calls.find((c) => c.action === 'removeMember')).toMatchObject({ orgId: 'gofundme', uid: 'uid-a' });
  });

  test('resend and revoke act on the right invite', async ({ page }) => {
    const state = { org: gofundme() };
    await openAdmin(page, state);
    const row = page.locator('#invites-body tr').first();

    await row.getByRole('button', { name: 'Resend' }).click();
    await expect(page.getByRole('alert')).toContainText('Sent a new link to cy@gofundme.com');

    page.once('dialog', (d) => d.accept());
    await row.getByRole('button', { name: 'Revoke' }).click();
    await expect(page.getByRole('alert')).toHaveText('Revoked the invite to cy@gofundme.com.');
    expect(state.calls.filter((c) => c.inviteId === 'inv-1').map((c) => c.action)).toEqual(['resend', 'revoke']);
  });
});
