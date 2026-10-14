import assert from 'node:assert/strict';
import { test } from 'node:test';
import vm from 'node:vm';
import { loadAppsScriptSource } from './appsscript-source';

function backend() {
  const sheets = new Map<string, any>();
  let writes = 0, locked = false, released = 0, failWrite = false;
  const sandbox: any = {
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
