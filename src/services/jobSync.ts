/**
 * Offline-first sync engine for the customer database (Apps Script).
 *
 * Everything the UI reads or writes goes through here:
 *  - reads  — served instantly from the IndexedDB mirror, refreshed from the
 *             server in the background; falls back to the mirror when offline.
 *  - writes — applied to the mirror immediately and queued in an outbox that
 *             replays to the backend when connectivity returns (last write
 *             wins; the user is told when the server copy moved underneath).
 *
 * The engine works identically in the browser (with the service worker's
 * Background Sync as an extra trigger) and in the Electron desktop shell
 * (which has no service worker — flush happens on start / online / interval).
 */
import {
  acquireAuthContext,
  deleteJob,
  getCurrentUser,
  getJob,
  isDatabaseConfigured,
  listJobs,
  saveJob,
  DatabaseError,
  type AuthContext,
  type JobSummary,
} from './appsScriptService';
import {
  countOutbox,
  deleteMirrorJob,
  deleteOutboxOp,
  enqueueOutbox,
  getAllMirrorJobs,
  getDraft,
  getMirrorJob,
  getOutboxOps,
  putDraft,
  putMirrorJob,
  updateOutboxOp,
  type MirrorJob,
  type OutboxOp,
  type SyncJobSummary,
} from './localDb';
import { createRecordId, type RestorationJobData } from '../types/jobData';
import { requestOutboxSync } from './pwa';

export interface SyncState {
  online: boolean;
  pendingCount: number;
  syncing: boolean;
  lastSyncAt: string | null;
  lastError: string | null;
  /** Transient message shown when a server copy changed underneath a local edit. */
  conflictNotice: string | null;
}

const NETWORK_ERROR_CODES = new Set(['network_error', 'timeout']);

function isNetworkish(err: unknown): boolean {
  return err instanceof DatabaseError && NETWORK_ERROR_CODES.has(err.code);
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ---- state (tiny pub/sub for the UI) --------------------------------------

let state: SyncState = {
  online: typeof navigator === 'undefined' ? true : navigator.onLine,
  pendingCount: 0,
  syncing: false,
  lastSyncAt: null,
  lastError: null,
  conflictNotice: null,
};

const listeners = new Set<(next: SyncState) => void>();

function patchState(patch: Partial<SyncState>) {
  state = { ...state, ...patch };
  for (const listener of [...listeners]) listener(state);
}

export function subscribeSyncState(listener: (next: SyncState) => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getSyncState(): SyncState {
  return state;
}

let conflictTimer: number | null = null;

function noticeConflict(message: string) {
  patchState({ conflictNotice: message });
  if (conflictTimer) window.clearTimeout(conflictTimer);
  conflictTimer = window.setTimeout(() => patchState({ conflictNotice: null }), 8000);
}

export function clearConflictNotice() {
  if (conflictTimer) window.clearTimeout(conflictTimer);
  patchState({ conflictNotice: null });
}

// ---- summary helpers ------------------------------------------------------

function summaryFromRecord(record: RestorationJobData, prior?: JobSummary | null): JobSummary {
  return {
    recordId: record.recordId ?? prior?.recordId ?? '',
    jobNumber: record.customer?.jobNumber || prior?.jobNumber || '',
    jobName: record.customer?.jobName || prior?.jobName || '',
    customerName: record.customer?.customerName || prior?.customerName || '',
    email: record.customer?.email || prior?.email || '',
    mobilePhone: record.customer?.mobilePhone || prior?.mobilePhone || '',
    lossAddress: record.customer?.lossAddress || prior?.lossAddress || '',
    carrier: record.insurance?.carrier || prior?.carrier || '',
    claimNumber: record.insurance?.claimNumber || prior?.claimNumber || '',
    status: prior?.status || 'Draft',
    createdAt: prior?.createdAt || record.dateCreated || new Date().toISOString(),
    updatedAt: prior?.updatedAt || '',
    updatedBy: prior?.updatedBy || '',
    schemaVersion: prior?.schemaVersion ?? record.schemaVersion ?? 0,
    deleted: false,
  };
}

function stripRecord(job: JobSummary): JobSummary {
  const { record: _record, ...summary } = job;
  return summary;
}

/** Fill blank server columns from the cached record (older backends leave them empty). */
function displaySummary(server: JobSummary, record: RestorationJobData | null): JobSummary {
  const base = stripRecord(server);
  if (!record) return base;
  const derived = summaryFromRecord(record, base);
  return {
    ...base,
    jobNumber: base.jobNumber || derived.jobNumber,
    jobName: base.jobName || derived.jobName,
    customerName: base.customerName || derived.customerName,
    email: base.email || derived.email,
    mobilePhone: base.mobilePhone || derived.mobilePhone,
    lossAddress: base.lossAddress || derived.lossAddress,
    carrier: base.carrier || derived.carrier,
    claimNumber: base.claimNumber || derived.claimNumber,
  };
}

// ---- reads ----------------------------------------------------------------

/** Instantly available summaries from the local mirror (no network). */
export async function readCachedJobSummaries(): Promise<SyncJobSummary[]> {
  const all = await getAllMirrorJobs();
  return all
    .filter((row) => row.syncState !== 'pending-delete')
    .map((row) => ({
      ...(row.record ? summaryFromRecord(row.record, row.summary) : row.summary),
      syncState: row.syncState,
    }))
    .sort((a, b) => (b.updatedAt || b.createdAt || '').localeCompare(a.updatedAt || a.createdAt || ''));
}

export interface RefreshJobsResult {
  jobs: SyncJobSummary[];
  fromCache: boolean;
  error?: string;
}

/** Server refresh with mirror fallback. Never throws. */
export async function refreshJobs(): Promise<RefreshJobsResult> {
  if (!isDatabaseConfigured()) {
    return {
      jobs: await readCachedJobSummaries(),
      fromCache: true,
      error: 'The customer database is not connected yet.',
    };
  }
  try {
    const auth = await acquireAuthContext();
    if (state.pendingCount > 0 && state.online) await flushOutboxNow();
    const { jobs } = await listJobs(auth, { fullRecords: true });
    const merged = await mergeServerList(jobs);
    patchState({
      lastSyncAt: new Date().toISOString(),
      lastError: null,
      pendingCount: await countOutbox(),
    });
    return { jobs: merged, fromCache: false };
  } catch (err) {
    const cached = await readCachedJobSummaries();
    if (isNetworkish(err)) {
      if (cached.length) return { jobs: cached, fromCache: true };
      return { jobs: [], fromCache: true, error: 'Offline — no saved copies on this device yet.' };
    }
    return { jobs: cached, fromCache: cached.length > 0, error: errorMessage(err) };
  }
}

async function mergeServerList(serverJobs: JobSummary[]): Promise<SyncJobSummary[]> {
  const mirror = await getAllMirrorJobs();
  const byId = new Map(mirror.map((row) => [row.recordId, row]));
  const seen = new Set<string>();
  const conflicts: string[] = [];
  const results: SyncJobSummary[] = [];

  for (const job of serverJobs) {
    seen.add(job.recordId);
    const local = byId.get(job.recordId);

    if (!local) {
      const next: MirrorJob = {
        recordId: job.recordId,
        summary: stripRecord(job),
        record: job.record ?? null,
        syncState: 'synced',
        baseUpdatedAt: job.updatedAt || null,
        locallyUpdatedAt: new Date().toISOString(),
      };
      await putMirrorJob(next);
      results.push({ ...next.summary, syncState: 'synced' });
      continue;
    }

    if (local.syncState === 'synced') {
      const next: MirrorJob = {
        ...local,
        summary: stripRecord(job),
        record: job.record ?? local.record,
        baseUpdatedAt: job.updatedAt || local.baseUpdatedAt,
        locallyUpdatedAt: new Date().toISOString(),
      };
      await putMirrorJob(next);
      results.push({ ...displaySummary(next.summary, next.record), syncState: 'synced' });
      continue;
    }

    if (local.syncState === 'pending-delete') {
      // Hidden until the delete syncs; ignore the server copy (no resurrection).
      continue;
    }

    // pending-save: keep the local copy; flag if the server moved since our base.
    if (local.baseUpdatedAt && job.updatedAt && job.updatedAt > local.baseUpdatedAt) {
      conflicts.push(job.jobNumber || local.summary.jobNumber || 'a record');
    }
    const derived = local.record ? summaryFromRecord(local.record, local.summary) : local.summary;
    results.push({ ...derived, syncState: 'pending-save' });
  }

  for (const row of mirror) {
    if (seen.has(row.recordId)) continue;
    if (row.syncState === 'synced') {
      // Gone from the server (deleted elsewhere) — drop the stale mirror row.
      await deleteMirrorJob(row.recordId);
      continue;
    }
    if (row.syncState === 'pending-save') {
      results.push({
        ...(row.record ? summaryFromRecord(row.record, row.summary) : row.summary),
        syncState: 'pending-save',
      });
    }
  }

  if (conflicts.length) {
    noticeConflict(
      `${conflicts.join(', ')} changed on the server while you had unsaved edits. ` +
        `Syncing will overwrite — open the record to review.`
    );
  }
  return results;
}

export interface LoadedJob {
  job: RestorationJobData;
  fromCache: boolean;
}

/** Opens one record: local copy wins when it has unsynced edits; else server-first. */
export async function loadJobOffline(recordId: string): Promise<LoadedJob> {
  const mirror = await getMirrorJob(recordId);
  if (mirror && mirror.syncState !== 'synced' && mirror.record) {
    return { job: mirror.record, fromCache: true };
  }
  try {
    const auth = await acquireAuthContext();
    const result = await getJob(auth, { recordId });
    await putMirrorJob({
      recordId,
      summary: summaryFromRecord(result.job, mirror?.summary ?? null),
      record: result.job,
      syncState: 'synced',
      baseUpdatedAt: result.updatedAt || mirror?.summary?.updatedAt || null,
      locallyUpdatedAt: new Date().toISOString(),
    });
    return { job: result.job, fromCache: false };
  } catch (err) {
    if (isNetworkish(err) && mirror?.record) {
      return { job: mirror.record, fromCache: true };
    }
    throw err;
  }
}

// ---- writes ---------------------------------------------------------------

export interface SaveJobOutcome {
  record: RestorationJobData;
  recordId: string;
  created: boolean;
  /** True when the write is queued locally and will sync later. */
  queued: boolean;
}

/** Saves a job through the mirror + outbox. Never loses the edit when offline. */
export async function saveJobOffline(job: RestorationJobData): Promise<SaveJobOutcome> {
  const recordId = job.recordId || createRecordId();
  const record: RestorationJobData = { ...job, recordId };
  const existing = await getMirrorJob(recordId);
  const created = !existing;

  await putMirrorJob({
    recordId,
    summary: summaryFromRecord(record, existing?.summary ?? null),
    record,
    syncState: 'pending-save',
    baseUpdatedAt: existing?.baseUpdatedAt ?? existing?.summary?.updatedAt ?? null,
    locallyUpdatedAt: new Date().toISOString(),
  });
  await enqueueOutbox({ type: 'save', recordId, job: record, createdAt: Date.now(), attempts: 0 });
  patchState({ pendingCount: await countOutbox() });

  if (state.online) await flushOutboxNow();
  else void requestOutboxSync();

  const after = await getMirrorJob(recordId);
  return {
    record: after?.record ?? record,
    recordId,
    created,
    queued: !after || after.syncState !== 'synced',
  };
}

export interface DeleteJobOutcome {
  queued: boolean;
}

/** Deletes a job through the mirror + outbox (soft delete server-side). */
export async function deleteJobOffline(recordId: string): Promise<DeleteJobOutcome> {
  const existing = await getMirrorJob(recordId);
  if (!existing) {
    // Not in the mirror — still queue the delete so the server converges.
    await putMirrorJob({
      recordId,
      summary: summaryFromRecord({ recordId } as RestorationJobData, null),
      record: null,
      syncState: 'pending-delete',
      baseUpdatedAt: null,
      locallyUpdatedAt: new Date().toISOString(),
    });
  } else {
    await putMirrorJob({
      ...existing,
      syncState: 'pending-delete',
      locallyUpdatedAt: new Date().toISOString(),
    });
  }
  await enqueueOutbox({ type: 'delete', recordId, createdAt: Date.now(), attempts: 0 });
  patchState({ pendingCount: await countOutbox() });

  if (state.online) await flushOutboxNow();
  else void requestOutboxSync();

  const after = await getMirrorJob(recordId);
  return { queued: !!after && after.syncState === 'pending-delete' };
}

// ---- outbox flush ---------------------------------------------------------

let flushPromise: Promise<void> | null = null;

/** Replays the outbox to the Apps Script backend. Re-entrant calls share one run. */
export function flushOutboxNow(): Promise<void> {
  if (!flushPromise) {
    flushPromise = doFlush().finally(() => {
      flushPromise = null;
    });
  }
  return flushPromise;
}

export const syncNow = flushOutboxNow;

async function doFlush(): Promise<void> {
  if (!isDatabaseConfigured()) return;
  const ops = await getOutboxOps();
  if (ops.length === 0) {
    if (state.pendingCount !== 0) patchState({ pendingCount: 0 });
    return;
  }

  let auth: AuthContext;
  try {
    auth = await acquireAuthContext();
  } catch {
    // Signed out — keep the queue; it flushes after the next sign-in.
    return;
  }

  patchState({ syncing: true });
  let conflictLine: string | null = null;

  try {
    const needsBaseCheck = ops.some((op) => op.type === 'save');
    let serverRows: Map<string, JobSummary> | null = null;
    if (needsBaseCheck) {
      try {
        const { jobs } = await listJobs(auth);
        serverRows = new Map(jobs.map((job) => [job.recordId, job]));
      } catch {
        serverRows = null; // conflict check is best-effort
      }
    }

    for (const op of ops) {
      const mirror = await getMirrorJob(op.recordId);
      try {
        if (op.type === 'save' && op.job) {
          const serverRow = serverRows?.get(op.recordId);
          if (
            mirror?.baseUpdatedAt &&
            serverRow?.updatedAt &&
            serverRow.updatedAt > mirror.baseUpdatedAt
          ) {
            const actor =
              serverRow.updatedBy && serverRow.updatedBy !== getCurrentUser()?.email
                ? ` by ${serverRow.updatedBy}`
                : '';
            conflictLine = `${serverRow.jobNumber || op.job.customer?.jobNumber || 'A record'} was changed${actor} after your last download`;
          }
          const result = await saveJob(auth, op.job);
          await applyServerSave(op.recordId, result.record);
        } else if (op.type === 'delete') {
          await deleteJob(auth, op.recordId);
          await deleteMirrorJob(op.recordId);
        }
        await deleteOutboxOp(op.id as number);
        patchState({ pendingCount: await countOutbox() });
      } catch (err) {
        if (isNetworkish(err)) {
          await updateOutboxOp({ ...op, attempts: op.attempts + 1, lastError: errorMessage(err) });
          patchState({ lastError: errorMessage(err) });
          throw err; // stop this run; retry on the next trigger
        }
        if (err instanceof DatabaseError && err.code === 'not_found') {
          // The server no longer has this record — clear local traces and move on.
          await deleteMirrorJob(op.recordId);
          await deleteOutboxOp(op.id as number);
          patchState({ pendingCount: await countOutbox() });
          continue;
        }
        // Rejected write (role, validation, …): keep it queued, report, continue.
        await updateOutboxOp({ ...op, attempts: op.attempts + 1, lastError: errorMessage(err) });
        patchState({ lastError: errorMessage(err) });
      }
    }

    patchState({ lastSyncAt: new Date().toISOString() });
    if (conflictLine) {
      noticeConflict(`${conflictLine}. Your version was saved last — review it when convenient.`);
    }
  } finally {
    patchState({ syncing: false });
  }
}

async function applyServerSave(recordId: string, serverRecord: RestorationJobData) {
  const mirror = await getMirrorJob(recordId);
  const record = { ...(mirror?.record ?? {}), ...serverRecord, recordId } as RestorationJobData;
  await putMirrorJob({
    recordId,
    summary: summaryFromRecord(record, mirror?.summary ?? null),
    record,
    syncState: 'synced',
    // The next list refresh picks up the server's authoritative updatedAt.
    baseUpdatedAt: null,
    locallyUpdatedAt: new Date().toISOString(),
  });
}

// ---- lifecycle ------------------------------------------------------------

let initialized = false;

/** Wires connectivity listeners, the SW relay and the retry interval. */
export function initJobSync(): () => void {
  if (initialized) return () => {};
  initialized = true;
  state = { ...state, online: navigator.onLine };

  const onOnline = () => {
    patchState({ online: true });
    void flushOutboxNow();
  };
  const onOffline = () => patchState({ online: false });

  window.addEventListener('online', onOnline);
  window.addEventListener('offline', onOffline);

  const onSwMessage = (event: MessageEvent) => {
    const data = event.data as { type?: string } | undefined;
    if (data?.type === 'HAYS_FLUSH_OUTBOX') void flushOutboxNow();
  };
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.addEventListener('message', onSwMessage);
  }

  const timer = window.setInterval(() => {
    if (state.online && state.pendingCount > 0 && !state.syncing) void flushOutboxNow();
  }, 60_000);

  void countOutbox().then((count) => patchState({ pendingCount: count }));
  void flushOutboxNow();

  return () => {
    initialized = false;
    window.removeEventListener('online', onOnline);
    window.removeEventListener('offline', onOffline);
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.removeEventListener('message', onSwMessage);
    }
    window.clearInterval(timer);
  };
}

// ---- workspace drafts -----------------------------------------------------

let draftTimer: number | null = null;

/** Debounced autosave of the current workspace record. */
export function scheduleDraftSave(job: RestorationJobData, recordId?: string) {
  if (draftTimer) window.clearTimeout(draftTimer);
  draftTimer = window.setTimeout(() => {
    void putDraft({ id: 'current', job, recordId, savedAt: Date.now() });
  }, 500);
}

/** Restores the last workspace record, if one was autosaved. */
export async function restoreDraft() {
  try {
    return await getDraft();
  } catch {
    return undefined;
  }
}
