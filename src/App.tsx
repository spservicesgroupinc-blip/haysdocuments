/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect } from 'react';
import { User } from 'firebase/auth';
import {
  RestorationJobData,
  CustomerData,
  InsuranceData,
  FinancialData,
  TeamData,
  MortgageData,
  ChangeOrderData,
  createEmptyJob,
  ensureRecordDefaults,
} from './types/jobData';
import {
  initAuth,
  googleSignIn,
  logoutGoogle,
  uploadPdfToGoogleDrive,
  syncJobToGoogleSheets,
} from './services/googleWorkspaceService';
import {
  downloadPdf,
  generateCompletePacket,
  generateDocWithSpans,
  type PdfFieldSpan,
} from './services/pdfService';
import { getPdfFieldSchema } from './services/pdfFieldSchema';
import type { JobDocument } from './services/documentCatalog';
import { isDesktop } from './services/desktopBridge';
import {
  isDatabaseConfigured,
  isDeveloperBypassEnabled,
  login as loginToDatabase,
  registerAccount,
  logout as logoutFromDatabase,
  verifySession,
  getCurrentUser,
  AppUser,
} from './services/appsScriptService';
import {
  deleteJobOffline,
  getSyncState,
  initJobSync,
  loadJobOffline,
  readCachedJobSummaries,
  refreshJobs,
  restoreDraft,
  saveJobOffline,
  scheduleDraftSave,
  subscribeSyncState,
  type RestoredDraft,
  type SyncState,
} from './services/jobSync';
import type { SyncJobSummary } from './services/localDb';
import { LoginScreen } from './components/LoginScreen';
import { Navbar } from './components/Navbar';
import { MobileSectionNav, Sidebar } from './components/Sidebar';
import type { WorkspaceTab } from './components/Sidebar';
import { SavedCustomersPage } from './components/SavedCustomersPage';
import { FinancialSummaryCard } from './components/FinancialSummaryCard';
import { SectionCustomer } from './components/SectionCustomer';
import { SectionInsurance } from './components/SectionInsurance';
import { SectionTeam } from './components/SectionTeam';
import { SectionMortgage } from './components/SectionMortgage';
import { SectionChangeOrder } from './components/SectionChangeOrder';
import { SectionChecklist } from './components/SectionChecklist';
import { SectionProductionNotes } from './components/SectionProductionNotes';
import { IntakeParserCard } from './components/IntakeParserCard';
import { DocumentGenerationPanel } from './components/DocumentGenerationPanel';
import { PdfPreviewModal } from './components/PdfPreviewModal';
import { ConfirmModal } from './components/ConfirmModal';
import { PwaStatus } from './components/PwaStatus';
import { ProvenanceRecord } from './services/intakeParser';
import { Loader2 } from 'lucide-react';

export default function App() {
  const [jobData, setJobData] = useState<RestorationJobData>(() => createEmptyJob());
  const [provenance, setProvenance] = useState<ProvenanceRecord>({});
  const [activeTab, setActiveTab] = useState<WorkspaceTab>('home');

  // Google Workspace Authentication & state
  const [user, setUser] = useState<User | null>(null);
  const [isLoggingIn, setIsLoggingIn] = useState(false);
  const [isDriveLoading, setIsDriveLoading] = useState(false);
  const [isSheetsLoading, setIsSheetsLoading] = useState(false);
  const [driveSuccessLink, setDriveSuccessLink] = useState<string | undefined>();
  const [sheetsSuccessLink, setSheetsSuccessLink] = useState<string | undefined>();

  // Preview Modal state
  const [previewTitle, setPreviewTitle] = useState<string>('');
  const [previewDoc, setPreviewDoc] = useState<JobDocument | null>(null);
  const [previewBytes, setPreviewBytes] = useState<Uint8Array | null>(null);
  const [previewSpans, setPreviewSpans] = useState<PdfFieldSpan[]>([]);
  const [isPreviewOpen, setIsPreviewOpen] = useState(false);
  const [isPreviewLoading, setIsPreviewLoading] = useState(false);
  const [isPreviewRegenerating, setIsPreviewRegenerating] = useState(false);

  // Latest job record for async PDF work (generators must read the freshest state).
  const jobDataRef = React.useRef<RestorationJobData>(jobData);
  const previewRegenTimerRef = React.useRef<number | null>(null);

  useEffect(() => {
    jobDataRef.current = jobData;
  }, [jobData]);

  // Confirm Modal state (for Workspace changes)
  const [confirmDialog, setConfirmDialog] = useState<{
    isOpen: boolean;
    title: string;
    message: string;
    action: () => Promise<void>;
    confirmLabel: string;
    isDanger?: boolean;
  }>({
    isOpen: false,
    title: '',
    message: '',
    action: async () => {},
    confirmLabel: 'Confirm',
  });

  // Notification Banner
  const [statusNotification, setStatusNotification] = useState<{
    type: 'success' | 'error' | 'info';
    message: string;
  } | null>(null);

  // ---- Customer database (Google Apps Script) state ----------------------
  const [recordId, setRecordId] = useState<string | undefined>(undefined);
  const [isDirty, setIsDirty] = useState(false);
  const [isSavingJob, setIsSavingJob] = useState(false);
  const [savedJobs, setSavedJobs] = useState<SyncJobSummary[]>([]);
  const [isLoadingJobs, setIsLoadingJobs] = useState(false);
  const [jobListError, setJobListError] = useState<string | null>(null);
  const [jobSearch, setJobSearch] = useState('');
  const [databaseEmail, setDatabaseEmail] = useState<string | null>(null);
  const [currentUser, setCurrentUser] = useState<AppUser | null>(() => getCurrentUser());
  const [isAuthReady, setIsAuthReady] = useState(false);
  const [syncState, setSyncState] = useState<SyncState>(getSyncState);

  // Dirty tracking compares the record against the last saved/loaded baseline,
  // so programmatic whole-record replacements never look like user edits.
  const baselineRef = React.useRef<string>(JSON.stringify(jobData));
  // True once the workspace has been filled from the shared/draft copy, so a
  // later sign-in does not overwrite work already on screen.
  const draftRestoredRef = React.useRef(false);

  useEffect(() => {
    setIsDirty(JSON.stringify(jobData) !== baselineRef.current);
  }, [jobData]);

  /** Replaces the whole record and treats it as the new clean baseline. */
  const replaceJob = (next: RestorationJobData) => {
    const normalized = ensureRecordDefaults(next);
    baselineRef.current = JSON.stringify(normalized);
    setJobData(normalized);
    setIsDirty(false);
  };

  // Offline-first sync engine: connectivity listeners, outbox flush, status.
  useEffect(() => initJobSync(), []);
  useEffect(() => subscribeSyncState(setSyncState), []);

  // Autosave the workspace record (debounced) so a reload never loses work…
  useEffect(() => {
    scheduleDraftSave(jobData, recordId);
  }, [jobData, recordId]);

  // The workspace draft is stored in the Apps Script database (and mirrored
  // locally so it still works offline), which is what keeps an unfinished
  // record from being stranded in one browser profile.
  const applyRestoredDraft = (draft: RestoredDraft) => {
    if (draftRestoredRef.current) return;
    draftRestoredRef.current = true;
    replaceJob(draft.job);
    setRecordId(draft.recordId ?? draft.job.recordId);
    showStatus(
      'info',
      draft.origin === 'server'
        ? `Restored the shared workspace draft${draft.updatedBy ? ` last edited by ${draft.updatedBy}` : ''}.`
        : 'Restored your last workspace from this device.'
    );
  };

  // …and restore it once when the app starts.
  useEffect(() => {
    let cancelled = false;
    void restoreDraft().then((draft) => {
      if (cancelled || !draft) return;
      applyRestoredDraft(draft);
    });
    return () => {
      cancelled = true;
    };
    // Restore once on mount; the workspace is autosaved from then on.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // A device with no draft of its own (a new machine, or a different account)
  // picks up the shared draft as soon as the session is live.
  useEffect(() => {
    if (!isAuthReady || draftRestoredRef.current) return;
    if (!getCurrentUser() && !isDeveloperBypassEnabled()) return;
    let cancelled = false;
    void restoreDraft().then((draft) => {
      if (cancelled || !draft || draft.origin !== 'server') return;
      applyRestoredDraft(draft);
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isAuthReady, currentUser]);

  // Restore and verify any stored session before rendering the app.
  useEffect(() => {
    let cancelled = false;

    const restore = async () => {
      if (isDeveloperBypassEnabled() || !isDatabaseConfigured() || !getCurrentUser()) {
        if (!cancelled) setIsAuthReady(true);
        return;
      }
      try {
        const user = await verifySession();
        if (!cancelled) setCurrentUser(user);
      } catch (err) {
        console.warn('Session verification failed:', err);
      } finally {
        if (!cancelled) setIsAuthReady(true);
      }
    };

    restore();
    return () => {
      cancelled = true;
    };
  }, []);

  const handleRefreshJobs = async () => {
    setIsLoadingJobs(true);
    setJobListError(null);
    // Paint the cached list instantly, then reconcile with the server.
    const cached = await readCachedJobSummaries();
    if (cached.length) setSavedJobs(cached);
    const result = await refreshJobs();
    setSavedJobs(result.jobs);
    setJobListError(result.error ?? null);
    setIsLoadingJobs(false);
  };

  // Load the saved-customer list as soon as the workspace becomes available.
  useEffect(() => {
    if (!isAuthReady || !isDatabaseConfigured()) return;
    if (!currentUser && !isDeveloperBypassEnabled()) return;
    void handleRefreshJobs();
    // handleRefreshJobs is rebuilt every render; it is intentionally excluded here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isAuthReady, currentUser]);

  /** Jump to the Saved Customers home page with a fresh list. */
  const handleOpenSavedCustomers = async () => {
    setActiveTab('home');
    await handleRefreshJobs();
  };

  /** Side-menu navigation. Returning home always refreshes the saved list. */
  const handleNavigate = (tab: WorkspaceTab) => {
    setActiveTab(tab);
    if (tab === 'home') void handleRefreshJobs();
  };

  const handleAppSignIn = async (email: string, password: string) => {
    const user = await loginToDatabase(email, password);
    setCurrentUser(user);
    setDatabaseEmail(user.email);
    showStatus('success', `Signed in as ${user.name || user.email}.`);
    await handleRefreshJobs();
  };

  const handleAppRegister = async (values: {
    name: string;
    email: string;
    password: string;
    inviteCode: string;
  }) => {
    const user = await registerAccount(values);
    setCurrentUser(user);
    setDatabaseEmail(user.email);
    showStatus('success', `Account created. Welcome, ${user.name || user.email}.`);
    await handleRefreshJobs();
  };

  const handleAppSignOut = async () => {
    await logoutFromDatabase();
    setCurrentUser(null);
    setDatabaseEmail(null);
    setSavedJobs([]);
    setRecordId(undefined);
    showStatus('info', 'Signed out.');
  };

  const handleSaveJob = async () => {
    if (isSavingJob) return;
    setIsSavingJob(true);
    try {
      const outcome = await saveJobOffline({ ...jobData, recordId: jobData.recordId ?? recordId });
      setRecordId(outcome.recordId);
      replaceJob(outcome.record);
      if (outcome.queued) {
        showStatus(
          'info',
          `Job ${jobData.customer.jobNumber} saved on this device — it will sync when you're back online.`
        );
      } else {
        showStatus(
          'success',
          outcome.created
            ? `Saved job ${jobData.customer.jobNumber} to the customer database.`
            : `Updated job ${jobData.customer.jobNumber} in the customer database.`
        );
      }
      if (activeTab === 'home') await handleRefreshJobs();
    } catch (err: any) {
      showStatus('error', err?.message || 'Could not save to the customer database.');
    } finally {
      setIsSavingJob(false);
    }
  };

  const handleLoadJob = async (id: string) => {
    try {
      const { job, fromCache } = await loadJobOffline(id);
      replaceJob(job);
      setRecordId(job.recordId ?? id);
      setProvenance({});
      const who = job.customer.customerName || 'record';
      const label = `(${job.customer.jobNumber || 'no job number'})`;
      showStatus(
        fromCache ? 'info' : 'success',
        fromCache ? `Opened ${who} ${label} from this device's saved copy.` : `Opened ${who} ${label}.`
      );
    } catch (err: any) {
      showStatus('error', err?.message || 'Could not open that saved job.');
    }
  };

  const handleDeleteJob = (job: SyncJobSummary) => {
    setConfirmDialog({
      isOpen: true,
      title: 'Delete this saved job?',
      message: `This removes ${job.customerName || 'this record'} (${job.jobNumber || 'no job number'}) from the customer database. The audit log keeps a record of the deletion.`,
      confirmLabel: 'Delete Job',
      isDanger: true,
      action: async () => {
        try {
          const outcome = await deleteJobOffline(job.recordId);
          if (recordId === job.recordId) setRecordId(undefined);
          showStatus(
            'info',
            outcome.queued
              ? 'Saved job deleted on this device — the database will catch up when online.'
              : 'Saved job deleted.'
          );
          await handleRefreshJobs();
        } catch (err: any) {
          showStatus('error', err?.message || 'Could not delete that job.');
        }
      },
    });
  };

  // Initialize auth
  useEffect(() => {
    const unsubscribe = initAuth(
      (currentUser) => {
        setUser(currentUser);
      },
      () => {
        setUser(null);
      }
    );
    return () => unsubscribe();
  }, []);

  const handleLogin = async () => {
    setIsLoggingIn(true);
    try {
      const res = await googleSignIn();
      if (res?.user) {
        setUser(res.user);
        showStatus('success', `Connected to Google as ${res.user.displayName || res.user.email}`);
      }
    } catch (err: any) {
      console.error('Google Sign-in failed:', err);
      showStatus('error', err.message || 'Failed to sign in with Google');
    } finally {
      setIsLoggingIn(false);
    }
  };

  const handleLogout = async () => {
    await logoutGoogle();
    setUser(null);
    showStatus('info', 'Disconnected from Google');
  };

  const showStatus = (type: 'success' | 'error' | 'info', message: string) => {
    setStatusNotification({ type, message });
    setTimeout(() => {
      setStatusNotification(null);
    }, 5000);
  };

  // Recalculate Financials whenever RCV or Deductible changes
  const computeFinancialRecord = (
    current: RestorationJobData,
    rcvVal: number | '',
    dedVal: number | ''
  ): RestorationJobData => {
    const rcv = typeof rcvVal === 'number' && !isNaN(rcvVal) ? rcvVal : 0;
    const deductible = typeof dedVal === 'number' && !isNaN(dedVal) ? dedVal : 0;

    const netClaimValue = Math.max(0, rcv - deductible);
    const downPayment = rcv * 0.5; // 50%
    const midProgressPayment = rcv * 0.25; // 25%
    const balancePayment = rcv * 0.25; // 25%

    return {
      ...current,
      financials: {
        ...current.financials,
        totalApprovedRcv: rcvVal,
        deductible: dedVal,
        netClaimValue,
        downPayment,
        midProgressPayment,
        balancePayment,
      },
      changeOrder: {
        ...current.changeOrder,
        originalContractSum: rcvVal,
      },
    };
  };

  const updateFinancials = (rcvVal: number | '', dedVal: number | '') => {
    setJobData((prev) => computeFinancialRecord(prev, rcvVal, dedVal));
  };

  // Field change handlers
  const handleCustomerChange = (field: keyof CustomerData, value: string) => {
    setJobData((prev) => ({
      ...prev,
      customer: { ...prev.customer, [field]: value },
    }));
  };

  const handleInsuranceChange = (field: keyof InsuranceData, value: any) => {
    setJobData((prev) => ({
      ...prev,
      insurance: { ...prev.insurance, [field]: value },
    }));
  };

  const handleTeamChange = (field: keyof TeamData, value: string) => {
    setJobData((prev) => ({
      ...prev,
      team: { ...prev.team, [field]: value },
    }));
  };

  const handleMortgageChange = (field: keyof MortgageData, value: any) => {
    setJobData((prev) => ({
      ...prev,
      mortgage: { ...prev.mortgage, [field]: value },
    }));
  };

  const handleChangeOrderChange = (field: keyof ChangeOrderData, value: any) => {
    setJobData((prev) => ({
      ...prev,
      changeOrder: { ...prev.changeOrder, [field]: value },
    }));
  };

  const handleChecklistChange = (
    field: keyof RestorationJobData['checklist'],
    value: any
  ) => {
    setJobData((prev) => ({
      ...prev,
      checklist: { ...prev.checklist, [field]: value },
    }));
  };

  const handleProductionNotesChange = (
    field: keyof RestorationJobData['productionNotes'],
    value: string
  ) => {
    setJobData((prev) => ({
      ...prev,
      productionNotes: { ...prev.productionNotes, [field]: value },
    }));
  };

  // Preview Document Handler
  const handleOpenPreview = async (doc: JobDocument) => {
    setPreviewTitle(doc.title);
    setPreviewDoc(doc);
    setPreviewBytes(null);
    setPreviewSpans([]);
    setIsPreviewOpen(true);
    setIsPreviewLoading(true);

    try {
      const { bytes, spans } = await generateDocWithSpans(doc.generator, jobDataRef.current);
      setPreviewBytes(bytes);
      setPreviewSpans(spans);
    } catch (err: any) {
      console.error('Failed generating preview:', err);
      showStatus('error', 'Error generating PDF preview');
    } finally {
      setIsPreviewLoading(false);
    }
  };

  /** Debounced live regeneration after a click-to-edit change in the preview. */
  const regeneratePreview = (doc: JobDocument, data: RestorationJobData) => {
    if (previewRegenTimerRef.current !== null) {
      window.clearTimeout(previewRegenTimerRef.current);
    }
    previewRegenTimerRef.current = window.setTimeout(async () => {
      setIsPreviewRegenerating(true);
      try {
        const { bytes, spans } = await generateDocWithSpans(doc.generator, data);
        setPreviewBytes(bytes);
        setPreviewSpans(spans);
      } catch (err: any) {
        console.error('Failed regenerating preview:', err);
        showStatus('error', 'Error refreshing PDF preview');
      } finally {
        setIsPreviewRegenerating(false);
      }
    }, 300);
  };

  // Fields whose PDF editor widgets commit 'Yes'/'No' instead of raw booleans.
  const BOOLEAN_PDF_FIELDS = new Set<string>([
    'mortgage.hasMortgage',
    'changeOrder.isInsuranceRelated',
    'checklist.isSelfPay',
    'checklist.isProgramClaim',
    'checklist.hasCheckBeenSent',
    'checklist.isDepreciationWithheld',
  ]);

  // Fields stored as number | '' that the PDF editor edits as free text.
  const NUMERIC_PDF_FIELDS = new Set<string>([
    'changeOrder.originalContractSum',
    'changeOrder.netPreviousChanges',
    'changeOrder.changeAmount',
    'changeOrder.addedDays',
    'checklist.depreciationAmount',
  ]);

  const coercePdfFieldValue = (field: string, value: string): string | number | boolean => {
    if (BOOLEAN_PDF_FIELDS.has(field)) {
      const lower = value.toLowerCase();
      return lower === 'yes' ? true : lower === 'no' ? false : value;
    }
    if (NUMERIC_PDF_FIELDS.has(field)) {
      if (value === '') return '';
      const n = Number(value);
      return Number.isNaN(n) ? '' : n;
    }
    return value;
  };

  /** Routes an edit from the click-to-edit PDF preview into the job record. */
  const handlePdfFieldChange = (field: string, value: string) => {
    const dot = field.indexOf('.');
    if (dot === -1) return;
    const section = field.slice(0, dot);
    const fieldName = field.slice(dot + 1);

    const current = jobDataRef.current;
    let next: RestorationJobData;

    if (section === 'financials') {
      if (fieldName === 'totalApprovedRcv' || fieldName === 'deductible') {
        const num = value === '' ? '' : Number(value);
        const parsed = typeof num === 'number' && !Number.isNaN(num) ? num : '';
        next = computeFinancialRecord(
          current,
          fieldName === 'totalApprovedRcv' ? parsed : current.financials.totalApprovedRcv,
          fieldName === 'deductible' ? parsed : current.financials.deductible
        );
      } else {
        // commenceDays / completeDays are day counts.
        next = {
          ...current,
          financials: {
            ...current.financials,
            [fieldName]: value === '' ? 0 : Number(value) || 0,
          },
        };
      }
    } else if (section === 'branch') {
      next = { ...current, branch: { ...current.branch, [fieldName]: value } };
    } else if (
      section === 'customer' ||
      section === 'insurance' ||
      section === 'team' ||
      section === 'mortgage' ||
      section === 'changeOrder' ||
      section === 'checklist' ||
      section === 'productionNotes'
    ) {
      const nextRaw: any = { ...current };
      nextRaw[section] = {
        ...(current as any)[section],
        [fieldName]: coercePdfFieldValue(field, value),
      };
      next = nextRaw as RestorationJobData;
    } else {
      return;
    }

    jobDataRef.current = next;
    setJobData(next);

    if (previewDoc) {
      regeneratePreview(previewDoc, next);
    }
  };

  const handlePreviewDownload = async () => {
    if (!previewDoc) return;
    try {
      const bytes = await previewDoc.generator(jobDataRef.current);
      downloadPdf(bytes, previewDoc.buildFileName(jobDataRef.current));
    } catch (err) {
      console.error('Download error:', err);
    }
  };

  // Save the CURRENTLY previewed document to Google Drive (per-document upload).
  const handleSaveDocToDrive = () => {
    if (!previewDoc) return;
    if (!user) {
      handleLogin();
      return;
    }
    const doc = previewDoc;
    const fileName = doc.buildFileName(jobDataRef.current);

    setConfirmDialog({
      isOpen: true,
      title: `Save ${doc.title} to Google Drive?`,
      message: `This will generate the latest ${doc.title} for Job #${jobDataRef.current.customer.jobNumber} and upload it to your Google Drive in the "Hays & Sons Restoration" folder.`,
      confirmLabel: 'Upload to Drive',
      action: async () => {
        setIsDriveLoading(true);
        try {
          const pdfBytes = await doc.generator(jobDataRef.current);
          const result = await uploadPdfToGoogleDrive(pdfBytes, fileName);
          setDriveSuccessLink(result.webViewLink);
          showStatus('success', `Saved "${fileName}" to your Google Drive!`);
        } catch (err: any) {
          console.error('Drive save error:', err);
          showStatus('error', err.message || 'Failed to save to Google Drive');
        } finally {
          setIsDriveLoading(false);
        }
      },
    });
  };

  // Save to Google Drive with Mandatory User Confirmation
  const handleSaveToDrive = () => {
    if (!user) {
      handleLogin();
      return;
    }

    const fileName = `${jobData.customer.jobNumber}_Complete_Packet_${jobData.customer.customerName}.pdf`;

    setConfirmDialog({
      isOpen: true,
      title: 'Save Packet to Google Drive?',
      message: `This will generate the complete 9-page Hays + Sons restoration packet for Job #${jobData.customer.jobNumber} (${jobData.customer.customerName}) and upload it to your Google Drive in the "Hays & Sons Restoration" folder.`,
      confirmLabel: 'Upload to Drive',
      action: async () => {
        setIsDriveLoading(true);
        try {
          const pdfBytes = await generateCompletePacket(jobData);
          const result = await uploadPdfToGoogleDrive(pdfBytes, fileName);
          setDriveSuccessLink(result.webViewLink);
          showStatus('success', `Saved "${fileName}" to your Google Drive!`);
        } catch (err: any) {
          console.error('Drive save error:', err);
          showStatus('error', err.message || 'Failed to save to Google Drive');
        } finally {
          setIsDriveLoading(false);
        }
      },
    });
  };

  // Sync to Google Sheets with Mandatory User Confirmation
  const handleSyncToSheets = () => {
    if (!user) {
      handleLogin();
      return;
    }

    setConfirmDialog({
      isOpen: true,
      title: 'Sync Job to Google Sheets?',
      message: `This will append a new row for Job #${jobData.customer.jobNumber} (${jobData.customer.customerName}) to your "Hays & Sons - Restoration Job Log" Google Spreadsheet, recording all financial figures and team assignments.`,
      confirmLabel: 'Sync to Sheets',
      action: async () => {
        setIsSheetsLoading(true);
        try {
          const result = await syncJobToGoogleSheets(jobData);
          setSheetsSuccessLink(result.spreadsheetUrl);
          showStatus('success', `Logged Job #${jobData.customer.jobNumber} to Google Sheets!`);
        } catch (err: any) {
          console.error('Sheets sync error:', err);
          showStatus('error', err.message || 'Failed to sync to Google Sheets');
        } finally {
          setIsSheetsLoading(false);
        }
      },
    });
  };

  // Reset Job with Confirmation
  const handleReset = () => {
    setConfirmDialog({
      isOpen: true,
      title: 'Start New Restoration Job?',
      message:
        'This will clear all current customer, insurance, and claim fields back to default empty values. Make sure you have downloaded or saved any needed PDF documents first.',
      confirmLabel: 'Clear All Fields',
      isDanger: true,
      action: async () => {
        replaceJob(createEmptyJob());
        setRecordId(undefined);
        showStatus('info', 'New blank job created — not yet saved to the database.');
      },
    });
  };

  const handleApplyIntake = (newJob: RestorationJobData, newProv: ProvenanceRecord) => {
    replaceJob(newJob);
    setRecordId(newJob.recordId);
    setProvenance(newProv);
    const who = newJob.customer.customerName || 'new intake';
    showStatus('success', `Master Job Record updated from intake (${who}) - all production documents refreshed.`);
  };

  // Auth gate — the workspace is only reachable once signed in (or in developer mode).
  if (!isAuthReady) {
    return (
      <div className="min-h-screen bg-slate-50 flex items-center justify-center">
        <Loader2 className="w-5 h-5 animate-spin text-slate-400" />
      </div>
    );
  }

  if (!currentUser && !isDeveloperBypassEnabled()) {
    return (
      <>
        <LoginScreen
          onSubmit={handleAppSignIn}
          onRegister={handleAppRegister}
          isDatabaseConfigured={isDatabaseConfigured()}
        />
        <PwaStatus />
      </>
    );
  }

  return (
    <div className="min-h-screen bg-slate-50 text-slate-800 font-sans flex flex-col">
      {/* Top Navbar */}
      <Navbar
        jobNumber={jobData.customer.jobNumber}
        customerName={jobData.customer.customerName}
        user={user}
        isLoggingIn={isLoggingIn}
        onLogin={handleLogin}
        onLogout={handleLogout}
        onReset={handleReset}
        isDirty={isDirty}
        isSavingJob={isSavingJob}
        savedJobsCount={savedJobs.length}
        databaseEmail={currentUser ? currentUser.email : null}
        isDatabaseConfigured={isDatabaseConfigured()}
        isDeveloperBypass={isDeveloperBypassEnabled()}
        onSaveJob={handleSaveJob}
        onOpenSavedCustomers={handleOpenSavedCustomers}
        onSignOut={handleAppSignOut}
        pendingSyncCount={syncState.pendingCount}
        isOffline={!syncState.online}
      />

      {/* Status toast */}
      {statusNotification && (
        <div className="fixed top-[calc(5rem+env(safe-area-inset-top))] inset-x-4 sm:inset-x-auto sm:right-5 z-50 animate-in slide-in-from-top-2 duration-200">
          <div className="flex items-start gap-3 rounded-xl border border-slate-200 bg-white px-4 py-3 shadow-lg w-full sm:w-auto sm:max-w-sm">
            <span
              className={`mt-1 w-2 h-2 rounded-full shrink-0 ${
                statusNotification.type === 'success'
                  ? 'bg-emerald-500'
                  : statusNotification.type === 'error'
                  ? 'bg-red-500'
                  : 'bg-slate-400'
              }`}
            />
            <p className="text-[13px] font-medium text-slate-800 leading-snug">
              {statusNotification.message}
            </p>
          </div>
        </div>
      )}

      {/* Main */}
      <main className="flex-1 w-full max-w-[1400px] mx-auto px-5 py-6">
        {/* Compact section menu below the lg breakpoint */}
        <MobileSectionNav
          activeTab={activeTab}
          onNavigate={handleNavigate}
          savedJobsCount={savedJobs.length}
        />

        <div className="flex items-start gap-6">
          {/* Side menu — one entry per section */}
          <Sidebar
            activeTab={activeTab}
            onNavigate={handleNavigate}
            savedJobsCount={savedJobs.length}
            customerName={jobData.customer.customerName}
            jobNumber={jobData.customer.jobNumber}
            isDirty={isDirty}
          />

          {/* Section workspace */}
          <div className="flex-1 min-w-0 space-y-6">
            {/* The intake parser always sits at the top — paste an intake to refresh every section. */}
            <IntakeParserCard
              onApplyIntake={handleApplyIntake}
              currentJob={jobData}
              currentProvenance={provenance}
            />

            {activeTab === 'home' && (
              <SavedCustomersPage
                jobs={savedJobs}
                isLoading={isLoadingJobs}
                error={jobListError}
                search={jobSearch}
                currentRecordId={recordId}
                isDatabaseConfigured={isDatabaseConfigured()}
                databaseEmail={currentUser ? currentUser.email : null}
                isDeveloperBypass={isDeveloperBypassEnabled()}
                onSearchChange={setJobSearch}
                onRefresh={handleRefreshJobs}
                onOpenJob={handleLoadJob}
                onDeleteJob={handleDeleteJob}
              />
            )}

            {activeTab === 'customer' && (
              <SectionCustomer
                data={jobData.customer}
                jobData={jobData}
                onPreview={handleOpenPreview}
                onChange={handleCustomerChange}
              />
            )}

            {activeTab === 'insurance' && (
              <SectionInsurance
                data={jobData.insurance}
                jobData={jobData}
                onPreview={handleOpenPreview}
                onChange={handleInsuranceChange}
              />
            )}

            {activeTab === 'financials' && (
              <FinancialSummaryCard
                financials={jobData.financials}
                jobData={jobData}
                onPreview={handleOpenPreview}
                onRcvChange={(val) => updateFinancials(val, jobData.financials.deductible)}
                onDeductibleChange={(val) =>
                  updateFinancials(jobData.financials.totalApprovedRcv, val)
                }
              />
            )}

            {activeTab === 'team' && (
              <>
                <SectionTeam
                  data={jobData.team}
                  branch={jobData.branch}
                  jobData={jobData}
                  onPreview={handleOpenPreview}
                  onChange={handleTeamChange}
                />
                <SectionMortgage
                  data={jobData.mortgage}
                  jobData={jobData}
                  onPreview={handleOpenPreview}
                  onChange={handleMortgageChange}
                />
              </>
            )}

            {activeTab === 'changeOrder' && (
              <SectionChangeOrder
                data={jobData.changeOrder}
                contractRcv={jobData.financials.totalApprovedRcv}
                jobData={jobData}
                onPreview={handleOpenPreview}
                onChange={handleChangeOrderChange}
              />
            )}

            {activeTab === 'checklist' && (
              <SectionChecklist
                checklist={jobData.checklist}
                jobData={jobData}
                onPreview={handleOpenPreview}
                onChange={handleChecklistChange}
              />
            )}

            {activeTab === 'productionNotes' && (
              <SectionProductionNotes
                productionNotes={jobData.productionNotes}
                jobData={jobData}
                onPreview={handleOpenPreview}
                onChange={handleProductionNotesChange}
              />
            )}

            {activeTab === 'documents' && (
              <DocumentGenerationPanel
                jobData={jobData}
                onPreview={handleOpenPreview}
                onSaveToDrive={handleSaveToDrive}
                onSyncToSheets={handleSyncToSheets}
                isDriveLoading={isDriveLoading}
                isSheetsLoading={isSheetsLoading}
                driveSuccessLink={driveSuccessLink}
                sheetsSuccessLink={sheetsSuccessLink}
              />
            )}
          </div>
        </div>
      </main>

      {/* Footer */}
      <footer className="border-t border-slate-200 mt-auto">
        <div className="max-w-[1400px] mx-auto px-5 py-6 flex flex-col sm:flex-row items-center justify-between gap-2 text-[12px] text-slate-500">
          <p className="font-medium text-slate-600">
            Hays &amp; Sons Complete Restoration — Fort Wayne Division
          </p>
          <p className="tabular-nums">909 Production Road, Fort Wayne, IN 46808 · 1-260-471-9110</p>
        </div>
      </footer>

      {/* PDF In-App Preview Modal (click-to-edit) */}
      <PdfPreviewModal
        isOpen={isPreviewOpen}
        title={previewTitle}
        pdfBytes={previewBytes}
        isLoading={isPreviewLoading}
        isRegenerating={isPreviewRegenerating}
        onClose={() => {
          setIsPreviewOpen(false);
          setPreviewBytes(null);
          setPreviewDoc(null);
          setPreviewSpans([]);
          if (previewRegenTimerRef.current !== null) {
            window.clearTimeout(previewRegenTimerRef.current);
            previewRegenTimerRef.current = null;
          }
        }}
        onDownload={handlePreviewDownload}
        jobData={jobData}
        editableFields={previewDoc ? getPdfFieldSchema(previewDoc.id) : []}
        spans={previewSpans}
        onFieldChange={handlePdfFieldChange}
        onSaveToDrive={!isDesktop() && previewDoc ? handleSaveDocToDrive : undefined}
        isDriveLoading={isDriveLoading}
        driveSuccessLink={driveSuccessLink}
      />

      {/* Workspace / Destructive Confirmation Modal */}
      <ConfirmModal
        isOpen={confirmDialog.isOpen}
        title={confirmDialog.title}
        message={confirmDialog.message}
        confirmLabel={confirmDialog.confirmLabel}
        isDanger={confirmDialog.isDanger}
        onCancel={() => setConfirmDialog((prev) => ({ ...prev, isOpen: false }))}
        onConfirm={async () => {
          const action = confirmDialog.action;
          setConfirmDialog((prev) => ({ ...prev, isOpen: false }));
          await action();
        }}
      />

      {/* PWA install / update prompt + offline + pending-sync status */}
      <PwaStatus />
    </div>
  );
}
