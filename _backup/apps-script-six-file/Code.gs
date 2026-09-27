/**
 * ============================================================================
 *  HAYS + SONS COMPLETE RESTORATION - CUSTOMER & JOB DATABASE
 *  Google Apps Script backend  -  1 of 6: configuration + provisioning
 * ============================================================================
 *
 *  THIS PROJECT IS SPLIT ACROSS SIX FILES. Paste each one into its own file in
 *  the Apps Script editor (the editor's "+" button adds a script file). The
 *  names below are only a guide - any file name works.
 *
 *    Code.gs          <- this file: configuration, provisioning, menu
 *    WebApp.gs        web app entry points and authentication
 *    Sessions.gs      accounts, sessions, login/logout, user administration
 *    Registration.gs  self-service sign-up
 *    Jobs.gs          job actions and record normalisation
 *    Support.gs       sheet access, utilities, self test
 *
 *  Apps Script merges every .gs file in a project into a single global scope, so
 *  the split is purely organisational - no imports and no load order to worry
 *  about.
 *
 *  QUICK START
 *    1. Create the six files and paste one of ours into each.
 *    2. Project Settings -> Show appsscript.json -> paste the manifest.
 *    3. Run ONE command and approve the permissions prompt:
 *         setupDatabase()
 *       That provisions the spreadsheet, every sheet, all headers, formatting
 *       and the README tab. It is idempotent, so running it again is safe.
 *       Add an admin in the same call with three arguments, run from a
 *       temporary wrapper because the editor cannot pass arguments:
 *         function bootstrap() {
 *           setupDatabase('you@example.com', 'Your Name', 'a-strong-password');
 *         }
 *    4. Run selfTest()  ->  should report PASS
 *    5. Deploy -> New deployment -> Web app
 *         Execute as:      Me
 *         Who has access:  Anyone
 *       Copy the /exec URL into the front-end as VITE_APPS_SCRIPT_URL
 *    6. SIGN-UP IS OPEN by default - anyone with the web app URL can create an
 *       account from the login page. To lock it down, run either of these from
 *       the function dropdown (no arguments, so they run directly, and both take
 *       effect immediately with no redeploy):
 *         disableRegistration()   -> no sign-up at all
 *         useInviteCode()         -> an invite code is required
 *
 *  If step 3 is skipped, the very first web request provisions the database
 *  automatically, so a fresh deployment is never left half-built.
 *
 *  SECURITY MODEL
 *    The app has its own login page. Credentials are checked against the "Users"
 *    sheet and a short-lived bearer token is issued, recorded in the "Sessions"
 *    sheet and sent with every subsequent request.
 *
 *    Passwords are never stored in plain text: each account carries a random
 *    salt and an iterated HMAC-SHA256 derivation. Accounts lock after repeated
 *    failures and sessions expire automatically.
 *
 *    The Google ID-token path (ALLOWED_CLIENT_ID / ALLOWED_EMAILS) remains
 *    available but optional. SHARED_SECRET is a deliberate developer bypass and
 *    must stay unset in production.
 *
 *    Self-service sign-up is OPEN by default: anyone who has the web app URL can
 *    create an account from the login page. It can be restricted to an invite
 *    code, or switched off entirely, and it can never create an administrator.
 *    The policy lives in the REGISTRATION_MODE Script Property:
 *      open (default) | invite | off
 *
 *  API
 *    POST /exec   Content-Type: text/plain;charset=utf-8
 *                 body: {"action":"login","email":"...","password":"..."}
 *                       {"action":"register","email":"...","name":"...","password":"...","inviteCode":"..."}
 *                       {"action":"saveJob","sessionToken":"<token>","job":{...}}
 *                 Every response is HTTP 200 with a JSON envelope:
 *                 {"ok":true,"data":{...}}  |  {"ok":false,"error":"...","code":"..."}
 *                 Always branch on 'ok', never on the HTTP status.
 * ============================================================================
 */

/* ---------------------------------------------------------------------------
 * 1. CONFIGURATION
 * ------------------------------------------------------------------------ */

var PROP = {
  DB_SPREADSHEET_ID: 'DB_SPREADSHEET_ID',
  SCHEMA_VERSION: 'SCHEMA_VERSION',
  ALLOWED_CLIENT_ID: 'ALLOWED_CLIENT_ID',
  ALLOWED_EMAILS: 'ALLOWED_EMAILS',
  REQUIRE_ID_TOKEN: 'REQUIRE_ID_TOKEN',
  SHARED_SECRET: 'SHARED_SECRET',
  DB_SHEET_NAME: 'DB_SHEET_NAME',
  LOG_SHEET_NAME: 'LOG_SHEET_NAME',
  USERS_SHEET_NAME: 'USERS_SHEET_NAME',
  SESSIONS_SHEET_NAME: 'SESSIONS_SHEET_NAME',
  REGISTRATION_CODE: 'REGISTRATION_CODE',
  REGISTRATION_MODE: 'REGISTRATION_MODE',
  REGISTRATION_EMAIL_DOMAINS: 'REGISTRATION_EMAIL_DOMAINS',
  REGISTRATION_DEFAULT_ROLE: 'REGISTRATION_DEFAULT_ROLE'
};

var DEFAULTS = {
  DB_SHEET_NAME: 'Jobs',
  LOG_SHEET_NAME: 'AuditLog',
  USERS_SHEET_NAME: 'Users',
  SESSIONS_SHEET_NAME: 'Sessions',
  SCHEMA_VERSION: 1,
  REQUIRE_ID_TOKEN: 'true',
  SPREADSHEET_TITLE: 'Hays + Sons - Customer & Job Database',
  NOTES_SHEET_NAME: 'README',
  WEBAPP_ACCESS_HINT: 'Anyone',
  EXECUTE_AS_HINT: 'Me',
  // --- Authentication tunables -------------------------------------------------
  SESSION_HOURS: 12,
  PASSWORD_ITERATIONS: 1500,
  MAX_FAILED_ATTEMPTS: 5,
  LOCKOUT_MINUTES: 15,
  // --- Self-service registration ------------------------------------------------
  MIN_PASSWORD_LENGTH: 8,
  // When the mode is 'invite', the code is the ONLY thing between the public
  // web-app URL and the customer records, so it must resist guessing.
  MIN_REGISTRATION_CODE_LENGTH: 12,
  REGISTRATION_DEFAULT_ROLE: 'editor',
  // 'open'   - anyone with the web app URL can create an account (default)
  // 'invite' - an invite code is required
  // 'off'    - no sign-up at all
  REGISTRATION_MODE: 'open'
};

/** 'Jobs' sheet columns, in order. Keep in sync with the front-end index columns. */
var JOB_HEADERS = [
  'RecordId',
  'JobNumber',
  'JobName',
  'CustomerName',
  'Email',
  'MobilePhone',
  'LossAddress',
  'Carrier',
  'ClaimNumber',
  'Status',
  'CreatedAt',
  'UpdatedAt',
  'UpdatedBy',
  'SchemaVersion',
  'RecordJson',
  'Deleted'
];

/** Append-only audit trail. */
var LOG_HEADERS = ['Timestamp', 'User', 'Action', 'RecordId', 'JobNumber', 'Detail'];

/**
 * Application accounts. Passwords are NEVER stored in plain text: the sheet
 * holds a per-user random salt plus an iterated HMAC-SHA256 derivation.
 */
var USER_HEADERS = [
  'Email',
  'Name',
  'Role',
  'Salt',
  'PasswordHash',
  'Active',
  'FailedAttempts',
  'LockedUntil',
  'CreatedAt',
  'LastLoginAt'
];

/** Short-lived bearer sessions issued on successful login. */
var SESSION_HEADERS = ['Token', 'Email', 'Name', 'Role', 'CreatedAt', 'ExpiresAt', 'LastSeenAt'];

var ROLE_VALUES = ['admin', 'editor', 'viewer'];

var STATUS_VALUES = ['Draft', 'Active', 'On Hold', 'Complete', 'Cancelled'];

/* Fields that round-trip as 'number | empty-string' in the front-end. Blank must stay blank - never 0. */
var NUMERIC_OR_BLANK_PATHS = [
  'insurance.roughEstimateAmount',
  'financials.totalApprovedRcv',
  'financials.deductible',
  'changeOrder.originalContractSum',
  'changeOrder.netPreviousChanges',
  'changeOrder.changeAmount',
  'changeOrder.addedDays',
  'checklist.depreciationAmount'
];

/** Always-numeric fields (default supplied). */
var NUMERIC_PATHS = {
  'financials.netClaimValue': 0,
  'financials.downPayment': 0,
  'financials.midProgressPayment': 0,
  'financials.balancePayment': 0,
  'financials.commenceDays': 10,
  'financials.completeDays': 60
};

/** Boolean fields. Strings such as "FALSE" must NOT become true. */
var BOOLEAN_PATHS = [
  'mortgage.hasMortgage',
  'changeOrder.isInsuranceRelated',
  'checklist.isSelfPay',
  'checklist.isProgramClaim',
  'checklist.hasCheckBeenSent',
  'checklist.isDepreciationWithheld'
];

/** Case-sensitive string unions. */
var ENUM_PATHS = {
  'changeOrder.changeType': { values: ['increase', 'decrease', 'unchanged'], fallback: 'increase' },
  'checklist.hasDeductibleBeenCollected': { values: ['Yes', 'No', 'Pending'], fallback: 'No' }
};

/** Guaranteed sub-objects are provided by emptyRecordTemplate_(). */

/* ---------------------------------------------------------------------------
 * 2. PROVISIONING  - run this once
 * ------------------------------------------------------------------------ */

/**
 * Creates (or repairs) the ENTIRE database in one call: the spreadsheet, the
 * Jobs, AuditLog, Users, Sessions and README sheets, all headers, formatting,
 * hidden credential columns and configuration.
 *
 * Idempotent and order-independent - safe to run as the very first action after
 * pasting this file into a new Apps Script project, and safe to run again later
 * to repair or upgrade.
 *
 * Optionally seeds the first administrator in the same step:
 *   setupDatabase('you@example.com', 'Your Name', 'a-strong-password')
 *
 * @param {string} [adminEmail]    Optional email for the first administrator.
 * @param {string} [adminName]     Optional display name for that administrator.
 * @param {string} [adminPassword] Optional password, 8+ characters.
 * @return {Object} summary describing what was provisioned.
 */
function setupDatabase(adminEmail, adminName, adminPassword) {
  var props = PropertiesService.getScriptProperties();
  var created = false;
  var spreadsheet = null;

  var existingId = props.getProperty(PROP.DB_SPREADSHEET_ID);
  if (existingId) {
    try {
      spreadsheet = SpreadsheetApp.openById(existingId);
    } catch (err) {
      Logger.log('Stored DB_SPREADSHEET_ID is not reachable (' + err + '). A new spreadsheet will be created.');
      spreadsheet = null;
    }
  }

  if (!spreadsheet) {
    spreadsheet = SpreadsheetApp.create(DEFAULTS.SPREADSHEET_TITLE);
    created = true;
  }

  var jobSheetName = props.getProperty(PROP.DB_SHEET_NAME) || DEFAULTS.DB_SHEET_NAME;
  var logSheetName = props.getProperty(PROP.LOG_SHEET_NAME) || DEFAULTS.LOG_SHEET_NAME;
  var usersSheetName = props.getProperty(PROP.USERS_SHEET_NAME) || DEFAULTS.USERS_SHEET_NAME;
  var sessionsSheetName = props.getProperty(PROP.SESSIONS_SHEET_NAME) || DEFAULTS.SESSIONS_SHEET_NAME;

  var jobsResult = ensureSheet_(spreadsheet, jobSheetName, JOB_HEADERS);
  var logResult = ensureSheet_(spreadsheet, logSheetName, LOG_HEADERS);
  var usersResult = ensureSheet_(spreadsheet, usersSheetName, USER_HEADERS);
  var sessionsResult = ensureSheet_(spreadsheet, sessionsSheetName, SESSION_HEADERS);

  // Persist configuration.
  props.setProperty(PROP.DB_SPREADSHEET_ID, spreadsheet.getId());
  props.setProperty(PROP.DB_SHEET_NAME, jobSheetName);
  props.setProperty(PROP.LOG_SHEET_NAME, logSheetName);
  props.setProperty(PROP.USERS_SHEET_NAME, usersSheetName);
  props.setProperty(PROP.SESSIONS_SHEET_NAME, sessionsSheetName);
  if (!props.getProperty(PROP.SCHEMA_VERSION)) {
    props.setProperty(PROP.SCHEMA_VERSION, String(DEFAULTS.SCHEMA_VERSION));
  }
  if (!props.getProperty(PROP.REQUIRE_ID_TOKEN)) {
    props.setProperty(PROP.REQUIRE_ID_TOKEN, DEFAULTS.REQUIRE_ID_TOKEN);
  }

  removeDefaultSheet_(spreadsheet);

  var jobsSheet = spreadsheet.getSheetByName(jobSheetName);
  var logSheet = spreadsheet.getSheetByName(logSheetName);
  var usersSheet = spreadsheet.getSheetByName(usersSheetName);
  var sessionsSheet = spreadsheet.getSheetByName(sessionsSheetName);

  applySheetFormatting_(jobsSheet, JOB_HEADERS);
  applySheetFormatting_(logSheet, LOG_HEADERS);
  applySheetFormatting_(usersSheet, USER_HEADERS);
  applySheetFormatting_(sessionsSheet, SESSION_HEADERS);

  // Credentials and live sessions must never be casually visible.
  hideColumns_(usersSheet, USER_HEADERS, ['Salt', 'PasswordHash']);
  hideColumns_(sessionsSheet, SESSION_HEADERS, ['Token']);

  writeNotesTab_(spreadsheet, jobSheetName, logSheetName, usersSheetName, sessionsSheetName);

  var userCount = countDataRows_(usersSheet);

  var summary = {
    spreadsheetId: spreadsheet.getId(),
    spreadsheetUrl: spreadsheet.getUrl(),
    created: created,
    jobsSheet: jobSheetName,
    logSheet: logSheetName,
    usersSheet: usersSheetName,
    sessionsSheet: sessionsSheetName,
    userCount: userCount,
    columnsAdded:
      jobsResult.columnsAdded + logResult.columnsAdded + usersResult.columnsAdded + sessionsResult.columnsAdded,
    schemaVersion: Number(props.getProperty(PROP.SCHEMA_VERSION)),
    requiresFirstUser: userCount === 0,
    webAppUrl: ScriptApp.getService().getUrl()
  };

  if (userCount === 0) {
    Logger.log(
      'No application users exist yet. Run createUser("you@example.com", "Your Name", "a-strong-password") ' +
        'from the editor to create the first account, then log in through the app.'
    );
  }

  // Optional one-step bootstrap of the first administrator.
  var bootstrap = null;
  if (adminEmail && adminPassword) {
    bootstrap = createUser(adminEmail, adminName || adminEmail, adminPassword, 'admin');
    summary.userCount = countDataRows_(usersSheet);
    summary.requiresFirstUser = false;
  }

  summary.nextSteps = bootstrap
    ? 'Account "' + bootstrap.email + '" is ready. Log in through the app with that email and password.'
    : userCount === 0
    ? 'Create your first login with createUser(email, name, password, "admin"), then sign in through the app.'
    : 'Set up. Sign in through the app, then paste the web app /exec URL into VITE_APPS_SCRIPT_URL.';

  Logger.log('setupDatabase complete.\n' + JSON.stringify(summary, null, 2));
  Logger.log('NEXT: ' + summary.nextSteps);
  return summary;
}

/**
 * Guarantees the database exists before a request is served, so the very first
 * call to the web app provisions everything even if setupDatabase() was never
 * run by hand. Only runs when no spreadsheet has been recorded yet.
 *
 * @return {boolean} true when provisioning happened during this call.
 */
function ensureDatabaseReady_() {
  var props = PropertiesService.getScriptProperties();
  if (props.getProperty(PROP.DB_SPREADSHEET_ID)) return false;

  Logger.log('No database configured - provisioning automatically on first use.');
  try {
    var summary = setupDatabase();
    Logger.log('Automatic provisioning complete: ' + summary.spreadsheetUrl);
    return true;
  } catch (err) {
    throw appError_(
      'not_configured',
      'The database could not be provisioned automatically (' +
        ((err && err.message) || err) +
        '). Open the Apps Script editor and run setupDatabase() once, then try again.'
    );
  }
}

/** Ensures a sheet exists with the given headers, adding any missing columns. */
function ensureSheet_(spreadsheet, name, headers) {
  var sheet = spreadsheet.getSheetByName(name);
  if (!sheet) {
    sheet = spreadsheet.insertSheet(name);
  }

  var columnsAdded = 0;
  var lastColumn = Math.max(sheet.getLastColumn(), 0);
  var existing = lastColumn > 0 ? sheet.getRange(1, 1, 1, lastColumn).getValues()[0] : [];

  if (existing.length === 0) {
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
    columnsAdded = headers.length;
  } else {
    // Keep the canonical order but never destroy an operator-added column.
    var present = {};
    for (var i = 0; i < existing.length; i++) {
      if (existing[i]) present[String(existing[i])] = true;
    }
    for (var h = 0; h < headers.length; h++) {
      if (!present[headers[h]]) {
        sheet.getRange(1, sheet.getLastColumn() + 1, 1, 1).setValue(headers[h]);
        columnsAdded++;
      }
    }
  }

  if (sheet.getFrozenRows() !== 1) sheet.setFrozenRows(1);
  return { columnsAdded: columnsAdded };
}

/** Deletes the empty "Sheet1" that SpreadsheetApp.create() adds. */
function removeDefaultSheet_(spreadsheet) {
  var sheets = spreadsheet.getSheets();
  for (var i = 0; i < sheets.length; i++) {
    var sheet = sheets[i];
    if (sheet.getName() === 'Sheet1' && sheet.getLastRow() === 0 && sheets.length > 1) {
      spreadsheet.deleteSheet(sheet);
    }
  }
}

/** Cosmetic + protective formatting: header styling, text formats, widths. */
function applySheetFormatting_(sheet, headers) {
  if (!sheet) return;

  var headerRange = sheet.getRange(1, 1, 1, headers.length);
  headerRange
    .setFontWeight('bold')
    .setFontColor('#ffffff')
    .setBackground('#b91c1c')
    .setVerticalAlignment('middle')
    .setWrap(false);
  sheet.setRowHeight(1, 28);

  // Force text format so Sheets never coerces ids, dates or JSON.
  var textColumns = ['RecordId', 'JobNumber', 'ClaimNumber', 'RecordJson', 'CreatedAt', 'UpdatedAt'];
  for (var i = 0; i < headers.length; i++) {
    if (textColumns.indexOf(headers[i]) !== -1) {
      sheet.getRange(2, i + 1, Math.max(sheet.getMaxRows() - 1, 1), 1).setNumberFormat('@');
    }
  }

  for (var c = 0; c < headers.length; c++) {
    var name = headers[c];
    if (name === 'RecordJson') sheet.setColumnWidth(c + 1, 120);
    else if (name === 'Email' || name === 'LossAddress') sheet.setColumnWidth(c + 1, 200);
    else sheet.setColumnWidth(c + 1, Math.max(120, Math.min(220, name.length * 12 + 60)));
  }

  // Hide implementation-only columns for a cleaner operator experience.
  var recordIdCol = headers.indexOf('RecordId');
  var jsonCol = headers.indexOf('RecordJson');
  if (recordIdCol !== -1) sheet.hideColumns(recordIdCol + 1);
  if (jsonCol !== -1) sheet.hideColumns(jsonCol + 1);
}

/** Hides the named columns, ignoring any that are not present. */
function hideColumns_(sheet, headers, names) {
  if (!sheet) return;
  for (var i = 0; i < names.length; i++) {
    var index = headers.indexOf(names[i]);
    if (index === -1) continue;
    try {
      sheet.hideColumns(index + 1);
    } catch (err) {
      Logger.log('Could not hide column ' + names[i] + ': ' + err);
    }
  }
}

/** Populated data rows in a sheet, excluding the header row. */
function countDataRows_(sheet) {
  if (!sheet) return 0;
  var lastRow = sheet.getLastRow();
  return lastRow < 2 ? 0 : lastRow - 1;
}

/** Documents the schema and configuration inside the spreadsheet itself. */
function writeNotesTab_(spreadsheet, jobSheetName, logSheetName, usersSheetName, sessionsSheetName) {
  var sheet = spreadsheet.getSheetByName(DEFAULTS.NOTES_SHEET_NAME);
  if (!sheet) sheet = spreadsheet.insertSheet(DEFAULTS.NOTES_SHEET_NAME);
  sheet.clear();

  var lines = [
    ['Hays + Sons Complete Restoration - Customer & Job Database'],
    ['Provisioned', new Date().toISOString()],
    ['Schema version', String(currentSchemaVersion_())],
    [''],
    ['HOW THIS WORKS'],
    ['This spreadsheet is the system of record for customer/job data entered in the document automation app.'],
    ['The front-end talks to the Apps Script web app, which reads and writes the "' + jobSheetName + '" sheet.'],
    ['Every change is also appended to "' + logSheetName + '".'],
    [''],
    ['SHEETS'],
    [jobSheetName, 'One row per saved job. RecordJson holds the complete record.'],
    [logSheetName, 'Append-only audit trail of who changed what and when.'],
    [usersSheetName, 'Application accounts. Salt and PasswordHash are hidden.'],
    [sessionsSheetName, 'Active login sessions. The Token column is hidden.'],
    [''],
    ['SIGNING IN'],
    ['The app has its own login page. Credentials are checked against the "' + usersSheetName + '" sheet.'],
    ['Passwords are never stored in plain text - each account has a random salt and an iterated hash.'],
    ['Create accounts from the Apps Script editor with createUser(email, name, password, role).'],
    ['People can also create their own account from the login page. See REGISTRATION_MODE below.'],
    ['Sessions expire after ' + DEFAULTS.SESSION_HOURS + ' hours and are listed in "' + sessionsSheetName + '".'],
    [''],
    ['COLUMNS - ' + jobSheetName],
  ];

  for (var i = 0; i < JOB_HEADERS.length; i++) {
    lines.push(['  ' + (i + 1) + '. ' + JOB_HEADERS[i], describeColumn_(JOB_HEADERS[i])]);
  }

  lines.push(['']);
  lines.push(['COLUMNS - ' + logSheetName]);
  for (var l = 0; l < LOG_HEADERS.length; l++) {
    lines.push(['  ' + (l + 1) + '. ' + LOG_HEADERS[l], '']);
  }

  lines.push(['']);
  lines.push(['SECURITY - do not weaken these in production']);
  lines.push(['Sessions', 'Bearer tokens issued by login; expire after ' + DEFAULTS.SESSION_HOURS + ' hours.']);
  lines.push([
    'Lockout',
    'An account locks for ' + DEFAULTS.LOCKOUT_MINUTES + ' minutes after ' + DEFAULTS.MAX_FAILED_ATTEMPTS + ' failed attempts.'
  ]);
  lines.push(['ALLOWED_CLIENT_ID', 'Optional Google ID-token path (legacy).']);
  lines.push(['ALLOWED_EMAILS', 'Optional Google ID-token path (legacy).']);
  lines.push(['SHARED_SECRET', 'DEVELOPER BYPASS ONLY - leave blank in production.']);
  lines.push([
    'REGISTRATION_MODE',
    describeRegistrationMode_()
  ]);

  var width = 2;
  sheet.getRange(1, 1, lines.length, width).setValues(
    lines.map(function (row) {
      var padded = row.slice(0, width);
      while (padded.length < width) padded.push('');
      return padded;
    })
  );

  sheet.getRange(1, 1, 1, width).setFontWeight('bold').setFontSize(14);
  sheet.setColumnWidth(1, 320);
  sheet.setColumnWidth(2, 520);
  sheet.getRange(4, 1, lines.length - 3, width).setWrap(true).setVerticalAlignment('top');
}

function describeColumn_(name) {
  var map = {
    RecordId: 'Immutable UUID. Primary key. Never edited.',
    JobNumber: 'Human-facing job number, e.g. FW-2026-0842.',
    JobName: 'Job / project name.',
    CustomerName: 'Property owner.',
    Email: 'Customer email.',
    MobilePhone: 'Best contact number.',
    LossAddress: 'Property where the loss occurred.',
    Carrier: 'Insurance carrier.',
    ClaimNumber: 'Carrier claim number.',
    Status: 'Draft | Active | On Hold | Complete | Cancelled.',
    CreatedAt: 'YYYY-MM-DD when the job was first created.',
    UpdatedAt: 'ISO timestamp of the last save.',
    UpdatedBy: 'Verified email of the last editor.',
    SchemaVersion: 'Record schema version for future migrations.',
    RecordJson: 'Complete record as JSON. Source of truth for reload.',
    Deleted: 'TRUE for soft-deleted rows.'
  };
  return map[name] || '';
}

/* ---------------------------------------------------------------------------
 * 3. MENU (only appears in a container-bound copy)
 * ------------------------------------------------------------------------ */

function onOpen() {
  try {
    SpreadsheetApp.getUi()
      .createMenu('Hays + Sons DB')
      .addItem('Set up / repair database', 'setupDatabase')
      .addItem('Run self test', 'selfTest')
      .addItem('Turn ON self-service sign-up', 'enableRegistration')
      .addItem('Turn OFF self-service sign-up', 'disableRegistration')
      .addItem('List users', 'listUsers')
      .addItem('Clean up expired sessions', 'cleanupSessions')
      .addItem('Sign out everyone', 'revokeAllSessions')
      .addItem('Show install info', 'showInstallInfo')
      .addToUi();
  } catch (err) {
    // Standalone scripts have no UI; this is expected and harmless.
  }
}

/** Logs deployment + configuration state. Useful for support. */
function showInstallInfo() {
  var props = PropertiesService.getScriptProperties();

  var userCount = 0;
  var sessionCount = 0;
  try {
    userCount = countDataRows_(usersSheet_());
  } catch (err) {
    userCount = -1;
  }
  try {
    sessionCount = countDataRows_(sessionsSheet_());
  } catch (err) {
    sessionCount = -1;
  }

  var info = {
    spreadsheetId: props.getProperty(PROP.DB_SPREADSHEET_ID) || '(not set - run setupDatabase)',
    schemaVersion: props.getProperty(PROP.SCHEMA_VERSION) || '(not set)',
    jobsSheet: props.getProperty(PROP.DB_SHEET_NAME) || DEFAULTS.DB_SHEET_NAME,
    logSheet: props.getProperty(PROP.LOG_SHEET_NAME) || DEFAULTS.LOG_SHEET_NAME,
    usersSheet: props.getProperty(PROP.USERS_SHEET_NAME) || DEFAULTS.USERS_SHEET_NAME,
    sessionsSheet: props.getProperty(PROP.SESSIONS_SHEET_NAME) || DEFAULTS.SESSIONS_SHEET_NAME,
    userCount: userCount,
    activeSessionCount: sessionCount,
    sessionHours: DEFAULTS.SESSION_HOURS,
    signedInAccounts: userCount === 0 ? '(none - run createUser to add the first account)' : userCount,
    legacyIdTokenPathEnabled: props.getProperty(PROP.REQUIRE_ID_TOKEN) !== 'false',
    allowedClientIdSet: !!props.getProperty(PROP.ALLOWED_CLIENT_ID),
    allowedEmails: props.getProperty(PROP.ALLOWED_EMAILS) || '(not set)',
    developerBypassEnabled: !!props.getProperty(PROP.SHARED_SECRET),
    selfRegistrationMode: registrationMode_(),
    selfRegistrationEnabled: registrationEnabled_(),
    selfRegistrationRequiresCode: registrationRequiresCode_(),
    selfRegistrationDomains: props.getProperty(PROP.REGISTRATION_EMAIL_DOMAINS) || '(any domain)',
    selfRegistrationRole: registrationEnabled_() ? selfRegistrationRole_() : '(n/a)',
    webAppUrl: ScriptApp.getService().getUrl() || '(not deployed)'
  };
  Logger.log(JSON.stringify(info, null, 2));
  return info;
}
