import React, { useState } from 'react';
import { FileText, Trash2, X, NotebookPen, Pencil, AlertCircle, Image as ImageIcon, Mic, Info } from 'lucide-react';
import { Source, SourceType } from '../types';

interface SourceInputProps {
  sources: Source[];
  onUpdate: (sources: Source[]) => void;
}

// Helper for ID generation (fallback for non-secure contexts)
const generateId = () => {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  return Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);
};

export const SourceInput: React.FC<SourceInputProps> = ({ sources, onUpdate }) => {
  const [noteText, setNoteText] = useState('');
  const [isAddingNote, setIsAddingNote] = useState(false);
  const [editingSourceId, setEditingSourceId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const handleSaveNote = () => {
    if (!noteText.trim()) return;

    if (editingSourceId) {
      // Update existing source (Text note or a legacy audio transcript)
      onUpdate(sources.map(s => {
        if (s.id !== editingSourceId) return s;

        if (s.type === SourceType.AUDIO) {
          return {
            ...s,
            transcription: noteText,
            name: s.name.includes('(Edited)') ? s.name : `${s.name} (Edited)`
          };
        }

        return {
          ...s,
          content: noteText,
          name: s.name.includes('(Edited)') ? s.name : `${s.name} (Edited)`
        };
      }));
    } else {
      const newSource: Source = {
        id: generateId(),
        type: SourceType.TEXT,
        name: `Text Note - ${new Date().toLocaleDateString()}`,
        content: noteText,
        isProcessing: false,
      };
      onUpdate([...sources, newSource]);
    }

    setNoteText('');
    setEditingSourceId(null);
    setIsAddingNote(false);
  };

  const startEditingNote = (source: Source) => {
    setError(null);
    const contentToEdit = source.type === SourceType.TEXT ? source.content : (source.transcription || '');
    setNoteText(contentToEdit);
    setEditingSourceId(source.id);
    setIsAddingNote(true);
  };

  const removeSource = (id: string) => {
    onUpdate(sources.filter(s => s.id !== id));
  };

  return (
    <div className="space-y-8">
      {/* Action Bar */}
      <div className="grid grid-cols-1 gap-4">
        <button
          onClick={() => {
            setError(null);
            setEditingSourceId(null);
            setNoteText('');
            setIsAddingNote(true);
          }}
          className="bg-white border-2 border-slate-100 hover:border-emerald-200 hover:bg-emerald-50/30 text-slate-800 px-4 py-5 rounded-xl flex flex-row items-center justify-center gap-3 transition-all group"
        >
          <div className="bg-emerald-50 p-2.5 rounded-full group-hover:bg-emerald-100 transition-colors">
            <NotebookPen className="w-6 h-6 text-emerald-600" />
          </div>
          <span className="font-bold text-sm text-slate-700 group-hover:text-emerald-800">Write Note</span>
        </button>
      </div>

      {/* Provider limitation notice */}
      <div className="bg-blue-50 border border-blue-100 text-blue-800 px-4 py-3 rounded-lg flex items-start gap-3">
        <Info className="w-5 h-5 shrink-0 mt-0.5" />
        <p className="text-sm leading-relaxed">
          DeepSeek is a text-only model, so audio recordings and image references can no longer be added.
          Paste or type your notes below instead — existing audio transcripts and images in older projects are still kept and used.
        </p>
      </div>

      {/* Error Message */}
      {error && (
        <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-lg flex items-start gap-3 animate-in slide-in-from-top-2">
           <AlertCircle className="w-5 h-5 shrink-0 mt-0.5" />
           <div>
             <h4 className="font-bold text-sm">Action Failed</h4>
             <p className="text-sm">{error}</p>
           </div>
           <button onClick={() => setError(null)} className="ml-auto text-red-400 hover:text-red-700"><X size={16} /></button>
        </div>
      )}

      {/* Note Input Area */}
      {isAddingNote && (
        <div className="bg-white p-6 rounded-xl border-2 border-blue-100 shadow-xl animate-in fade-in slide-in-from-top-2 relative z-10">
          <div className="flex justify-between items-center mb-4 border-b border-slate-100 pb-4">
             <div className="flex items-center gap-2">
                <div className="p-1.5 bg-emerald-100 rounded text-emerald-700"><NotebookPen size={16}/></div>
                <h3 className="font-bold text-slate-800">{editingSourceId ? 'Edit Material' : 'New Text Note'}</h3>
             </div>
             <button onClick={() => setIsAddingNote(false)} className="text-slate-400 hover:text-slate-600 bg-slate-50 p-1 rounded-full hover:bg-slate-100 transition-colors">
               <X size={18} />
             </button>
          </div>
          <textarea
            className="w-full p-4 bg-slate-50 text-slate-900 border-0 rounded-lg focus:ring-2 focus:ring-blue-200 focus:bg-white outline-none min-h-[200px] placeholder-slate-400 font-serif leading-relaxed resize-y text-lg"
            placeholder="Start typing your story, thoughts, or outline ideas here..."
            value={noteText}
            onChange={(e) => setNoteText(e.target.value)}
            autoFocus
          />
          <div className="flex justify-end gap-3 mt-6">
            <button
              onClick={() => setIsAddingNote(false)}
              className="px-5 py-2.5 text-slate-600 hover:bg-slate-100 rounded-lg text-sm font-medium transition-colors"
            >
              Discard
            </button>
            <button
              onClick={handleSaveNote}
              className="px-6 py-2.5 bg-blue-600 text-white hover:bg-blue-500 rounded-lg text-sm font-bold shadow-md shadow-blue-200 transition-all"
            >
              {editingSourceId ? 'Update Material' : 'Save Note'}
            </button>
          </div>
        </div>
      )}

      {/* Source List */}
      <div>
        <div className="flex items-center justify-between mb-6 border-b border-slate-200 pb-2">
            <h3 className="text-xs font-bold text-slate-400 uppercase tracking-widest">Added Materials ({sources.length})</h3>
        </div>

        {sources.length === 0 && (
          <div className="text-center py-12 border-2 border-dashed border-slate-200 rounded-xl bg-slate-50/50">
            <p className="text-slate-400 font-medium text-sm">No materials added yet.</p>
          </div>
        )}

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {sources.map(source => (
            <div key={source.id} className="bg-white p-4 rounded-xl border border-slate-200 flex items-start gap-4 group hover:border-blue-200 hover:shadow-md transition-all relative overflow-hidden">
              <div className={`p-3 rounded-lg shrink-0 ${
                source.type === SourceType.AUDIO ? 'bg-red-50 text-red-500' :
                source.type === SourceType.IMAGE ? 'bg-purple-50 text-purple-500' :
                'bg-emerald-50 text-emerald-500'
              }`}>
                {source.type === SourceType.AUDIO && <Mic size={20} />}
                {source.type === SourceType.TEXT && <FileText size={20} />}
                {source.type === SourceType.IMAGE && <ImageIcon size={20} />}
              </div>

              <div className="flex-1 min-w-0 z-10">
                <div className="flex justify-between items-start mb-1">
                  <h4 className="font-bold text-slate-900 truncate text-sm">{source.name}</h4>
                  <div className="flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                    {source.type !== SourceType.IMAGE && (
                      <button
                        onClick={() => startEditingNote(source)}
                        className="text-slate-300 hover:text-blue-600 hover:bg-blue-50 p-1 rounded-md transition-all"
                        title="Edit Content"
                      >
                        <Pencil size={14} />
                      </button>
                    )}
                    <button
                      onClick={() => removeSource(source.id)}
                      className="text-slate-300 hover:text-red-500 hover:bg-red-50 p-1 rounded-md transition-all"
                      title="Delete"
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>
                </div>

                {source.type === SourceType.AUDIO && (
                  <div className="mt-1">
                    <p className="text-xs text-slate-500 font-serif leading-relaxed line-clamp-3">
                      {source.transcription || "No transcript available."}
                    </p>
                  </div>
                )}

                {source.type === SourceType.TEXT && (
                  <p className="text-xs text-slate-500 line-clamp-3 font-serif leading-relaxed">{source.content}</p>
                )}

                {source.type === SourceType.IMAGE && (
                  <div className="mt-2 h-24 w-full bg-slate-100 rounded-lg overflow-hidden border border-slate-100">
                    <img src={`data:${source.mimeType};base64,${source.content}`} alt="Preview" className="w-full h-full object-cover" />
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};
