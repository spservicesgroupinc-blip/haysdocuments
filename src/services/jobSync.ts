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
  fetchDraft,
  getCurrentUser,
  getJob,
  isDatabaseConfigured,
  isDeveloperBypassEnabled,
  listJobs,
  saveDraft,
  saveJob,
  DatabaseError,
  type AuthContext,
  type JobSummary,
} from './appsScriptService';
import {
  deleteMirrorJob,
  deleteOutboxOp,
  enqueueOutbox,
  getAllMirrorJobs,
  getDraft,
  getMirrorJob,
  getOutboxOps,
  outboxOpIsMine,
  putDraft,
  putMirrorJob,
  queueDraftOutbox,
  summarizeOutbox,
  updateOutboxOp,
  type MirrorJob,
  type OutboxOp,
  type SyncJobSummary,
  type WorkspaceDraft,
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
  /** Queued writes on this device that belong to a different account. */
  strandedCount: number;
  /** The account those stranded writes belong to, when it can be determined. */
  strandedOwner: string | null;
}

const NETWORK_ERROR_CODES = new Set(['network_error', 'timeout']);

function isNetworkish(err: unknown): boolean {
  return err instanceof DatabaseError && NETWORK_ERROR_CODES.has(err.code);
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * The account whose local edits this session may read and replay.
 *
 * Local mirrors and the outbox are per-account: on a shared machine one person
 * must never see - or publish - another person's unsaved work. Rows that are
 * fully synced carry no owner, because they are only a cache of the shared
 * server data that every account is entitled to.
 */
function currentOwner(): string | null {
  if (isDeveloperBypassEnabled()) return 'dev';
  const user = getCurrentUser();
  return user?.email ? user.email.toLowerCase() : null;
}

/** True when a locally queued row was written by somebody else's account. */
function ownedByOther(owner: string | undefined, mine: string | null): boolean {
  return !!owner && owner !== mine;
}

/** Keeps the sync badge in step with what this account can actually flush. */
async function refreshPendingState(): Promise<void> {
  const summary = await summarizeOutbox(currentOwner());
  patchState({
    pendingCount: summary.mine,
    strandedCount: summary.stranded,
    strandedOwner: summary.strandedOwner,
  });
}

// ---- state (tiny pub/sub for the UI) --------------------------------------

let state: SyncState = {
  online: typeof navigator === 'undefined' ? true : navigator.onLine,
  pendingCount: 0,
  syncing: false,
  lastSyncAt: null,
  lastError: null,
  conflictNotice: null,
  strandedCount: 0,
  strandedOwner: null,
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
  const owner = currentOwner();
  const all = await getAllMirrorJobs();
  return all
    .filter((row) => row.syncState !== 'pending-delete')
    .filter((row) => row.syncState === 'synced' || !ownedByOther(row.owner, owner))
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
    });
    await refreshPendingState();
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
  const owner = currentOwner();
  const mirror = await getAllMirrorJobs();
  const byId = new Map(mirror.map((row) => [row.recordId, row]));
  const seen = new Set<string>();
  const conflicts: string[] = [];
  const results: SyncJobSummary[] = [];

  for (const job of serverJobs) {
    seen.add(job.recordId);
    const local = byId.get(job.recordId);

    // Another account has unsynced edits for this record. Leave its row exactly
    // as it is - that person will publish it - and show the server copy here.
    if (local && local.syncState !== 'synced' && ownedByOther(local.owner, owner)) {
      results.push({ ...stripRecord(job), syncState: 'synced' });
      continue;
    }

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
    if (row.syncState === 'pending-save' && !ownedByOther(row.owner, owner)) {
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
  const owner = currentOwner();
  const mirror = await getMirrorJob(recordId);
  // Another account's unsynced copy is off limits: fall through to the server.
  const cached = mirror && !ownedByOther(mirror.owner, owner) ? mirror : undefined;

  if (cached && cached.syncState !== 'synced' && cached.record) {
    return { job: cached.record, fromCache: true };
  }
  try {
    const auth = await acquireAuthContext();
    const result = await getJob(auth, { recordId });
    await putMirrorJob({
      recordId,
      summary: summaryFromRecord(result.job, cached?.summary ?? null),
      record: result.job,
      syncState: 'synced',
      baseUpdatedAt: result.updatedAt || cached?.summary?.updatedAt || null,
      locallyUpdatedAt: new Date().toISOString(),
    });
    return { job: result.job, fromCache: false };
  } catch (err) {
    if (isNetworkish(err) && cached?.record) {
      return { job: cached.record, fromCache: true };
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
  const owner = currentOwner();
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
    owner: owner ?? undefined,
  });
  await enqueueOutbox({
    type: 'save',
    recordId,
    job: record,
    createdAt: Date.now(),
    attempts: 0,
    owner: owner ?? undefined,
  });
  await refreshPendingState();

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
  const owner = currentOwner();
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
      owner: owner ?? undefined,
    });
  } else {
    await putMirrorJob({
      ...existing,
      syncState: 'pending-delete',
      locallyUpdatedAt: new Date().toISOString(),
      owner: owner ?? undefined,
    });
  }
  await enqueueOutbox({
    type: 'delete',
    recordId,
    createdAt: Date.now(),
    attempts: 0,
    owner: owner ?? undefined,
  });
  await refreshPendingState();

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
  const owner = currentOwner();
  // Only this account's writes are replayed. Anything queued by a different
  // account on this device stays put until that person signs in, so nobody ever
  // publishes - or is credited with - somebody else's edit.
  const ops = (await getOutboxOps()).filter((op) => outboxOpIsMine(op, owner));
  if (ops.length === 0) {
    await refreshPendingState();
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
  let hadFailure = false;
  let publishedAny = false;

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
        let published = true;
        if (op.type === 'draft' && op.draft) {
          published = await pushDraft(auth, op);
        } else if (op.type === 'save' && op.job) {
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
        if (published) {
          await deleteOutboxOp(op.id as number);
          publishedAny = true;
        }
        await refreshPendingState();
      } catch (err) {
        if (isNetworkish(err)) {
          await updateOutboxOp({ ...op, attempts: op.attempts + 1, lastError: errorMessage(err) });
          patchState({ lastError: errorMessage(err) });
          throw err; // stop this run; retry on the next trigger
        }
        if (err instanceof DatabaseError && err.code === 'not_found' && op.type !== 'draft') {
          // The server no longer has this record — clear local traces and move on.
          await deleteMirrorJob(op.recordId);
          await deleteOutboxOp(op.id as number);
          await refreshPendingState();
          continue;
        }
        if (op.type === 'draft' && err instanceof DatabaseError && err.code === 'unknown_action') {
          // The deployed script predates draft support. Retrying cannot help, and
          // the local draft still holds the work, so drop the queued copy.
          await deleteOutboxOp(op.id as number);
          console.warn(
            'The Apps Script backend does not store workspace drafts yet. Paste the latest Code.gs into the editor and redeploy to back up in-progress work.'
          );
          await refreshPendingState();
          continue;
        }
        // Rejected write (role, validation, …): keep it queued, report, continue.
        hadFailure = true;
        await updateOutboxOp({ ...op, attempts: op.attempts + 1, lastError: errorMessage(err) });
        patchState({ lastError: errorMessage(err) });
        // An invalid deployment response affects every operation. Keep the rest
        // queued rather than sending more writes without acknowledgements.
        if (err instanceof DatabaseError && err.code === 'bad_response') return;
      }
    }

    if (publishedAny) patchState({ lastSyncAt: new Date().toISOString() });
    if (!hadFailure) patchState({ lastError: null });
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

// ---- drafts ---------------------------------------------------------------

/**
 * Publishes one queued workspace draft.
 *
 * Returns false when the local draft has already moved on: every autosave reuses
 * the same outbox slot, so the newer payload stays queued and goes out on the
 * next pass instead of being dropped.
 */
async function pushDraft(auth: AuthContext, op: OutboxOp): Promise<boolean> {
  if (!op.draft) return true;
  const draft = op.draft;

  const saved = await saveDraft(auth, {
    job: draft.job,
    recordId: draft.recordId,
    savedAt: draft.savedAt,
  });

  const latest = await safeGetDraft();
  if (latest && latest.savedAt > draft.savedAt) return false;

  try {
    await putDraft({
      id: 'current',
      job: draft.job,
      recordId: draft.recordId,
      savedAt: draft.savedAt,
      serverUpdatedAt: saved.updatedAt,
      updatedBy: saved.updatedBy,
    });
  } catch {
    /* cache-only write */
  }
  return true;
}

async function safeGetDraft(): Promise<WorkspaceDraft | undefined> {
  try {
    return await getDraft();
  } catch {
    return undefined;
  }
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

  void refreshPendingState();
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
let draftPushTimer: number | null = null;

/**
 * Debounced autosave of the current workspace record.
 *
 * The local mirror write is quick (500ms) so nothing in progress is ever lost;
 * the push to the Apps Script database waits for a longer idle gap (4s), so a
 * long typing session cannot hammer the backend with one request per pause. The
 * queued push is durable either way: it is replayed on the next start, on
 * reconnect, and by the periodic flush.
 */
export function scheduleDraftSave(job: RestorationJobData, recordId?: string) {
  if (draftTimer) window.clearTimeout(draftTimer);
  draftTimer = window.setTimeout(() => {
    void putDraft({ id: 'current', job, recordId, savedAt: Date.now() }).catch(() => {
      /* storage unavailable (private mode) - the server copy still goes out */
    });
  }, 500);

  if (draftPushTimer) window.clearTimeout(draftPushTimer);
  draftPushTimer = window.setTimeout(() => {
    void queueCurrentDraftPush();
  }, 4000);
}

/**
 * Queues the local draft for publishing. Used when the local copy is ahead of
 * the shared one, including drafts that were never pushed.
 */
async function queueCurrentDraftPush(): Promise<void> {
  const draft = await safeGetDraft();
  if (!draft) return;

  try {
    await queueDraftOutbox({
      type: 'draft',
      recordId: draft.recordId ?? draft.job.recordId ?? '',
      draft,
      createdAt: Date.now(),
      attempts: 0,
    });
  } catch {
    return;
  }

  await refreshPendingState();
  if (state.online) void flushOutboxNow();
}

export interface RestoredDraft {
  job: RestorationJobData;
  recordId?: string;
  updatedBy?: string;
  updatedAt?: string;
  /** Where the record came from, so the UI can say so. */
  origin: 'server' | 'local';
}

/** Failures that mean "no server draft to read", not "something is broken". */
function isDraftReadMiss(err: unknown): boolean {
  if (!(err instanceof DatabaseError)) return false;
  return (
    err.code === 'unknown_action' ||
    err.code === 'not_configured' ||
    err.code === 'network_error' ||
    err.code === 'timeout' ||
    err.code === 'bad_response' ||
    err.code === 'no_session' ||
    err.code === 'session_expired' ||
    err.code === 'unauthenticated' ||
    err.code === 'unauthorized'
  );
}

/**
 * Returns the record the workspace should open with.
 *
 * The Apps Script copy is the shared system of record, which is what makes an
 * unfinished job reappear on another machine or under another account. It only
 * displaces the local copy when the shared draft has genuinely moved on since
 * this device last saw it - decided from server timestamps, so a wrong device
 * clock can never cause a newer local edit to be discarded. Offline, or on a
 * deployment without draft support, the local mirror is used.
 */
export async function restoreDraft(): Promise<RestoredDraft | undefined> {
  const local = await safeGetDraft();
  const localResult: RestoredDraft | undefined = local
    ? { job: local.job, recordId: local.recordId, updatedBy: local.updatedBy, origin: 'local' }
    : undefined;

  if (!isDatabaseConfigured()) return localResult;

  try {
    const auth = await acquireAuthContext();
    const server = await fetchDraft(auth);

    if (!server) {
      // Nothing shared yet: publish whatever this device already had.
      if (local) void queueCurrentDraftPush();
      return localResult;
    }

    const seenAt = Date.parse(local?.serverUpdatedAt ?? '');
    const sharedMovedOn = !Number.isNaN(seenAt) && Date.parse(server.updatedAt) > seenAt;
    if (local && !sharedMovedOn) {
      void queueCurrentDraftPush();
      return localResult;
    }

    const mirrored: WorkspaceDraft = {
      id: 'current',
      job: server.job,
      recordId: server.recordId || server.job.recordId,
      savedAt: Date.parse(server.updatedAt) || Date.now(),
      serverUpdatedAt: server.updatedAt,
      updatedBy: server.updatedBy,
    };
    try {
      await putDraft(mirrored);
    } catch {
      /* cache-only write */
    }

    return {
      job: mirrored.job,
      recordId: mirrored.recordId,
      updatedBy: server.updatedBy,
      updatedAt: server.updatedAt,
      origin: 'server',
    };
  } catch (err) {
    if (isDraftReadMiss(err)) return localResult;
    throw err;
  }
}
