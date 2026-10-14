import assert from 'node:assert/strict';
import { test } from 'node:test';
import vm from 'node:vm';
import { loadAppsScriptSource } from './appsscript-source';

function backend() {
  const sheets = new Map<string, any>();
  let writes = 0, locked = false, released = 0, failWrite = false;
  const sandbox: any = {
    PropertiesService: { getScriptProperties: () => ({ getProperty: (key: string) => key === 'DEEPSEEK_API_KEY' ? 'test-key' : null }) },
    Utilities: { getUuid: () => `version-${writes}`, newBlob: (value: string) => ({ getBytes: () => Buffer.from(value) }), sleep: () => {} },
    LockService: { getScriptLock: () => ({ tryLock: () => { assert.equal(locked, false); locked = true; return true; }, releaseLock: () => { locked = false; released++; } }) },
    SpreadsheetApp: { flush: () => {} },
    ContentService: { MimeType: { JSON: 'json' }, createTextOutput: (body: string) => ({ setMimeType: () => JSON.parse(body) }) },
  };
  vm.createContext(sandbox);
  vm.runInContext(loadAppsScriptSource(), sandbox);
  sandbox.getSpreadsheet_ = () => ({
    getSheetByName: (name: string) => sheets.get(name),
    insertSheet: (name: string) => {
      const sheet: any = {
        rows: [], maxRows: 1000,
        getLastRow: () => sheet.rows.length,
        getMaxRows: () => sheet.maxRows,
        insertRowsAfter: (_: number, count: number) => { sheet.maxRows += count; },
        getDataRange: () => ({ getValues: () => sheet.rows.map((row: unknown[]) => [...row]) }),
        setFrozenRows: () => {},
        getRange: (row: number, _col: number, _rows: number, _cols: number) => ({
          setValues: (values: unknown[][]) => {
            assert.equal(locked, true);
            if (failWrite) throw new Error('simulated write failure');
            writes++;
            values.forEach((value, index) => { sheet.rows[row - 1 + index] = [...value]; });
          },
        }),
      };
      sheets.set(name, sheet);
      return sheet;
    },
  });
  sandbox.authenticateRequest_ = (payload: any) => {
    if (!payload.sessionToken) throw sandbox.appError_('unauthorized', 'Authentication required');
    return { email: payload.sessionToken, role: payload.role || 'editor' };
  };
  return { sandbox, sheets, writes: () => writes, released: () => released, fail: () => { failWrite = true; } };
}
const first = [{ customerName: '=do not execute', jobNumber: 'F-1', contractPrice: 15 }, { customerName: 'Two', jobNumber: 'F-2', contractPrice: 0 }];
test('authenticated shared snapshot is replaced, erasing previous customer data in one write', () => {
  const env = backend();
  const call = (payload: any) => env.sandbox.handleAction_(payload);
  assert.throws(() => call({ action: 'getCustomerReference' }), /Authentication/);
  const saved = call({ action: 'replaceCustomerReference', sessionToken: 'editor-one', customers: first, fileName: 'first.csv' });
  assert.equal(saved.data.customers.length, 2);
  const writesBefore = env.writes();
  call({ action: 'replaceCustomerReference', sessionToken: 'editor-two', customers: [first[1]], fileName: 'second.csv' });
  assert.equal(env.writes(), writesBefore + 1);
  const loaded = call({ action: 'getCustomerReference', sessionToken: 'viewer', role: 'viewer' }).data;
  assert.equal(loaded.customers.length, 1);
  assert.equal(loaded.fileName, 'second.csv');
  assert.equal(loaded.updatedBy, 'editor-two');
  assert.doesNotMatch(JSON.stringify([...env.sheets.values()].map(sheet => sheet.rows)), /do not execute|first.csv/);
  assert.ok(env.released() >= 2);
});
test('estimate analysis sends the complete current knowledge base to DeepSeek and validates its match', () => {
  const env = backend();
  const customers = [
    { customerName: 'Smith Jane', jobNumber: 'DASH-1', contractPrice: 1500, jobAddress: '10 First St', city: 'Fort Wayne', state: 'IN', zip: '46808' },
    { customerName: 'Smith Jane', jobNumber: 'DASH-2', contractPrice: 2000, jobAddress: '20 Second St', city: 'Fort Wayne', state: 'IN', zip: '46809' },
  ];
  const saved = env.sandbox.replaceCustomerReference_({ email: 'u1', role: 'editor' }, { customers, fileName: 'context.csv' });
  let request: any;
  env.sandbox.UrlFetchApp = { fetch: (url: string, options: any) => {
    assert.equal(url, 'https://api.deepseek.com/chat/completions');
    request = JSON.parse(options.payload);
    assert.equal(options.headers.Authorization, 'Bearer test-key');
    return { getResponseCode: () => 200, getContentText: () => JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ customer: { customerName: 'Smith Jane', jobNumber: 'DASH-2', lossAddress: '20 Second St' }, financials: { totalApprovedRcv: 2200 }, knowledgeMatch: { status: 'matched', jobNumber: 'DASH-2', explanation: 'Same name and second address.', evidence: ['Jane Smith', '20 Second St'] }, estimateTotal: 2200 }) } }] }) };
  } };
  const analyzed = env.sandbox.handleAction_({ action: 'analyzeIntake', sessionToken: 'different-user', rawText: 'Estimate for Jane Smith, 20 Second St. Total $2,200.' }).data;
  assert.ok(request.messages.some((message: any) => message.content.includes('DASH-1') && message.content.includes('DASH-2')));
  assert.equal(analyzed.knowledgeBase.version, saved.version);
  assert.equal(analyzed.knowledgeBase.matchedCustomer.jobNumber, 'DASH-2');
  assert.equal(analyzed.knowledgeBase.priceReview.status, 'pending');
  assert.equal(analyzed.knowledgeBase.priceReview.estimateAmount, 2200);
  assert.equal(analyzed.knowledgeBase.priceReview.csvAmount, 2000);
  env.sandbox.replaceCustomerReference_({ email: 'u2', role: 'editor' }, { customers: [customers[0]], fileName: 'replacement.csv' });
  assert.throws(() => env.sandbox.analyzeIntake_({ rawText: 'Jane Smith, 20 Second St.' }), /not in the current knowledge base/);
  assert.ok(!request.messages.some((message: any) => message.content.includes('DASH-2')));
});

test('oversized context is rejected before replacing the previous knowledge base', () => {
  const env = backend();
  env.sandbox.replaceCustomerReference_({ email: 'editor', role: 'editor' }, { customers: first, fileName: 'good.csv' });
  const original = JSON.stringify([...env.sheets.values()].map(sheet => sheet.rows));
  const huge = Array.from({ length: 5000 }, (_, index) => ({ customerName: 'x'.repeat(300), jobNumber: `D-${index}`, contractPrice: 10, jobAddress: 'y'.repeat(500) }));
  assert.throws(() => env.sandbox.replaceCustomerReference_({ email: 'editor', role: 'editor' }, { customers: huge, fileName: 'huge.csv' }), /context/);
  assert.equal(JSON.stringify([...env.sheets.values()].map(sheet => sheet.rows)), original);
});
test('viewer, duplicate, empty and invalid uploads cannot alter the shared snapshot', () => {
  const env = backend();
  env.sandbox.replaceCustomerReference_({ email: 'editor', role: 'editor' }, { customers: first, fileName: 'good.csv' });
  const original = JSON.stringify([...env.sheets.values()].map(sheet => sheet.rows));
  for (const payload of [{ customers: [] }, { customers: [first[0], first[0]] }, { customers: [{ ...first[0], contractPrice: -1 }] }, { customers: [{ ...first[0], contractPrice: '10' }] }]) {
    assert.throws(() => env.sandbox.replaceCustomerReference_({ email: 'editor', role: 'editor' }, { fileName: 'bad.csv', ...payload }));
  }
  assert.throws(() => env.sandbox.replaceCustomerReference_({ email: 'viewer', role: 'viewer' }, { customers: first, fileName: 'bad.csv' }), /permission/);
  assert.equal(JSON.stringify([...env.sheets.values()].map(sheet => sheet.rows)), original);
  env.fail();
  assert.throws(() => env.sandbox.replaceCustomerReference_({ email: 'editor', role: 'editor' }, { customers: [first[1]], fileName: 'bad.csv' }), /simulated/);
  assert.equal(JSON.stringify([...env.sheets.values()].map(sheet => sheet.rows)), original);
  assert.ok(env.released() >= 2);
});
