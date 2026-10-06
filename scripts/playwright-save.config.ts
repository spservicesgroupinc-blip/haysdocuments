import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: '.',
  testMatch: 'test-save-ui.spec.ts',
  workers: 1,
  timeout: 20000,
  use: { baseURL: 'http://127.0.0.1:3108', viewport: { width: 1440, height: 1000 } },
  webServer: {
    command: 'npm run dev -- --port=3108 --strictPort',
    cwd: '..',
    url: 'http://127.0.0.1:3108',
    reuseExistingServer: false,
    env: { VITE_APPS_SCRIPT_URL: 'https://script.google.com/macros/s/TEST/exec', VITE_DEV_SHARED_SECRET: '' },
  },
});
