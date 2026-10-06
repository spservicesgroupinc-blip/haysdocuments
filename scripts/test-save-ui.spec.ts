import { test, expect, type Page, type Route } from '@playwright/test';

const user = { email: 'test@example.com', name: 'Test', role: 'editor' };
const job = { recordId: 'saved-1', customer: { jobNumber: 'UI-TEST', customerName: 'Recovered customer' } };
const ok = (route: Route, data: unknown) => route.fulfill({
  contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': '*' },
  body: JSON.stringify({ ok: true, data }),
});

async function start(page: Page, handler: (route: Route, body: any) => Promise<void>) {
  await page.addInitScript((account) => {
    localStorage.setItem('hays.db.session', JSON.stringify({ token: 'ui-session', expiresAt: '2099-01-01T00:00:00Z', user: account }));
  }, user);
  await page.route('https://script.google.com/macros/s/TEST/exec', async (route) => {
    const body = route.request().postDataJSON();
    if (body.action === 'checkSession') await ok(route, { user });
    else if (body.action === 'listJobs') await ok(route, []);
    else await handler(route, body);
  });
  await page.goto('/');
}

test('startup recovers the shared draft before any autosave writes', async ({ page }) => {
  const sent: any[] = [];
  await start(page, async (route, body) => {
    if (body.action === 'getDraft') await ok(route, { draft: { job, recordId: job.recordId, updatedAt: '2026-10-06T12:00:00Z' } });
    else if (body.action === 'saveDraft') { sent.push(body.draft.job); await ok(route, { job: body.draft.job, updatedAt: new Date().toISOString() }); }
  });
  await page.getByRole('button', { name: 'Customer & Loss', exact: true }).last().click();
  await expect(page.locator('#customer-customerName')).toHaveValue('Recovered customer');
  await page.waitForTimeout(2300);
  expect(sent).toHaveLength(0);
  await page.locator('#customer-customerName').fill('Edited customer');
  await expect.poll(() => sent.length).toBe(1);
  expect(sent[0].customer.customerName).toBe('Edited customer');
  await expect(page.getByText('Draft synced', { exact: true })).toBeVisible();
});

test('manual save stays responsive and edits survive a delayed cloud response', async ({ page }) => {
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  let saveStarted = false;
  const errors: string[] = [];
  page.on('pageerror', (err) => errors.push(err.message));
  await start(page, async (route, body) => {
    if (body.action === 'getDraft') await ok(route, { draft: { job, recordId: job.recordId, updatedAt: '2026-10-06T12:00:00Z' } });
    else if (body.action === 'saveJob') { saveStarted = true; await held; await ok(route, body.job); }
    else if (body.action === 'saveDraft') await ok(route, { job: body.draft.job, updatedAt: new Date().toISOString() });
  });
  await page.getByRole('button', { name: 'Customer & Loss', exact: true }).last().click();
  await page.locator('#customer-customerName').fill('Saved snapshot');
  const save = page.getByRole('button', { name: 'Save', exact: true });
  await save.click();
  await expect(save).toBeEnabled();
  await expect.poll(() => saveStarted).toBe(true);
  await page.locator('#customer-customerName').fill('Typed while syncing');
  release();
  await expect(page.locator('#customer-customerName')).toHaveValue('Typed while syncing');
  await expect(page.getByText('Draft synced', { exact: true })).toBeVisible();
  await page.reload();
  await page.getByRole('button', { name: 'Customer & Loss', exact: true }).last().click();
  await expect(page.locator('#customer-customerName')).toHaveValue('Typed while syncing');
  expect(errors).toEqual([]);
});

test('a failed cloud request keeps the saved job without an uncaught UI error', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (err) => errors.push(err.message));
  await start(page, async (route, body) => {
    if (body.action === 'getDraft') await ok(route, { draft: { job, recordId: job.recordId, updatedAt: '2026-10-06T12:00:00Z' } });
    else await route.fulfill({ status: 503, body: 'Temporarily unavailable', headers: { 'Access-Control-Allow-Origin': '*' } });
  });
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeEnabled();
  await expect(page.getByText('Retrying the connection automatically.', { exact: false })).toBeVisible();
  await expect(page.getByText('Recovered customer', { exact: true }).first()).toBeVisible();
  expect(errors).toEqual([]);
});
