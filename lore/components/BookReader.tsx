
import React, { useState, useEffect } from 'react';
import { ChapterContent, BookOutline, User } from '../types';
import { ChevronLeft, ChevronRight, Loader2, Download, PenLine, Save, FileText, Wand2, Menu, X } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import { refineChapterText } from '../services/deepseek';
import { Notification } from './Notification';
import { CloudService } from '../services/cloud';

// Declare html2pdf globally as it's loaded via CDN in index.html
declare var html2pdf: any;

interface BookReaderProps {
  outline: BookOutline;
  chapters: ChapterContent[];
  onChapterUpdate?: (chapter: ChapterContent) => void;
  user?: User;
}

export const BookReader: React.FC<BookReaderProps> = ({ 
  outline, 
  chapters, 
  onChapterUpdate, 
  user
}) => {
  const [currentChapterIndex, setCurrentChapterIndex] = useState(0);
  const [isSidebarOpen, setIsSidebarOpen] = useState(true);
  const [isExportingDocs, setIsExportingDocs] = useState(false);
  const [isEditing, setIsEditing] = useState(false);
  const [editContent, setEditContent] = useState('');
  const [polishInstruction, setPolishInstruction] = useState('');
  const [isPolishing, setIsPolishing] = useState(false);
  const [notification, setNotification] = useState<{message: string, type: 'error' | 'success'} | null>(null);
  
  // PDF Generation State: We use a specific mode to render the print layout
  const [isPdfMode, setIsPdfMode] = useState(false);

  const currentChapter = chapters[currentChapterIndex];

  // --- PDF GENERATION LOGIC ---
  useEffect(() => {
    if (!isPdfMode) return;

    let isMounted = true;

    const generate = async () => {
       // Allow DOM to render the PDF root
       await new Promise(r => setTimeout(r, 1000));

       if (!isMounted) return;

       const element = document.getElementById('pdf-root');
       if (!element) {
          showNotification("Could not find PDF content.", 'error');
          setIsPdfMode(false);
          return;
       }

       // A4 width ~ 210mm. With 10mm margins L/R, content is 190mm.
       // At ~96 DPI, 1mm ~ 3.78px. 190mm ~ 718px.
       // We set container to 720px for safety.
       const opt = {
          margin: [10, 10, 10, 10], // mm
          filename: `${outline.title.replace(/[^a-z0-9]/gi, '_').substring(0, 30)}.pdf`,
          image: { type: 'jpeg', quality: 0.95 },
          html2canvas: { 
            scale: 2, 
            useCORS: true, 
            logging: false,
            // Important: Matches the CSS width of pdf-root to prevent overflow
            windowWidth: 900 
          },
          jsPDF: { unit: 'mm', format: 'a4', orientation: 'portrait' },
          pagebreak: { mode: ['css', 'legacy'] }
       };

       try {
         await html2pdf().set(opt).from(element).save();
         showNotification("PDF Downloaded!");
       } catch(e) {
         console.error(e);
         showNotification("PDF Generation Error", 'error');
       } finally {
         if (isMounted) setIsPdfMode(false);
       }
    };

    generate();

    return () => { isMounted = false; };
  }, [isPdfMode]);

  const showNotification = (message: string, type: 'error' | 'success' = 'success') => {
    setNotification({ message, type });
    setTimeout(() => setNotification(null), 4000);
  };

  const handleExportDocs = async () => {
    if (!user) {
        showNotification("Please log in to export to Google Docs.", 'error');
        return;
    }
    setIsExportingDocs(true);
    try {
      const url = await CloudService.exportToDoc(
        user,
        outline.title,
        outline.description,
        chapters.map(c => ({
            chapterNumber: c.chapterNumber,
            title: c.title,
            content: c.content
        }))
      );
      showNotification("Export Successful! Opening Doc...");
      window.open(url, '_blank');
    } catch (e: any) {
      showNotification("Docs export failed: " + e.message, 'error');
    } finally {
      setIsExportingDocs(false);
    }
  };

  const startEditing = () => { setEditContent(currentChapter.content); setIsEditing(true); };
  const saveEditing = () => {
    if (onChapterUpdate) onChapterUpdate({ ...currentChapter, content: editContent });
    setIsEditing(false);
    showNotification("Changes saved.");
  };

  const handlePolish = async () => {
    if (!polishInstruction.trim()) return;
    setIsPolishing(true);
    try {
      const polished = await refineChapterText(editContent, polishInstruction);
      setEditContent(polished);
      setPolishInstruction('');
    } catch (e) {
      showNotification("Polish failed.", 'error');
    } finally {
      setIsPolishing(false);
    }
  };

  return (
    <>
      {notification && (
        <Notification message={notification.message} type={notification.type} onClose={() => setNotification(null)} />
      )}

      {isPdfMode && (
        <div className="fixed inset-0 z-[9999] bg-white overflow-y-auto">
          <div className="fixed top-0 left-0 w-full h-full bg-white/95 flex flex-col items-center justify-center z-[10000]">
             <Loader2 size={64} className="animate-spin text-blue-600 mb-6" />
             <h2 className="text-3xl font-bold text-slate-800 mb-2">Generating PDF</h2>
             <p className="text-slate-500">Rendering book layout...</p>
          </div>

          {/* PDF Rendering Container */}
          <div id="pdf-root" style={{ width: '720px', margin: '0 auto', background: 'white', padding: '40px 60px', minHeight: '100vh', boxSizing: 'border-box' }}>
             <style>{`
               .pdf-text { font-family: 'Georgia', serif; font-size: 13pt; line-height: 1.6; text-align: justify; color: #000; word-wrap: break-word; }
               .pdf-title-page { height: 900px; display: flex; flex-direction: column; align-items: center; justify-content: center; text-align: center; page-break-after: always; }
               .pdf-chapter { page-break-before: always; margin-top: 40px; }
               .pdf-chapter h2 { page-break-after: avoid; }
               h1 { font-size: 42pt; margin-bottom: 20px; font-weight: bold; line-height: 1.1; color: #000; word-wrap: break-word; }
               h2 { font-size: 28pt; margin-bottom: 25px; font-weight: bold; color: #000; }
               p { margin-bottom: 1em; }
               img { max-width: 100%; page-break-inside: avoid; }
             `}</style>

             <div className="pdf-title-page">
                <h1>{outline.title}</h1>
                {outline.coverImage && (
                  <img 
                    src={`data:image/jpeg;base64,${outline.coverImage}`} 
                    style={{ width: '350px', height: 'auto', marginBottom: '40px', boxShadow: '0 4px 12px rgba(0,0,0,0.1)' }} 
                  />
                )}
                <p style={{ fontSize: '18pt', fontStyle: 'italic', maxWidth: '500px' }}>{outline.description}</p>
             </div>

             {chapters.map((chap) => (
               <div key={chap.chapterNumber} className="pdf-chapter">
                  <div style={{textAlign: 'center', marginBottom: '40px'}}>
                     <div style={{fontSize: '14pt', textTransform: 'uppercase', letterSpacing: '2px', marginBottom: '10px', color: '#666'}}>
                        {chap.chapterNumber === 0 ? 'INTRODUCTION' : `CHAPTER ${chap.chapterNumber}`}
                     </div>
                     <h2>{chap.title}</h2>
                  </div>
                  {chap.image && (
                     <div style={{display: 'flex', justifyContent: 'center', marginBottom: '30px'}}>
                        <img src={`data:image/jpeg;base64,${chap.image}`} style={{ maxWidth: '100%', borderRadius: '4px' }} />
                     </div>
                  )}
                  <div className="pdf-text">
                     <ReactMarkdown>{chap.content}</ReactMarkdown>
                  </div>
               </div>
             ))}
          </div>
        </div>
      )}

      <div className="flex flex-col md:flex-row h-[calc(100vh-4rem)] bg-slate-50 relative overflow-hidden">
        
        {/* Sidebar */}
        <div className={`
            flex-col bg-white border-r border-slate-200 flex-shrink-0 transition-all duration-300 z-30
            ${isSidebarOpen ? 'fixed inset-0 w-full flex md:static md:w-80' : 'hidden md:flex md:w-0 md:overflow-hidden'}
        `}>
          <div className="p-6 border-b border-slate-100 flex-shrink-0 flex justify-between items-start bg-slate-50/50">
             <div className="min-w-0 pr-2 flex-1">
               <h3 className="font-bold text-slate-900 font-serif mb-1 truncate">{outline.title}</h3>
               <p className="text-xs text-slate-400 uppercase tracking-widest font-bold">Table of Contents</p>
             </div>
             <button onClick={() => setIsSidebarOpen(false)} className="md:hidden p-1 text-slate-400 hover:text-slate-600"><X size={24} /></button>
          </div>

          <div className="flex-1 overflow-y-auto p-4 space-y-2">
            {chapters.map((chap, idx) => (
              <button
                key={chap.chapterNumber}
                onClick={() => { setCurrentChapterIndex(idx); if(window.innerWidth < 768) setIsSidebarOpen(false); }}
                className={`w-full text-left p-3 rounded-lg text-sm transition-all border group flex items-start gap-3 ${
                  currentChapterIndex === idx ? 'bg-blue-50 border-blue-200 text-blue-800' : 'border-transparent hover:bg-slate-50 text-slate-600'
                }`}
              >
                 <span className={`shrink-0 w-6 h-6 flex items-center justify-center rounded-full text-[10px] font-bold mt-0.5 ${
                    currentChapterIndex === idx ? 'bg-blue-200 text-blue-800' : 'bg-slate-100 text-slate-400 group-hover:bg-slate-200'
                 }`}>
                    {chap.chapterNumber === 0 ? 'i' : chap.chapterNumber}
                 </span>
                 <div>
                    <div className={`font-bold leading-tight ${currentChapterIndex === idx ? 'text-blue-900' : 'text-slate-700'}`}>
                        {chap.title}
                    </div>
                    {chap.isGenerating && (
                        <div className="flex items-center gap-1 text-[10px] text-blue-500 mt-1">
                            <Loader2 size={10} className="animate-spin" /> Writing...
                        </div>
                    )}
                 </div>
              </button>
            ))}
          </div>
        </div>

        {/* Main Content */}
        <div className="flex-1 bg-white relative h-full overflow-hidden flex flex-col">
            {/* Mobile/Desktop Toolbar */}
             <div className="h-14 border-b border-slate-100 flex items-center justify-between px-4 shrink-0 bg-white/80 backdrop-blur-sm z-20">
                <div className="flex items-center gap-2">
                   {!isSidebarOpen && (
                      <button onClick={() => setIsSidebarOpen(true)} className="p-2 text-slate-400 hover:bg-slate-50 rounded-lg">
                         <Menu size={20} />
                      </button>
                   )}
                   <span className="md:hidden font-bold text-slate-800 truncate max-w-[150px]">
                      {currentChapter?.title || "Loading..."}
                   </span>
                </div>
                
                <div className="flex items-center gap-1">
                   {currentChapter && !currentChapter.isGenerating && (
                      <>
                        <button 
                            onClick={() => setIsPdfMode(true)}
                            className="p-2 text-slate-400 hover:text-blue-600 hover:bg-blue-50 rounded-lg transition-colors"
                            title="Download PDF"
                        >
                            <Download size={18} />
                        </button>
                        <button 
                            onClick={handleExportDocs}
                            disabled={isExportingDocs}
                            className="p-2 text-slate-400 hover:text-blue-600 hover:bg-blue-50 rounded-lg transition-colors"
                            title="Export to Google Docs"
                        >
                            {isExportingDocs ? <Loader2 size={18} className="animate-spin" /> : <FileText size={18} />}
                        </button>
                        <button 
                            onClick={() => setIsEditing(!isEditing)}
                            className={`p-2 rounded-lg transition-colors ${isEditing ? 'text-blue-600 bg-blue-50' : 'text-slate-400 hover:text-blue-600 hover:bg-blue-50'}`}
                            title="Edit Mode"
                        >
                            <PenLine size={18} />
                        </button>
                      </>
                   )}
                </div>
             </div>

             {/* Content Area */}
             <div className="flex-1 overflow-y-auto p-6 md:p-12 pb-32">
                {!currentChapter ? (
                  <div className="flex flex-col items-center justify-center h-full py-20 opacity-50">
                     <Loader2 className="animate-spin text-slate-300 mb-4" size={32} />
                     <p className="text-slate-400">Loading Chapter...</p>
                  </div>
                ) : (
                  <div className="max-w-3xl mx-auto animate-in fade-in slide-in-from-bottom-2 duration-500">
                     <div className="mb-8 border-b border-slate-100 pb-8 text-center">
                        <div className="text-xs font-bold text-slate-400 uppercase tracking-[0.2em] mb-3">
                           {currentChapter.chapterNumber === 0 ? 'Introduction' : `Chapter ${currentChapter.chapterNumber}`}
                        </div>
                        <h1 className="text-3xl md:text-4xl font-serif font-bold text-slate-900 leading-tight">
                            {currentChapter.title}
                        </h1>
                     </div>

                     {currentChapter.isGenerating ? (
                        <div className="space-y-6 animate-pulse">
                            <div className="h-4 bg-slate-100 rounded w-full"></div>
                            <div className="h-4 bg-slate-100 rounded w-5/6"></div>
                            <div className="h-4 bg-slate-100 rounded w-full"></div>
                            <div className="h-4 bg-slate-100 rounded w-4/6"></div>
                            <div className="h-4 bg-slate-100 rounded w-5/6"></div>
                            <div className="mt-12 flex items-center justify-center text-blue-600 gap-2 font-medium bg-blue-50 py-3 rounded-lg">
                                <Wand2 size={16} className="animate-bounce" />
                                <span className="animate-pulse">Writing your story...</span>
                            </div>
                        </div>
                     ) : (
                        <>
                           {isEditing ? (
                              <div className="space-y-4">
                                 {/* Edit Toolbar */}
                                 <div className="flex flex-wrap gap-2 items-center bg-slate-50 p-3 rounded-lg border border-slate-200 sticky top-0 z-10">
                                    <div className="flex items-center gap-2 flex-1 min-w-[200px]">
                                       <div className="p-1.5 bg-purple-100 text-purple-600 rounded"><Wand2 size={14} /></div>
                                       <input 
                                         value={polishInstruction}
                                         onChange={(e) => setPolishInstruction(e.target.value)}
                                         placeholder="Instruction: e.g. 'Deepen sensory description' or 'Add dialogue'"
                                         className="flex-1 bg-white border border-slate-200 rounded px-2.5 py-1.5 text-xs focus:ring-1 focus:ring-purple-500 outline-none"
                                       />
                                       <button 
                                          onClick={handlePolish}
                                          disabled={isPolishing}
                                          className="text-xs font-bold bg-purple-600 text-white px-3 py-1.5 rounded hover:bg-purple-700 transition-colors"
                                       >
                                          {isPolishing ? <Loader2 size={12} className="animate-spin" /> : 'Refine'}
                                       </button>
                                    </div>

                                    {/* Action Chips */}
                                    <div className="w-full flex flex-wrap items-center gap-1.5 pt-2 border-t border-slate-200/80 mt-1">
                                       <span className="text-[10px] font-bold text-slate-400 uppercase tracking-wider mr-1">Presets:</span>
                                       {[
                                          { label: "✨ Sensory Details", prompt: "Deepen sensory descriptions with sights, sounds, and physical atmosphere." },
                                          { label: "💬 Character Dialogue", prompt: "Add realistic character dialogue and natural subtext." },
                                          { label: "⚡ Accelerate Pacing", prompt: "Tighten sentences, remove slow exposition, and accelerate pacing." },
                                          { label: "🧹 Strip AI Clichés", prompt: "Strip AI clichés ('testament to', 'tapestry', 'delve') and strengthen active verbs." }
                                       ].map((chip, i) => (
                                          <button
                                             key={i}
                                             type="button"
                                             onClick={async () => {
                                                setPolishInstruction(chip.prompt);
                                                setIsPolishing(true);
                                                try {
                                                  const polished = await refineChapterText(editContent, chip.prompt);
                                                  setEditContent(polished);
                                                  setPolishInstruction('');
                                                } catch (e) {
                                                  showNotification("Polish failed.", 'error');
                                                } finally {
                                                  setIsPolishing(false);
                                                }
                                             }}
                                             disabled={isPolishing}
                                             className="text-[11px] bg-white border border-slate-200 text-slate-600 hover:text-purple-700 hover:border-purple-300 px-2 py-0.5 rounded-full transition-colors font-medium"
                                          >
                                             {chip.label}
                                          </button>
                                       ))}
                                    </div>
                                    <div className="h-6 w-px bg-slate-200 mx-1"></div>
                                    <button onClick={saveEditing} className="flex items-center gap-1 text-xs font-bold bg-blue-600 text-white px-3 py-1.5 rounded hover:bg-blue-700 transition-colors">
                                       <Save size={12} /> Save
                                    </button>
                                 </div>

                                 <textarea 
                                    value={editContent}
                                    onChange={(e) => setEditContent(e.target.value)}
                                    className="w-full h-[60vh] p-6 bg-white border border-slate-200 rounded-lg shadow-inner font-serif text-lg leading-relaxed focus:ring-2 focus:ring-blue-100 focus:border-blue-300 outline-none resize-none"
                                 />
                              </div>
                           ) : (
                              <div className="prose prose-lg prose-slate max-w-none font-serif leading-loose prose-headings:font-sans prose-headings:font-bold prose-p:text-slate-700">
                                 <ReactMarkdown>{currentChapter.content}</ReactMarkdown>
                              </div>
                           )}

                           {!isEditing && (
                              <div className="mt-16 pt-8 border-t border-slate-100 flex justify-between text-slate-400">
                                 <button 
                                   disabled={currentChapterIndex === 0}
                                   onClick={() => setCurrentChapterIndex(prev => prev - 1)}
                                   className="flex items-center gap-2 hover:text-blue-600 disabled:opacity-30 disabled:hover:text-slate-400 transition-colors"
                                 >
                                    <ChevronLeft size={20} /> Previous
                                 </button>

                                 <button 
                                   disabled={currentChapterIndex === chapters.length - 1}
                                   onClick={() => setCurrentChapterIndex(prev => prev + 1)}
                                   className="flex items-center gap-2 hover:text-blue-600 disabled:opacity-30 disabled:hover:text-slate-400 transition-colors"
                                 >
                                    Next <ChevronRight size={20} />
                                 </button>
                              </div>
                           )}
                        </>
                     )}
                  </div>
                )}
             </div>
        </div>

      </div>
    </>
  );
};
