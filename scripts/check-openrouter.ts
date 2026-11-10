/** Live check of the actual Apps Script request and client autofill, with synthetic data only. */
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { config } from 'dotenv';
import { loadAppsScriptSource } from './appsscript-source';
import { applyAiExtractionToJob } from '../src/services/intakeParser';
import { createEmptyJob } from '../src/types/jobData';

config({ path: '.env.openrouter.local', quiet: true });
const key = process.env.OPENROUTER_API_KEY?.trim();
if (!key) throw new Error('Set OPENROUTER_API_KEY in .env.openrouter.local or the shell environment.');

const rawText = [
  'SYNTHETIC TEST DOCUMENT - fictional customer, not real customer data.',
  'Customer Name: Morgan Example',
  'Loss Property Address: 123 Example Lane, Fort Wayne, IN 46802',
  'Insurance Carrier: Travelers',
  'Claim Number: TEST-OR-2468',
  'Total Approved RCV: $12,000.00',
  'Deductible: $1,000.00',
  'Loss Description: A supply line burst damaged the kitchen floor.',
].join('\n');

async function main() {
  let request: { url: string; options: { headers: Record<string, string>; payload: string } } | undefined;
  const sandbox: any = {
    PropertiesService: { getScriptProperties: () => ({ getProperty: (name: string) => name === 'OPENROUTER_API_KEY' ? key : null }) },
    Utilities: { newBlob: (value: string) => ({ getBytes: () => Buffer.from(value) }) },
    UrlFetchApp: { fetch: (url: string, options: any) => {
      request = { url, options };
      return { getResponseCode: () => 200, getContentText: () => '{"choices":[{"finish_reason":"stop","message":{"content":"{}"}}]}' };
    } },
  };
  vm.createContext(sandbox);
  vm.runInContext(loadAppsScriptSource(), sandbox);
  sandbox.analyzeIntake_({ rawText });
  assert.ok(request);
  const response = await fetch(request.url, {
    method: 'POST', headers: { ...request.options.headers, 'Content-Type': 'application/json' },
    body: request.options.payload, signal: AbortSignal.timeout(60000),
  });
  const body = await response.text();
  // Pass the real response through the backend's normal validation and error handling.
  sandbox.UrlFetchApp.fetch = () => ({ getResponseCode: () => response.status, getContentText: () => body });
  const payload = sandbox.analyzeIntake_({ rawText });
  const existing = createEmptyJob();
  existing.insurance.specialInstructions = 'Keep these manually entered instructions.';
  const result = applyAiExtractionToJob(payload, existing);
  assert.equal(result.jobData.customer.customerName, 'Morgan Example');
  assert.match(result.jobData.customer.lossAddress, /123 Example Lane/);
  assert.equal(result.jobData.insurance.claimNumber, 'TEST-OR-2468');
  assert.equal(result.jobData.insurance.carrier, 'Travelers');
  assert.equal(result.jobData.financials.totalApprovedRcv, 12000);
  assert.equal(result.jobData.financials.deductible, 1000);
  assert.equal(result.jobData.insurance.specialInstructions, existing.insurance.specialInstructions);
  const usage = JSON.parse(body).usage;
  assert.equal(usage?.cost, 0, 'The live check must report zero cost.');
  console.log(`OpenRouter extraction and job autofill passed. ${result.extractionSummary.fieldsExtractedCount} fields extracted; reported cost: $0.`);
}

main().catch((error: unknown) => {
  // Never print upstream bodies, request objects, keys, or customer data.
  const message = error instanceof Error ? error.message : 'Unknown failure';
  console.error(message.replaceAll(key!, '[redacted]'));
  process.exitCode = 1;
});
