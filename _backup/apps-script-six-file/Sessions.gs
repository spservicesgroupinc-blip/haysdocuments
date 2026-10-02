/**
 * HAYS + SONS CUSTOMER & JOB DATABASE - 3 of 6: accounts and sessions
 *
 * Password hashing, session issue/validate/revoke, login and logout, and the
 * editor-only user administration helpers. See Code.gs for the overview.
 */

/* ---------------------------------------------------------------------------
 * 5B. APPLICATION ACCOUNTS & SESSIONS
 *
 * The app has its own login page. Credentials are verified against the "Users"
 * sheet and successful logins mint a short-lived bearer token stored in the
 * "Sessions" sheet.
 *
 * Passwords are never stored in plain text. Each account carries a random salt
 * and an iterated HMAC-SHA256 derivation (Apps Script has no bcrypt/argon2, so
 * a high-iteration HMAC is the strongest primitive available natively).
 * ------------------------------------------------------------------------ */

/** Derives a hex password hash from a password and per-user salt. */
function hashPassword_(password, salt, iterations) {
  var rounds = Number(iterations) > 0 ? Number(iterations) : DEFAULTS.PASSWORD_ITERATIONS;
  var key = String(salt || '');
  // computeHmacSha256Signature only accepts (String, String) or (Byte[], Byte[]).
  // Convert each round's bytes to hex so the next round passes a String, not a
  // Byte[] (number[]), which the V8 runtime rejects with a signature mismatch.
  var hex = bytesToHex_(Utilities.computeHmacSha256Signature(String(password), key));
  for (var i = 1; i < rounds; i++) {
    hex = bytesToHex_(Utilities.computeHmacSha256Signature(hex, key));
  }
  return hex;
}

/** Signed bytes -> lowercase hex. */
function bytesToHex_(bytes) {
  var out = '';
  for (var i = 0; i < bytes.length; i++) {
    var value = bytes[i];
    if (value < 0) value += 256;
    var hex = value.toString(16);
    out += hex.length === 1 ? '0' + hex : hex;
  }
  return out;
}

/** A fresh, unpredictable per-user salt. */
function newSalt_() {
  return Utilities.getUuid() + Utilities.getUuid();
}

/** Generic sheet accessor used by the account/session stores. */
function namedSheet_(propKey, fallbackName) {
  var props = PropertiesService.getScriptProperties();
  var id = props.getProperty(PROP.DB_SPREADSHEET_ID);
  if (!id) throw appError_('not_configured', 'The database has not been set up yet. Run setupDatabase().');

  var spreadsheet;
  try {
    spreadsheet = SpreadsheetApp.openById(id);
  } catch (err) {
    throw appError_('not_configured', 'The database spreadsheet cannot be opened. Re-run setupDatabase().');
  }

  var name = props.getProperty(propKey) || fallbackName;
  var sheet = spreadsheet.getSheetByName(name);
  if (!sheet) throw appError_('not_configured', 'Missing sheet "' + name + '". Re-run setupDatabase().');
  return sheet;
}

function usersSheet_() {
  return namedSheet_(PROP.USERS_SHEET_NAME, DEFAULTS.USERS_SHEET_NAME);
}

function sessionsSheet_() {
  return namedSheet_(PROP.SESSIONS_SHEET_NAME, DEFAULTS.SESSIONS_SHEET_NAME);
}

/** Issues a bearer token and records the session. */
function createSession_(user) {
  var sheet = sessionsSheet_();
  var index = headerIndexFor_(sheet, SESSION_HEADERS);

  var token =
    Utilities.getUuid().replace(/-/g, '') + Utilities.getUuid().replace(/-/g, '');
  var now = new Date();
  var expires = new Date(now.getTime() + DEFAULTS.SESSION_HOURS * 60 * 60 * 1000);

  var row = [];
  for (var i = 0; i < SESSION_HEADERS.length; i++) row.push('');
  row[index.Token] = token;
  row[index.Email] = user.email;
  row[index.Name] = user.name;
  row[index.Role] = user.role;
  row[index.CreatedAt] = now.toISOString();
  row[index.ExpiresAt] = expires.toISOString();
  row[index.LastSeenAt] = now.toISOString();

  sheet.appendRow(row);
  return { token: token, expiresAt: expires.toISOString() };
}

/** Validates a token, expiring it on use if stale. Returns null when invalid. */
function validateSession_(token) {
  if (!token) return null;

  var sheet = sessionsSheet_();
  var index = headerIndexFor_(sheet, SESSION_HEADERS);
  var rows = dataRows_(sheet);
  var now = new Date();

  for (var i = 0; i < rows.length; i++) {
    var row = rows[i].values;
    if (String(row[index.Token] || '') !== String(token)) continue;

    var expires = new Date(String(row[index.ExpiresAt] || ''));
    if (isNaN(expires.getTime()) || expires.getTime() <= now.getTime()) {
      try {
        sheet.deleteRow(rows[i].rowNumber);
      } catch (err) {
        /* non-fatal */
      }
      return null;
    }

    try {
      sheet.getRange(rows[i].rowNumber, index.LastSeenAt + 1).setValue(now.toISOString());
    } catch (err) {
      /* non-fatal */
    }

    return {
      email: String(row[index.Email] || ''),
      name: String(row[index.Name] || ''),
      role: oneOf_(row[index.Role], ROLE_VALUES, 'editor')
    };
  }

  return null;
}

/** Revokes a single session. */
function deleteSession_(token) {
  if (!token) return;
  var sheet = sessionsSheet_();
  var index = headerIndexFor_(sheet, SESSION_HEADERS);
  var rows = dataRows_(sheet);
  for (var i = 0; i < rows.length; i++) {
    if (String(rows[i].values[index.Token] || '') === String(token)) {
      sheet.deleteRow(rows[i].rowNumber);
      return;
    }
  }
}

/** Records a failed attempt, locking the account after the configured limit. */
function registerFailedAttempt_(sheet, index, rowNumber, row) {
  try {
    var attempts = Number(row[index.FailedAttempts] || 0) + 1;
    sheet.getRange(rowNumber, index.FailedAttempts + 1).setValue(attempts);
    if (attempts >= DEFAULTS.MAX_FAILED_ATTEMPTS) {
      var until = new Date(Date.now() + DEFAULTS.LOCKOUT_MINUTES * 60 * 1000);
      sheet.getRange(rowNumber, index.LockedUntil + 1).setValue(until.toISOString());
    }
  } catch (err) {
    Logger.log('Could not record failed attempt: ' + err);
  }
}

function clearFailedAttempts_(sheet, index, rowNumber) {
  try {
    sheet.getRange(rowNumber, index.FailedAttempts + 1).setValue(0);
    sheet.getRange(rowNumber, index.LockedUntil + 1).setValue('');
  } catch (err) {
    /* non-fatal */
  }
}

/**
 * Verifies credentials and issues a session.
 * Failures are deliberately uniform so the endpoint cannot be used to discover
 * which email addresses have accounts.
 */
function api_login_(payload) {
  return withLock_(function () {
    var email = String(payload.email || '').trim().toLowerCase();
    var password = String(payload.password || '');
    if (!email || !password) {
      throw appError_('invalid_credentials', 'Enter your email address and password.');
    }

    var sheet = usersSheet_();
    var index = headerIndexFor_(sheet, USER_HEADERS);
    var rows = dataRows_(sheet);

    var found = null;
    for (var i = 0; i < rows.length; i++) {
      var rowEmail = String(rows[i].values[index.Email] || '').trim().toLowerCase();
      if (rowEmail === email) {
        found = rows[i];
        break;
      }
    }

    var genericFailure = appError_('invalid_credentials', 'Incorrect email address or password.');
    if (!found) throw genericFailure;

    var row = found.values;

    if (!toBool_(row[index.Active])) {
      throw appError_('account_disabled', 'This account is disabled. Contact an administrator.');
    }

    var lockedUntilRaw = String(row[index.LockedUntil] || '');
    if (lockedUntilRaw) {
      var lockedUntil = new Date(lockedUntilRaw);
      if (!isNaN(lockedUntil.getTime()) && lockedUntil.getTime() > Date.now()) {
        throw appError_('account_locked', 'Too many failed attempts. Please try again later.');
      }
    }

    var salt = String(row[index.Salt] || '');
    var expected = String(row[index.PasswordHash] || '');
    var actual = hashPassword_(password, salt);

    if (!expected || !timingSafeEqual_(actual, expected)) {
      registerFailedAttempt_(sheet, index, found.rowNumber, row);
      appendLog_(email, 'login_failed', '', '', 'Incorrect password');
      throw genericFailure;
    }

    clearFailedAttempts_(sheet, index, found.rowNumber);

    var name = String(row[index.Name] || email);
    var role = oneOf_(row[index.Role], ROLE_VALUES, 'editor');
    var session = createSession_({ email: email, name: name, role: role });

    sheet.getRange(found.rowNumber, index.LastLoginAt + 1).setValue(new Date().toISOString());
    appendLog_(email, 'login', '', '', 'Signed in');

    return {
      token: session.token,
      expiresAt: session.expiresAt,
      user: { email: email, name: name, role: role }
    };
  });
}

function api_logout_(payload, user) {
  deleteSession_(payload.sessionToken || payload.token);
  appendLog_(user.email, 'logout', '', '', 'Signed out');
  return { signedOut: true };
}

function api_session_(payload, user) {
  return { user: { email: user.email, name: user.name, role: user.role }, method: user.method };
}
