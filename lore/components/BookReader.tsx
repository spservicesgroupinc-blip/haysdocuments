
import React, { useState, useRef, useEffect } from 'react';
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
  selectedVoice?: string;
  onVoiceChange?: (voice: string) => void;
  onUpdateOutline?: (outline: BookOutline) => void;
  user?: User;
}

// Audio Cache
const audioCache = new Map<string, AudioBuffer>();

function decode(base64: string) {
  try {
    const binaryString = atob(base64);
    const len = binaryString.length;
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) {
      bytes[i] = binaryString.charCodeAt(i);
    }
    return bytes;
  } catch (e) {
    console.error("Audio decoding failed", e);
    return new Uint8Array(0);
  }
}

async function decodeAudioData(
  data: Uint8Array,
  ctx: AudioContext,
  sampleRate: number = 24000,
  numChannels: number = 1
): Promise<AudioBuffer> {
  let bufferToUse = data.buffer;
  let byteOffset = data.byteOffset;
  let byteLength = data.byteLength;

  if (byteLength % 2 !== 0) {
      const newBuffer = new Uint8Array(byteLength - 1);
      newBuffer.set(data.subarray(0, byteLength - 1));
      bufferToUse = newBuffer.buffer;
      byteOffset = 0;
      byteLength = newBuffer.byteLength;
  }

  const dataInt16 = new Int16Array(bufferToUse, byteOffset, byteLength / 2);
  const frameCount = dataInt16.length / numChannels;
  const buffer = ctx.createBuffer(numChannels, frameCount, sampleRate);

  for (let channel = 0; channel < numChannels; channel++) {
    const channelData = buffer.getChannelData(channel);
    for (let i = 0; i < frameCount; i++) {
      channelData[i] = dataInt16[i * numChannels + channel] / 32768.0;
    }
  }
  return buffer;
}

export const BookReader: React.FC<BookReaderProps> = ({ 
  outline, 
  chapters, 
  onChapterUpdate, 
  selectedVoice, 
  onVoiceChange,
  onUpdateOutline,
  user
}) => {
  const [currentChapterIndex, setCurrentChapterIndex] = useState(0);
  const [isSidebarOpen, setIsSidebarOpen] = useState(true);
  const [isPlaying, setIsPlaying] = useState(false);
  const [audioLoading, setAudioLoading] = useState(false);
  const [isExportingDocs, setIsExportingDocs] = useState(false);
  const [isEditing, setIsEditing] = useState(false);
  const [editContent, setEditContent] = useState('');
  const [polishInstruction, setPolishInstruction] = useState('');
  const [isPolishing, setIsPolishing] = useState(false);
  const [isCoverGenerating, setIsCoverGenerating] = useState(false);
  const [isChapterImageGenerating, setIsChapterImageGenerating] = useState(false);
  const [notification, setNotification] = useState<{message: string, type: 'error' | 'success'} | null>(null);
  
  // PDF Generation State: We use a specific mode to render the print layout
  const [isPdfMode, setIsPdfMode] = useState(false);

  const audioContextRef = useRef<AudioContext | null>(null);
  const audioSourceRef = useRef<AudioBufferSourceNode | null>(null);

  const currentChapter = chapters[currentChapterIndex];

  useEffect(() => {
    stopAudio();
  }, [currentChapterIndex]);

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

  const [playbackSpeed, setPlaybackSpeed] = useState<number>(1.0);

  const stopAudio = () => {
    if (audioSourceRef.current) {
      try { audioSourceRef.current.stop(); } catch(e) {}
      audioSourceRef.current = null;
    }
    setIsPlaying(false);
  };

  const updatePlaybackSpeed = (speed: number) => {
    setPlaybackSpeed(speed);
    if (audioSourceRef.current) {
      try {
        audioSourceRef.current.playbackRate.value = speed;
      } catch (e) {
        console.warn("Could not set playback rate", e);
      }
    }
  };

  const playChapterAudio = async () => {
    if (isPlaying) { stopAudio(); return; }
    if (!currentChapter?.content) return;

    let ctx = audioContextRef.current;
    if (!ctx) {
      const AudioContextClass = window.AudioContext || (window as any).webkitAudioContext;
      ctx = new AudioContextClass();
      audioContextRef.current = ctx;
    }

    if (ctx.state === 'suspended') await ctx.resume();

    const cacheKey = `${currentChapter.chapterNumber}-${selectedVoice}-${currentChapter.content.length}`;
    if (audioCache.has(cacheKey)) {
        playBuffer(audioCache.get(cacheKey)!);
        return;
    }

    setAudioLoading(true);
    try {
      const textToSpeak = currentChapter.content.slice(0, 4000);
      const pcmBase64 = await generateSpeech(textToSpeak, selectedVoice || 'Kore');
      if (!pcmBase64) throw new Error("Audio generation failed");
      const pcmData = decode(pcmBase64);
      const audioBuffer = await decodeAudioData(pcmData, ctx, 24000);
      audioCache.set(cacheKey, audioBuffer);
      playBuffer(audioBuffer);
    } catch (err: any) {
      showNotification(err.message || "Audio playback failed", 'error');
    } finally {
      setAudioLoading(false);
    }
  };

  const playBuffer = (buffer: AudioBuffer) => {
    const ctx = audioContextRef.current;
    if (!ctx) return;
    if (audioSourceRef.current) try { audioSourceRef.current.stop(); } catch(e) {}
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.playbackRate.value = playbackSpeed;
    source.connect(ctx.destination);
    source.onended = () => { setIsPlaying(false); audioSourceRef.current = null; };
    audioSourceRef.current = source;
    source.start(0);
    setIsPlaying(true);
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

  const handleGenerateBookCover = async () => {
    if (!onUpdateOutline) return;
    setIsCoverGenerating(true);
    try {
      const prompt = `Create a flat 2D front cover design for a book titled "${outline.title}". 
      Description: ${outline.description}. 
      Style: Minimalist, modern, striking typography, best-selling aesthetic.
      IMPORTANT: This must be a flat, rectangular 2D image suitable for printing. Do NOT render a 3D book object, do NOT show a book spine.`;
      
      const base64Image = await generateImage(prompt, '3:4'); 
      onUpdateOutline({
        ...outline,
        coverImage: base64Image
      });
      showNotification("Cover Generated!");
    } catch (e: any) {
      showNotification("Failed to generate cover.", 'error');
    } finally {
      setIsCoverGenerating(false);
    }
  };

  const handleGenerateChapterImage = async () => {
    if (!currentChapter || !onChapterUpdate) return;
    setIsChapterImageGenerating(true);
    try {
      const prompt = `Charcoal sketch. ${currentChapter.title}. ${currentChapter.content.slice(0, 200)}. High contrast, black and white.`;
      const base64 = await generateImage(prompt, '16:9');
      onChapterUpdate({ ...currentChapter, image: base64 });
    } catch (e) {
      showNotification("Failed to generate sketch.", 'error');
    } finally {
      setIsChapterImageGenerating(false);
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

          {/* Book Cover in Sidebar */}
          <div className="p-4 border-b border-slate-100 flex flex-col items-center bg-white">
              {outline.coverImage ? (
                  <div className="relative group w-32 shadow-lg rounded-md overflow-hidden mb-3">
                      <img src={`data:image/jpeg;base64,${outline.coverImage}`} alt="Cover" className="w-full h-auto" />
                      <div className="absolute inset-0 bg-black/50 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center">
                          <button 
                            onClick={handleGenerateBookCover}
                            disabled={isCoverGenerating}
                            className="p-2 bg-white text-slate-900 rounded-full hover:bg-blue-50 transition-colors"
                            title="Regenerate Cover"
                          >
                             {isCoverGenerating ? <Loader2 size={16} className="animate-spin" /> : <RefreshCw size={16} />}
                          </button>
                      </div>
                  </div>
              ) : (
                  <button 
                    onClick={handleGenerateBookCover}
                    disabled={isCoverGenerating}
                    className="w-full py-6 border-2 border-dashed border-slate-200 rounded-lg flex flex-col items-center justify-center text-slate-400 hover:text-blue-600 hover:border-blue-300 hover:bg-blue-50 transition-all mb-2"
                  >
                      {isCoverGenerating ? (
                          <Loader2 size={24} className="animate-spin mb-2" />
                      ) : (
                          <ImageIcon size={24} className="mb-2" />
                      )}
                      <span className="text-xs font-bold uppercase tracking-wide">
                          {isCoverGenerating ? 'Designing...' : 'Create Cover Art'}
                      </span>
                  </button>
              )}
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
                                 {/* Chapter Image/Sketch */}
                                 {currentChapter.image ? (
                                    <div className="my-8 rounded-xl overflow-hidden shadow-lg border border-slate-100">
                                       <img src={`data:image/jpeg;base64,${currentChapter.image}`} alt="Chapter Sketch" className="w-full h-auto" />
                                    </div>
                                 ) : (
                                    <div className="flex justify-center my-6 group">
                                       <button 
                                          onClick={handleGenerateChapterImage}
                                          disabled={isChapterImageGenerating}
                                          className="flex items-center gap-2 text-xs text-slate-300 hover:text-blue-600 border border-transparent hover:border-blue-100 hover:bg-blue-50 px-3 py-1.5 rounded-full transition-all"
                                       >
                                          {isChapterImageGenerating ? <Loader2 size={12} className="animate-spin" /> : <ImageIcon size={14} />}
                                          Generate Illustration
                                       </button>
                                    </div>
                                 )}

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

                                 {/* Audio Player */}
                                 <div className="flex items-center gap-4">
                                     {selectedVoice && onVoiceChange && (
                                         <select 
                                           value={selectedVoice} 
                                           onChange={(e) => onVoiceChange(e.target.value)}
                                           className="text-xs bg-slate-50 border border-slate-200 rounded px-2 py-1 outline-none font-medium"
                                         >
                                            <option value="Kore">Kore (Female)</option>
                                            <option value="Puck">Puck (Male)</option>
                                            <option value="Fenrir">Fenrir (Deep)</option>
                                            <option value="Aoede">Aoede (Soft)</option>
                                         </select>
                                     )}

                                     {/* Audiobook Speed Controls */}
                                     <select
                                       value={playbackSpeed}
                                       onChange={(e) => updatePlaybackSpeed(parseFloat(e.target.value))}
                                       className="text-xs bg-slate-50 border border-slate-200 rounded px-2 py-1 outline-none font-medium text-slate-700 cursor-pointer"
                                     >
                                        <option value={0.75}>0.75x</option>
                                        <option value={1.0}>1.0x</option>
                                        <option value={1.25}>1.25x</option>
                                        <option value={1.5}>1.5x</option>
                                        <option value={2.0}>2.0x</option>
                                     </select>
                                     <button 
                                        onClick={playChapterAudio}
                                        disabled={audioLoading}
                                        className={`w-10 h-10 rounded-full flex items-center justify-center transition-all shadow-sm ${isPlaying ? 'bg-red-50 text-red-600 hover:bg-red-100' : 'bg-blue-50 text-blue-600 hover:bg-blue-100'}`}
                                     >
                                        {audioLoading ? (
                                           <Loader2 size={18} className="animate-spin" />
                                        ) : isPlaying ? (
                                           <Square size={16} fill="currentColor" />
                                        ) : (
                                           <Play size={18} fill="currentColor" className="ml-0.5" />
                                        )}
                                     </button>
                                 </div>

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
