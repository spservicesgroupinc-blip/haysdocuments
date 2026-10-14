import type { RestorationJobData } from '../types/jobData';
import type { KnowledgeBaseAnalysis } from './customerReference';

export function hasUnresolvedPriceReview(job: RestorationJobData): boolean {
  const review = job.knowledgeBase?.priceReview;
  return Boolean(review && (review.status !== 'resolved' || review.resolvedAmount !== job.financials.totalApprovedRcv));
}

export function assertPriceReviewed(job: RestorationJobData): void {
  if (hasUnresolvedPriceReview(job)) throw new Error('Review the estimate and knowledge-base contract prices in Financials before generating this document.');
}

export const PRICE_DEPENDENT_DOCUMENT_IDS = new Set(['contract', 'change_order', 'checklist', 'production_notes', 'completePacket']);

export function attachKnowledgeBaseAnalysis(job: RestorationJobData, analysis: KnowledgeBaseAnalysis): RestorationJobData {
  const previous = job.knowledgeBase;
  // Later notes without a new amount must not silently clear an unresolved discrepancy.
  const keepPreviousReview = previous?.priceReview && previous.matchedCustomer?.jobNumber === analysis.matchedCustomer?.jobNumber && analysis.estimateTotal === null;
  return { ...job, knowledgeBase: { ...analysis, priceReview: keepPreviousReview ? previous.priceReview : analysis.priceReview } };
}

export function resolveKnowledgeBasePrice(job: RestorationJobData, source: 'estimate' | 'knowledgeBase'): RestorationJobData {
  const knowledgeBase = job.knowledgeBase;
  const review = knowledgeBase?.priceReview;
  if (!review) return job;
  const amount = source === 'estimate' ? review.estimateAmount : review.csvAmount;
  const deductible = typeof job.financials.deductible === 'number' ? job.financials.deductible : 0;
  const round = (value: number) => Math.round(value * 100) / 100;
  return {
    ...job,
    knowledgeBase: { ...knowledgeBase, priceReview: { ...review, status: 'resolved', selectedSource: source, resolvedAmount: amount, resolvedAt: new Date().toISOString() } },
    financials: { ...job.financials, totalApprovedRcv: amount, netClaimValue: round(Math.max(0, amount - deductible)), downPayment: round(amount * 0.5), midProgressPayment: round(amount * 0.25), balancePayment: round(amount * 0.25) },
  };
}
