
import React from 'react';
import { AlertCircle, CheckCircle2, X } from 'lucide-react';

interface NotificationProps {
  message: string;
  type: 'error' | 'success';
  onClose: () => void;
}

export const Notification: React.FC<NotificationProps> = ({ message, type, onClose }) => {
  return (
    <div className="fixed top-4 right-4 z-[200] animate-in slide-in-from-top-2 fade-in">
      <div className={`flex items-center gap-3 px-4 py-3 rounded-xl shadow-lg border ${
        type === 'error' ? 'bg-red-50 border-red-200 text-red-800' : 'bg-emerald-50 border-emerald-200 text-emerald-800'
      }`}>
        {type === 'error' ? <AlertCircle size={20} /> : <CheckCircle2 size={20} />}
        <p className="font-medium text-sm">{message}</p>
        <button onClick={onClose} className="p-1 hover:bg-black/5 rounded-full ml-2">
          <X size={16} />
        </button>
      </div>
    </div>
  );
};
