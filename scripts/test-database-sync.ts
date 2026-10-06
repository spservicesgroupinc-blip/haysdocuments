import assert from 'node:assert/strict';
import vm from 'node:vm';
import { test } from 'node:test';
import { build } from 'esbuild';

// Use the real client and sync engine, with only device storage replaced.
const storageExports = [
  'deleteMirrorJob', 'deleteOutboxOp', 'enqueueOutbox', 'getAllMirrorJobs',
  'getDraft', 'getMirrorJob', 'getOutboxOps', 'outboxOpIsMine', 'putDraft',
  'putMirrorJob', 'queueDraftOutbox', 'summarizeOutbox', 'updateOutboxOp',
];
const bundle = await build({
  entryPoints: ['src/services/jobSync.ts'], bundle: true, write: false,
  format: 'iife', globalName: 'syncEngine', platform: 'browser',
  external: ['virtual:pwa-register'],
  define: { 'import.meta.env': JSON.stringify({ VITE_APPS_SCRIPT_URL: 'https://script.google.com/macros/s/TEST/exec' }) },
  plugins: [{
    name: 'in-memory-device-storage',
    setup(builder) {
      builder.onResolve({ filter: /^\.\/localDb$/ }, () => ({ path: 'storage', namespace: 'test' }));
      builder.onLoad({ filter: /.*/, namespace: 'test' }, () => ({
        contents: storageExports.map((name) => `export const ${name} = globalThis.deviceStorage.${name};`).join('\n'),
      }));
    },
  }],
});

test('unreadable responses retain the outbox; a successful retry clears the error', async () => {
  const job = { recordId: 'customer-1', customer: { jobNumber: 'TEST-1' } };
  const draft = { job, recordId: job.recordId, savedAt: 1 };
  const queued = [1, 2].map((id) => ({ id, type: 'draft', recordId: job.recordId, draft, attempts: 0, owner: 'test@example.com' }));
  let broken = true;
  let requests = 0;
  const deviceStorage = {
    getOutboxOps: async () => queued.slice(),
    outboxOpIsMine: (op: { owner: string }, owner: string) => op.owner === owner,
    summarizeOutbox: async () => ({ mine: queued.length, stranded: 0, strandedOwner: null }),
    getMirrorJob: async () => undefined,
    getDraft: async () => draft,
    putDraft: async () => {},
    updateOutboxOp: async (op: typeof queued[number]) => {
      queued[queued.findIndex((item) => item.id === op.id)] = op;
    },
    deleteOutboxOp: async (id: number) => { queued.splice(queued.findIndex((op) => op.id === id), 1); },
  };
  const context = vm.createContext({
    deviceStorage, console, URL, AbortController, setTimeout, clearTimeout,
    window: { setTimeout, clearTimeout }, navigator: { onLine: true },
    localStorage: {
      getItem: () => JSON.stringify({ token: 'test-session', expiresAt: '2099-01-01T00:00:00Z',
        user: { email: 'test@example.com', name: 'Test', role: 'editor' } }),
    },
    fetch: async () => {
      requests++;
      return new Response(broken ? '<html>Unexpected Google error</html>' :
        JSON.stringify({ ok: true, data: { job, recordId: job.recordId, updatedAt: '2026-10-06T12:00:00Z' } }));
    },
  });
  vm.runInContext(bundle.outputFiles[0].text, context);
  const engine = context.syncEngine;

  await engine.flushOutboxNow();
  assert.equal(requests, 1, 'stop the run after the first unreadable response');
  assert.equal(queued.length, 2, 'retain every unacknowledged write');
  assert.equal(queued[0].attempts, 1);
  assert.equal(engine.getSyncState().lastSyncAt, null, 'a failed request is not a completed sync');
  assert.ok(engine.getSyncState().lastError);
  assert.equal(engine.getSyncState().syncing, false);

  broken = false;
  await engine.flushOutboxNow();
  assert.equal(queued.length, 0, 'remove writes only after valid acknowledgements');
  assert.equal(engine.getSyncState().lastError, null, 'recovery clears the previous error');
  assert.equal(engine.getSyncState().pendingCount, 0);
  assert.ok(engine.getSyncState().lastSyncAt);
});
