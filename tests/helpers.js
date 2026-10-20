const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const ORIGIN = 'http://empath.test';
const FAKE_FIREBASE = fs.readFileSync(path.join(__dirname, 'fake-firebase.js'), 'utf8');

const USER = { uid: 'uid-123', email: 'jordan@example.com', displayName: 'Jordan Rivera' };

// Serves the repo's pages at http://empath.test/<name> (as vercel.json's
// rewrites do), swaps the Firebase SDKs for the fake, and blocks every
// other network request so a test can never reach a real service.
async function openPage(page, pagePath = '/dashboard') {
  await page.route('**/*', (route) => {
    const url = new URL(route.request().url());
    if (url.hostname === 'www.gstatic.com' && url.pathname.includes('/firebasejs/')) {
      // The fake stands in for all three SDKs, so only the first one gets it.
      return url.pathname.endsWith('firebase-app-compat.js')
        ? route.fulfill({ contentType: 'text/javascript', body: FAKE_FIREBASE })
        : route.fulfill({ contentType: 'text/javascript', body: '' });
    }
    if (url.origin === ORIGIN) {
      const name = url.pathname === '/' ? 'login' : url.pathname.slice(1).split('/')[0];
      const file = path.join(ROOT, `${name}.html`);
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
