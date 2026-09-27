/**
 * ============================================================================
 *  HAYS + SONS COMPLETE RESTORATION - CUSTOMER & JOB DATABASE
 *  Google Apps Script backend  -  the complete backend (one file)
 * ============================================================================
 *
 *  THIS ONE FILE IS THE ENTIRE BACKEND. Paste it into the Apps Script editor's
 *  Code.gs in a single go: clear the placeholder first (Ctrl+A, then Delete),
 *  paste, and save. Then press Ctrl+End - the last line must be a single "}"
 *  and the file must match the line count printed by "npm run apps:ascii".
 *  Keep it pure ASCII; it is delivered by copy-paste.
 *
 *  QUICK START
 *    1. Paste this whole file into Code.gs (see above).
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
  MIN_REGISTRATION_CODE_LENGTH: 12,
  REGISTRATION_DEFAULT_ROLE: 'editor',
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

/** Application accounts. */
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

/* Fields that round-trip as 'number | empty-string' in the front-end. */
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

/** Boolean fields. */
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

/* ---------------------------------------------------------------------------
 * 2. PROVISIONING & SCHEMA
 * ------------------------------------------------------------------------ */

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

function removeDefaultSheet_(spreadsheet) {
  var sheets = spreadsheet.getSheets();
  for (var i = 0; i < sheets.length; i++) {
    var sheet = sheets[i];
    if (sheet.getName() === 'Sheet1' && sheet.getLastRow() === 0 && sheets.length > 1) {
      spreadsheet.deleteSheet(sheet);
    }
  }
}

function applySheetFormatting_(sheet, headers) {
  if (!sheet) return;

  var headerRange = sheet.getRange(1, 1, 1, headers.length);
  headerRange
    .setFontWeight('bold')
    .setFontColor('#ffffff')
    .setBackground('#dc2626')
    .setVerticalAlignment('middle')
    .setWrap(false);
  sheet.setRowHeight(1, 28);

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

  var recordIdCol = headers.indexOf('RecordId');
  var jsonCol = headers.indexOf('RecordJson');
  if (recordIdCol !== -1) sheet.hideColumns(recordIdCol + 1);
  if (jsonCol !== -1) sheet.hideColumns(jsonCol + 1);
}

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

function countDataRows_(sheet) {
  if (!sheet) return 0;
  var lastRow = sheet.getLastRow();
  return lastRow < 2 ? 0 : lastRow - 1;
}

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
    ['COLUMNS - ' + jobSheetName]
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
  lines.push(['REGISTRATION_MODE', describeRegistrationMode_()]);

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
 * 3. MENU & ACCESSORS
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
    // Standalone scripts have no UI; this is normal.
  }
}

function getSpreadsheet_() {
  var id = PropertiesService.getScriptProperties().getProperty(PROP.DB_SPREADSHEET_ID);
  if (!id) {
    ensureDatabaseReady_();
    id = PropertiesService.getScriptProperties().getProperty(PROP.DB_SPREADSHEET_ID);
  }
  return SpreadsheetApp.openById(id);
}

function jobsSheet_() {
  var ss = getSpreadsheet_();
  var name = PropertiesService.getScriptProperties().getProperty(PROP.DB_SHEET_NAME) || DEFAULTS.DB_SHEET_NAME;
  return ss.getSheetByName(name);
}

function usersSheet_() {
  var ss = getSpreadsheet_();
  var name = PropertiesService.getScriptProperties().getProperty(PROP.USERS_SHEET_NAME) || DEFAULTS.USERS_SHEET_NAME;
  return ss.getSheetByName(name);
}

function sessionsSheet_() {
  var ss = getSpreadsheet_();
  var name = PropertiesService.getScriptProperties().getProperty(PROP.SESSIONS_SHEET_NAME) || DEFAULTS.SESSIONS_SHEET_NAME;
  return ss.getSheetByName(name);
}

function logSheet_() {
  var ss = getSpreadsheet_();
  var name = PropertiesService.getScriptProperties().getProperty(PROP.LOG_SHEET_NAME) || DEFAULTS.LOG_SHEET_NAME;
  return ss.getSheetByName(name);
}

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

/* ---------------------------------------------------------------------------
 * 4. WEB APP ENTRY POINTS
 * ------------------------------------------------------------------------ */

function doGet(e) {
  try {
    var payload = parseRequest_(e);
    if (!payload.action) payload.action = 'ping';
    return handleAction_(payload);
  } catch (err) {
    return errorResponse_(err);
  }
}

function doPost(e) {
  try {
    var payload = parseRequest_(e);
    return handleAction_(payload);
  } catch (err) {
    return errorResponse_(err);
  }
}

function parseRequest_(e) {
  if (!e) return {};
  if (e.postData && e.postData.contents) {
    try {
      return JSON.parse(e.postData.contents);
    } catch (err) {
      return { action: 'raw', contents: e.postData.contents };
    }
  }
  if (e.parameter) {
    return e.parameter;
  }
  return {};
}

function handleAction_(payload) {
  var action = payload.action;

  // Unauthenticated routes
  if (action === 'ping') {
    return successResponse_({ status: 'ok', timestamp: new Date().toISOString() });
  }
  if (action === 'login') {
    var loginResult = loginUser_(payload.email, payload.password);
    return successResponse_(loginResult);
  }
  if (action === 'register') {
    var regResult = registerUser_(payload.email, payload.name, payload.password, payload.inviteCode);
    return successResponse_(regResult);
  }

  // Authenticated routes
  var user = authenticateRequest_(payload);

  if (action === 'logout') {
    revokeSession_(payload.sessionToken || payload.token);
    return successResponse_({ loggedOut: true });
  }
  if (action === 'getCurrentUser' || action === 'checkSession') {
    return successResponse_({ user: user });
  }
  if (action === 'listJobs') {
    var jobs = listJobs_(user, payload);
    return successResponse_(jobs);
  }
  if (action === 'getJob') {
    var job = getJob_(user, payload.recordId);
    return successResponse_(job);
  }
  if (action === 'saveJob') {
    var savedJob = saveJob_(user, payload.job);
    return successResponse_(savedJob);
  }
  if (action === 'deleteJob') {
    var delResult = deleteJob_(user, payload.recordId);
    return successResponse_(delResult);
  }
  if (action === 'listUsers') {
    if (user.role !== 'admin') throw appError_('forbidden', 'Administrator rights required.');
    return successResponse_(listUsers());
  }

  throw appError_('unknown_action', 'Unrecognized action: ' + action);
}

function successResponse_(data) {
  return ContentService.createTextOutput(JSON.stringify({ ok: true, data: data }))
    .setMimeType(ContentService.MimeType.JSON);
}

function errorResponse_(err) {
  var code = (err && err.code) || 'server_error';
  var message = (err && err.message) || String(err);
  return ContentService.createTextOutput(JSON.stringify({ ok: false, error: message, code: code }))
    .setMimeType(ContentService.MimeType.JSON);
}

function appError_(code, message) {
  var err = new Error(message || code);
  err.code = code;
  return err;
}

/* ---------------------------------------------------------------------------
 * 5. AUTHENTICATION & SECURITY
 * ------------------------------------------------------------------------ */

function hashPassword_(password, salt) {
  var iterations = DEFAULTS.PASSWORD_ITERATIONS;
  var key = salt;
  var hash = password;
  for (var i = 0; i < iterations; i++) {
    var sig = Utilities.computeHmacSha256Signature(hash + key, key);
    hash = Utilities.base64Encode(sig);
  }
  return hash;
}

function generateSalt_() {
  var randomString = Utilities.getUuid() + ':' + Math.random() + ':' + new Date().getTime();
  var digest = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, randomString);
  return Utilities.base64Encode(digest);
}

function authenticateRequest_(payload) {
  ensureDatabaseReady_();
  var props = PropertiesService.getScriptProperties();

  // Developer bypass (if explicitly configured)
  var devSecret = props.getProperty(PROP.SHARED_SECRET);
  if (devSecret && payload.sharedSecret === devSecret) {
    return { email: 'dev-bypass@system.local', name: 'Developer Bypass', role: 'admin' };
  }

  var token = payload.sessionToken || payload.token;
  if (!token) {
    throw appError_('unauthorized', 'Authentication required. No session token provided.');
  }

  var user = validateSession_(token);
  if (!user) {
    throw appError_('session_expired', 'Session invalid or expired. Please sign in again.');
  }
  return user;
}

function createSession_(email, name, role) {
  var sheet = sessionsSheet_();
  var token = Utilities.getUuid();
  var now = new Date();
  var expires = new Date(now.getTime() + DEFAULTS.SESSION_HOURS * 60 * 60 * 1000);

  sheet.appendRow([
    token,
    email,
    name,
    role,
    now.toISOString(),
    expires.toISOString(),
    now.toISOString()
  ]);

  return {
    token: token,
    expiresAt: expires.toISOString()
  };
}

function validateSession_(token) {
  if (!token) return null;
  var sheet = sessionsSheet_();
  var data = sheet.getDataRange().getValues();
  if (data.length <= 1) return null;

  var now = new Date();
  for (var i = 1; i < data.length; i++) {
    if (String(data[i][0]) === String(token)) {
      var expiresAt = new Date(data[i][5]);
      if (now > expiresAt) {
        return null;
      }
      try {
        sheet.getRange(i + 1, 7).setValue(now.toISOString());
      } catch (e) {}
      return {
        email: String(data[i][1]),
        name: String(data[i][2]),
        role: String(data[i][3])
      };
    }
  }
  return null;
}

function revokeSession_(token) {
  if (!token) return;
  var sheet = sessionsSheet_();
  var data = sheet.getDataRange().getValues();
  for (var i = 1; i < data.length; i++) {
    if (String(data[i][0]) === String(token)) {
      sheet.deleteRow(i + 1);
      return;
    }
  }
}

function revokeAllSessions() {
  var sheet = sessionsSheet_();
  var lastRow = sheet.getLastRow();
  if (lastRow > 1) {
    sheet.deleteRows(2, lastRow - 1);
  }
  Logger.log('All active sessions have been revoked.');
}

function cleanupSessions() {
  var sheet = sessionsSheet_();
  var data = sheet.getDataRange().getValues();
  if (data.length <= 1) return 0;

  var now = new Date();
  var removed = 0;
  for (var i = data.length - 1; i >= 1; i--) {
    var expiresAt = new Date(data[i][5]);
    if (now > expiresAt) {
      sheet.deleteRow(i + 1);
      removed++;
    }
  }
  Logger.log('Cleaned up ' + removed + ' expired session(s).');
  return removed;
}

/* ---------------------------------------------------------------------------
 * 6. USER MANAGEMENT & REGISTRATION
 * ------------------------------------------------------------------------ */

function registrationMode_() {
  var props = PropertiesService.getScriptProperties();
  return props.getProperty(PROP.REGISTRATION_MODE) || DEFAULTS.REGISTRATION_MODE;
}

function registrationEnabled_() {
  return registrationMode_() !== 'off';
}

function registrationRequiresCode_() {
  return registrationMode_() === 'invite';
}

function selfRegistrationRole_() {
  var props = PropertiesService.getScriptProperties();
  return props.getProperty(PROP.REGISTRATION_DEFAULT_ROLE) || DEFAULTS.REGISTRATION_DEFAULT_ROLE;
}

function describeRegistrationMode_() {
  var mode = registrationMode_();
  if (mode === 'off') return 'Disabled. Users must be created by an administrator.';
  if (mode === 'invite') return 'Invite code required. Script Property REGISTRATION_CODE must match.';
  return 'Open. Anyone with the web app URL can create an account.';
}

function enableRegistration() {
  PropertiesService.getScriptProperties().setProperty(PROP.REGISTRATION_MODE, 'open');
  Logger.log('Registration is now OPEN.');
}

function disableRegistration() {
  PropertiesService.getScriptProperties().setProperty(PROP.REGISTRATION_MODE, 'off');
  Logger.log('Registration is now OFF.');
}

function useInviteCode(code) {
  if (!code || String(code).length < DEFAULTS.MIN_REGISTRATION_CODE_LENGTH) {
    throw new Error('Invite code must be at least ' + DEFAULTS.MIN_REGISTRATION_CODE_LENGTH + ' characters.');
  }
  var props = PropertiesService.getScriptProperties();
  props.setProperty(PROP.REGISTRATION_MODE, 'invite');
  props.setProperty(PROP.REGISTRATION_CODE, String(code));
  Logger.log('Registration set to INVITE with code.');
}

function createUser(email, name, password, role) {
  ensureDatabaseReady_();
  if (!email || !password) throw appError_('bad_request', 'Email and password are required.');
  email = String(email).trim().toLowerCase();
  role = role || 'editor';

  if (ROLE_VALUES.indexOf(role) === -1) {
    throw appError_('invalid_role', 'Role must be one of: ' + ROLE_VALUES.join(', '));
  }
  if (String(password).length < DEFAULTS.MIN_PASSWORD_LENGTH) {
    throw appError_('weak_password', 'Password must be at least ' + DEFAULTS.MIN_PASSWORD_LENGTH + ' characters.');
  }

  var sheet = usersSheet_();
  var data = sheet.getDataRange().getValues();
  for (var i = 1; i < data.length; i++) {
    if (String(data[i][0]).toLowerCase() === email) {
      throw appError_('user_exists', 'A user with this email already exists.');
    }
  }

  var salt = generateSalt_();
  var hash = hashPassword_(password, salt);
  var now = new Date().toISOString();

  sheet.appendRow([
    email,
    name || email,
    role,
    salt,
    hash,
    true, // Active
    0,    // FailedAttempts
    '',   // LockedUntil
    now,  // CreatedAt
    ''    // LastLoginAt
  ]);

  appendLog_('SYSTEM', 'USER_CREATED', '', '', 'Created account for ' + email + ' (' + role + ')');
  return { email: email, name: name || email, role: role };
}

function removeUser_(email) {
  var sheet = usersSheet_();
  var data = sheet.getDataRange().getValues();
  for (var i = 1; i < data.length; i++) {
    if (String(data[i][0]).toLowerCase() === String(email).toLowerCase()) {
      sheet.deleteRow(i + 1);
      return true;
    }
  }
  return false;
}

function listUsers() {
  var sheet = usersSheet_();
  var data = sheet.getDataRange().getValues();
  var users = [];
  for (var i = 1; i < data.length; i++) {
    users.push({
      email: data[i][0],
      name: data[i][1],
      role: data[i][2],
      active: data[i][5],
      createdAt: data[i][8],
      lastLoginAt: data[i][9]
    });
  }
  Logger.log(JSON.stringify(users, null, 2));
  return users;
}

function loginUser_(email, password) {
  ensureDatabaseReady_();
  if (!email || !password) throw appError_('bad_request', 'Email and password are required.');
  email = String(email).trim().toLowerCase();

  var sheet = usersSheet_();
  var data = sheet.getDataRange().getValues();
  var rowIndex = -1;
  var row = null;

  for (var i = 1; i < data.length; i++) {
    if (String(data[i][0]).toLowerCase() === email) {
      rowIndex = i + 1;
      row = data[i];
      break;
    }
  }

  if (!row) throw appError_('invalid_credentials', 'Incorrect email or password.');

  var name = row[1];
  var role = row[2];
  var salt = row[3];
  var expectedHash = row[4];
  var active = row[5];
  var failedAttempts = Number(row[6]) || 0;
  var lockedUntilStr = row[7];

  if (!active) throw appError_('account_disabled', 'This account has been disabled.');

  var now = new Date();
  if (lockedUntilStr) {
    var lockedUntil = new Date(lockedUntilStr);
    if (now < lockedUntil) {
      var minutesLeft = Math.ceil((lockedUntil.getTime() - now.getTime()) / 60000);
      throw appError_('account_locked', 'Account locked due to failed attempts. Try again in ' + minutesLeft + ' minute(s).');
    }
  }

  var candidateHash = hashPassword_(password, salt);
  if (candidateHash !== expectedHash) {
    failedAttempts++;
    var updateRange = sheet.getRange(rowIndex, 7, 1, 2);
    if (failedAttempts >= DEFAULTS.MAX_FAILED_ATTEMPTS) {
      var lockExpires = new Date(now.getTime() + DEFAULTS.LOCKOUT_MINUTES * 60 * 1000);
      updateRange.setValues([[failedAttempts, lockExpires.toISOString()]]);
      appendLog_(email, 'LOGIN_LOCKED', '', '', 'Locked out after ' + failedAttempts + ' failed attempts');
      throw appError_('account_locked', 'Too many failed attempts. Account locked for ' + DEFAULTS.LOCKOUT_MINUTES + ' minutes.');
    } else {
      updateRange.setValues([[failedAttempts, '']]);
      appendLog_(email, 'LOGIN_FAILED', '', '', 'Failed login attempt (' + failedAttempts + ')');
      throw appError_('invalid_credentials', 'Incorrect email or password.');
    }
  }

  // Login successful: reset attempts and record timestamp
  sheet.getRange(rowIndex, 7, 1, 4).setValues([[0, '', row[8], now.toISOString()]]);

  var session = createSession_(email, name, role);
  appendLog_(email, 'LOGIN_SUCCESS', '', '', 'Session started');

  return {
    sessionToken: session.token,
    expiresAt: session.expiresAt,
    user: { email: email, name: name, role: role }
  };
}

function registerUser_(email, name, password, inviteCode) {
  var mode = registrationMode_();
  if (mode === 'off') {
    throw appError_('registration_closed', 'Self-service registration is currently disabled.');
  }

  if (mode === 'invite') {
    var requiredCode = PropertiesService.getScriptProperties().getProperty(PROP.REGISTRATION_CODE);
    if (!requiredCode || String(inviteCode).trim() !== requiredCode.trim()) {
      throw appError_('invalid_invite_code', 'Invalid or missing registration invite code.');
    }
  }

  var allowedDomains = PropertiesService.getScriptProperties().getProperty(PROP.REGISTRATION_EMAIL_DOMAINS);
  if (allowedDomains) {
    var domains = allowedDomains.split(',').map(function (d) { return d.trim().toLowerCase(); });
    var emailDomain = String(email).split('@')[1] || '';
    if (domains.indexOf(emailDomain.toLowerCase()) === -1) {
      throw appError_('domain_not_allowed', 'Email domain is not authorized for registration.');
    }
  }

  var defaultRole = selfRegistrationRole_();
  var user = createUser(email, name, password, defaultRole);
  var session = createSession_(user.email, user.name, user.role);

  appendLog_(user.email, 'REGISTRATION_SUCCESS', '', '', 'User registered via ' + mode + ' mode');

  return {
    sessionToken: session.token,
    expiresAt: session.expiresAt,
    user: user
  };
}

/* ---------------------------------------------------------------------------
 * 7. JOB DATA LAYER
 * ------------------------------------------------------------------------ */

function emptyRecordTemplate_() {
  return {
    recordId: '',
    jobNumber: '',
    jobName: '',
    customerName: '',
    email: '',
    mobilePhone: '',
    lossAddress: '',
    carrier: '',
    claimNumber: '',
    status: 'Draft',
    insurance: { roughEstimateAmount: '' },
    financials: {
      totalApprovedRcv: '',
      deductible: '',
      netClaimValue: 0,
      downPayment: 0,
      midProgressPayment: 0,
      balancePayment: 0,
      commenceDays: 10,
      completeDays: 60
    },
    mortgage: { hasMortgage: false },
    changeOrder: {
      originalContractSum: '',
      netPreviousChanges: '',
      changeAmount: '',
      addedDays: '',
      changeType: 'increase',
      isInsuranceRelated: false
    },
    checklist: {
      depreciationAmount: '',
      isSelfPay: false,
      isProgramClaim: false,
      hasCheckBeenSent: false,
      isDepreciationWithheld: false,
      hasDeductibleBeenCollected: 'No'
    }
  };
}

function saveJob_(user, jobData) {
  if (user.role === 'viewer') {
    throw appError_('forbidden', 'Viewer role does not have permission to save or update jobs.');
  }
  if (!jobData || typeof jobData !== 'object') {
    throw appError_('bad_request', 'Job record payload is missing or invalid.');
  }

  var sheet = jobsSheet_();
  var recordId = jobData.recordId || jobData.RecordId || Utilities.getUuid();
  jobData.recordId = recordId;

  var nowIso = new Date().toISOString();
  var todayStr = nowIso.slice(0, 10);

  // Look up existing row
  var data = sheet.getDataRange().getValues();
  var targetRow = -1;
  var existingCreatedAt = todayStr;

  for (var i = 1; i < data.length; i++) {
    if (String(data[i][0]) === String(recordId)) {
      targetRow = i + 1;
      existingCreatedAt = data[i][10] || todayStr;
      break;
    }
  }

  var rowValues = [
    recordId,
    jobData.jobNumber || jobData.JobNumber || '',
    jobData.jobName || jobData.JobName || '',
    jobData.customerName || jobData.CustomerName || '',
    jobData.email || jobData.Email || '',
    jobData.mobilePhone || jobData.MobilePhone || '',
    jobData.lossAddress || jobData.LossAddress || '',
    jobData.carrier || jobData.Carrier || '',
    jobData.claimNumber || jobData.ClaimNumber || '',
    jobData.status || jobData.Status || 'Draft',
    targetRow !== -1 ? existingCreatedAt : todayStr,
    nowIso,
    user.email,
    currentSchemaVersion_(),
    JSON.stringify(jobData),
    false // Deleted
  ];

  if (targetRow !== -1) {
    sheet.getRange(targetRow, 1, 1, rowValues.length).setValues([rowValues]);
    appendLog_(user.email, 'JOB_UPDATED', recordId, rowValues[1], 'Job updated');
  } else {
    sheet.appendRow(rowValues);
    appendLog_(user.email, 'JOB_CREATED', recordId, rowValues[1], 'New job record added');
  }

  return jobData;
}

function getJob_(user, recordId) {
  if (!recordId) throw appError_('bad_request', 'recordId is required.');
  var sheet = jobsSheet_();
  var data = sheet.getDataRange().getValues();

  for (var i = 1; i < data.length; i++) {
    if (String(data[i][0]) === String(recordId)) {
      var isDeleted = data[i][15] === true || String(data[i][15]).toUpperCase() === 'TRUE';
      if (isDeleted) throw appError_('not_found', 'Job record has been deleted.');

      var jsonStr = data[i][14];
      try {
        return JSON.parse(jsonStr);
      } catch (err) {
        throw appError_('data_corrupt', 'Stored JSON could not be parsed: ' + err);
      }
    }
  }
  throw appError_('not_found', 'Job record not found.');
}

function listJobs_(user, options) {
  options = options || {};
  var sheet = jobsSheet_();
  var data = sheet.getDataRange().getValues();
  var jobs = [];

  for (var i = 1; i < data.length; i++) {
    var isDeleted = data[i][15] === true || String(data[i][15]).toUpperCase() === 'TRUE';
    if (isDeleted && !options.includeDeleted) continue;

    var recordId = data[i][0];
    if (!recordId) continue;

    var item = {
      recordId: recordId,
      jobNumber: data[i][1],
      jobName: data[i][2],
      customerName: data[i][3],
      email: data[i][4],
      mobilePhone: data[i][5],
      lossAddress: data[i][6],
      carrier: data[i][7],
      claimNumber: data[i][8],
      status: data[i][9],
      createdAt: data[i][10],
      updatedAt: data[i][11],
      updatedBy: data[i][12],
      deleted: isDeleted
    };

    if (options.fullRecords) {
      try {
        item.record = JSON.parse(data[i][14]);
      } catch (e) {
        item.record = null;
      }
    }
    jobs.push(item);
  }
  return jobs;
}

function deleteJob_(user, recordId) {
  if (user.role === 'viewer') {
    throw appError_('forbidden', 'Viewer role cannot delete jobs.');
  }
  if (!recordId) throw appError_('bad_request', 'recordId is required.');

  var sheet = jobsSheet_();
  var data = sheet.getDataRange().getValues();

  for (var i = 1; i < data.length; i++) {
    if (String(data[i][0]) === String(recordId)) {
      sheet.getRange(i + 1, 12).setValue(new Date().toISOString()); // UpdatedAt
      sheet.getRange(i + 1, 13).setValue(user.email);             // UpdatedBy
      sheet.getRange(i + 1, 16).setValue(true);                   // Deleted
      appendLog_(user.email, 'JOB_DELETED', recordId, String(data[i][1]), 'Job soft-deleted');
      return { recordId: recordId, deleted: true };
    }
  }
  throw appError_('not_found', 'Job record not found.');
}

/* ---------------------------------------------------------------------------
 * 8. AUDIT LOGGING & UTILITIES
 * ------------------------------------------------------------------------ */

function appendLog_(userEmail, action, recordId, jobNumber, detail) {
  try {
    var sheet = logSheet_();
    if (!sheet) return;
    sheet.appendRow([
      new Date().toISOString(),
      userEmail || 'ANONYMOUS',
      action || '',
      recordId || '',
      jobNumber || '',
      detail || ''
    ]);
  } catch (err) {
    Logger.log('Audit log failure: ' + err);
  }
}

function currentSchemaVersion_() {
  var props = PropertiesService.getScriptProperties();
  return Number(props.getProperty(PROP.SCHEMA_VERSION)) || DEFAULTS.SCHEMA_VERSION;
}

/* ---------------------------------------------------------------------------
 * 9. SELF TEST & DIAGNOSTICS
 * ------------------------------------------------------------------------ */

function selfTest() {
  Logger.log('Starting Self-Test verification...');
  ensureDatabaseReady_();

  var testEmail = 'selftest.' + new Date().getTime() + '@example.com';
  var testPass = 'SelfTestPass123!';

  // 1. Create User
  var user = createUser(testEmail, 'Self-Test Operator', testPass, 'editor');
  if (!user || user.email !== testEmail) throw new Error('SelfTest: Failed to create user.');

  // 2. Login
  var loginResult = loginUser_(testEmail, testPass);
  if (!loginResult.sessionToken) throw new Error('SelfTest: Login did not return sessionToken.');

  // 3. Save Job
  var template = emptyRecordTemplate_();
  template.jobNumber = 'TEST-001';
  template.jobName = 'Self-Test Drying Phase';
  template.customerName = 'Test Property';
  template.status = 'Draft';

  var saved = saveJob_(loginResult.user, template);
  if (!saved.recordId) throw new Error('SelfTest: Job save failed to produce recordId.');

  // 4. Retrieve Job
  var fetched = getJob_(loginResult.user, saved.recordId);
  if (fetched.jobName !== 'Self-Test Drying Phase') throw new Error('SelfTest: Fetched job mismatch.');

  // 5. Delete Job
  var deleted = deleteJob_(loginResult.user, saved.recordId);
  if (!deleted.deleted) throw new Error('SelfTest: Job deletion failed.');

  // 6. Cleanup
  removeUser_(testEmail);
  cleanupSessions();

  Logger.log('=============================');
  Logger.log('>>> SELF TEST RESULT: PASS <<<');
  Logger.log('=============================');
  return 'PASS';
}
