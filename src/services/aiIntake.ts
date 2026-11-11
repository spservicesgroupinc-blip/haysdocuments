import { callAuthenticatedAppsScript, DatabaseError } from './appsScriptService';
import type { AiIntakePayload } from './intakeParser';

/** Apps Script calls OpenRouter's free router with its server-side key and only the uploaded text. */
export async function analyzeIntakeWithAi(rawText: string): Promise<AiIntakePayload> {
  if (!rawText.trim()) throw new Error('No intake text to analyze.');
  try {
    return await callAuthenticatedAppsScript<AiIntakePayload>('analyzeIntake', { rawText }, 60000);
  } catch (error) {
    if (error instanceof DatabaseError && error.code === 'unknown_action') {
      throw new Error('Deploy the latest Apps Script backend to enable AI intake analysis.');
    }
    throw error;
  }
}
