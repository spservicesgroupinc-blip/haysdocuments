import { applyAiExtractionToJob, type IntakeParseResult, type AiIntakePayload } from './intakeParser';

export interface CustomerReference {
  customerName: string;
  jobNumber: string;
  contractPrice: number | null;
}

export interface CustomerReferenceSnapshot {
  customers: CustomerReference[];
  fileName: string;
  updatedAt: string;
  updatedBy: string;
}

export const MAX_CUSTOMERS = 5000;
export const MAX_CUSTOMER_CSV_BYTES = 10 * 1024 * 1024;

/** RFC 4180 fields: quoted commas/newlines/escaped quotes must stay in their column. */
function csvRows(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [], field = '', quoted = false, closed = false;
  const pushField = () => { row.push(field.trim()); field = ''; closed = false; };
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (quoted) {
      if (char === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (char === '"') { quoted = false; closed = true; }
      else field += char;
    } else if (char === ',') pushField();
    else if (char === '\r' || char === '\n') {
      pushField(); rows.push(row); row = [];
      if (char === '\r' && text[i + 1] === '\n') i++;
    } else if (char === '"' && !field.trim() && !closed) { field = ''; quoted = true; }
    else if (char === '"' || (closed && char.trim())) throw new Error('Malformed CSV: unexpected character after a quoted field.');
    else field += char;
  }
  if (quoted) throw new Error('Malformed CSV: a quoted field is not closed.');
  if (field || row.length || closed) { pushField(); rows.push(row); }
  return rows.filter(cells => cells.some(cell => cell !== ''));
}

export function parseCustomerCsv(text: string): { customers: CustomerReference[]; priceColumn: string } {
  if (new TextEncoder().encode(text).length > MAX_CUSTOMER_CSV_BYTES) throw new Error('CSV must be 10 MB or smaller.');
  const rows = csvRows(text.replace(/^\uFEFF/, ''));
  const headers = rows.shift() ?? [];
  const normalized = headers.map(header => header.toLowerCase().replace(/[^a-z0-9]/g, ''));
  const column = (aliases: string[]) => {
    const key = aliases.find(alias => normalized.includes(alias));
    if (!key) return -1;
    if (normalized.filter(header => header === key).length > 1) throw new Error('CSV contains duplicate required column headers.');
    return normalized.indexOf(key);
  };
  const name = column(['customername', 'customer']);
  const job = column(['jobnumber', 'jobno', 'job']);
  const price = column(['contractprice', 'contractamount', 'contractsum', 'estimateamount']);
  if ([name, job, price].some(index => index < 0)) throw new Error('CSV needs Customer (or Customer Name), Job Number, and Contract Price (or Estimate Amount) columns.');
  if (!rows.length) throw new Error('CSV contains no customers. The shared list has not been changed.');
  if (rows.length > MAX_CUSTOMERS) throw new Error(`CSV may contain at most ${MAX_CUSTOMERS.toLocaleString()} customers.`);
  const seen = new Set<string>();
  const customers = rows.map((cells, index) => {
    const rowNumber = index + 2;
    if (cells.length !== headers.length) throw new Error(`Row ${rowNumber}: column count does not match the header.`);
    const customerName = cells[name], jobNumber = cells[job];
    if (!customerName || !jobNumber) throw new Error(`Row ${rowNumber}: customer name and job number are required.`);
    if (customerName.length > 300 || jobNumber.length > 100) throw new Error(`Row ${rowNumber}: customer name or job number is too long.`);
    const key = jobNumber.toUpperCase();
    if (seen.has(key)) throw new Error(`Row ${rowNumber}: duplicate job number ${jobNumber}.`);
    seen.add(key);
    const money = cells[price];
    if (money && !/^\$?\s*(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d{1,2})?$/.test(money)) throw new Error(`Row ${rowNumber}: invalid contract price.`);
    const amount = money ? Number(money.replace(/[$,\s]/g, '')) : null;
    if (amount !== null && (!Number.isFinite(amount) || amount > 1e12)) throw new Error(`Row ${rowNumber}: invalid contract price.`);
    return { customerName, jobNumber, contractPrice: amount };
  });
  return { customers, priceColumn: headers[price] };
}

const words = (value: string) => value.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
const nameKey = (value: string) => words(value).split(' ').sort().join(' ');
const escapeRegex = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function findCustomerReferences(rawText: string, customers: CustomerReference[], identity?: { jobNumber?: string; customerName?: string }): CustomerReference[] {
  const jobMatches = customers.filter(customer => new RegExp(`(^|[^a-z0-9-])${escapeRegex(customer.jobNumber)}(?=$|[^a-z0-9-])`, 'i').test(rawText));
  if (jobMatches.length) return jobMatches;
  if (identity?.jobNumber?.trim()) return customers.filter(customer => customer.jobNumber.toUpperCase() === identity.jobNumber!.trim().toUpperCase());
  const source = ` ${words(rawText)} `;
  return customers.filter(customer =>
    (identity?.customerName && nameKey(identity.customerName) === nameKey(customer.customerName))
    || source.includes(` ${words(customer.customerName)} `)
    || (words(customer.customerName).split(' ').length === 2 && source.includes(` ${words(customer.customerName).split(' ').reverse().join(' ')} `)));
}

/** Reference values only fill gaps; document/manual values keep precedence. */
export function enrichIntakeWithReference(result: IntakeParseResult, rawText: string, customers: CustomerReference[]): IntakeParseResult {
  const identity = { ...result.jobData.customer };
  // A new workspace has an automatically generated number, not an extracted identity.
  if (result.provenance.jobNumber?.source !== 'EXTRACTED') identity.jobNumber = '';
  const matches = findCustomerReferences(rawText, customers, identity);
  if (matches.length > 1) {
    result.extractionSummary.warnings.push('Customer reference matches multiple jobs. Add the exact job number before using a contract price.');
    return result;
  }
  if (!matches.length) return result;
  const match = matches[0];
  const job = result.jobData;
  const keepJobNumber = Boolean(job.customer.jobNumber) && !/^FW-\d{4}-\d{4}$/.test(job.customer.jobNumber);
  const price = job.financials.totalApprovedRcv;
  if (typeof price === 'number' && match.contractPrice !== null && price !== match.contractPrice) {
    result.extractionSummary.warnings.push(`Contract price differs from the current customer CSV for ${match.jobNumber}. Kept the document/workspace amount; review Financials.`);
  }
  if (job.customer.customerName && nameKey(job.customer.customerName) !== nameKey(match.customerName)) {
    result.extractionSummary.warnings.push(`Customer name differs from the current customer CSV for ${match.jobNumber}. Review Customer & Property.`);
  }
  const payload: AiIntakePayload = {
    customer: { customerName: job.customer.customerName ? '' : match.customerName, jobNumber: keepJobNumber ? '' : match.jobNumber },
    financials: { totalApprovedRcv: price === '' ? match.contractPrice : null },
    insurance: {}, team: {}, mortgage: {}, changeOrder: {}, productionNotes: {}, checklist: {},
  };
  const supplement = applyAiExtractionToJob(payload, job);
  for (const key of ['customerName', 'jobNumber', 'totalApprovedRcv']) {
    if (supplement.provenance[key]?.source === 'EXTRACTED') {
      supplement.provenance[key] = { source: 'FOUND', detail: `Current customer CSV: ${match.jobNumber}` };
      for (const section of supplement.extractionSummary.sections) for (const field of section.fields) if (field.key === key) field.source = 'FOUND';
    }
  }
  return {
    ...result, jobData: supplement.jobData, blockingMissingFields: supplement.blockingMissingFields,
    provenance: { ...result.provenance, ...supplement.provenance },
    extractionSummary: {
      ...result.extractionSummary,
      fieldsExtractedCount: result.extractionSummary.fieldsExtractedCount + supplement.extractionSummary.fieldsExtractedCount,
      fieldsUpdatedCount: result.extractionSummary.fieldsUpdatedCount + supplement.extractionSummary.fieldsUpdatedCount,
      sections: [...new Set([...result.extractionSummary.sections, ...supplement.extractionSummary.sections].map(section => section.section))].map(key => ({
        section: key,
        label: (result.extractionSummary.sections.find(section => section.section === key) ?? supplement.extractionSummary.sections.find(section => section.section === key)!).label,
        fields: [...(result.extractionSummary.sections.find(section => section.section === key)?.fields ?? []), ...(supplement.extractionSummary.sections.find(section => section.section === key)?.fields ?? [])],
      })),
      warnings: [...result.extractionSummary.warnings, `Customer reference matched ${match.jobNumber}. Missing customer and contract fields filled from the current CSV.`],
    },
  };
}
