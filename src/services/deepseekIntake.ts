import { callAuthenticatedAppsScript, DatabaseError } from './appsScriptService';
import type { AiIntakePayload } from './intakeParser';

/** Apps Script calls DeepSeek with its server-side key; the uploaded text is the only context. */
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
