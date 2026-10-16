import { defineConfig, devices } from '@playwright/test'

/**
 * Browser tests (plan.md, Stack decisions). They run the real SPA in Chromium
 * against the Vite dev server; each spec answers `/api/*` itself with
 * `page.route`, so no API process or database is needed.
 *
 * A dedicated port, so a developer's own `npm run dev` on 5173 is never reused
 * by accident. Timezones are emulated per test with `timezoneId`, which works
 * on every OS -- unlike the `TZ` environment variable, which Chromium ignores
 * on Windows.
 */
const PORT = 5174

export default defineConfig({
  testDir: './e2e',
  forbidOnly: !!process.env.CI,
  reporter: 'list',
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: `npm run dev -- --port ${PORT} --strictPort`,
    url: `http://localhost:${PORT}`,
    reuseExistingServer: !process.env.CI,
  },
})
