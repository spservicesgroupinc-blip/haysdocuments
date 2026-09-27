/**
 * HAYS + SONS CUSTOMER & JOB DATABASE - 5 of 6: jobs and record normalisation
 *
 * Save/list/get/delete/search plus the round-trip safety net that repairs
 * anything a spreadsheet can do to the record shape. See Code.gs for the overview.
 */

/* ---------------------------------------------------------------------------
 * 6. ACTIONS
 * ------------------------------------------------------------------------ */

/** Upsert on RecordId. Appends when new, updates in place when it already exists. */
function api_saveJob_(payload, user) {
  return withLock_(function () {
    var incoming = payload.job || payload.record;
    if (!incoming || typeof incoming !== 'object') {
      throw appError_('invalid_job', 'saveJob requires a "job" object.');
    }

    var record = normalizeRecord_(incoming);
    var sheet = jobsSheet_();
    var index = headerIndex_(sheet);
    var rows = dataRows_(sheet);

    var existingRowNumber = findRowNumber_(rows, index.RecordId, record.recordId);
    var now = new Date().toISOString();

    record.schemaVersion = currentSchemaVersion_();
    record.updatedAt = now;
    if (!record.dateCreated) record.dateCreated = today_();

    var row = buildJobRow_(record, index, user.email);
    var created = existingRowNumber === -1;

    if (created) {
      sheet.appendRow(row);
    } else {
      sheet.getRange(existingRowNumber, 1, 1, row.length).setValues([row]);
    }

    appendLog_(user.email, created ? 'create' : 'update', record.recordId, record.customer.jobNumber,
      created ? 'Created record' : 'Updated record');

    return { record: record, created: created, recordId: record.recordId };
  });
}

/** Returns lightweight summaries (no RecordJson) for a library list. */
function api_listJobs_(payload, user) {
  var sheet = jobsSheet_();
  var index = headerIndex_(sheet);
  var rows = dataRows_(sheet);
  var includeDeleted = payload.includeDeleted === true;
  var limit = Number(payload.limit) > 0 ? Number(payload.limit) : 500;

  var out = [];
  for (var i = 0; i < rows.length && out.length < limit; i++) {
    var row = rows[i].values;
    var deleted = toBool_(row[index.Deleted]);
    if (deleted && !includeDeleted) continue;
    out.push(summaryFromRow_(row, index));
  }

  out.sort(function (a, b) { return String(b.updatedAt).localeCompare(String(a.updatedAt)); });
  return { jobs: out, count: out.length };
}

/** Full record lookup by RecordId (preferred) or JobNumber. */
function api_getJob_(payload, user) {
  var sheet = jobsSheet_();
  var index = headerIndex_(sheet);
  var rows = dataRows_(sheet);
  var record = findRecord_(rows, index, payload);

  if (!record) throw appError_('not_found', 'That job could not be found.');

  appendLog_(user.email, 'read', record.record.recordId, record.record.customer.jobNumber, 'Opened record');
  return { job: record.record, updatedAt: record.record.updatedAt, updatedBy: String(record.row[index.UpdatedBy] || '') };
}

/** Soft delete by default; payload.hard === true removes the row. */
function api_deleteJob_(payload, user) {
  return withLock_(function () {
    var sheet = jobsSheet_();
    var index = headerIndex_(sheet);
    var rows = dataRows_(sheet);
    var found = findRecordRow_(rows, index, payload);

    if (!found) throw appError_('not_found', 'That job could not be found.');

    var recordId = String(found.values[index.RecordId] || '');
    var jobNumber = String(found.values[index.JobNumber] || '');

    if (payload.hard === true) {
      sheet.deleteRow(found.rowNumber);
      appendLog_(user.email, 'delete_hard', recordId, jobNumber, 'Row permanently removed');
      return { deleted: true, hard: true, recordId: recordId };
    }

    sheet.getRange(found.rowNumber, index.Deleted + 1).setValue(true);
    sheet.getRange(found.rowNumber, index.UpdatedAt + 1).setValue(new Date().toISOString());
    sheet.getRange(found.rowNumber, index.UpdatedBy + 1).setValue(user.email);
    appendLog_(user.email, 'delete', recordId, jobNumber, 'Soft deleted');
    return { deleted: true, hard: false, recordId: recordId };
  });
}

/** Free-text search across the index columns. */
function api_searchJobs_(payload, user) {
  var query = String(payload.query || '').trim().toLowerCase();
  var listed = api_listJobs_({ includeDeleted: payload.includeDeleted, limit: payload.limit }, user);
  if (!query) return listed;

  var matches = listed.jobs.filter(function (job) {
    var haystack = [
      job.jobNumber,
      job.jobName,
      job.customerName,
      job.email,
      job.lossAddress,
      job.carrier,
      job.claimNumber
    ].join(' ').toLowerCase();
    return haystack.indexOf(query) !== -1;
  });

  return { jobs: matches, count: matches.length, query: query };
}

/* ---------------------------------------------------------------------------
 * 7. RECORD NORMALISATION  - the round-trip safety net
 * ------------------------------------------------------------------------ */

/**
 * The canonical empty record. Guarantees every key the front-end expects exists
 * with the correct type, which keeps React inputs controlled and prevents
 * "undefined" reaching the UI.
 */
function emptyRecordTemplate_() {
  return {
    recordId: '',
    id: '',
    schemaVersion: DEFAULTS.SCHEMA_VERSION,
    dateCreated: '',
    updatedAt: '',
    status: 'Draft',
    branch: {
      name: '',
      division: '',
      address: '',
      cityStateZip: '',
      phone: '',
      fax: '',
      managerName: '',
      managerEmail: ''
    },
    customer: {
      jobNumber: '',
      jobName: '',
      customerName: '',
      mailingAddress: '',
      mailingCityStateZip: '',
      lossAddress: '',
      lossContact: '',
      mainPhone: '',
      homePhone: '',
      mobilePhone: '',
      email: ''
    },
    insurance: {
      carrier: '',
      primaryAdjuster: '',
      adjusterPhone: '',
      adjusterEmail: '',
      independentAdjuster: '',
      brokerAgent: '',
      agentPhone: '',
      policyNumber: '',
      claimNumber: '',
      reportedBy: 'Insured',
      referredBy: '',
      dateOfLoss: '',
      timeOfLoss: '',
      dateReceived: '',
      timeReceived: '',
      dateInsuredContacted: '',
      timeInsuredContacted: '',
      dateInspected: '',
      typeOfLoss: '',
      typeOfLossSecondary: '',
      roughEstimateAmount: '',
      lossDescription: '',
      specialInstructions: '',
      detailedFindings: ''
    },
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
    team: {
      estimator: 'Russell Shive',
      supervisor: 'Kenny Belford',
      coordinator: 'Rhnea Schinbeckler',
      projectManager: '',
      foreman: 'To be determined',
      marketingPerson: 'Cecilia Rolf',
      accountingPerson: 'Jami Hillock'
    },
    mortgage: {
      hasMortgage: false,
      mortgageCompany: '',
      mortgagePhone: '',
      loanNumber: '',
      last4Ssn: '',
      spouseLast4Ssn: ''
    },
    changeOrder: {
      changeOrderNumber: 'CO-01',
      changeOrderDate: '',
      isInsuranceRelated: true,
      scopeDescription: '',
      originalContractSum: '',
      netPreviousChanges: '',
      changeAmount: '',
      changeType: 'increase',
      addedDays: ''
    },
    checklist: {
      hasDeductibleBeenCollected: 'No',
      deductibleExplanation: '',
      xactimateVersion: 'X1',
      isSelfPay: false,
      isProgramClaim: false,
      hasCheckBeenSent: false,
      checkToWhom: 'Hays + Sons Construction, Inc.',
      checkPayableTo: '',
      isDepreciationWithheld: false,
      depreciationAmount: '',
      startDate: '',
      finishDate: '',
      projectManagerNotes: ''
    }
  };
}

function isPlainObject_(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Merges incoming data over a template. Rules:
 *  - null / undefined never overwrite a template default (so "" wins over null)
 *  - a primitive template slot is never replaced by a nested object (malformed data)
 *  - unknown keys are preserved (forward compatible)
 */
function deepMerge_(base, incoming) {
  for (var key in incoming) {
    if (!incoming.hasOwnProperty(key)) continue;

    var value = incoming[key];
    if (value === null || value === undefined) continue;

    var baseValue = isPlainObject_(base) ? base[key] : undefined;

    if (isPlainObject_(value)) {
      if (isPlainObject_(baseValue)) {
        base[key] = deepMerge_(baseValue, value);
      } else if (baseValue === undefined) {
        base[key] = deepMerge_({}, value);
      }
      // else: template expects a primitive here, so ignore the nested value
    } else if (Array.isArray(value)) {
      base[key] = value.slice();
    } else {
      base[key] = value;
    }
  }
  return base;
}

/**
 * Repairs everything a spreadsheet round-trip can damage, and guarantees the
 * exact shape the front-end expects. Numbers stay numbers, booleans stay
 * booleans, and 'number | empty-string' fields keep blank as blank.
 */
function normalizeRecord_(input) {
  var incoming = JSON.parse(JSON.stringify(input || {}));
  var record = deepMerge_(emptyRecordTemplate_(), incoming);

  // Identity + traceability.
  record.recordId = toStr_(record.recordId) || uuid_();
  record.id = toStr_(record.id) || record.recordId;
  record.schemaVersion = currentSchemaVersion_();
  record.dateCreated = toStr_(record.dateCreated) || today_();
  record.updatedAt = toStr_(record.updatedAt) || new Date().toISOString();

  // number | blank - blank must survive as blank, never become 0.
  for (var n = 0; n < NUMERIC_OR_BLANK_PATHS.length; n++) {
    var path = NUMERIC_OR_BLANK_PATHS[n];
    setPath_(record, path, toNumberOrBlank_(getPath_(record, path)));
  }

  // Always-numeric fields with defaults.
  for (var key in NUMERIC_PATHS) {
    if (NUMERIC_PATHS.hasOwnProperty(key)) {
      var value = getPath_(record, key);
      var num = toNumber_(value, null);
      setPath_(record, key, num === null ? NUMERIC_PATHS[key] : num);
    }
  }

  // Booleans - never trust JS truthiness of the string "FALSE".
  for (var b = 0; b < BOOLEAN_PATHS.length; b++) {
    setPath_(record, BOOLEAN_PATHS[b], toBool_(getPath_(record, BOOLEAN_PATHS[b])));
  }

  // Case-sensitive string unions.
  for (var enumPath in ENUM_PATHS) {
    if (ENUM_PATHS.hasOwnProperty(enumPath)) {
      var spec = ENUM_PATHS[enumPath];
      setPath_(record, enumPath, oneOf_(getPath_(record, enumPath), spec.values, spec.fallback));
    }
  }

  // String slots must never hold a non-string (would break controlled inputs).
  var textValues = [
    record.recordId, record.id, record.dateCreated, record.updatedAt, record.status
  ];
  for (var t = 0; t < textValues.length; t++) {
    if (typeof textValues[t] !== 'string') throw appError_('invalid_record', 'Record metadata must be text.');
  }

  return record;
}

function getPath_(obj, path) {
  var parts = path.split('.');
  var current = obj;
  for (var i = 0; i < parts.length; i++) {
    if (current === null || current === undefined || typeof current !== 'object') return undefined;
    current = current[parts[i]];
  }
  return current;
}

function setPath_(obj, path, value) {
  var parts = path.split('.');
  var current = obj;
  for (var i = 0; i < parts.length - 1; i++) {
    var part = parts[i];
    if (!current[part] || typeof current[part] !== 'object') current[part] = {};
    current = current[part];
  }
  current[parts[parts.length - 1]] = value;
  return obj;
}
