/**
 * HAYS + SONS CUSTOMER & JOB DATABASE - 2 of 6: web app entry points and auth
 *
 * The POST router plus the authentication chain: session token, then the
 * developer shared secret, then the Google ID-token path. See Code.gs for the
 * full project overview.
 */

/* ---------------------------------------------------------------------------
 * 4. WEB APP ENTRY POINTS
 * ------------------------------------------------------------------------ */

function doGet(e) {
  var payload = parseRequest_(e);
  if (!payload.action) payload.action = 'ping';
  return respond_(dispatch_(payload));
}

function doPost(e) {
  return respond_(dispatch_(parseRequest_(e)));
}

/** Normalises either a JSON body (preferred) or form/query parameters. */
function parseRequest_(e) {
  if (!e) return {};

  if (e.postData && e.postData.contents) {
    var raw = e.postData.contents;
    try {
      return JSON.parse(raw) || {};
    } catch (err) {
      /* not JSON - try form encoding below */
    }
    if (raw.indexOf('=') !== -1) {
      var decoded = {};
      raw.split('&').forEach(function (pair) {
        var bits = pair.split('=');
        decoded[decodeURIComponent(bits[0])] = decodeURIComponent((bits[1] || '').replace(/\+/g, ' '));
      });
      if (decoded.payload) {
        try { return JSON.parse(decoded.payload) || {}; } catch (err2) { /* ignore */ }
      }
      return decoded;
    }
  }

  if (e.parameter) {
    var params = {};
    for (var key in e.parameter) params[key] = e.parameter[key];
    if (params.payload) {
      try { return JSON.parse(params.payload) || {}; } catch (err3) { /* ignore */ }
    }
    return params;
  }

  return {};
}

/** Routes one request to its action handler and always returns an envelope. */
function dispatch_(payload) {
  try {
    var action = String(payload.action || '').trim();
    if (!action) throw appError_('missing_action', 'No action was supplied.');

    // First-ever request provisions the spreadsheet, sheets and configuration
    // automatically so a fresh deployment works without a manual setup step.
    var provisioned = ensureDatabaseReady_();

    // Unauthenticated liveness probe. Deliberately reveals no data.
    if (action === 'ping') {
      return ok_({
        pong: true,
        provisionedNow: provisioned,
        schemaVersion: currentSchemaVersion_(),
        time: new Date().toISOString(),
        sessionHours: DEFAULTS.SESSION_HOURS
      });
    }

    // The login page must be reachable before a session exists.
    if (action === 'login') {
      return ok_(api_login_(payload));
    }

    // Self-service sign-up is unauthenticated by definition - the whole point is
    // to create an account before you have one. It fails closed: it only works
    // when an operator has set REGISTRATION_CODE.
    if (action === 'register') {
      return ok_(api_register_(payload));
    }

    // Non-secret capability probe so the login page knows whether to offer the
    // "Create account" affordance at all.
    if (action === 'registrationInfo') {
      return ok_(api_registrationInfo_());
    }

    var user = authorize_(payload);

    switch (action) {
      case 'logout':
        return ok_(api_logout_(payload, user));
      case 'session':
        return ok_(api_session_(payload, user));
      case 'saveJob':
        return ok_(api_saveJob_(payload, user));
      case 'listJobs':
        return ok_(api_listJobs_(payload, user));
      case 'getJob':
        return ok_(api_getJob_(payload, user));
      case 'deleteJob':
        return ok_(api_deleteJob_(payload, user));
      case 'searchJobs':
        return ok_(api_searchJobs_(payload, user));
      default:
        throw appError_('unknown_action', 'Unsupported action: ' + action);
    }
  } catch (err) {
    var code = (err && err.appCode) || 'internal_error';
    var message = (err && err.message) || String(err);
    Logger.log('Request failed [' + code + ']: ' + message);
    return { ok: false, code: code, error: message };
  }
}

function respond_(envelope) {
  return ContentService.createTextOutput(JSON.stringify(envelope)).setMimeType(
    ContentService.MimeType.JSON
  );
}

/* ---------------------------------------------------------------------------
 * 5. AUTHENTICATION
 * ------------------------------------------------------------------------ */

/**
 * Establishes who is calling. Returns { email, name, role, method } or throws.
 *
 * Order of precedence: application session -> developer shared secret ->
 * Google ID token. Fails closed.
 */
function authorize_(payload) {
  var props = PropertiesService.getScriptProperties();

  // 1. Application session issued by the login page (primary path).
  var sessionToken = payload.sessionToken || payload.token;
  if (sessionToken) {
    var session = validateSession_(String(sessionToken));
    if (session) {
      return { email: session.email, name: session.name, role: session.role, method: 'session' };
    }
    throw appError_('session_expired', 'Your session has expired. Please sign in again.');
  }

  // 2. Deliberate, documented developer bypass.
  var sharedSecret = props.getProperty(PROP.SHARED_SECRET);
  if (sharedSecret && payload.secret && timingSafeEqual_(String(payload.secret), sharedSecret)) {
    Logger.log('WARNING: request authenticated with the developer shared secret.');
    return { email: 'developer-bypass@local', method: 'shared_secret' };
  }

  if (props.getProperty(PROP.REQUIRE_ID_TOKEN) === 'false') {
    Logger.log('WARNING: REQUIRE_ID_TOKEN is false - serving without authentication.');
    return { email: 'unauthenticated@local', method: 'disabled' };
  }

  var token = payload.idToken || payload.id_token;
  if (!token) {
    throw appError_('unauthenticated', 'Sign in with Google before using the database.');
  }

  var claims = verifyIdToken_(String(token));

  var allowedClientId = props.getProperty(PROP.ALLOWED_CLIENT_ID);
  if (allowedClientId && claims.aud !== allowedClientId) {
    throw appError_('forbidden', 'This ID token was not issued for this application.');
  }
  if (claims.email_verified === false || claims.email_verified === 'false') {
    throw appError_('forbidden', 'The Google account email is not verified.');
  }

  var email = String(claims.email || '').toLowerCase();
  if (!email) {
    throw appError_('forbidden', 'The Google account did not provide an email address.');
  }
  if (!isEmailAllowed_(email, props.getProperty(PROP.ALLOWED_EMAILS))) {
    throw appError_('forbidden', 'This account (' + email + ') is not permitted to access the database.');
  }

  return { email: email, method: 'id_token' };
}

/** Verifies a Google ID token with Google. Returns the claims. */
function verifyIdToken_(token) {
  var response = UrlFetchApp.fetch(
    'https://oauth2.googleapis.com/tokeninfo?id_token=' + encodeURIComponent(token),
    { muteHttpExceptions: true }
  );

  var body = response.getContentText();
  var claims;
  try {
    claims = JSON.parse(body);
  } catch (err) {
    throw appError_('unauthenticated', 'Could not read the sign-in response.');
  }

  if (response.getResponseCode() !== 200) {
    throw appError_('unauthenticated', claims.error_description || claims.error || 'Sign-in token was rejected.');
  }

  var nowSeconds = Math.floor(Date.now() / 1000);
  if (claims.exp && Number(claims.exp) < nowSeconds) {
    throw appError_('unauthenticated', 'Your sign-in has expired. Please sign in again.');
  }

  return claims;
}

/** Supports exact emails and "@domain.com" entries. */
function isEmailAllowed_(email, allowList) {
  if (!allowList) return false;
  var entries = String(allowList)
    .split(',')
    .map(function (entry) { return entry.trim().toLowerCase(); })
    .filter(function (entry) { return entry.length > 0; });

  for (var i = 0; i < entries.length; i++) {
    var entry = entries[i];
    if (entry.charAt(0) === '@') {
      if (email.slice(-entry.length) === entry) return true;
    } else if (entry === email) {
      return true;
    }
  }
  return false;
}

/** Constant-time-ish comparison to avoid trivial secret-length probing. */
function timingSafeEqual_(a, b) {
  if (a.length !== b.length) return false;
  var diff = 0;
  for (var i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
