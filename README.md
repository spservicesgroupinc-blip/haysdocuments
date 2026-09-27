# Hays + Sons — Restoration Document Suite

Single-entry document automation for Hays + Sons Complete Restoration: capture a job once,
then generate the contract, reports and production packet as PDFs. Runs as a web app
(installable PWA) and as a Windows desktop app (Electron). Works **offline-first**: jobs are
cached on the device and changes sync to the Google Apps Script database automatically.

## Prerequisites

- Node.js 20+ and npm
- The Apps Script backend deployed (see `apps-script/README.md`)

## Environment

Copy `.env.example` to `.env.local` and set:

| Key | Purpose |
| --- | --- |
| `VITE_APPS_SCRIPT_URL` | Deployed Apps Script `/exec` URL (the job database) |
| `VITE_GOOGLE_CLIENT_ID` | OAuth client for Google Drive/Sheets features (web only) |
| `VITE_DEV_SHARED_SECRET` | **Local development only** — disables auth. Never ship a build with this set. |

Vite inlines `VITE_*` values at build time — restart `npm run dev` (or rebuild) after changes.

## Commands

| Command | What it does |
| --- | --- |
| `npm run dev` | Dev server on http://localhost:3000 |
| `npm run build` | Production build into `dist/` (web app + service worker + manifest) |
| `npm run preview` | Serve the production build locally (use this to test PWA/offline behaviour) |
| `npm run lint` | Type-check (`tsc --noEmit`) |
| `npm run verify` | Full gate: lint + backend tests + parser tests + build |
| `npm run icons` | Regenerate all app icons from `public/logo.svg` |
| `npm run deploy:web` | Build + deploy the PWA to Vercel (linked project) |
| `npm run apps:test`, `npm run apps:register`, `npm run parser:test` | Backend / parser test suites |

## PWA (browser install)

The production build ships a web app manifest and service worker (`src/sw.ts`) that precache
the shell — including the pdf.js worker — so the app opens and generates documents offline.
Database reads come from an IndexedDB mirror; writes queue in an outbox and replay when the
connection returns (last write wins; a notice appears when the server copy moved underneath).

- Test locally: `npm run build && npm run preview`, then DevTools → Application (manifest,
  service worker, cache) and Network → Offline.
- The service worker is **production-only**; `npm run dev` intentionally does not register it.

### Deploy to Vercel

1. One-time: `npx vercel link` (create/select the project for this repo).
2. Deploy: `npm run deploy:web` (builds locally via `vercel build --prebuilt`, so your
   `.env.local` values are baked in — no Vercel dashboard env setup required).
3. In Google Cloud Console → APIs & Services → Credentials → your OAuth web client, add the
   deployed origin (e.g. `https://your-app.vercel.app`) to **Authorized JavaScript origins**
   so Google Drive/Sheets sign-in works on the deployed site.

## Desktop app (Windows)

| Command | What it does |
| --- | --- |
| `npm run desktop:dev` | Bundles the Electron main process and launches the app (prefers the dev server on :3000 when running, otherwise loads the built `dist/`) |
| `npm run desktop:build` | Builds the web app + bundles Electron, then produces the NSIS installer in `dist_desktop/` |
| `npm run desktop:release` | `desktop:build` + copies installer/`latest.yml` into `release/` for the update feed |

- Installer: `dist_desktop/Hays-Sons-Document-Suite-Setup-<version>.exe` (per-user install, no admin needed).
- Auto-update: packaged builds check the static feed configured in `electron-builder.yml`
  (`publish.url`). The installer is ~130 MB, which exceeds Vercel's ~100 MB per-file limit —
  host the `release/` folder where there is no such cap (GitHub Releases, Cloudflare R2, S3,
  or any static server) and set `publish.url` to that location before cutting a release.
- The installer is **not code-signed** — first install shows a SmartScreen warning
  ("More info" → "Run anyway"). Updates work regardless.
- Google Drive/Sheets buttons are **browser-only**: Google blocks OAuth popups inside
  embedded browsers, so the desktop app disables them (tooltip explains).
- PDF/ZIP downloads open a native "Save as" dialog; printing opens in an app window.

## Offline behaviour (both platforms)

- The saved-jobs list paints instantly from the local mirror, then refreshes from the server.
- Saves/deletes made offline are queued (amber "PENDING SYNC" badge); the status card in the
  bottom-right shows the queue, a "Sync now" button, and reconnect notices.
- The current workspace record autosaves locally (debounced), so a reload/crash never loses
  in-progress work.
- If someone else changed a record while you had unsaved edits, syncing still succeeds (your
  version wins) and a notice tells you to review it.

## Known issues

- `npm run apps:test` (and therefore `npm run verify`) currently fails: `apps-script/Code.gs`
  (1,312 lines) diverged from the test suite and `apps-script/paste-chunks/` (~2,410 lines) —
  `normalizeRecord_`/`oneOf_` exist only in `_backup/Code.gs.monolith.bak` and the chunks.
  Reconcile `Code.gs` with the backup before deploying backend changes.
- `npm run clean` references a `server.js` that has never existed (template leftover).

