import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseCustomerCsv, findCustomerReferences, enrichIntakeWithReference } from '../src/services/customerReference';
import { parseRawIntakeText } from '../src/services/intakeParser';
import { createEmptyJob } from '../src/types/jobData';

const customers = [
  { customerName: 'Cox Stan', jobNumber: 'F-26-0239-R', contractPrice: 144614.52 },
  { customerName: 'Cox Stan', jobNumber: 'F-26-0240-R', contractPrice: 12000 },
];
test('DASH CSV handles quoted notes, newlines, escaped quotes, BOM and zero prices', () => {
  assert.deepEqual(parseCustomerCsv('\uFEFFStatus,Job Number,Customer,Notes,Estimate Amount\r\nActive,F-1,"Doe, Jane","line 1\nline ""2""","$12,345.67"\r\nActive,F-2,Zero Price,,0\r\n,,,,\r\n').customers, [
    { jobNumber: 'F-1', customerName: 'Doe, Jane', contractPrice: 12345.67 },
    { jobNumber: 'F-2', customerName: 'Zero Price', contractPrice: 0 },
  ]);
});
test('invalid data fails the entire import instead of deleting good shared data', () => {
  for (const csv of ['Customer,Job Number\nJane,F-1', 'Customer,Job Number,Contract Price\nJane,F-1,bad', 'Customer,Job Number,Contract Price\nJane,F-1,-2', 'Customer,Job Number,Contract Price\nJane,F-1,1\nJohn,F-1,2', 'Customer,Job Number,Contract Price\nJane,F-1,"2', 'Customer,Job Number,Contract Price\n,,']) {
    assert.throws(() => parseCustomerCsv(csv));
  }
});
test('matches exact job numbers, prevents partial numbers and ambiguous names', () => {
  assert.equal(findCustomerReferences('Update F-26-0239-R.', customers).length, 1);
  assert.equal(findCustomerReferences('Update F-26-0239-RM', customers).length, 0);
  assert.equal(findCustomerReferences('Stan Cox update', customers, { customerName: 'Stan Cox' }).length, 2);
  assert.equal(findCustomerReferences('Job F-99', customers, { jobNumber: 'F-99', customerName: 'Cox Stan' }).length, 0);
});
test('reference fills missing fields and computes document payment totals', () => {
  const result = enrichIntakeWithReference(parseRawIntakeText('Job Number: F-26-0239-R'), 'Job Number: F-26-0239-R', customers);
  assert.equal(result.jobData.customer.customerName, 'Cox Stan');
  assert.equal(result.jobData.financials.totalApprovedRcv, 144614.52);
  assert.equal(result.jobData.financials.downPayment, 72307.26);
  assert.equal(result.provenance.totalApprovedRcv.source, 'FOUND');
});
test('name-only intake in a new workspace replaces its generated number with the reference number', () => {
  const raw = 'Customer Name: Cox Stan';
  const result = enrichIntakeWithReference(parseRawIntakeText(raw, createEmptyJob()), raw, [customers[0]]);
  assert.equal(result.jobData.customer.jobNumber, 'F-26-0239-R');
  assert.equal(result.jobData.financials.totalApprovedRcv, 144614.52);
});
test('explicit document price wins with a conflict warning; ambiguity adds no data', () => {
  const raw = 'Job Number: F-26-0239-R\nTotal Approved RCV: $20,000';
  const result = enrichIntakeWithReference(parseRawIntakeText(raw), raw, customers);
  assert.equal(result.jobData.financials.totalApprovedRcv, 20000);
  assert.match(result.extractionSummary.warnings.join(' '), /differs/);
  const ambiguous = enrichIntakeWithReference(parseRawIntakeText('Customer Name: Cox Stan'), 'Customer Name: Cox Stan', customers);
  assert.equal(ambiguous.jobData.financials.totalApprovedRcv, '');
  assert.match(ambiguous.extractionSummary.warnings.join(' '), /multiple/);
});
