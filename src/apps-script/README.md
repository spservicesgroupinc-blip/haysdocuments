# Hays + Sons — Customer & Job Database (Google Apps Script)

This folder holds the **entire backend** for the app's customer/job database: shared workspace storage. It is designed to be copied into the Apps Script editor and run once.

The backend is **one single file — `Code.gs`** — so setup is one paste. After pasting, press
**Ctrl+End** and check the end: the last line must be a single `}` and the file must match the line
count printed by `npm run apps:ascii`. (The backend was split into six files for a while to dodge
paste truncation in the Apps Script editor; `node scripts/split-once.mjs` regenerates that fallback
if a big paste ever truncates again — see troubleshooting.)

| File | Lines | Purpose |
| --- | --- | --- |
| `Code.gs` | ~2400 | The complete backend: configuration, provisioning, auth, jobs, self test |
| `appsscript.json` | — | Project manifest (timezone, scopes, web-app access) |

Everything is dependency-free — no libraries, no `clasp`, no build step.

> **Keep `Code.gs` pure ASCII.** The file reaches the Apps Script editor by copy-paste, so a
> multi-byte character (em dash, curly quote, non-breaking space) can be mangled in transit. Use `-`
> instead of `—`, straight quotes instead of curly ones, and a plain space instead of a non-breaking
> space. `npm run apps:ascii` checks the file and fails the build if this regresses.

---

## 1. Set it up (one command)

1. Go to **[script.google.com](https://script.google.com)** → **New project**.
2. Rename the project to `Hays + Sons DB`.
3. Clear the placeholder first: click into the editor, press **Ctrl+A** then **Delete** (deleting it
   only halfway is the classic cause of an `Unexpected end of input` error - a leftover
   `function myFunction() {` leaves an unclosed brace). Then paste in the **entire** `Code.gs`, from
   the first line to the final `}`. Save it, then press **Ctrl+End** - the last line must be `}`.
   If the paste arrives cut short (some clipboards cap around 25 KB - see Troubleshooting), clear the
   editor and paste the numbered parts from `src/apps-script/paste-chunks/` instead, one after
   another, pressing **Ctrl+End** between pastes.
4. Open **Project Settings** → tick **"Show `appsscript.json` manifest file in editor"**, then open the
   `appsscript.json` tab and replace its contents with the provided `appsscript.json`.
5. Click **Save**, then select **`setupDatabase`** in the function dropdown and click **Run**, then
   approve the permission prompt. Google will ask for *"See, edit, create and delete your
   spreadsheets"* and *"Connect to an external service"*. Both are required.

That single call provisions **everything**:

- a spreadsheet named **`Hays + Sons - Customer & Job Database`**
- a **`Jobs`** sheet — one row per saved job
- an **`AuditLog`** sheet — append-only trail of who changed what
- a **`Users`** sheet — login accounts (the `Salt` and `PasswordHash` columns are hidden)
- a **`Sessions`** sheet — active logins (the `Token` column is hidden)
- a **`Drafts`** sheet — the shared workspace draft, i.e. the record currently being edited (one row; the `PayloadJson` column is hidden)
- a **`README`** sheet documenting the schema inside the spreadsheet itself
- optionally, your **first administrator account** (only when you pass the three arguments)

`setupDatabase()` is **idempotent** — run it as often as you like, in any order, to repair or upgrade.
Calling it with **no arguments** also provisions everything and simply skips creating the account.

> If step 5 is skipped entirely, the **first web request provisions the database automatically**, so a
> fresh deployment is never left half-built. The `ping` response reports `provisionedNow: true` when
> that happens.

### Where the data lives

This spreadsheet is the **system of record** — the single place every account reads from and writes to,
so signing in from any machine shows the same customer and job data.

| Data | Stored in | Notes |
| --- | --- | --- |
| Saved jobs | `Jobs` sheet | Full record JSON per row; soft-deleted rows are flagged, never removed. |
| In-progress record (workspace draft) | `Drafts` sheet | Autosaved as you type, so an unfinished job is never stranded on one device. |
| Change history | `AuditLog` sheet | Who saved, deleted or cleared what, and when. |
| Accounts and logins | `Users` / `Sessions` sheets | Only credential *hashes* are stored. |

Two things stay on the device on purpose, and neither is customer data:

- the **session token**, so a page reload does not sign you out (`Sessions` holds the server side);
- an **offline cache** of the jobs list, plus an outbox of edits made while offline. Every queued
  write is replayed to this backend as soon as the device is online — the cache is a copy, never the
  only home for a record. Queued writes are tagged with the account that made them, so on a shared
  machine one person's unsaved edits are never shown to, or published by, anyone else.

`saveDraft` / `getDraft` are the two actions behind the shared draft, and the `Drafts` sheet is
created on first use, so an already-provisioned spreadsheet does not need a repair run.

### Customer knowledge base and DeepSeek estimate analysis

The Customer Knowledge Base page imports Customer, Job Number, Estimate Amount
(or Contract Price), Job Address, Loss City, Loss State, and Loss ZIP. Other CSV
columns, including notes and contact details, are discarded. A successful import
replaces the complete shared `CustomerReference` sheet snapshot in one locked
write, including clearing old trailing rows. The source CSV is not retained.
Editors/admins can replace it; signed-in users can read it.

Set `DEEPSEEK_API_KEY` in **Project Settings > Script Properties**. No API key is
embedded in the frontend. `DEEPSEEK_MODEL` optionally overrides the default
`deepseek-flash` model. The existing external-request OAuth scope is sufficient.
See [DeepSeek chat completions](https://api-docs.deepseek.com/api/create-chat-completion/).

The authenticated `analyzeIntake` action accepts `{ rawText }`. Apps Script reads
the latest complete customer snapshot and sends it with the extracted estimate
text to DeepSeek. It returns the existing extraction fields plus `knowledgeBase`:
snapshot version, source filename, customer count, match status, matched record,
explanation, document estimate total, and any pending price review. It validates
the selected DASH record and supporting document quotes before returning results.
The model never receives a client-supplied customer list or system prompt.

Imports allow 5,000 records, a 10 MB CSV, and at most 100,000 UTF-8 bytes of
normalized customer context. Estimate text is limited separately to 100,000
UTF-8 bytes. Oversized input is rejected in full, never silently truncated.
Each snapshot has a server-generated version. Old three-field snapshots remain
readable; reimport the CSV to add addresses.

Price discrepancies remain in saved job/draft JSON until the user selects the
estimate or knowledge-base amount in Financials. Price-dependent PDFs, packets,
ZIPs, and Drive packet saves are blocked while the choice is unresolved. A later
manual edit of the chosen amount requires review again. Failed analysis leaves
the workspace untouched and offers a retry.

**Rollout:** run `npm run apps:paste` and `npm run apps:chunks`, deploy the updated
`Code.gs` as a new version of the existing web app, set the Script Property, then
deploy the frontend. Verify an import and estimate analysis from two signed-in
sessions. Do not rerun database setup or recreate the database to install this
feature; the reference sheet is created on first use.

### Internal workspace access

The app opens directly to Jobs. Workspace API requests require no application
account, session token, or shared secret. Saves and imports use the shared
`internal@system.local` editor identity in the audit log.

The login, register, logout, checkSession and listUsers API routes have been removed.
Legacy Users/Sessions sheets and editor helpers remain for existing database
compatibility; no account setup is required to use the app.

Deploy the updated Code.gs as a new version of the existing deployment before
rebuilding/deploying the frontend. Keep the same /exec URL and spreadsheet.
Restrict reachability through internal hosting/network controls: anyone who can
reach the backend can read and modify workspace data.

## 2. Optional Script Properties

**None of these are required** when using the login page. Add them under
**Project Settings → Script Properties** only if you want the extra behaviour.

| Property | Default | Purpose |
| --- | --- | --- |
| `DB_SHEET_NAME` / `LOG_SHEET_NAME` | `Jobs` / `AuditLog` | Override the default sheet names. |
| `USERS_SHEET_NAME` / `SESSIONS_SHEET_NAME` | `Users` / `Sessions` | Override the account/session sheet names. |
| `ALLOWED_EMAILS` / `ALLOWED_CLIENT_ID` | *(unset)* | Enable the **legacy** Google ID-token path alongside the login page. |
| `SHARED_SECRET` | *(unset)* | **Developer bypass — disables authentication entirely.** Never set in production. |
| `REQUIRE_ID_TOKEN` | `true` | Only affects the legacy ID-token path. |

Session length is not a Script Property — change `DEFAULTS.SESSION_HOURS` in `Code.gs` (`12` by default).

---

## 3. Verify

Run **`selfTest()`**. It provisions on demand, then exercises the real spreadsheet end-to-end and
reports **`SELF TEST PASSED`** in the execution log (View → Logs). It confirms that:

- created currency strings like `"$24,850.00"` come back as the number `24850`
- blank `number | ''` fields stay blank instead of turning into `0`
- `"FALSE"` becomes boolean `false` (not truthy)
- `"yes"` is repaired to the exact union value `Yes`
- updating does **not** duplicate the row
- login issues a token, that token authorises a request, wrong passwords and unknown accounts are
  rejected, logout revokes the session, and no plain-text password is stored

It cleans up every temporary record and account it creates.

---

## 4. Deploy as a web app

**Deploy → New deployment → Select type: Web app**

| Setting | Value |
| --- | --- |
| Description | `Hays + Sons DB v2` |
| Execute as | **Me** |
| Who has access | **Anyone** |

Click **Deploy** and copy the **`/exec`** URL.

> **Why "Anyone"?** Access is enforced by the application login, not by Google session cookies. A
> cross-origin `fetch` from the browser does not carry Google's session anyway, so "Anyone with a
> Google account" would not add any protection.

Whenever you change `Code.gs`, use **Deploy → Manage deployments → Edit → Version: New version**.
A brand-new deployment URL is only created if you add a *new* deployment, so the app's URL stays stable.

---

## 5. Point the front-end at it

Add to `.env.local` in the project root:

```
VITE_APPS_SCRIPT_URL="https://script.google.com/macros/s/XXXXXXXX/exec"
VITE_GOOGLE_CLIENT_ID="XXXXXXXX.apps.googleusercontent.com"
```

Restart the dev server afterwards.

---

## 6. API reference

All requests are `POST` to the `/exec` URL with
`Content-Type: text/plain;charset=utf-8` and a JSON body.

> Apps Script does not answer CORS preflight requests, so `application/json` **must not** be used —
> `text/plain` is a CORS "simple request" and goes straight through.

Every response is **HTTP 200** with a JSON envelope — always branch on `ok`, never on the status code:

```json
{ "ok": true,  "data": { }, "schemaVersion": 1 }
{ "ok": false, "code": "forbidden", "error": "This account is not permitted to access the database." }
```

| Action | Body | Returns |
| --- | --- | --- |
| `ping` | *(none — no auth needed)* | `{ pong, schemaVersion, time }` |
| `saveJob` | `{ job }` | `{ record, created, recordId }` |
| `listJobs` | `{ includeDeleted?, limit? }` | `{ jobs: [...], count }` |
| `getJob` | `{ recordId }` or `{ jobNumber }` | `{ job, updatedAt, updatedBy }` |
| `deleteJob` | `{ recordId, hard? }` | `{ deleted, hard, recordId }` |
| `searchJobs` | `{ query, includeDeleted?, limit? }` | `{ jobs: [...], count, query }` |

Workspace actions require no credentials. Example:

```json
{ "action": "getJob", "recordId": "b1e2..." }
```

Error codes: `missing_action`, `unknown_action`, `unauthenticated`, `forbidden`, `not_configured`,
`invalid_job`, `invalid_record`, `not_found`, `corrupt_record`, `busy`, `internal_error`.

---

## 7. How data is stored

One row per job in `Jobs`. Human-readable columns are indexed for searching; the complete record
lives in `RecordJson` and is the source of truth when reloading.

Concurrent writes are serialised with `LockService`, so two saves can never interleave.
Deletes are **soft** by default (a `Deleted` flag), keeping the audit trail intact.

### Round-trip safety
Spreadsheets mangle data in well-known ways, so `normalizeRecord_()` repairs every one of them
before a record is returned:

| Hazard | Handled |
| --- | --- |
| Currency written as text | `"$24,850.00"` → `24850` |
| Blank `number \| ''` field | stays `''`, never becomes `0` |
| `"FALSE"` / `"0"` | becomes boolean `false`, not truthy |
| Union casing (`"yes"`, `"INCREASE"`) | repaired to `Yes`, `increase` |
| Missing fields | materialised from a canonical template so UI inputs stay controlled |
| Unknown/new fields | preserved, so schema additions need no migration |

---

## 8. Troubleshooting

| Symptom | Cause / fix |
| --- | --- |
| `Syntax error: ... Unexpected end of input line: N` | The pasted copy is missing a closing `}` somewhere before its end - **line N is the end of the pasted file, not the line with the mistake**. Click into the editor, press **Ctrl+A**, delete, then paste the whole file in again. |
| `Unexpected end of input` at the same line every time (e.g. `line: 623`), while `npm run apps:ascii` reports the file is fine | The paste is being cut short before the end - large preview panes and some clipboards cap around 25 KB (about 620 lines of `Code.gs`). Clear the editor, then paste `src/apps-script/paste-chunks/part1.txt` through `part6.txt` in order (**Ctrl+End** between each). Regenerate after edits with `npm run apps:chunks`. |
| `Syntax error: ... Invalid or unexpected token`, reported at a `/**` comment opener | The paste was cut short inside a block comment. Same fix. If a ~2400-line paste keeps truncating, run `node scripts/split-once.mjs` to regenerate six smaller files and paste those instead, or paste in two halves and join them at a section banner. |
| `not_configured` | Run `setupDatabase()` first. |
| Every request returns `forbidden` | `ALLOWED_EMAILS` is not set, or your email/domain is not listed. |
| `unauthenticated: Sign-in token was rejected` | `ALLOWED_CLIENT_ID` does not match the client that issued the token, or the token expired. |
| Browser console shows a CORS error | The request used `application/json`. Use `text/plain;charset=utf-8`. |
| Manifest rejected on save | You omitted the `oauthScopes` entries; re-paste `appsscript.json` exactly. |
| Changes have no effect | You edited the code but did not create a **new version** of the deployment. |
| The login page has no **Create account** button | The button only appears when the deployed backend reports sign-up is on: a `registrationInfo` probe answering `"enabled":false` means it is off. Turn it on with `enableRegistration()` (open sign-up) or `useInviteCode()` (invite-only) on current builds, or deploy the current `Code.gs` (open by default) as a **new version**, then refresh the app. |
| `The database is busy` | Another write holds the lock; retry. |

Paste problems are the most common failure of all, and the reported line is always the **end** of the
pasted file rather than the real mistake. `npm run apps:ascii` prints the file's line count; after
pasting, press **Ctrl+End** — the last line must contain only `}`. If a one-shot paste keeps arriving
short, use the parts in `src/apps-script/paste-chunks/` (regenerate with `npm run apps:chunks`).

To confirm the deployment is live, open the `/exec` URL in a browser — it performs a `ping` and
should show `{"ok":true,...}` **without revealing any data**.

---

## 9. Security notes

- Workspace requests are open without application authentication.
- Internal hosting/network controls must provide any required access restrictions.
- The spreadsheet is **not** shared publicly; only the script owner needs access, because the web app
  executes as the owner.
- `RecordId` and `RecordJson` columns are hidden in the sheet to reduce accidental edits.

---

## 10. Schema reference — `Jobs`

| # | Column | Notes |
| --- | --- | --- |
| 1 | `RecordId` | Immutable UUID, primary key (hidden) |
| 2 | `JobNumber` | e.g. `FW-2026-0842` |
| 3 | `JobName` | |
| 4 | `CustomerName` | Property owner |
| 5 | `Email` | |
| 6 | `MobilePhone` | |
| 7 | `LossAddress` | |
| 8 | `Carrier` | |
| 9 | `ClaimNumber` | |
| 10 | `Status` | `Draft` / `Active` / `On Hold` / `Complete` / `Cancelled` |
| 11 | `CreatedAt` | `YYYY-MM-DD` |
| 12 | `UpdatedAt` | ISO timestamp |
| 13 | `UpdatedBy` | Verified email of last editor |
| 14 | `SchemaVersion` | For future migrations |
| 15 | `RecordJson` | Complete record (hidden) |
| 16 | `Deleted` | Soft-delete flag |
