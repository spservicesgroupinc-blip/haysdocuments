/**
 * DeepSeek AI intake analysis.
 *
 * Sends pasted intake text (DASH job logs, carrier assignment emails, Xactimate
 * recaps) or the text extracted from an uploaded PDF to the DeepSeek chat API.
 * The model is asked to READ and UNDERSTAND the document, then return a
 * structured extraction of every Master Job Record field, which the intake
 * engine routes into the correct sections.
 */
import { AiIntakePayload } from './intakeParser';

const DEEPSEEK_URL = 'https://api.deepseek.com/chat/completions';
const MODEL_CHAT = 'deepseek-chat';
const REQUEST_TIMEOUT_MS = 60_000;

/**
 * DeepSeek API key built into the application. Ships with every build so the
 * intake AI works out of the box with no per-user key entry. (Any value
 * embedded in a client-side bundle is visible to end users - keep this key's
 * account usage limits in mind.)
 */
const EMBEDDED_API_KEY = 'sk-6a52e74c734c4788a9aea6730257b56a';

const envKey = ((import.meta.env.VITE_DEEPSEEK_API_KEY as string | undefined) || '').trim();

export class DeepseekIntakeError extends Error {
  status?: number;
  constructor(message: string, status?: number) {
    super(message);
    this.name = 'DeepseekIntakeError';
    this.status = status;
  }
}

/* ------------------------------------------------------------------ *
 * API key resolution - the key is built into the application; an
 * environment override (VITE_DEEPSEEK_API_KEY) still takes priority.
 * ------------------------------------------------------------------ */

export function getIntakeApiKey(): string {
  if (envKey) return envKey;
  return EMBEDDED_API_KEY;
}

export function hasIntakeApiKey(): boolean {
  return getIntakeApiKey().length > 0;
}

/* ------------------------------------------------------------------ *
 * Prompt
 * ------------------------------------------------------------------ */

const SYSTEM_PROMPT = `You are the intake analyst for Hays + Sons Complete Restoration, a restoration contractor.
You read raw intake documents - DASH job logs, carrier assignment emails, Xactimate estimate
summaries, field notes, or the text extracted from an uploaded PDF - and convert them into a
structured Master Job Record used to generate restoration contracts, reports, and production packets.

RULES:
1. Extract ONLY facts that are actually stated or clearly implied in the source. Never invent names,
   numbers, dates, or other values. If a fact is not present, leave the field empty.
2. Empty values: "" (empty string) for text/enum fields, null for numbers and booleans.
3. Normalize values:
   - dates -> "YYYY-MM-DD"
   - times -> 24-hour "HH:MM"
   - phones -> "1-XXX-XXX-XXXX" (digits only, normalized)
   - money -> a plain number with no "$" or commas (e.g. 12500.00)
   - "last4Ssn"/"spouseLast4Ssn" -> exactly 4 digits or ""
4. "typeOfLoss" and "typeOfLossSecondary" MUST be one of exactly:
   "Water - Supply Line Burst", "Water - Sewage Backup", "Fire & Smoke Damage",
   "Storm / Wind / Hail", "Vehicle Impact / Structural", "Mold Remediation".
   Map whatever the source describes onto the closest one. Use "" when unknown.
5. "changeType" is "increase" | "decrease" | "unchanged" | "".
6. "hasDeductibleBeenCollected" is "Yes" | "No" | "Pending" | "".
7. Booleans (hasMortgage, isInsuranceRelated, isSelfPay, isProgramClaim, hasCheckBeenSent,
   isDepreciationWithheld) are true / false / null.
8. "hasMortgage" is false when the source says no mortgage / free and clear / paid off.
9. Narrative fields (lossDescription, specialInstructions, detailedFindings, scopeDescription,
   and the productionNotes.* fields) may be concise factual summaries based on the source.
   Draft the productionNotes.* fields only from details the source actually provides.
10. "missingCoreFields" lists the friendly labels of any of these that could NOT be found in the
    source: "Customer Name", "Loss Property Address", "Insurance Carrier", "Claim Number",
    "Total Approved RCV", "Deductible".
11. "analysisNotes" is 1-2 sentences describing what the document is and how complete the
    extraction is.

Return ONLY a JSON object (no markdown fences, no commentary) with EXACTLY this shape - every key
must be present:
{
  "customer": {
    "jobNumber": "", "jobName": "", "customerName": "", "mailingAddress": "",
    "mailingCityStateZip": "", "lossAddress": "", "lossContact": "", "mainPhone": "",
    "homePhone": "", "mobilePhone": "", "email": ""
  },
  "insurance": {
    "carrier": "", "primaryAdjuster": "", "adjusterPhone": "", "adjusterEmail": "",
    "independentAdjuster": "", "brokerAgent": "", "agentPhone": "", "policyNumber": "",
    "claimNumber": "", "reportedBy": "", "referredBy": "", "dateOfLoss": "", "timeOfLoss": "",
    "dateReceived": "", "timeReceived": "", "dateInsuredContacted": "", "timeInsuredContacted": "",
    "dateInspected": "", "typeOfLoss": "", "typeOfLossSecondary": "", "roughEstimateAmount": null,
    "lossDescription": "", "specialInstructions": "", "detailedFindings": ""
  },
  "financials": { "totalApprovedRcv": null, "deductible": null },
  "team": {
    "estimator": "", "supervisor": "", "coordinator": "", "projectManager": "",
    "foreman": "", "marketingPerson": "", "accountingPerson": ""
  },
  "mortgage": {
    "hasMortgage": null, "mortgageCompany": "", "mortgagePhone": "", "loanNumber": "",
    "last4Ssn": "", "spouseLast4Ssn": ""
  },
  "changeOrder": {
    "changeOrderNumber": "", "changeOrderDate": "", "isInsuranceRelated": null,
    "scopeDescription": "", "originalContractSum": null, "netPreviousChanges": null,
    "changeAmount": null, "changeType": "", "addedDays": null
  },
  "productionNotes": {
    "scopeSummary": "", "materialsAndEquipment": "", "scheduleAndAccess": "",
    "safetyConsiderations": "", "communicationNotes": "", "additionalNotes": ""
  },
  "checklist": {
    "hasDeductibleBeenCollected": "", "deductibleExplanation": "", "xactimateVersion": "",
    "isSelfPay": null, "isProgramClaim": null, "hasCheckBeenSent": null, "checkToWhom": "",
    "checkPayableTo": "", "isDepreciationWithheld": null, "depreciationAmount": null,
    "startDate": "", "finishDate": "", "projectManagerNotes": ""
  },
  "missingCoreFields": [],
  "analysisNotes": ""
}`;

/* ------------------------------------------------------------------ *
 * HTTP layer
 * ------------------------------------------------------------------ */

interface ChatMessage {
  role: 'system' | 'user';
  content: string;
}

async function chatOnce(messages: ChatMessage[]): Promise<string> {
  const apiKey = getIntakeApiKey();
  if (!apiKey) {
    throw new DeepseekIntakeError(
      'No DeepSeek API key configured - add one under the intake panel or set VITE_DEEPSEEK_API_KEY.',
      401
    );
  }

  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(DEEPSEEK_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: MODEL_CHAT,
        messages,
        stream: false,
        temperature: 0.1,
        max_tokens: 6000,
        response_format: { type: 'json_object' },
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      let detail = '';
      try {
        const errorJson = (await response.json()) as { error?: { message?: string } };
        detail = errorJson?.error?.message || '';
      } catch {
        /* non-JSON error body - fall through without detail */
      }
      throw new DeepseekIntakeError(
        `DeepSeek API error (${response.status})${detail ? `: ${detail}` : ''}`,
        response.status
      );
    }

    const data = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> };
    const content = data?.choices?.[0]?.message?.content;
    if (typeof content !== 'string' || !content.trim()) {
      throw new DeepseekIntakeError('DeepSeek returned an empty response.', 0);
    }
    return content;
  } catch (error) {
    if (error instanceof DeepseekIntakeError) throw error;
    if (error instanceof DOMException && error.name === 'AbortError') {
      throw new DeepseekIntakeError('DeepSeek analysis timed out - please try again.', 0);
    }
    throw new DeepseekIntakeError(
      `Could not reach DeepSeek: ${error instanceof Error ? error.message : String(error)}`,
      0
    );
  } finally {
    window.clearTimeout(timeout);
  }
}

const delay = (ms: number) => new Promise<void>((resolve) => window.setTimeout(resolve, ms));

/** One retry for transient failures (network hiccups, 429, 5xx). */
async function chatWithRetry(messages: ChatMessage[]): Promise<string> {
  try {
    return await chatOnce(messages);
  } catch (error) {
    const status = error instanceof DeepseekIntakeError ? (error.status ?? 0) : 0;
    const retryable = status === 0 || status === 429 || status >= 500;
    if (!retryable) throw error;
    await delay(700);
    return await chatOnce(messages);
  }
}

/* ------------------------------------------------------------------ *
 * Response handling
 * ------------------------------------------------------------------ */

function parseJsonContent(content: string): unknown {
  const trimmed = content.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    /* fall through to unboxing */
  }
  const unboxed = trimmed.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  try {
    return JSON.parse(unboxed);
  } catch {
    /* fall through to substring extraction */
  }
  const start = unboxed.indexOf('{');
  const end = unboxed.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try {
      return JSON.parse(unboxed.slice(start, end + 1));
    } catch {
      /* handled below */
    }
  }
  throw new DeepseekIntakeError('DeepSeek returned a response that is not valid JSON.', 0);
}

function sanitizeAiPayload(raw: Record<string, unknown>): AiIntakePayload {
  const take = (key: string): Record<string, unknown> => {
    const value = raw[key];
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      return value as Record<string, unknown>;
    }
    return {};
  };
  return {
    customer: take('customer'),
    insurance: take('insurance'),
    financials: take('financials'),
    team: take('team'),
    mortgage: take('mortgage'),
    changeOrder: take('changeOrder'),
    productionNotes: take('productionNotes'),
    checklist: take('checklist'),
    missingCoreFields: Array.isArray(raw.missingCoreFields)
      ? raw.missingCoreFields.filter((item): item is string => typeof item === 'string')
      : [],
    analysisNotes: typeof raw.analysisNotes === 'string' ? raw.analysisNotes.trim() : '',
  };
}

/* ------------------------------------------------------------------ *
 * Public entry point
 * ------------------------------------------------------------------ */

/**
 * Sends the raw intake text to DeepSeek and returns a structured extraction
 * of every Master Job Record field the AI could understand from the document.
 * Throws DeepseekIntakeError on auth/billing/network/JSON problems so the
 * caller can fall back to the built-in rules parser.
 */
export async function analyzeIntakeWithAi(rawText: string): Promise<AiIntakePayload> {
  if (!rawText.trim()) {
    throw new DeepseekIntakeError('No intake text to analyze.', 0);
  }
  const content = await chatWithRetry([
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: `INTAKE DOCUMENT:\n${rawText}` },
  ]);
  const parsed = parseJsonContent(content);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new DeepseekIntakeError('DeepSeek returned an unexpected JSON structure.', 0);
  }
  return sanitizeAiPayload(parsed as Record<string, unknown>);
}
