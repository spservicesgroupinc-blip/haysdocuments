import { test, expect, type Page, type Route } from '@playwright/test';
import { PDFDocument } from 'pdf-lib';

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

const intakeText = 'Customer Name: Uploaded customer\nClaim Number: OLD-CLAIM\nTotal Approved RCV: $12,000';
const intakePayload = {
  customer: { customerName: 'Uploaded customer' },
  insurance: { claimNumber: 'OLD-CLAIM' },
  financials: { totalApprovedRcv: 12000 },
};
const aiResponse = (route: Route) => route.fulfill({
  contentType: 'application/json',
  body: JSON.stringify({ choices: [{ message: { content: JSON.stringify(intakePayload) } }] }),
});
const intakeInput = (page: Page) => page.getByPlaceholder('Paste DASH intake notes, carrier assignment email, Xactimate recap, or drop a PDF here...');

async function openNewJob(page: Page) {
  await page.getByRole('button', { name: 'Account and job actions', exact: true }).click();
  await page.getByRole('button', { name: 'Start a new job', exact: false }).click();
  await expect(page.getByRole('heading', { name: 'Start New Restoration Job?' })).toBeVisible();
}

async function clearJob(page: Page) {
  await openNewJob(page);
  await page.getByRole('button', { name: 'Clear All Fields', exact: true }).click();
  await expect(page.getByText('New blank job created — not yet saved to the database.', { exact: true })).toBeVisible();
  await expect(intakeInput(page)).toHaveValue('');
  await expect(page.getByText(/^Master Job Record Updated —/)).toHaveCount(0);
  await expect(page.locator('#customer-customerName')).toHaveValue('');
}

for (const fileType of ['text', 'PDF'] as const) {
  test(`clearing a ${fileType} intake removes uploads and results, preserves cancellation, and survives reload`, async ({ page }) => {
    let serverDraft: any = { job, recordId: job.recordId, updatedAt: '2026-10-06T12:00:00Z' };
    let analyses = 0;
    const errors: string[] = [];
    page.on('pageerror', (err) => errors.push(err.message));
    await page.route('https://api.deepseek.com/chat/completions', async (route) => {
      analyses++;
      await aiResponse(route);
    });
    await start(page, async (route, body) => {
      if (body.action === 'getDraft') await ok(route, { draft: serverDraft });
      else if (body.action === 'saveDraft') {
        serverDraft = { job: body.draft.job, recordId: body.draft.recordId, updatedAt: new Date().toISOString() };
        await ok(route, serverDraft);
      }
    });
    await page.getByRole('button', { name: 'Customer & Loss', exact: true }).last().click();
    let buffer = Buffer.from(intakeText);
    if (fileType === 'PDF') {
      const pdf = await PDFDocument.create();
      const pdfPage = pdf.addPage();
      intakeText.split('\n').forEach((line, index) => pdfPage.drawText(line, { x: 40, y: 740 - index * 24, size: 12 }));
      buffer = Buffer.from(await pdf.save());
    }
    const file = { name: fileType === 'PDF' ? 'old-intake.pdf' : 'old-intake.txt', mimeType: fileType === 'PDF' ? 'application/pdf' : 'text/plain', buffer };
    await page.locator('input[type=file]').setInputFiles(file);
    await expect(page.locator('#customer-customerName')).toHaveValue('Uploaded customer');
    await expect(page.getByText(file.name, { exact: true })).toBeVisible();
    await expect(page.getByText(/^Master Job Record Updated —/)).toBeVisible();
    await expect(intakeInput(page)).toHaveValue(/Uploaded customer/);

    await openNewJob(page);
    await page.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(page.getByText(file.name, { exact: true })).toBeVisible();
    await expect(page.locator('#customer-customerName')).toHaveValue('Uploaded customer');
    await expect(page.getByText(/^Master Job Record Updated —/)).toBeVisible();

    await clearJob(page);
    await expect(page.getByText(file.name, { exact: true })).toHaveCount(0);
    // Reload as soon as clearing completes, before the normal cloud autosave delay.
    await page.reload();
    await page.getByRole('button', { name: 'Customer & Loss', exact: true }).last().click();
    await expect(page.locator('#customer-customerName')).toHaveValue('');
    await expect(intakeInput(page)).toHaveValue('');
    await expect(page.getByText(file.name, { exact: true })).toHaveCount(0);
    await expect.poll(() => serverDraft.job.customer.customerName).toBe('');
    expect(serverDraft.job.insurance.claimNumber).toBe('');
    expect(serverDraft.job.financials.totalApprovedRcv).toBe('');
    expect(serverDraft.job.recordId).not.toBe(job.recordId);

    // The same file can be uploaded again after clearing, with a fresh analysis.
    await page.locator('input[type=file]').setInputFiles(file);
    await expect(page.locator('#customer-customerName')).toHaveValue('Uploaded customer');
    expect(analyses).toBe(2);
    expect(errors).toEqual([]);
  });
}

for (const outcome of ['success', 'failure'] as const) {
  test(`a delayed AI ${outcome} cannot restore an intake after clearing`, async ({ page }) => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    let analysisFinished = false;
    const errors: string[] = [];
    page.on('pageerror', (err) => errors.push(err.message));
    await page.route('https://api.deepseek.com/chat/completions', async (route) => {
      await held;
      if (outcome === 'success') await aiResponse(route);
      else await route.fulfill({ status: 401, contentType: 'application/json', body: JSON.stringify({ error: { message: 'Test failure' } }) });
      analysisFinished = true;
    });
    await start(page, async (route, body) => {
      if (body.action === 'getDraft') await ok(route, { draft: { job, recordId: job.recordId, updatedAt: '2026-10-06T12:00:00Z' } });
      else if (body.action === 'saveDraft') await ok(route, { job: body.draft.job, updatedAt: new Date().toISOString() });
    });
    await page.getByRole('button', { name: 'Customer & Loss', exact: true }).last().click();
    await page.locator('input[type=file]').setInputFiles({ name: 'pending-intake.txt', mimeType: 'text/plain', buffer: Buffer.from(intakeText) });
    await expect(page.getByRole('button', { name: 'DeepSeek AI Analyzing...', exact: true })).toBeVisible();
    await clearJob(page);
    release();
    await expect.poll(() => analysisFinished).toBe(true);
    // Allow response parsing and the fallback path to finish before checking the form.
    await page.waitForTimeout(200);
    await expect(page.locator('#customer-customerName')).toHaveValue('');
    await expect(intakeInput(page)).toHaveValue('');
    await expect(page.getByText(/^Master Job Record Updated —/)).toHaveCount(0);
    await expect(page.getByText('pending-intake.txt', { exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'AI Analyze & Populate Master Record', exact: true })).toBeDisabled();
    expect(errors).toEqual([]);
  });
}
