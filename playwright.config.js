const { defineConfig, devices } = require('@playwright/test');

// Pages are served straight from disk by a route in tests/helpers.js, so no
// server is needed. PROD_URL switches tests/prod.spec.js to the live site.
module.exports = defineConfig({
  testDir: './tests',
  fullyParallel: true,
  reporter: 'list',
  use: { trace: 'retain-on-failure' },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'mobile', use: { ...devices['Pixel 7'] } }
  ]
});
