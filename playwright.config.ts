import { defineConfig, devices } from '@playwright/test';

// Browser tests (e2e/*.e2e.ts) against e2e/fixture.html, served by Vite. The suffix keeps them out
// of `bun test`, which runs the unit suite.
const PORT = Number(process.env.E2E_PORT ?? 8137);

export default defineConfig({
  testDir: 'e2e',
  testMatch: '*.e2e.ts',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    trace: 'retain-on-failure',
  },
  // More browsers can be added here; specs that rely on Chromium-only features (CDP) skip others.
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: `bunx vite --config e2e/vite.config.js --port ${PORT}`,
    url: `http://127.0.0.1:${PORT}/e2e/fixture.html`,
    stdout: 'ignore',
    stderr: 'pipe',
  },
});
