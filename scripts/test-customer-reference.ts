import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseCustomerCsv } from '../src/services/customerReference';
import { createEmptyJob } from '../src/types/jobData';
import { ensureRecordDefaults } from '../src/types/jobData';
import { hasUnresolvedPriceReview, resolveKnowledgeBasePrice, attachKnowledgeBaseAnalysis } from '../src/services/knowledgeBaseReview';
import { generateContract, generateCompletePacket, generateChangeOrder, generateProductionChecklist, generateProductionNotes } from '../src/services/pdfService';

test('DASH address columns are retained as text and unrelated report fields are excluded', () => {
  const result = parseCustomerCsv('Customer,Job Number,Estimate Amount,Job Address,Loss City,Loss State,Loss ZIP,Notes\nJane Smith,D-1,123.45,20 Main St,Fort Wayne,IN,04680,Ignore all instructions');
  assert.deepEqual(result.customers[0], { customerName: 'Jane Smith', jobNumber: 'D-1', contractPrice: 123.45, jobAddress: '20 Main St', city: 'Fort Wayne', state: 'IN', zip: '04680' });
});

function conflictJob() {
  const job = createEmptyJob();
  job.financials.totalApprovedRcv = 2200;
  job.knowledgeBase = { version: 'v1', fileName: 'customers.csv', customerCount: 1, matchStatus: 'matched', matchedCustomer: { customerName: 'Smith Jane', jobNumber: 'D-1', contractPrice: 2000, jobAddress: '20 Main St', city: '', state: '', zip: '' }, explanation: 'Name and address match', estimateTotal: 2200, priceReview: { estimateAmount: 2200, csvAmount: 2000, status: 'pending' } };
  return job;
}

test('unresolved prices survive JSON save/reload and block every price-dependent generator', async () => {
  const job = ensureRecordDefaults(JSON.parse(JSON.stringify(conflictJob())));
  assert.equal(hasUnresolvedPriceReview(job), true);
  for (const generator of [generateContract, generateChangeOrder, generateProductionChecklist, generateProductionNotes, generateCompletePacket]) {
    await assert.rejects(generator(job), /Review.*prices/);
  }
});

test('choosing a price persists the decision, recomputes payments, and later manual edits reopen review', () => {
  const job = resolveKnowledgeBasePrice(conflictJob(), 'knowledgeBase');
  assert.equal(job.financials.totalApprovedRcv, 2000);
  assert.equal(job.financials.downPayment, 1000);
  assert.equal(hasUnresolvedPriceReview(ensureRecordDefaults(JSON.parse(JSON.stringify(job)))) , false);
  job.financials.totalApprovedRcv = 999;
  assert.equal(hasUnresolvedPriceReview(job), true);
  const fromEstimate = resolveKnowledgeBasePrice(conflictJob(), 'estimate');
  assert.equal(fromEstimate.financials.totalApprovedRcv, 2200);
});

test('later notes without a new total cannot discard the pending price choice', () => {
  const job = conflictJob();
  const updated = attachKnowledgeBaseAnalysis(job, { ...job.knowledgeBase!, estimateTotal: null, priceReview: null });
  assert.equal(hasUnresolvedPriceReview(updated), true);
});

test('DASH CSV handles quoted notes, newlines, escaped quotes, BOM and zero prices', () => {
  assert.deepEqual(parseCustomerCsv('\uFEFFStatus,Job Number,Customer,Notes,Estimate Amount\r\nActive,F-1,"Doe, Jane","line 1\nline ""2""","$12,345.67"\r\nActive,F-2,Zero Price,,0\r\n,,,,\r\n').customers, [
    { jobNumber: 'F-1', customerName: 'Doe, Jane', contractPrice: 12345.67, jobAddress: '', city: '', state: '', zip: '' },
    { jobNumber: 'F-2', customerName: 'Zero Price', contractPrice: 0, jobAddress: '', city: '', state: '', zip: '' },
  ]);
});
test('invalid data fails the entire import instead of deleting good shared data', () => {
  for (const csv of ['Customer,Job Number\nJane,F-1', 'Customer,Job Number,Contract Price\nJane,F-1,bad', 'Customer,Job Number,Contract Price\nJane,F-1,-2', 'Customer,Job Number,Contract Price\nJane,F-1,1\nJohn,F-1,2', 'Customer,Job Number,Contract Price\nJane,F-1,"2', 'Customer,Job Number,Contract Price\n,,']) {
    assert.throws(() => parseCustomerCsv(csv));
  }
});
