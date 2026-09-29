
import React, { useEffect, useState } from 'react';
import { Sparkles, CheckCircle2 } from 'lucide-react';
import { PricingService, CostSummary } from '../services/pricing';

export const CostTracker: React.FC = () => {
  const [costs, setCosts] = useState<CostSummary>({ sessionCost: 0, totalCost: 0, totalTokens: 0, isFreeTier: true });
  const [isOpen, setIsOpen] = useState(false);

  useEffect(() => {
    const unsubscribe = PricingService.subscribe((summary) => {
      setCosts({ ...summary });
    });
    return () => { unsubscribe(); };
  }, []);

  const formatTokens = (num: number) => {
    if (num >= 1_000_000) return `${(num / 1_000_000).toFixed(2)}M`;
    if (num >= 1_000) return `${(num / 1_000).toFixed(1)}k`;
    return num.toString();
  };

  return (
    <div className="fixed bottom-4 left-4 z-50">
      <div 
        className="bg-white/90 backdrop-blur-md border border-emerald-200 shadow-lg rounded-full px-3.5 py-1.5 flex items-center gap-2.5 text-xs font-sans text-slate-700 hover:border-emerald-400 transition-colors cursor-pointer group"
        onClick={() => setIsOpen(!isOpen)}
      >
        <div className="flex items-center gap-1.5 text-emerald-700 font-semibold">
           <CheckCircle2 size={14} className="text-emerald-500" />
           <span>DeepSeek API Usage</span>
        </div>

        <span className="bg-emerald-100 text-emerald-800 text-[10px] font-bold px-2 py-0.5 rounded-full uppercase tracking-wider">
          ${(costs.sessionCost || 0).toFixed(3)} session
        </span>
        
        {isOpen && (
            <div className="flex items-center gap-3 pl-3 border-l border-slate-200 animate-in fade-in slide-in-from-left-2 text-slate-600 font-mono text-[11px]">
                <div className="flex flex-col">
                    <span className="text-[9px] text-slate-400 uppercase tracking-wider">Session Tokens</span>
                    <span>{formatTokens(costs.totalTokens)}</span>
                </div>
                <div className="flex flex-col">
                    <span className="text-[9px] text-emerald-600 uppercase tracking-wider font-semibold">Total Cost</span>
                    <span>${(costs.totalCost || 0).toFixed(3)}</span>
                </div>
            </div>
        )}

        {!isOpen && costs.totalTokens > 0 && (
            <span className="text-[10px] text-emerald-500 animate-pulse">●</span>
        )}
      </div>
    </div>
  );
};
