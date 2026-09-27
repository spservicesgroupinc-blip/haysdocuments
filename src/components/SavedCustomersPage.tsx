import React from 'react';
import {
  Search,
  RefreshCw,
  FolderOpen,
  Trash2,
  Loader2,
  AlertCircle,
  Database,
  CloudOff,
} from 'lucide-react';
import type { SyncJobSummary } from '../services/localDb';

interface SavedCustomersPageProps {
  jobs: SyncJobSummary[];
  isLoading: boolean;
  error: string | null;
  search: string;
  currentRecordId?: string;
  isDatabaseConfigured: boolean;
  /** Verified email, when signed in to the database. */
  databaseEmail: string | null;
  /** True when the developer shared-secret bypass is active (no sign-in). */
  isDeveloperBypass: boolean;
  onSearchChange: (value: string) => void;
  onRefresh: () => void;
  onOpenJob: (recordId: string) => void;
  onDeleteJob: (job: SyncJobSummary) => void;
}

function formatWhen(value: string): string {
  if (!value) return '—';
  const date = new Date(value);
  if (isNaN(date.getTime())) return value;
  return date.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

const STATUS_STYLES: Record<string, string> = {
  Draft: 'bg-slate-100 text-slate-700 border-slate-200',
  Active: 'bg-emerald-100 text-emerald-700 border-emerald-200',
  'On Hold': 'bg-amber-100 text-amber-700 border-amber-200',
  Complete: 'bg-blue-100 text-blue-700 border-blue-200',
  Cancelled: 'bg-rose-100 text-rose-700 border-rose-200',
};

/** Home page — the saved customer/job records from the Apps Script database. */
export const SavedCustomersPage: React.FC<SavedCustomersPageProps> = ({
  jobs,
  isLoading,
  error,
  search,
  currentRecordId,
  isDatabaseConfigured,
  databaseEmail,
  isDeveloperBypass,
  onSearchChange,
  onRefresh,
  onOpenJob,
  onDeleteJob,
}) => {
  const query = search.trim().toLowerCase();
  const visible = query
    ? jobs.filter((job) =>
        [job.jobNumber, job.jobName, job.customerName, job.email, job.lossAddress, job.carrier, job.claimNumber]
          .join(' ')
          .toLowerCase()
          .includes(query)
      )
    : jobs;

  return (
    <section className="bg-white rounded-xl border border-slate-200" aria-label="Saved customers">
      {/* Page header */}
      <div className="px-5 py-4 border-b border-slate-200 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <div className="p-2 rounded-lg bg-red-50 text-red-600">
            <Database className="w-4 h-4" />
          </div>
          <div>
            <h2 className="text-[15px] font-semibold text-slate-900 tracking-tight">
              Saved Customers
            </h2>
            <p className="mt-0.5 text-[12px] text-slate-500">
              {isDatabaseConfigured
                ? databaseEmail
                  ? `Signed in as ${databaseEmail}`
                  : 'Saved jobs from your Google Apps Script database'
                : 'Database not configured — set VITE_APPS_SCRIPT_URL'}
            </p>
          </div>
        </div>
        <span className="text-[12px] text-slate-500">
          {isDatabaseConfigured
            ? `${jobs.length} saved job${jobs.length === 1 ? '' : 's'}`
            : 'Not connected'}
        </span>
      </div>

      {/* Toolbar */}
      <div className="px-5 py-3 border-b border-slate-100 flex flex-col sm:flex-row sm:items-center gap-3">
        <div className="relative flex-1">
          <span className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none text-slate-400">
            <Search className="w-4 h-4" />
          </span>
          <input
            type="text"
            value={search}
            onChange={(event) => onSearchChange(event.target.value)}
            placeholder="Search by job #, customer, address, carrier or claim #…"
            className="w-full pl-9 pr-3 py-2 text-sm bg-slate-50 border border-slate-300 rounded-lg text-slate-900 focus:bg-white focus:outline-none focus:border-red-500 focus:ring-1 focus:ring-red-500 transition"
          />
        </div>
        <button
          type="button"
          onClick={onRefresh}
          disabled={isLoading || !isDatabaseConfigured}
          className="inline-flex items-center justify-center gap-1.5 px-3.5 py-2 text-xs font-semibold rounded-lg border border-slate-200 text-slate-700 bg-white hover:bg-slate-50 disabled:opacity-50 disabled:cursor-not-allowed transition"
        >
          {isLoading ? (
            <Loader2 className="w-3.5 h-3.5 animate-spin" />
          ) : (
            <RefreshCw className="w-3.5 h-3.5" />
          )}
          Refresh
        </button>
      </div>

      {/* Body */}
      <div className="px-5 py-4 min-h-[240px]">
        {!isDatabaseConfigured && (
          <div className="flex items-start gap-3 rounded-xl border border-amber-200 bg-amber-50 p-4 text-amber-900">
            <CloudOff className="w-5 h-5 shrink-0 mt-0.5" />
            <div className="text-xs leading-relaxed">
              <p className="font-bold">The customer database is not connected yet.</p>
              <p className="mt-1">
                Deploy <code className="font-mono">apps-script/Code.gs</code> (see{' '}
                <code className="font-mono">apps-script/README.md</code>), then add{' '}
                <code className="font-mono">VITE_APPS_SCRIPT_URL</code> and{' '}
                <code className="font-mono">VITE_GOOGLE_CLIENT_ID</code> to{' '}
                <code className="font-mono">.env.local</code> and restart the dev server.
              </p>
            </div>
          </div>
        )}

        {isDatabaseConfigured && isDeveloperBypass && (
          <div className="mb-4 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3">
            <p className="text-[13px] font-semibold text-amber-900">Developer mode</p>
            <p className="mt-0.5 text-[12px] leading-relaxed text-amber-800">
              Sign-in is bypassed with a shared secret. Anyone holding the web-app URL and this secret
              has full access — remove <code className="font-mono">VITE_DEV_SHARED_SECRET</code> and the
              Apps Script <code className="font-mono">SHARED_SECRET</code> property before going live.
            </p>
          </div>
        )}

        {isDatabaseConfigured && error && (
          <div className="flex items-start gap-3 rounded-xl border border-rose-200 bg-rose-50 p-4 text-rose-900">
            <AlertCircle className="w-5 h-5 shrink-0 mt-0.5" />
            <p className="text-xs font-medium leading-relaxed">{error}</p>
          </div>
        )}

        {isDatabaseConfigured && isLoading && jobs.length === 0 && (
          <div className="flex flex-col items-center justify-center py-14 text-slate-500">
            <Loader2 className="w-6 h-6 animate-spin text-red-600" />
            <p className="mt-3 text-xs font-semibold">Loading saved jobs…</p>
          </div>
        )}

        {isDatabaseConfigured && !isLoading && !error && visible.length === 0 && (
          <div className="flex flex-col items-center justify-center py-14 text-center">
            <div className="p-3 rounded-2xl bg-slate-100 text-slate-400">
              <Database className="w-6 h-6" />
            </div>
            <p className="mt-3 text-sm font-bold text-slate-800">
              {jobs.length === 0 ? 'No saved jobs yet' : 'No matches'}
            </p>
            <p className="mt-1 text-xs text-slate-500 max-w-sm">
              {jobs.length === 0
                ? 'Paste an intake at the top of the page, review the sections, then choose “Save” in the header to store it here for future editing.'
                : 'Try a different search term.'}
            </p>
          </div>
        )}

        {visible.length > 0 && (
          <ul className="space-y-2">
            {visible.map((job) => {
              const isCurrent = !!currentRecordId && job.recordId === currentRecordId;
              return (
                <li
                  key={job.recordId}
                  className={`rounded-xl border p-3.5 transition ${
                    isCurrent
                      ? 'border-red-300 bg-red-50/40'
                      : 'border-slate-200 hover:border-slate-300 hover:bg-slate-50'
                  }`}
                >
                  <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="font-bold text-sm text-slate-900">
                          {job.customerName || 'Unnamed customer'}
                        </span>
                        <span className="text-[11px] font-bold text-red-700 bg-red-50 border border-red-200 px-1.5 py-0.5 rounded">
                          {job.jobNumber || 'No job #'}
                        </span>
                        {job.status && (
                          <span
                            className={`text-[10px] font-bold px-1.5 py-0.5 rounded border ${
                              STATUS_STYLES[job.status] ?? 'bg-slate-100 text-slate-700 border-slate-200'
                            }`}
                          >
                            {job.status}
                          </span>
                        )}
                        {job.syncState === 'pending-save' && (
                          <span
                            title="Saved on this device — waiting to sync to the database"
                            className="text-[10px] font-bold px-1.5 py-0.5 rounded border border-amber-200 bg-amber-50 text-amber-700"
                          >
                            PENDING SYNC
                          </span>
                        )}
                        {isCurrent && (
                          <span className="text-[10px] font-bold px-1.5 py-0.5 rounded border border-red-300 bg-white text-red-700">
                            OPEN
                          </span>
                        )}
                      </div>
                      <p className="mt-1 text-xs text-slate-600 truncate">
                        {job.lossAddress || 'No loss address'}
                        {job.carrier ? ` • ${job.carrier}` : ''}
                        {job.claimNumber ? ` • Claim ${job.claimNumber}` : ''}
                      </p>
                      <p className="mt-0.5 text-[11px] text-slate-400">
                        Updated {formatWhen(job.updatedAt)}
                        {job.updatedBy ? ` by ${job.updatedBy}` : ''}
                      </p>
                    </div>

                    <div className="flex items-center gap-2 shrink-0">
                      <button
                        type="button"
                        onClick={() => onOpenJob(job.recordId)}
                        className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-bold rounded-lg bg-slate-900 text-white hover:bg-slate-800 transition"
                      >
                        <FolderOpen className="w-3.5 h-3.5" />
                        Open
                      </button>
                      <button
                        type="button"
                        onClick={() => onDeleteJob(job)}
                        className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-lg border border-rose-200 text-rose-700 bg-white hover:bg-rose-50 transition"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                        Delete
                      </button>
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {/* Footer */}
      <div className="px-5 py-3 border-t border-slate-100 flex flex-col sm:flex-row sm:items-center justify-between gap-1 text-[11px] text-slate-500">
        <span>
          {isDatabaseConfigured
            ? `${visible.length} of ${jobs.length} saved job${jobs.length === 1 ? '' : 's'}`
            : 'Not connected'}
        </span>
        <span>Open a record to edit its sections — the document parser above always stays available.</span>
      </div>
    </section>
  );
};
