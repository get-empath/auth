const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const ORIGIN = 'http://empath.test';
const FAKE_FIREBASE = fs.readFileSync(path.join(__dirname, 'fake-firebase.js'), 'utf8');

// The page each path serves, straight from vercel.json
const REWRITES = JSON.parse(fs.readFileSync(path.join(ROOT, 'vercel.json'), 'utf8')).rewrites
  .filter((r) => r.destination.startsWith('/'));

const USER = { uid: 'uid-123', email: 'jordan@example.com', displayName: 'Jordan Rivera' };

const FUNCTIONS_ORIGIN = 'https://us-central1-get-empath.cloudfunctions.net';

// Serves the repo's pages at http://empath.test/<name> (as vercel.json's
// rewrites do), swaps the Firebase SDKs for the fake, and blocks every
// other network request so a test can never reach a real service.
// `functions` maps a Cloud Function name to a handler that gets the request
// ({ data, authorization }) and returns the callable's result, or throws
// { status, message, reason } for an error.
async function openPage(page, pagePath = '/dashboard', { functions = {} } = {}) {
  page.functionCalls = [];
  await page.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    if (url.origin === FUNCTIONS_ORIGIN) {
      const name = url.pathname.slice(1);
      const request = {
        data: route.request().postDataJSON()?.data,
        authorization: route.request().headers().authorization || null
      };
      page.functionCalls.push({ name, ...request });
      if (!functions[name]) return route.fulfill({ status: 404, body: 'not found' });
      try {
        const result = await functions[name](request);
        return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ result }) });
      } catch (error) {
        return route.fulfill({
          status: error.status || 400,
          contentType: 'application/json',
          body: JSON.stringify({ error: { message: error.message, status: error.code || 'FAILED_PRECONDITION', details: { reason: error.reason } } })
        });
      }
    }
    if (url.hostname === 'www.gstatic.com' && url.pathname.includes('/firebasejs/')) {
      // The fake stands in for all three SDKs, so only the first one gets it.
      return url.pathname.endsWith('firebase-app-compat.js')
        ? route.fulfill({ contentType: 'text/javascript', body: FAKE_FIREBASE })
        : route.fulfill({ contentType: 'text/javascript', body: '' });
    }
    if (url.origin === ORIGIN) {
      const rewrite = REWRITES.find((r) => r.source === url.pathname);
      const file = rewrite
        ? path.join(ROOT, rewrite.destination)
        : path.join(ROOT, `${url.pathname.slice(1).split('/')[0]}.html`);
      if (fs.existsSync(file)) {
        return route.fulfill({ contentType: 'text/html', body: fs.readFileSync(file, 'utf8') });
      }
      return route.fulfill({ status: 404, body: 'not found' });
    }
    return route.abort();
  });
  await page.goto(ORIGIN + pagePath);
}

const fake = {
  signIn: (page, user = USER) => page.evaluate((u) => window.__fake.signedIn(u), user),
  signOut: (page) => page.evaluate(() => window.__fake.signedOut()),
  orgSnapshot: (page, data) => page.evaluate((d) => window.__fake.snapshot(d, { collection: 'orgs' }), data),
  snapshot: (page, data, opts) => page.evaluate(([d, o]) => window.__fake.snapshot(d, o), [data, opts]),
  fail: (page, code) => page.evaluate((c) => window.__fake.fail(c), code),
  calls: (page) => page.evaluate(() => window.__fake.calls),
  set: (page, key, value) => page.evaluate(([k, v]) => { window.__fake[k] = v; }, [key, value])
};

async function signedInWith(page, data) {
  await openPage(page);
  await fake.signIn(page);
  await fake.snapshot(page, data);
}

module.exports = { ORIGIN, USER, openPage, fake, signedInWith };
