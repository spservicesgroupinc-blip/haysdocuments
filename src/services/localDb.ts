/**
 * IndexedDB persistence for the offline-first job store.
 *
 * Stores:
 *  - `jobs`   — one mirror row per record: last known server summary, the full
 *               record JSON, and the local sync state.
 *  - `outbox` — ordered queue of pending writes (save/delete) for the Apps
 *               Script database; replayed when connectivity returns.
 *  - `drafts` — the current workspace record, autosaved so a reload/restart
 *               never loses in-progress work.
 */
import type { RestorationJobData } from '../types/jobData';
import type { JobSummary } from './appsScriptService';

export type JobSyncStatus = 'synced' | 'pending-save' | 'pending-delete';

/** A job summary plus its local sync state, used by the saved-jobs list. */
export interface SyncJobSummary extends JobSummary {
  syncState: JobSyncStatus;
}

export interface MirrorJob {
  recordId: string;
  /** Last known server-shaped summary (locally derived while pending). */
  summary: JobSummary;
  /** Full record JSON. May be null for rows cached from a summary-only list. */
  record: RestorationJobData | null;
  syncState: JobSyncStatus;
  /** Server `updatedAt` at the time the local edit started (conflict base). */
  baseUpdatedAt: string | null;
  /** When this mirror row last changed locally. */
  locallyUpdatedAt: string;
  /**
   * Lower-cased account email that made the unsynced edit. Unset on synced rows
   * because those are just a cache of the shared server data, and unset on rows
   * written before ownership existed. Pending rows are only ever shown to, and
   * flushed by, the account that created them.
   */
  owner?: string;
}

export interface OutboxOp {
  id?: number;
  type: 'save' | 'delete' | 'draft';
  recordId: string;
  job?: RestorationJobData;
  /** The autosaved workspace record, for `type: 'draft'` operations. */
  draft?: WorkspaceDraft;
  createdAt: number;
  attempts: number;
  lastError?: string;
  /** Account that queued the write; only that account replays it. */
  owner?: string;
}

export interface WorkspaceDraft {
  id: 'current';
  job: RestorationJobData;
  recordId?: string;
  savedAt: number;
  /** `updatedAt` of the server copy this local draft mirrors, when known. */
  serverUpdatedAt?: string;
  /** Who last wrote the draft server-side, when known. */
  updatedBy?: string;
}

const DB_NAME = 'hays.docsuite';
const DB_VERSION = 1;

const JOBS = 'jobs';
const OUTBOX = 'outbox';
const DRAFTS = 'drafts';

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(JOBS)) db.createObjectStore(JOBS, { keyPath: 'recordId' });
        if (!db.objectStoreNames.contains(OUTBOX)) {
          db.createObjectStore(OUTBOX, { keyPath: 'id', autoIncrement: true });
        }
        if (!db.objectStoreNames.contains(DRAFTS)) db.createObjectStore(DRAFTS, { keyPath: 'id' });
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }
  return dbPromise;
}

function runRequest<T>(
  storeName: string,
  mode: IDBTransactionMode,
  operation: (store: IDBObjectStore) => IDBRequest
): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const tx = db.transaction(storeName, mode);
        const request = operation(tx.objectStore(storeName));
        request.onsuccess = () => resolve(request.result as T);
        request.onerror = () => reject(request.error);
      })
  );
}

// ---- jobs mirror ----------------------------------------------------------

export function getAllMirrorJobs(): Promise<MirrorJob[]> {
  return runRequest<MirrorJob[]>(JOBS, 'readonly', (store) => store.getAll());
}

export function getMirrorJob(recordId: string): Promise<MirrorJob | undefined> {
  return runRequest<MirrorJob | undefined>(JOBS, 'readonly', (store) => store.get(recordId));
}

export function putMirrorJob(job: MirrorJob): Promise<void> {
  return runRequest<void>(JOBS, 'readwrite', (store) => store.put(job));
}

export function deleteMirrorJob(recordId: string): Promise<void> {
  return runRequest<void>(JOBS, 'readwrite', (store) => store.delete(recordId));
}

// ---- outbox ---------------------------------------------------------------

export function enqueueOutbox(op: Omit<OutboxOp, 'id'>): Promise<number> {
  return runRequest<number>(OUTBOX, 'readwrite', (store) => store.add(op));
}

export async function getOutboxOps(): Promise<OutboxOp[]> {
  const ops = await runRequest<OutboxOp[]>(OUTBOX, 'readonly', (store) => store.getAll());
  return ops.sort((a, b) => (a.id ?? 0) - (b.id ?? 0));
}

export function updateOutboxOp(op: OutboxOp): Promise<void> {
  return runRequest<void>(OUTBOX, 'readwrite', (store) => store.put(op));
}

export function deleteOutboxOp(id: number): Promise<void> {
  return runRequest<void>(OUTBOX, 'readwrite', (store) => store.delete(id));
}

export function countOutbox(): Promise<number> {
  return runRequest<number>(OUTBOX, 'readonly', (store) => store.count());
}

/**
 * True when `owner` is allowed to replay this queued write: it either belongs
 * to that account, or it predates ownership tagging.
 */
export function outboxOpIsMine(op: OutboxOp, owner: string | null): boolean {
  if (!op.owner) return true;
  return owner !== null && op.owner === owner;
}

export interface OutboxSummary {
  /** Writes this account can replay right now. */
  mine: number;
  /** Writes queued by a different account, waiting for that person to sign in. */
  stranded: number;
  /** Account that owns the stranded writes, when it can be determined. */
  strandedOwner: string | null;
}

/** Splits the outbox into "mine" and "waiting for another account". */
export async function summarizeOutbox(owner: string | null): Promise<OutboxSummary> {
  const ops = await getOutboxOps();
  let mine = 0;
  let stranded = 0;
  let strandedOwner: string | null = null;

  for (const op of ops) {
    if (outboxOpIsMine(op, owner)) {
      mine += 1;
    } else {
      stranded += 1;
      if (!strandedOwner) strandedOwner = op.owner ?? null;
    }
  }

  return { mine, stranded, strandedOwner };
}

/**
 * Queues a draft push, reusing the pending draft operation when there is one so
 * a long editing session cannot fill the outbox with superseded drafts.
 */
export async function queueDraftOutbox(op: Omit<OutboxOp, 'id'>): Promise<void> {
  const ops = await getOutboxOps();
  const existing = ops.find((candidate) => candidate.type === 'draft');

  if (existing && existing.id !== undefined) {
    await updateOutboxOp({ ...op, id: existing.id });
    return;
  }
  await enqueueOutbox(op);
}

// ---- workspace draft ------------------------------------------------------

export function putDraft(draft: WorkspaceDraft): Promise<void> {
  return runRequest<void>(DRAFTS, 'readwrite', (store) => store.put(draft));
}

export function getDraft(): Promise<WorkspaceDraft | undefined> {
  return runRequest<WorkspaceDraft | undefined>(DRAFTS, 'readonly', (store) =>
    store.get('current')
  );
}
