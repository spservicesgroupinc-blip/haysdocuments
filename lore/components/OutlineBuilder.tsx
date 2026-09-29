
import React, { useState } from 'react';
import { BookOutline, ChapterOutline, LoreVault } from '../types';
import { Sparkles, RefreshCw, Pencil, Check, X, Loader2, Plus, Trash2, BookMarked, UserCheck, Globe, KeyRound } from 'lucide-react';

interface OutlineBuilderProps {
  outline: BookOutline;
  isGenerating: boolean;
  onRegenerate: () => void;
  onUpdateOutline: (outline: BookOutline) => void;
}

export const OutlineBuilder: React.FC<OutlineBuilderProps> = ({ 
  outline, 
  isGenerating, 
  onRegenerate,
  onUpdateOutline
}) => {
  const [editingIndex, setEditingIndex] = useState<number | 'HEADER' | 'LORE' | null>(null);
  const [editData, setEditData] = useState<{title: string, summary: string} | null>(null);
  const [showLoreVault, setShowLoreVault] = useState<boolean>(true);
  const [editLore, setEditLore] = useState<LoreVault | null>(null);

  if (isGenerating) {
    return (
      <div className="flex flex-col items-center justify-center py-32 text-center space-y-8">
        <Loader2 className="w-12 h-12 text-blue-600 animate-spin" />
        <div>
           <h3 className="text-2xl font-serif font-bold text-blue-950">Structuring Manuscript...</h3>
           <p className="text-slate-500 mt-2 max-w-md mx-auto font-medium">
             Analyzing themes, narrative arcs, characters, and key events from your materials.
           </p>
        </div>
      </div>
    );
  }

  const startEditing = (index: number | 'HEADER', currentTitle: string, currentSummary: string) => {
    setEditingIndex(index);
    setEditData({ title: currentTitle, summary: currentSummary });
  };

  const cancelEditing = () => {
    setEditingIndex(null);
    setEditData(null);
    setEditLore(null);
  };

  const saveHeader = () => {
    if (!editData) return;
    onUpdateOutline({
      ...outline,
      title: editData.title,
      description: editData.summary
    });
    setEditingIndex(null);
  };

  const saveLoreVault = () => {
    if (!editLore) return;
    onUpdateOutline({
      ...outline,
      loreVault: editLore,
      loreBible: editLore
    });
    setEditingIndex(null);
    setEditLore(null);
  };

  const saveChapter = (index: number) => {
    if (!editData) return;
    const newChapters = [...outline.chapters];
    newChapters[index] = {
      ...newChapters[index],
      title: editData.title,
      summary: editData.summary
    };
    onUpdateOutline({
      ...outline,
      chapters: newChapters
    });
    setEditingIndex(null);
  };

  const addChapter = () => {
    const maxNum = outline.chapters.reduce((max, c) => Math.max(max, c.chapterNumber), 0);
    const nextNum = maxNum + 1;
    
    const newChapter: ChapterOutline = {
      chapterNumber: nextNum,
      title: "New Chapter",
      summary: "Description of the new chapter..."
    };
    const newChapters = [...outline.chapters, newChapter];
    onUpdateOutline({ ...outline, chapters: newChapters });
    
    startEditing(newChapters.length - 1, newChapter.title, newChapter.summary);
  };

  const deleteChapter = (index: number) => {
    if(!window.confirm("Delete this chapter?")) return;
    
    const newChapters = outline.chapters.filter((_, i) => i !== index);
    let currentNum = 1;
    const reindexed = newChapters.map((c) => {
        if (c.chapterNumber === 0) return c;
        return { ...c, chapterNumber: currentNum++ };
    });
    
    onUpdateOutline({ ...outline, chapters: reindexed });
  };

  return (
    <div className="space-y-16 animate-in fade-in slide-in-from-bottom-4 max-w-4xl mx-auto pb-24">
      {/* Header */}
      <div className="text-center border-b border-slate-200 pb-12 relative group">
        <div className="absolute top-0 left-1/2 -translate-x-1/2 w-24 h-1 bg-blue-600 rounded-full"></div>
        
        <div className="mt-8 mb-6 flex justify-center items-center gap-4">
           <span className="text-xs font-bold tracking-[0.2em] uppercase text-blue-600 bg-blue-50 px-3 py-1 rounded-full">Outline Draft</span>
        </div>

        {editingIndex === 'HEADER' && editData ? (
           <div className="max-w-2xl mx-auto text-left space-y-4 bg-slate-50 p-6 rounded-xl border border-blue-200 shadow-inner">
              <div>
                <label className="text-xs font-bold text-slate-400 uppercase tracking-wider mb-1 block">Book Title</label>
                <input 
                  value={editData.title}
                  onChange={(e) => setEditData({...editData, title: e.target.value})}
                  className="w-full text-3xl font-serif font-bold text-slate-900 bg-white border border-slate-300 rounded-lg px-4 py-2 focus:ring-2 focus:ring-blue-500 focus:border-transparent outline-none"
                />
              </div>
              <div>
                <label className="text-xs font-bold text-slate-400 uppercase tracking-wider mb-1 block">Synopsis</label>
                <textarea 
                  value={editData.summary}
                  onChange={(e) => setEditData({...editData, summary: e.target.value})}
                  rows={4}
                  className="w-full text-lg text-slate-700 bg-white border border-slate-300 rounded-lg px-4 py-2 focus:ring-2 focus:ring-blue-500 focus:border-transparent outline-none font-serif"
                />
              </div>
              <div className="flex justify-end gap-2 pt-2">
                <button onClick={cancelEditing} className="px-4 py-2 text-slate-600 font-bold text-sm hover:bg-slate-200 rounded-lg transition-colors">Cancel</button>
                <button onClick={saveHeader} className="px-4 py-2 bg-blue-600 text-white font-bold text-sm rounded-lg hover:bg-blue-700 transition-colors shadow-sm">Save Changes</button>
              </div>
           </div>
        ) : (
          <div className="relative">
             <h2 className="text-5xl md:text-6xl font-serif font-bold text-blue-950 mb-8 tracking-tight leading-tight px-4">{outline.title}</h2>
             <p className="text-xl text-slate-600 max-w-2xl mx-auto leading-relaxed font-serif italic px-4">
               {outline.description}
             </p>
             <button 
               onClick={() => startEditing('HEADER', outline.title, outline.description)}
               className="absolute top-0 right-0 md:right-10 p-2 text-slate-300 hover:text-blue-600 hover:bg-blue-50 rounded-full transition-all opacity-0 group-hover:opacity-100"
               title="Edit Title & Synopsis"
             >
               <Pencil size={18} />
             </button>
          </div>
        )}

        {/* Cover Image Preview */}
        {outline.coverImage && (
          <div className="mt-8 max-w-xs mx-auto shadow-2xl rounded-lg overflow-hidden border-4 border-white rotate-1 hover:rotate-0 transition-transform duration-500">
            <img src={`data:image/jpeg;base64,${outline.coverImage}`} alt="Book Cover" className="w-full h-auto" />
          </div>
        )}
      </div>

      {/* Story & Lore Vault Card */}
      {(outline.loreVault || outline.loreBible) && (() => {
        const loreVault = outline.loreVault || outline.loreBible!;
        return (
          <div className="bg-slate-50 border border-slate-200 rounded-2xl p-6 shadow-sm">
            <div className="flex items-center justify-between mb-4">
               <div className="flex items-center gap-2">
                  <BookMarked size={20} className="text-blue-600" />
                  <h3 className="font-bold text-slate-900 text-lg">Story & Lore Vault</h3>
                  <span className="text-xs bg-blue-100 text-blue-700 font-bold px-2.5 py-0.5 rounded-full">Auto-Extracted Context</span>
               </div>
               <div className="flex items-center gap-2">
                  <button 
                    onClick={() => setShowLoreVault(!showLoreVault)}
                    className="text-xs font-bold text-slate-500 hover:text-slate-800 underline"
                  >
                    {showLoreVault ? 'Collapse' : 'Expand'}
                  </button>
                  {editingIndex !== 'LORE' && (
                    <button 
                      onClick={() => {
                        setEditingIndex('LORE');
                        setEditLore(JSON.parse(JSON.stringify(loreVault)));
                      }}
                      className="p-1.5 text-slate-400 hover:text-blue-600 hover:bg-white rounded-lg transition-colors"
                      title="Edit Lore Vault"
                    >
                      <Pencil size={16} />
                    </button>
                  )}
               </div>
            </div>

            {editingIndex === 'LORE' && editLore ? (
              <div className="space-y-4 bg-white p-6 rounded-xl border border-blue-200 mt-2">
                <div>
                  <label className="text-xs font-bold text-slate-500 uppercase tracking-wider mb-1 block">World & Setting</label>
                  <textarea 
                    value={editLore.worldAndSetting}
                    onChange={(e) => setEditLore({...editLore, worldAndSetting: e.target.value})}
                    rows={3}
                    className="w-full text-sm bg-slate-50 border border-slate-300 rounded p-2 outline-none focus:ring-1 focus:ring-blue-500"
                  />
                </div>

                <div>
                  <label className="text-xs font-bold text-slate-500 uppercase tracking-wider mb-1 block">Key Terms & Concepts (Comma Separated)</label>
                  <input 
                    value={editLore.keyTermsAndConcepts.join(', ')}
                    onChange={(e) => setEditLore({...editLore, keyTermsAndConcepts: e.target.value.split(',').map(s => s.trim())})}
                    className="w-full text-sm bg-slate-50 border border-slate-300 rounded p-2 outline-none focus:ring-1 focus:ring-blue-500"
                  />
                </div>

                <div>
                  <label className="text-xs font-bold text-slate-500 uppercase tracking-wider mb-1 block">Plot Arcs & Narrative Rules</label>
                  <textarea 
                    value={editLore.plotArcsAndRules}
                    onChange={(e) => setEditLore({...editLore, plotArcsAndRules: e.target.value})}
                    rows={3}
                    className="w-full text-sm bg-slate-50 border border-slate-300 rounded p-2 outline-none focus:ring-1 focus:ring-blue-500"
                  />
                </div>

                <div className="flex justify-end gap-2 pt-2">
                  <button onClick={cancelEditing} className="px-3 py-1.5 text-slate-600 font-bold text-xs hover:bg-slate-100 rounded">Cancel</button>
                  <button onClick={saveLoreVault} className="px-4 py-1.5 bg-blue-600 text-white font-bold text-xs rounded hover:bg-blue-700">Save Lore Vault</button>
                </div>
              </div>
            ) : showLoreVault ? (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mt-2">
                <div className="bg-white p-4 rounded-xl border border-slate-100">
                  <div className="flex items-center gap-1.5 text-slate-700 font-bold text-sm mb-2">
                    <UserCheck size={16} className="text-blue-500" />
                    Key Characters
                  </div>
                  <div className="space-y-2 max-h-48 overflow-y-auto pr-1">
                    {loreVault.characters.map((char, i) => (
                      <div key={i} className="text-xs border-b border-slate-50 pb-1.5 last:border-0">
                        <span className="font-bold text-slate-800">{char.name}</span>
                        {char.role && <span className="text-slate-400 ml-1">({char.role})</span>}:
                        <span className="text-slate-600 ml-1">{char.description}</span>
                      </div>
                    ))}
                  </div>
                </div>

                <div className="space-y-3">
                  <div className="bg-white p-3 rounded-xl border border-slate-100">
                    <div className="flex items-center gap-1.5 text-slate-700 font-bold text-xs mb-1">
                      <Globe size={14} className="text-emerald-500" />
                      World & Setting
                    </div>
                    <p className="text-xs text-slate-600 leading-relaxed">{loreVault.worldAndSetting}</p>
                  </div>

                  <div className="bg-white p-3 rounded-xl border border-slate-100">
                    <div className="flex items-center gap-1.5 text-slate-700 font-bold text-xs mb-1.5">
                      <KeyRound size={14} className="text-purple-500" />
                      Key Terminology & Concepts
                    </div>
                    <div className="flex flex-wrap gap-1">
                      {loreVault.keyTermsAndConcepts.map((term, i) => (
                        <span key={i} className="text-[11px] bg-slate-100 text-slate-700 px-2 py-0.5 rounded font-medium">
                          {term}
                        </span>
                      ))}
                    </div>
                  </div>
                </div>
              </div>
            ) : null}
          </div>
        );
      })()}

      {/* Chapters */}
      <div className="space-y-8 px-6 md:px-0">
        <div className="flex justify-between items-end px-2 border-b border-slate-100 pb-4">
          <h3 className="font-sans text-sm font-bold text-slate-400 uppercase tracking-wider">Table of Contents</h3>
          <button 
            onClick={onRegenerate}
            className="text-xs text-blue-600 hover:text-blue-800 font-bold flex items-center gap-1 px-3 py-1.5 bg-blue-50 hover:bg-blue-100 rounded-md transition-all"
          >
            <RefreshCw size={12} />
            Regenerate Structure
          </button>
        </div>

        <div className="grid gap-10">
          {outline.chapters.map((chapter, idx) => (
            <div key={idx} className={`relative pl-10 md:pl-12 border-l-2 transition-colors py-2 group ${editingIndex === idx ? 'border-blue-500' : 'border-slate-100 hover:border-blue-300'}`}>
              <span className={`absolute -left-[13px] top-2 w-6 h-6 rounded-full border-2 text-xs font-bold flex items-center justify-center font-mono transition-all shadow-sm ${editingIndex === idx ? 'bg-blue-600 border-blue-600 text-white' : 'bg-slate-50 border-slate-200 text-slate-400 group-hover:border-blue-500 group-hover:bg-blue-600 group-hover:text-white'}`}>
                {chapter.chapterNumber === 0 ? 'i' : chapter.chapterNumber}
              </span>
              
              {editingIndex === idx && editData ? (
                 <div className="space-y-4 bg-slate-50 p-6 rounded-xl border border-blue-200 shadow-lg -ml-4 mr-4 md:mr-0 animate-in fade-in zoom-in-95 duration-200">
                    <div>
                      <label className="text-xs font-bold text-slate-400 uppercase tracking-wider mb-1 block">Chapter Title</label>
                      <input 
                        value={editData.title}
                        onChange={(e) => setEditData({...editData, title: e.target.value})}
                        className="w-full text-xl font-serif font-bold text-slate-900 bg-white border border-slate-300 rounded-lg px-3 py-2 focus:ring-2 focus:ring-blue-500 focus:border-transparent outline-none"
                      />
                    </div>
                    <div>
                      <label className="text-xs font-bold text-slate-400 uppercase tracking-wider mb-1 block">Chapter Summary / Plot Points</label>
                      <textarea 
                        value={editData.summary}
                        onChange={(e) => setEditData({...editData, summary: e.target.value})}
                        rows={5}
                        className="w-full text-base text-slate-700 bg-white border border-slate-300 rounded-lg px-3 py-2 focus:ring-2 focus:ring-blue-500 focus:border-transparent outline-none font-serif"
                      />
                    </div>
                    <div className="flex justify-end gap-3 pt-2">
                      <button onClick={cancelEditing} className="px-4 py-2 text-slate-600 font-bold text-xs hover:bg-slate-200 rounded-lg transition-colors flex items-center gap-1">
                        <X size={14} /> Cancel
                      </button>
                      <button onClick={() => saveChapter(idx)} className="px-4 py-2 bg-blue-600 text-white font-bold text-xs rounded-lg hover:bg-blue-700 transition-colors shadow-sm flex items-center gap-1">
                        <Check size={14} /> Save Changes
                      </button>
                    </div>
                 </div>
              ) : (
                <div className="relative pr-10">
                  <h4 className="text-2xl font-bold text-slate-800 font-serif mb-3 group-hover:text-blue-800 transition-colors">
                    {chapter.title}
                  </h4>
                  <p className="text-slate-600 leading-relaxed text-lg">
                    {chapter.summary}
                  </p>
                  
                  <div className="absolute top-0 right-0 flex flex-col gap-2 opacity-0 group-hover:opacity-100 transition-opacity">
                    <button 
                        onClick={() => startEditing(idx, chapter.title, chapter.summary)}
                        className="p-2 text-slate-300 hover:text-blue-600 hover:bg-blue-50 rounded-lg transition-all"
                        title="Edit Chapter"
                    >
                        <Pencil size={18} />
                    </button>
                    <button 
                        onClick={() => deleteChapter(idx)}
                        className="p-2 text-slate-300 hover:text-red-600 hover:bg-red-50 rounded-lg transition-all"
                        title="Delete Chapter"
                    >
                        <Trash2 size={18} />
                    </button>
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>

        {/* Add Chapter Button */}
        <div className="pt-4 flex justify-center">
            <button 
                onClick={addChapter}
                className="flex items-center gap-2 text-slate-500 hover:text-blue-600 font-bold border-2 border-dashed border-slate-200 hover:border-blue-300 px-6 py-3 rounded-xl transition-all hover:bg-blue-50"
            >
                <Plus size={18} />
                Add Chapter
            </button>
        </div>
      </div>
    </div>
  );
};

const LoaderSpinner = () => (
  <div className="relative">
     <div className="w-16 h-16 border-4 border-blue-100 rounded-full"></div>
     <div className="w-16 h-16 border-4 border-blue-600 rounded-full border-t-transparent absolute top-0 left-0 animate-spin"></div>
  </div>
);
