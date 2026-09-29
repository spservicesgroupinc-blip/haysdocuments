import React, { useRef, useState, useEffect } from 'react';
import { Mic, FileText, Loader2, Trash2, Square, X, UploadCloud, NotebookPen, Pencil, AlertCircle, Image as ImageIcon } from 'lucide-react';
import { Source, SourceType } from '../types';
import { transcribeAudio } from '../services/gemini';

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
  const fileInputRef = useRef<HTMLInputElement>(null);
  const imageInputRef = useRef<HTMLInputElement>(null);
  
  const [noteText, setNoteText] = useState('');
  const [isAddingNote, setIsAddingNote] = useState(false);
  const [editingSourceId, setEditingSourceId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Recording State
  const [isRecording, setIsRecording] = useState(false);
  const [recordingDuration, setRecordingDuration] = useState(0);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const timerIntervalRef = useRef<number | null>(null);

  // Clean up timer on unmount
  useEffect(() => {
    return () => {
      if (timerIntervalRef.current) {
        clearInterval(timerIntervalRef.current);
      }
      stopTracksSafely();
    };
  }, []);

  const stopTracksSafely = () => {
     if (mediaRecorderRef.current && mediaRecorderRef.current.stream) {
        mediaRecorderRef.current.stream.getTracks().forEach(track => {
          try { track.stop(); } catch(e) { console.warn(e); }
        });
     }
  };

  const handleAudioUpload = async (event: React.ChangeEvent<HTMLInputElement>) => {
    setError(null);
    const files = event.target.files;
    if (!files || files.length === 0) return;

    const file = files[0];
    const reader = new FileReader();

    const newSource: Source = {
      id: generateId(),
      type: SourceType.AUDIO,
      name: file.name,
      content: '', 
      mimeType: file.type,
      isProcessing: true,
    };

    onUpdate([...sources, newSource]);

    reader.onload = async (e) => {
      const result = e.target?.result as string;
      const base64Data = result.split(',')[1]; 
      
      const sourcesWithContent = [...sources, { ...newSource, content: base64Data }];
      onUpdate(sourcesWithContent);

      try {
        const transcription = await transcribeAudio(base64Data, file.type);
        onUpdate(sourcesWithContent.map(s => 
          s.id === newSource.id ? { ...s, transcription, isProcessing: false } : s
        ));
      } catch (err) {
        console.error(err);
        onUpdate(sourcesWithContent.map(s => 
            s.id === newSource.id ? { ...s, isProcessing: false, transcription: "Error transcribing audio." } : s
        ));
      }
    };

    reader.onerror = () => {
        setError("Failed to read file.");
        onUpdate(sources.filter(s => s.id !== newSource.id));
    };

    reader.readAsDataURL(file);
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const handleImageUpload = (event: React.ChangeEvent<HTMLInputElement>) => {
    setError(null);
    const files = event.target.files;
    if (!files || files.length === 0) return;

    const file = files[0];
    const reader = new FileReader();

    reader.onload = async (e) => {
      const result = e.target?.result as string;
      const base64Data = result.split(',')[1]; 
      
      const newSource: Source = {
        id: generateId(),
        type: SourceType.IMAGE,
        name: file.name,
        content: base64Data,
        mimeType: file.type,
        isProcessing: false
      };
      
      onUpdate([...sources, newSource]);
    };

    reader.onerror = () => setError("Failed to read image.");
    reader.readAsDataURL(file);
    if (imageInputRef.current) imageInputRef.current.value = '';
  };

  const startRecording = async () => {
    setError(null);
    
    if (window.location.protocol !== 'https:' && window.location.hostname !== 'localhost') {
        setError("Recording requires a secure HTTPS connection.");
        return;
    }

    try {
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        throw new Error("Microphone access is not supported in this browser.");
      }

      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      
      // Let browser choose the best container/codec naturally
      let mediaRecorder;
      try {
        mediaRecorder = new MediaRecorder(stream);
      } catch (e) {
         throw new Error("Failed to create MediaRecorder.");
      }

      mediaRecorderRef.current = mediaRecorder;
      audioChunksRef.current = [];

      mediaRecorder.ondataavailable = (event) => {
        if (event.data && event.data.size > 0) {
          audioChunksRef.current.push(event.data);
        }
      };
      
      mediaRecorder.onerror = (event: any) => {
         console.error("MediaRecorder error:", event.error);
         setError("An error occurred during recording.");
         stopRecording();
      };

      mediaRecorder.onstop = async () => {
        stopTracksSafely();

        if (audioChunksRef.current.length === 0) {
            console.warn("No audio data recorded.");
            return;
        }

        // Use the mimetype the browser actually used, or fallback
        const finalMimeType = mediaRecorder.mimeType || 'audio/webm';
        
        try {
            const audioBlob = new Blob(audioChunksRef.current, { type: finalMimeType });
            const reader = new FileReader();
    
            const newSource: Source = {
              id: generateId(),
              type: SourceType.AUDIO,
              name: `Voice Note - ${new Date().toLocaleDateString()} ${new Date().toLocaleTimeString()}`,
              content: '',
              mimeType: finalMimeType,
              isProcessing: true
            };
    
            onUpdate([...sources, newSource]);
    
            reader.readAsDataURL(audioBlob);
            reader.onloadend = async () => {
              if (reader.result) {
                const base64Data = (reader.result as string).split(',')[1];
                
                const sourcesWithContent = [...sources, { ...newSource, content: base64Data }];
                onUpdate(sourcesWithContent);
    
                try {
                  const transcription = await transcribeAudio(base64Data, finalMimeType);
                  onUpdate(sourcesWithContent.map(s => 
                    s.id === newSource.id ? { ...s, transcription, isProcessing: false } : s
                  ));
                } catch (err) {
                  console.error("Transcription error", err);
                  onUpdate(sourcesWithContent.map(s => 
                      s.id === newSource.id ? { ...s, isProcessing: false, transcription: "Error transcribing recording." } : s
                  ));
                }
              }
            };
        } catch(e) {
            console.error("Blob creation failed", e);
            setError("Failed to process recording.");
        }
      };

      // Start recording without timeslice to prevent chunk issues on iOS
      mediaRecorder.start(); 
      setIsRecording(true);
      setRecordingDuration(0);
      
      timerIntervalRef.current = window.setInterval(() => {
          setRecordingDuration(prev => prev + 1);
      }, 1000);

    } catch (err: any) {
      console.error("Microphone access denied or error:", err);
      setError(err.message || "Could not access microphone.");
      setIsRecording(false);
    }
  };

  const stopRecording = () => {
    if (mediaRecorderRef.current && isRecording) {
      if (mediaRecorderRef.current.state !== 'inactive') {
         try {
           mediaRecorderRef.current.stop();
         } catch(e) {
           console.error("Error stopping recorder", e);
         }
      }
      setIsRecording(false);
      if (timerIntervalRef.current) {
        clearInterval(timerIntervalRef.current);
        timerIntervalRef.current = null;
      }
    }
  };

  const cancelRecording = () => {
    if (mediaRecorderRef.current) {
       mediaRecorderRef.current.onstop = null; // Prevent saving
       if (mediaRecorderRef.current.state !== 'inactive') {
          try {
             mediaRecorderRef.current.stop();
          } catch (e) { console.warn(e); }
       }
       stopTracksSafely();
       
       setIsRecording(false);
       if (timerIntervalRef.current) {
         clearInterval(timerIntervalRef.current);
         timerIntervalRef.current = null;
       }
       // Clear chunks
       audioChunksRef.current = [];
    }
  };

  const formatTime = (seconds: number) => {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins}:${secs.toString().padStart(2, '0')}`;
  };

  const handleSaveNote = () => {
    if (!noteText.trim()) return;

    if (editingSourceId) {
      // Update existing source (Text or Audio transcription)
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
      // Create new
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
    // Allow editing both TEXT content and AUDIO transcriptions
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
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <button 
          onClick={startRecording}
          disabled={isRecording}
          className={`bg-white border-2 border-slate-100 hover:border-red-200 hover:bg-red-50/30 text-slate-800 px-4 py-5 rounded-xl flex flex-col items-center justify-center gap-3 transition-all group ${isRecording ? 'opacity-50 cursor-not-allowed' : ''}`}
        >
          <div className="bg-red-50 p-2.5 rounded-full group-hover:bg-red-100 transition-colors">
             <Mic className="w-6 h-6 text-red-500" />
          </div>
          <span className="font-bold text-xs md:text-sm text-slate-700 group-hover:text-red-800">Record Audio</span>
        </button>

        <button 
          onClick={() => {
            setError(null);
            fileInputRef.current?.click();
          }}
          disabled={isRecording}
          className={`bg-white border-2 border-slate-100 hover:border-blue-200 hover:bg-blue-50/30 text-slate-800 px-4 py-5 rounded-xl flex flex-col items-center justify-center gap-3 transition-all group ${isRecording ? 'opacity-50 cursor-not-allowed' : ''}`}
        >
          <div className="bg-blue-50 p-2.5 rounded-full group-hover:bg-blue-100 transition-colors">
             <UploadCloud className="w-6 h-6 text-blue-600" />
          </div>
          <span className="font-bold text-xs md:text-sm text-slate-700 group-hover:text-blue-800">Upload Audio</span>
          <input 
            type="file" 
            ref={fileInputRef} 
            className="hidden" 
            accept="audio/*"
            onChange={handleAudioUpload}
          />
        </button>

        <button 
          onClick={() => {
            setError(null);
            imageInputRef.current?.click();
          }}
          disabled={isRecording}
          className={`bg-white border-2 border-slate-100 hover:border-purple-200 hover:bg-purple-50/30 text-slate-800 px-4 py-5 rounded-xl flex flex-col items-center justify-center gap-3 transition-all group ${isRecording ? 'opacity-50 cursor-not-allowed' : ''}`}
        >
          <div className="bg-purple-50 p-2.5 rounded-full group-hover:bg-purple-100 transition-colors">
             <ImageIcon className="w-6 h-6 text-purple-600" />
          </div>
          <span className="font-bold text-xs md:text-sm text-slate-700 group-hover:text-purple-800">Add Image</span>
          <input 
            type="file" 
            ref={imageInputRef} 
            className="hidden" 
            accept="image/*"
            onChange={handleImageUpload}
          />
        </button>

        <button 
          onClick={() => {
            setError(null);
            setEditingSourceId(null);
            setNoteText('');
            setIsAddingNote(true);
          }}
          disabled={isRecording}
          className={`bg-white border-2 border-slate-100 hover:border-emerald-200 hover:bg-emerald-50/30 text-slate-800 px-4 py-5 rounded-xl flex flex-col items-center justify-center gap-3 transition-all group ${isRecording ? 'opacity-50 cursor-not-allowed' : ''}`}
        >
          <div className="bg-emerald-50 p-2.5 rounded-full group-hover:bg-emerald-100 transition-colors">
            <NotebookPen className="w-6 h-6 text-emerald-600" />
          </div>
          <span className="font-bold text-xs md:text-sm text-slate-700 group-hover:text-emerald-800">Write Note</span>
        </button>
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

      {/* Recording Modal */}
      {isRecording && (
        <div className="fixed inset-0 bg-slate-900/70 backdrop-blur-sm flex items-center justify-center z-50 animate-in fade-in duration-200">
          <div className="bg-white rounded-2xl shadow-2xl p-10 w-full max-w-md flex flex-col items-center text-center mx-4 border border-slate-200">
            <div className="w-20 h-20 bg-red-50 rounded-full flex items-center justify-center mb-8 relative">
               <div className="absolute inset-0 bg-red-500 rounded-full animate-ping opacity-20"></div>
               <div className="absolute inset-0 bg-red-500 rounded-full animate-pulse opacity-10"></div>
               <Mic className="w-8 h-8 text-red-600 relative z-10" />
            </div>
            
            <h3 className="text-2xl font-serif font-bold text-slate-900 mb-2">Listening...</h3>
            <p className="text-slate-500 mb-8 text-sm font-medium">Speak freely. We'll capture every word.</p>
            
            <div className="text-6xl font-mono font-light text-slate-900 mb-10 tabular-nums tracking-tighter">
              {formatTime(recordingDuration)}
            </div>

            <div className="flex gap-4 w-full">
              <button 
                onClick={cancelRecording}
                className="flex-1 py-3.5 px-4 rounded-xl border-2 border-slate-100 text-slate-600 font-bold hover:bg-slate-50 hover:text-slate-900 transition-colors"
              >
                Cancel
              </button>
              <button 
                onClick={stopRecording}
                className="flex-1 py-3.5 px-4 rounded-xl bg-red-600 text-white font-bold hover:bg-red-700 transition-colors flex items-center justify-center gap-2 shadow-lg shadow-red-200"
              >
                <Square size={14} fill="currentColor" />
                Done
              </button>
            </div>
          </div>
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
                    {source.isProcessing ? (
                      <div className="flex items-center gap-2 text-xs text-blue-600 font-bold bg-blue-50 inline-flex px-2 py-1 rounded">
                        <Loader2 size={12} className="animate-spin" />
                        Transcribing...
                      </div>
                    ) : (
                      <p className="text-xs text-slate-500 font-serif leading-relaxed line-clamp-3">
                        {source.transcription || "No speech detected."}
                      </p>
                    )}
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