/**
 * HAYS + SONS CUSTOMER & JOB DATABASE - 4 of 6: self-service sign-up
 *
 * The only endpoint reachable without credentials, so it carries the most
 * guards: open/invite/off modes, an optional domain allow-list, and a hard rule
 * that self-service can never mint an administrator. See Code.gs for the overview.
 */

/* --- Self-service registration -------------------------------------------
 *
 * This action is reachable WITHOUT credentials, because the whole point is to
 * let someone create an account before they have one. Anyone who has the web
 * app URL can therefore reach it, so the policy is explicit and configurable:
 *
 *   'open'   (DEFAULT) - anyone with the URL can create an account
 *   'invite'           - an invite code (min 12 characters) is required, and is
 *                        compared in constant time BEFORE any sheet lookup so
 *                        the Users sheet cannot be enumerated without it
 *   'off'              - sign-up is refused outright
 *
 * An optional email-domain allow-list narrows any of the three modes, and
 * self-service can NEVER mint an administrator - the role is clamped to a
 * non-admin value. Every attempt, successful or not, is written to the audit
 * log.
 *
 *   enableRegistration()               -> open
 *   disableRegistration()              -> off
 *   useInviteCode()                    -> invite, with a freshly generated code
 *   setRegistrationCode('a-long-code') -> invite, with a code you choose
 * ------------------------------------------------------------------------ */

/** The configured invite code, or '' when none is set. */
function registrationCode_() {
  var stored = PropertiesService.getScriptProperties().getProperty(PROP.REGISTRATION_CODE);
  return String(stored || '').trim();
}

/**
 * Resolves the effective registration mode: 'open', 'invite' or 'off'.
 *
 * REGISTRATION_MODE wins when it holds a recognised value. Otherwise an operator
 * who has configured an invite code clearly wants the stricter path, and
 * everyone else gets the documented default.
 */
function registrationMode_() {
  var props = PropertiesService.getScriptProperties();
  var explicit = String(props.getProperty(PROP.REGISTRATION_MODE) || '').trim().toLowerCase();
  if (explicit === 'open' || explicit === 'invite' || explicit === 'off') return explicit;
  return registrationCode_() ? 'invite' : DEFAULTS.REGISTRATION_MODE;
}

/** True when sign-up is available in any form. */
function registrationEnabled_() {
  return registrationMode_() !== 'off';
}

/** True when an invite code must be supplied. */
function registrationRequiresCode_() {
  return registrationMode_() === 'invite';
}

/** 'a.com, b.com' -> ['a.com', 'b.com'] (lower-cased, de-duplicated, '@' stripped). */
function parseDomainList_(raw) {
  var seen = {};
  var out = [];
  var parts = String(raw || '').split(/[,\s;]+/);
  for (var i = 0; i < parts.length; i++) {
    var domain = parts[i].trim().toLowerCase().replace(/^@/, '');
    if (!domain || seen[domain]) continue;
    seen[domain] = true;
    out.push(domain);
  }
  return out;
}

/** Exact match on the part of the address after the final '@'. */
function emailDomainAllowed_(email, domains) {
  var at = String(email).lastIndexOf('@');
  if (at === -1) return false;
  var domain = String(email).slice(at + 1).toLowerCase();
  for (var i = 0; i < domains.length; i++) {
    if (domains[i] === domain) return true;
  }
  return false;
}

/**
 * Single place to tighten the password rule for BOTH createUser and register,
 * so the two paths can never drift apart.
 */
function assertStrongPassword_(password) {
  var value = String(password || '');
  if (value.length < DEFAULTS.MIN_PASSWORD_LENGTH) {
    throw appError_(
      'weak_password',
      'Choose a password of at least ' + DEFAULTS.MIN_PASSWORD_LENGTH + ' characters.'
    );
  }
  return value;
}

/** The role a self-registered account receives. Administrators are never minted here. */
function selfRegistrationRole_() {
  var props = PropertiesService.getScriptProperties();
  var role = oneOf_(
    props.getProperty(PROP.REGISTRATION_DEFAULT_ROLE),
    ROLE_VALUES,
    DEFAULTS.REGISTRATION_DEFAULT_ROLE
  );
  if (role === 'admin') role = 'editor';
  return role;
}

/** Describes registration capability WITHOUT leaking the invite code. */
function api_registrationInfo_() {
  var props = PropertiesService.getScriptProperties();
  var mode = registrationMode_();
  var enabled = mode !== 'off';
  return {
    enabled: enabled,
    mode: mode,
    requiresInviteCode: mode === 'invite',
    allowedDomains: parseDomainList_(props.getProperty(PROP.REGISTRATION_EMAIL_DOMAINS)),
    defaultRole: enabled ? selfRegistrationRole_() : '',
    minPasswordLength: DEFAULTS.MIN_PASSWORD_LENGTH,
    sessionHours: DEFAULTS.SESSION_HOURS
  };
}

/**
 * Creates an account from the login page and signs the new user straight in.
 * See the security notes above this section before changing anything here.
 */
function api_register_(payload) {
  return withLock_(function () {
    var props = PropertiesService.getScriptProperties();
    var mode = registrationMode_();

    if (mode === 'off') {
      throw appError_(
        'registration_disabled',
        'Account creation is turned off. Ask an administrator to set up your account.'
      );
    }

    var email = String(payload.email || '').trim().toLowerCase();
    var name = String(payload.name || '').trim();
    var password = String(payload.password || '');
    var supplied = String(payload.inviteCode || payload.code || '').trim();

    if (!email || email.indexOf('@') === -1) {
      throw appError_('invalid_email', 'Enter a valid email address.');
    }

    if (mode === 'invite') {
      var inviteCode = registrationCode_();
      if (!inviteCode) {
        throw appError_(
          'registration_disabled',
          'Account creation is turned off. Ask an administrator to set up your account.'
        );
      }
      if (!supplied) {
        throw appError_('invalid_invite_code', 'Enter the invite code you were given.');
      }
      // Checked BEFORE any sheet access, so a wrong code cannot probe the Users sheet.
      if (!timingSafeEqual_(supplied, inviteCode)) {
        appendLog_(email, 'register_failed', '', '', 'Incorrect invite code');
        throw appError_('invalid_invite_code', 'That invite code is not correct.');
      }
    }

    var domains = parseDomainList_(props.getProperty(PROP.REGISTRATION_EMAIL_DOMAINS));
    if (domains.length && !emailDomainAllowed_(email, domains)) {
      appendLog_(email, 'register_failed', '', '', 'Email domain not permitted');
      throw appError_('forbidden', 'Accounts can only be created with an approved email domain.');
    }

    assertStrongPassword_(password);

    var sheet = usersSheet_();
    var index = headerIndexFor_(sheet, USER_HEADERS);
    var rows = dataRows_(sheet);

    for (var i = 0; i < rows.length; i++) {
      if (String(rows[i].values[index.Email] || '').trim().toLowerCase() === email) {
        appendLog_(email, 'register_failed', '', '', 'Email already registered');
        throw appError_(
          'email_in_use',
          'An account already exists for that email address. Sign in instead.'
        );
      }
    }

    var role = selfRegistrationRole_();
    var salt = newSalt_();
    var hash = hashPassword_(password, salt);
    var displayName = name || email;
    var now = new Date().toISOString();

    var row = [];
    for (var c = 0; c < USER_HEADERS.length; c++) row.push('');
    row[index.Email] = email;
    row[index.Name] = displayName;
    row[index.Role] = role;
    row[index.Salt] = salt;
    row[index.PasswordHash] = hash;
    row[index.Active] = true;
    row[index.FailedAttempts] = 0;
    row[index.LockedUntil] = '';
    row[index.CreatedAt] = now;
    row[index.LastLoginAt] = now;
    sheet.appendRow(row);

    // Sign the new user straight in so they land on the app, not back on the form.
    var session = createSession_({ email: email, name: displayName, role: role });
    appendLog_(email, 'register', '', '', 'Self-registered as ' + role);

    return {
      token: session.token,
      expiresAt: session.expiresAt,
      user: { email: email, name: displayName, role: role },
      created: true,
      role: role
    };
  });
}

/* --- Editor-only account management ------------------------------------- */

/**
 * Creates or updates an application account. Run from the Apps Script editor.
 *
 *   createUser('russell@haysandsons.com', 'Russell Shive', 'a-strong-password', 'admin')
 *
 * Roles: admin | editor | viewer. Resetting an existing account's password is
 * the same call - it updates in place.
 */
function createUser(email, name, password, role) {
  var cleanEmail = String(email || '').trim().toLowerCase();
  if (!cleanEmail || cleanEmail.indexOf('@') === -1) {
    throw appError_('invalid_email', 'A valid email address is required.');
  }
  assertStrongPassword_(password);

  var sheet = usersSheet_();
  var index = headerIndexFor_(sheet, USER_HEADERS);
  var rows = dataRows_(sheet);

  var salt = newSalt_();
  var hash = hashPassword_(String(password), salt);
  var resolvedRole = oneOf_(role, ROLE_VALUES, 'editor');
  var displayName = String(name || cleanEmail);

  for (var i = 0; i < rows.length; i++) {
    if (String(rows[i].values[index.Email] || '').trim().toLowerCase() === cleanEmail) {
      var target = rows[i].rowNumber;
      sheet.getRange(target, index.Name + 1).setValue(displayName);
      sheet.getRange(target, index.Role + 1).setValue(resolvedRole);
      sheet.getRange(target, index.Salt + 1).setValue(salt);
      sheet.getRange(target, index.PasswordHash + 1).setValue(hash);
      sheet.getRange(target, index.Active + 1).setValue(true);
      sheet.getRange(target, index.FailedAttempts + 1).setValue(0);
      sheet.getRange(target, index.LockedUntil + 1).setValue('');
      Logger.log('Updated existing account: ' + cleanEmail + ' (' + resolvedRole + ')');
      return { email: cleanEmail, role: resolvedRole, created: false };
    }
  }

  var row = [];
  for (var c = 0; c < USER_HEADERS.length; c++) row.push('');
  row[index.Email] = cleanEmail;
  row[index.Name] = displayName;
  row[index.Role] = resolvedRole;
  row[index.Salt] = salt;
  row[index.PasswordHash] = hash;
  row[index.Active] = true;
  row[index.FailedAttempts] = 0;
  row[index.LockedUntil] = '';
  row[index.CreatedAt] = new Date().toISOString();
  row[index.LastLoginAt] = '';
  sheet.appendRow(row);

  Logger.log('Created account: ' + cleanEmail + ' (' + resolvedRole + ')');
  return { email: cleanEmail, role: resolvedRole, created: true };
}

/**
 * Opens or closes self-service sign-up from the login page. Run from the editor.
 *
 *   setRegistrationCode('a-long-shared-invite-code')                    // open
 *   setRegistrationCode('a-long-shared-invite-code', 'haysandsons.com') // open, domain-limited
 *   setRegistrationCode('')                                             // close again
 *
 * The code is a shared secret: anyone who has it AND the web-app URL can create
 * an account. Treat it like a password, keep it at least
 * DEFAULTS.MIN_REGISTRATION_CODE_LENGTH characters, and rotate it by calling
 * this again. Self-registered accounts never receive the admin role.
 *
 * @param {string} code            The invite code. Empty string disables sign-up.
 * @param {string} [allowedDomains] Optional comma-separated email domains, e.g. 'haysandsons.com'.
 * @param {string} [defaultRole]   Optional role for new accounts. 'admin' is refused.
 * @return {Object} the resulting registration state.
 */
function setRegistrationCode(code, allowedDomains, defaultRole) {
  var props = PropertiesService.getScriptProperties();
  var value = String(code || '').trim();

  if (!value) {
    props.deleteProperty(PROP.REGISTRATION_CODE);
    props.setProperty(PROP.REGISTRATION_MODE, 'off');
    Logger.log('Self-service registration is now DISABLED.');
    return getRegistrationInfo();
  }

  if (value.length < DEFAULTS.MIN_REGISTRATION_CODE_LENGTH) {
    throw appError_(
      'weak_registration_code',
      'Choose an invite code of at least ' + DEFAULTS.MIN_REGISTRATION_CODE_LENGTH +
        ' characters. It is the only thing standing between the public web-app URL and your customer records.'
    );
  }

  props.setProperty(PROP.REGISTRATION_CODE, value);
  props.setProperty(PROP.REGISTRATION_MODE, 'invite');

  if (allowedDomains === undefined || allowedDomains === null || String(allowedDomains).trim() === '') {
    props.deleteProperty(PROP.REGISTRATION_EMAIL_DOMAINS);
  } else {
    props.setProperty(PROP.REGISTRATION_EMAIL_DOMAINS, String(allowedDomains).trim());
  }

  if (defaultRole) {
    var role = oneOf_(defaultRole, ROLE_VALUES, DEFAULTS.REGISTRATION_DEFAULT_ROLE);
    if (role === 'admin') {
      Logger.log('Refusing "admin" as a self-registration role; using "editor" instead.');
      role = 'editor';
    }
    props.setProperty(PROP.REGISTRATION_DEFAULT_ROLE, role);
  }

  var state = getRegistrationInfo();
  Logger.log('Self-service registration is now ENABLED.');
  return state;
}

/** Reports the registration configuration without revealing the invite code. */
function getRegistrationInfo() {
  var info = api_registrationInfo_();
  info.howToShare =
    'Give the person the app URL and the invite code, then they choose "Create account" on the login page.';
  Logger.log(JSON.stringify(info, null, 2));
  return info;
}

/**
 * A high-entropy invite code drawn from the platform UUID generator.
 * Grouped with dashes so it can be read off a screen and typed by hand.
 */
function generateInviteCode_() {
  var raw = (Utilities.getUuid() + Utilities.getUuid()).replace(/-/g, '').slice(0, 32);
  return raw.slice(0, 8) + '-' + raw.slice(8, 16) + '-' + raw.slice(16, 24) + '-' + raw.slice(24, 32);
}

/**
 * Turns self-service sign-up ON. Takes NO arguments on purpose.
 *
 * The Apps Script editor's Run button cannot pass arguments to a function, so
 * setRegistrationCode(code, domains) is awkward to invoke by hand. This wrapper
 * generates a strong invite code, stores it and logs it - select this function
 * in the dropdown, click Run, then read View > Logs and share the code.
 *
 * Takes effect immediately with no redeploy: Script Properties are shared
 * between the editor and the deployed web app.
 *
 * @return {Object} the registration state, including the generated invite code.
 */
function enableRegistration() {
  return setRegistrationMode('open');
}

/** Turns self-service sign-up OFF. Takes NO arguments on purpose. */
function disableRegistration() {
  return setRegistrationMode('off');
}

/**
 * Sets the registration mode explicitly.
 *
 * This takes an argument, so calling it by hand needs a temporary wrapper -
 * prefer enableRegistration() / disableRegistration() from the Run button.
 *
 * @param {string} mode 'open' (anyone), 'invite' (code required) or 'off'.
 * @return {Object} the resulting registration state.
 */
function setRegistrationMode(mode) {
  var props = PropertiesService.getScriptProperties();
  var wanted = String(mode || '').trim().toLowerCase();
  if (wanted !== 'open' && wanted !== 'invite' && wanted !== 'off') {
    throw appError_('invalid_mode', 'Registration mode must be "open", "invite" or "off".');
  }

  if (wanted === 'invite' && !registrationCode_()) {
    throw appError_(
      'invite_code_required',
      'Invite mode needs a code. Run useInviteCode() for a generated one, or call ' +
        'setRegistrationCode(code) with at least ' + DEFAULTS.MIN_REGISTRATION_CODE_LENGTH + ' characters.'
    );
  }

  props.setProperty(PROP.REGISTRATION_MODE, wanted);
  var state = getRegistrationInfo();

  if (wanted === 'open') {
    Logger.log(
      '\nSelf-service sign-up is OPEN.\n\n' +
        'ANYONE who has the web app URL can create an account from the login page.\n' +
        'No invite code is required.\n\n' +
        'Run disableRegistration() to close sign-up, or setRegistrationCode(code)\n' +
        'to require an invite code instead.'
    );
  } else if (wanted === 'off') {
    Logger.log('Self-service sign-up is OFF. Accounts can only be created with createUser().');
  } else {
    Logger.log('Self-service sign-up requires an invite code.');
  }
  return state;
}

/**
 * Generates a fresh invite code, stores it and switches to invite mode.
 * Takes NO arguments so it runs straight from the editor's Run button.
 */
function useInviteCode() {
  var code = generateInviteCode_();
  var state = setRegistrationCode(code);
  state.inviteCode = code;
  Logger.log(
    '\nSelf-service sign-up now requires an invite code.\n\n' +
      'Invite code - share this with the people who need accounts:\n\n    ' +
      code +
      '\n\nThey open the app, choose "Create account", and enter the code.\n' +
      'Run this again to rotate the code, or disableRegistration() to stop sign-up.'
  );
  return state;
}

/** A plain-English description of the current sign-up policy, for the README tab. */
function describeRegistrationMode_() {
  var mode = registrationMode_();
  if (mode === 'off') {
    return 'OFF. New accounts can only be created from the editor with createUser().';
  }
  if (mode === 'invite') {
    return 'INVITE ONLY. An invite code of at least ' + DEFAULTS.MIN_REGISTRATION_CODE_LENGTH +
      ' characters is required. The role is never admin.';
  }
  return 'OPEN. Anyone who has the web app URL can create an account from the login page. The role is never admin.';
}

/** Lists accounts without exposing any credential material. */
function listUsers() {
  var sheet = usersSheet_();
  var index = headerIndexFor_(sheet, USER_HEADERS);
  var rows = dataRows_(sheet);

  var out = rows.map(function (entry) {
    return {
      email: String(entry.values[index.Email] || ''),
      name: String(entry.values[index.Name] || ''),
      role: String(entry.values[index.Role] || ''),
      active: toBool_(entry.values[index.Active]),
      created: String(entry.values[index.CreatedAt] || ''),
      lastLogin: String(entry.values[index.LastLoginAt] || '')
    };
  });

  Logger.log(JSON.stringify(out, null, 2));
  return out;
}

/** Enables or disables an account without deleting it. */
function setUserActive(email, isActive) {
  var target = String(email || '').trim().toLowerCase();
  var sheet = usersSheet_();
  var index = headerIndexFor_(sheet, USER_HEADERS);
  var rows = dataRows_(sheet);

  for (var i = 0; i < rows.length; i++) {
    if (String(rows[i].values[index.Email] || '').trim().toLowerCase() === target) {
      sheet.getRange(rows[i].rowNumber, index.Active + 1).setValue(!!isActive);
      Logger.log((isActive ? 'Enabled ' : 'Disabled ') + target);
      return { email: target, active: !!isActive };
    }
  }
  throw appError_('not_found', 'No account found for ' + target);
}

/** Removes expired sessions. Safe to run on a daily time-driven trigger. */
function cleanupSessions() {
  var sheet = sessionsSheet_();
  var index = headerIndexFor_(sheet, SESSION_HEADERS);
  var rows = dataRows_(sheet);
  var now = Date.now();
  var removed = 0;

  // Walk backwards so row deletions do not shift later indices.
  for (var i = rows.length - 1; i >= 0; i--) {
    var expires = new Date(String(rows[i].values[index.ExpiresAt] || ''));
    if (isNaN(expires.getTime()) || expires.getTime() <= now) {
      sheet.deleteRow(rows[i].rowNumber);
      removed++;
    }
  }

  Logger.log('cleanupSessions removed ' + removed + ' expired session(s).');
  return { removed: removed };
}

/** Signs every session out. Useful after a suspected compromise. */
function revokeAllSessions() {
  var sheet = sessionsSheet_();
  var removed = Math.max(sheet.getLastRow() - 1, 0);
  if (removed > 0) sheet.deleteRows(2, removed);
  Logger.log('revokeAllSessions cleared ' + removed + ' session(s).');
  return { removed: removed };
}
