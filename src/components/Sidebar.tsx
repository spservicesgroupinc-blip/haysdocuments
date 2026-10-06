import React from 'react';
import {
  Home,
  UserCircle,
  ShieldAlert,
  Coins,
  Users2,
  FileEdit,
  CheckCircle,
  StickyNote,
  FileCheck,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

/** Every page reachable from the workspace side menu. */
export type WorkspaceTab =
  | 'home'
  | 'customer'
  | 'insurance'
  | 'financials'
  | 'team'
  | 'changeOrder'
  | 'checklist'
  | 'productionNotes'
  | 'documents';

export interface WorkspaceSection {
  id: WorkspaceTab;
  label: string;
  icon: LucideIcon;
}

/** Order mirrors the intake-to-production workflow. */
export const WORKSPACE_SECTIONS: WorkspaceSection[] = [
  { id: 'home', label: 'Saved Customers', icon: Home },
  { id: 'customer', label: 'Customer & Loss', icon: UserCircle },
  { id: 'insurance', label: 'Insurance & Claim', icon: ShieldAlert },
  { id: 'financials', label: 'Contract Financials', icon: Coins },
  { id: 'team', label: 'Team & Mortgage', icon: Users2 },
  { id: 'changeOrder', label: 'Change Order', icon: FileEdit },
  { id: 'checklist', label: 'Checklist', icon: CheckCircle },
  { id: 'productionNotes', label: 'Production Notes', icon: StickyNote },
  { id: 'documents', label: 'Generate PDFs', icon: FileCheck },
];

interface NavItemProps {
  section: WorkspaceSection;
  isActive: boolean;
  badge?: number;
  onNavigate: (tab: WorkspaceTab) => void;
  variant: 'sidebar' | 'strip';
}

const NavItem: React.FC<NavItemProps> = ({
  section,
  isActive,
  badge,
  onNavigate,
  variant,
}) => {
  const Icon = section.icon;
  const base =
    variant === 'sidebar'
      ? 'flex w-full items-center gap-2.5 px-2.5 h-10 rounded-lg text-[13px] font-medium border transition-colors'
      : 'inline-flex shrink-0 items-center gap-2 px-3 h-9 rounded-lg text-[13px] font-medium border transition-colors whitespace-nowrap';

  return (
    <button
      type="button"
      onClick={() => onNavigate(section.id)}
      aria-current={isActive ? 'page' : undefined}
      className={`${base} ${
        isActive
          ? 'bg-red-50 border-red-200 text-red-700'
          : 'bg-transparent border-transparent text-slate-600 hover:bg-slate-50 hover:text-slate-900'
      }`}
    >
      <Icon className={`w-4 h-4 shrink-0 ${isActive ? 'text-red-600' : 'text-slate-400'}`} />
      <span className="truncate">{section.label}</span>
      {typeof badge === 'number' && badge > 0 && (
        <span
          className={`${
            variant === 'sidebar' ? 'ml-auto' : ''
          } min-w-[18px] h-[18px] px-1 rounded text-[11px] font-bold flex items-center justify-center tabular-nums ${
            isActive ? 'bg-red-100 text-red-700' : 'bg-slate-100 text-slate-600'
          }`}
        >
          {badge}
        </span>
      )}
    </button>
  );
};

interface SidebarProps {
  activeTab: WorkspaceTab;
  onNavigate: (tab: WorkspaceTab) => void;
  savedJobsCount: number;
  customerName: string;
  jobNumber: string;
  isDirty: boolean;
}

/** Desktop side menu: one entry per section, plus the current record's context. */
export const Sidebar: React.FC<SidebarProps> = ({
  activeTab,
  onNavigate,
  savedJobsCount,
  customerName,
  jobNumber,
  isDirty,
}) => {
  const hasCustomer = Boolean(customerName.trim());

  return (
    <aside
      className="hidden lg:block w-60 shrink-0 self-start sticky top-20"
      aria-label="Workspace navigation"
    >
      <div className="bg-white rounded-xl border border-slate-200 p-2">
        <p className="px-2.5 pt-1.5 pb-1 text-[11px] font-semibold uppercase tracking-wider text-slate-400">
          Workspace
        </p>
        <nav className="space-y-0.5">
          {WORKSPACE_SECTIONS.map((section) => (
            <NavItem
              key={section.id}
              section={section}
              isActive={activeTab === section.id}
              badge={section.id === 'home' ? savedJobsCount : undefined}
              onNavigate={onNavigate}
              variant="sidebar"
            />
          ))}
        </nav>
      </div>

      {/* Current record context */}
      <div className="mt-3 bg-white rounded-xl border border-slate-200 px-3.5 py-3">
        <p className="text-[11px] font-semibold uppercase tracking-wider text-slate-400">
          Current record
        </p>
        <div className="mt-2 flex items-center gap-2">
          <span
            className={`w-1.5 h-1.5 rounded-full shrink-0 ${
              hasCustomer ? (isDirty ? 'bg-amber-500' : 'bg-emerald-500') : 'bg-slate-300'
            }`}
            aria-hidden
          />
          <p className="text-[13px] font-semibold text-slate-900 truncate">
            {hasCustomer ? customerName : 'New job'}
          </p>
        </div>
        <p className="mt-1 text-[11px] text-slate-500 tabular-nums truncate">
          {jobNumber || 'No job number yet'}
        </p>
        {isDirty && (
          <span className="mt-2 inline-block text-[11px] font-semibold text-amber-700 bg-amber-50 border border-amber-200 rounded px-1.5 py-0.5">
            Unsaved changes
          </span>
        )}
      </div>
    </aside>
  );
};

interface MobileSectionNavProps {
  activeTab: WorkspaceTab;
  onNavigate: (tab: WorkspaceTab) => void;
  savedJobsCount: number;
}

/** Below the lg breakpoint the side menu collapses into a scrollable pill strip. */
export const MobileSectionNav: React.FC<MobileSectionNavProps> = ({
  activeTab,
  onNavigate,
  savedJobsCount,
}) => (
  <div className="lg:hidden mb-4 min-w-0">
    <label className="block sm:hidden text-xs font-semibold text-slate-600 mb-1.5" htmlFor="workspace-section">
      Workspace section
    </label>
    <select
      id="workspace-section"
      value={activeTab}
      onChange={(event) => onNavigate(event.target.value as WorkspaceTab)}
      className="sm:hidden w-full min-w-0 min-h-11 rounded-xl border border-slate-300 bg-white px-3 text-slate-900 font-medium"
    >
      {WORKSPACE_SECTIONS.map((section) => (
        <option key={section.id} value={section.id}>
          {section.label}{section.id === 'home' && savedJobsCount > 0 ? ` (${savedJobsCount})` : ''}
        </option>
      ))}
    </select>
    <nav className="hidden sm:flex gap-1 overflow-x-auto no-scrollbar" aria-label="Workspace navigation">
      {WORKSPACE_SECTIONS.map((section) => (
        <NavItem
          key={section.id}
          section={section}
          isActive={activeTab === section.id}
          badge={section.id === 'home' ? savedJobsCount : undefined}
          onNavigate={onNavigate}
          variant="strip"
        />
      ))}
    </nav>
  </div>
);
