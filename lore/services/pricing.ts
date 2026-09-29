
export interface UsageRecord {
  model: string;
  inputTokens: number;
  outputTokens: number;
  cost: number;
  timestamp: number;
  type: 'text' | 'image' | 'audio' | 'search';
}

export interface CostSummary {
  totalCost: number;
  sessionCost: number;
  totalTokens: number;
  isFreeTier: boolean;
}

// Rates in USD per 1M tokens (DeepSeek official pricing)
const RATES: Record<string, { input: number; output: number; type: 'token' | 'image' | 'char' }> = {
  'deepseek-chat': { input: 0.27, output: 1.10, type: 'token' },
  'deepseek-reasoner': { input: 0.55, output: 2.19, type: 'token' }
};

const STORAGE_KEY = 'lore_cost_history';

export const PricingService = {
  sessionCost: 0,
  isFreeTier: false,
  listeners: new Set<(summary: CostSummary) => void>(),

  getHistory(): { totalCost: number; totalTokens: number } {
    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      return stored ? JSON.parse(stored) : { totalCost: 0, totalTokens: 0 };
    } catch {
      return { totalCost: 0, totalTokens: 0 };
    }
  },

  updateStorage(cost: number, tokens: number) {
    const history = this.getHistory();
    history.totalCost += cost;
    history.totalTokens += tokens;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(history));
    return history;
  },

  trackUsage(model: string, inputCount: number, outputCount: number) {
    let cost = 0;
    if (!this.isFreeTier) {
      const rate = RATES[model];
      if (rate) {
        if (rate.type === 'token') {
          cost = (inputCount / 1_000_000 * rate.input) + (outputCount / 1_000_000 * rate.output);
        } else if (rate.type === 'image') {
          cost = inputCount * rate.input;
        } else if (rate.type === 'char') {
          cost = (inputCount / 1_000_000 * rate.input);
        }
      }
    }

    this.sessionCost += cost;
    const history = this.updateStorage(cost, inputCount + outputCount);
    
    this.notify({
      sessionCost: this.sessionCost,
      totalCost: history.totalCost,
      totalTokens: history.totalTokens,
      isFreeTier: this.isFreeTier
    });

    console.log(`[Cost] Model: ${model} | In: ${inputCount} | Out: ${outputCount} | Cost: $${cost.toFixed(5)}`);
  },

  subscribe(callback: (summary: CostSummary) => void) {
    this.listeners.add(callback);
    const history = this.getHistory();
    callback({
      sessionCost: this.sessionCost,
      totalCost: history.totalCost,
      totalTokens: history.totalTokens,
      isFreeTier: this.isFreeTier
    });
    return () => this.listeners.delete(callback);
  },

  notify(summary: CostSummary) {
    this.listeners.forEach(cb => cb(summary));
  }
};
