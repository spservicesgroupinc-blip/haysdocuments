
import React, { useState, useEffect, useRef } from 'react';
import { BookProject, BookOutline, ChapterContent, WritingStyle, User } from '../types';
import { generateOutline } from '../services/deepseek';
import { SourceInput } from './SourceInput';
import { OutlineBuilder } from './OutlineBuilder';
import { BookReader } from './BookReader';
import { BookOpen, PenTool, FileAudio, ArrowRight, ChevronLeft, Check, Wand2, Feather, AlertTriangle, Sparkles } from 'lucide-react';

interface ProjectEditorProps {
  project: BookProject;
  onUpdateProject: (project: BookProject) => void;
  onBack: () => void;
  onStartGeneration: (style: WritingStyle) => void;
  isGeneratingGlobal: boolean;
  user?: User;
}

const STEPS = [
  { id: 0, title: 'Materials', icon: FileAudio },
  { id: 1, title: 'Outline', icon: BookOpen },
  { id: 2, title: 'Manuscript', icon: PenTool },
];

const WRITING_STYLES: {id: WritingStyle, name: string, description: string}[] = [
  { id: 'standard', name: 'Balanced', description: 'Clear, engaging, and professional.' },
  { id: 'literary', name: 'Literary', description: 'Rich descriptions, metaphoric, and elevated prose.' },
  { id: 'humorous', name: 'Witty', description: 'Light-hearted, clever, and entertaining.' },
  { id: 'sarcastic', name: 'Edgy', description: 'Sharp wit, heavy sarcasm, and adult humor.' },
  { id: 'technical', name: 'Technical', description: 'Precise, factual, and educational.' },
  { id: 'simple', name: 'Accessible', description: 'Easy to read, simple vocabulary, direct.' },
];

export const ProjectEditor: React.FC<ProjectEditorProps> = ({ 
  project, 
  onUpdateProject, 
  onBack,
  onStartGeneration,
  isGeneratingGlobal,
  user
}) => {
  const [isProcessing, setIsProcessing] = useState(false);
  const [localTitle, setLocalTitle] = useState(project.title);
  const [selectedStyle, setSelectedStyle] = useState<WritingStyle>('standard');
  const [error, setError] = useState<string | null>(null);

  // Sync title state if project changes externally
  useEffect(() => {
    setLocalTitle(project.title);
  }, [project.id, project.title]);

  // Auto-start generation when entering Step 2 if chapters are empty or missing
  useEffect(() => {
    if (project.currentStep === 2 && project.outline) {
       const needsGeneration = project.chapters.length === 0 || project.chapters.length < project.outline.chapters.length;
       
       if (needsGeneration && !isProcessing && !isGeneratingGlobal && !error) {
         onStartGeneration(selectedStyle);
       }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project.currentStep, project.outline]);

  const updateProject = (updates: Partial<BookProject>) => {
    onUpdateProject({
      ...project,
      ...updates,
      lastModified: Date.now()
    });
  };

  const handleTitleBlur = () => {
     if (localTitle !== project.title) {
       updateProject({ title: localTitle });
     }
  };

  const handleCreateOutline = async () => {
    if (project.sources.length === 0) return;
    setIsProcessing(true);
    setError(null);
    try {
      const generatedOutline = await generateOutline(project.sources, project.customInstruction);
      updateProject({
        outline: generatedOutline,
        chapters: [],
        currentStep: 1,
        title: generatedOutline.title
      });
      setLocalTitle(generatedOutline.title);
    } catch (e: any) {
      setError(e.message || "Failed to generate outline.");
    } finally {
      setIsProcessing(false);
    }
  };

  const handleUpdateOutline = (updatedOutline: BookOutline) => {
    updateProject({ outline: updatedOutline });
  };

  const navigateStep = (step: number) => {
    if (step <= project.currentStep) {
      updateProject({ currentStep: step });
    } else {
      if (step === 1 && project.outline) updateProject({ currentStep: 1 });
      if (step === 2 && project.outline && project.chapters.length > 0) updateProject({ currentStep: 2 });
    }
  };

  return (
    <div className="min-h-screen bg-white flex flex-col print:block text-slate-900">
      
      {/* Top Bar */}
      <div className="h-16 border-b border-slate-200 flex items-center px-4 md:px-6 bg-white/80 backdrop-blur-md sticky top-0 z-50 print:hidden no-print">
        <button 
          onClick={onBack}
          className="p-2 -ml-2 text-slate-400 hover:text-blue-700 hover:bg-blue-50 rounded-lg transition-colors flex items-center gap-1 text-sm font-medium group shrink-0"
        >
          <ChevronLeft size={18} className="group-hover:-translate-x-0.5 transition-transform" />
          <span className="hidden sm:inline">Library</span>
        </button>
        
        <div className="h-5 w-px bg-slate-200 mx-2 md:mx-4 shrink-0"></div>

        <input 
          value={localTitle}
          onChange={(e) => setLocalTitle(e.target.value)}
          onBlur={handleTitleBlur}
          className="font-serif font-bold text-lg text-slate-900 bg-transparent border border-transparent hover:border-slate-200 focus:border-blue-400 focus:ring-0 px-3 py-1.5 w-full max-w-lg rounded-md transition-all truncate"
        />

        <div className="flex-1"></div>

        {/* Step Progress */}
        <div className="hidden md:flex items-center gap-2 bg-slate-50 p-1 rounded-lg border border-slate-100 shrink-0">
            {STEPS.map((step, idx) => {
               const isActive = project.currentStep === step.id;
               const isCompleted = project.currentStep > step.id;
               const hasData = (step.id === 1 && !!project.outline) || (step.id === 2 && project.chapters.length > 0);
               const canClick = isCompleted || isActive || hasData;

               return (
                 <button
                   key={step.id}
                   onClick={() => canClick && navigateStep(step.id)}
                   disabled={!canClick}
                   className={`flex items-center gap-2 text-xs font-medium px-3 py-1.5 rounded-md transition-all ${
                     isActive ? 'bg-white text-blue-700 shadow-sm border border-slate-200' : 
                     (canClick || isCompleted) ? 'text-blue-600 hover:bg-blue-50' : 'text-slate-400 cursor-not-allowed'
                   }`}
                 >
                    <span className={`w-4 h-4 rounded-full flex items-center justify-center text-[10px] ${isActive ? 'bg-blue-100 text-blue-700' : (isCompleted || hasData) ? 'bg-blue-600 text-white' : 'bg-slate-200 text-slate-500'}`}>
                      {(isCompleted || hasData) ? <Check size={8} strokeWidth={3} /> : idx + 1}
                    </span>
                    {step.title}
                 </button>
               )
            })}
        </div>
      </div>

      {/* Main Workspace */}
      <div className="flex-1 bg-white overflow-y-auto print:overflow-visible scrollbar-hide">
        {error && (
            <div className="bg-red-50 border-b border-red-200 p-4 sticky top-0 z-40 flex items-center gap-3 animate-in slide-in-from-top-2">
                <AlertTriangle className="text-red-600 shrink-0" size={20} />
                <div className="flex-1 text-red-800 text-sm font-medium">{error}</div>
                <button onClick={() => setError(null)} className="text-red-500 hover:text-red-800 font-bold text-sm">Dismiss</button>
            </div>
        )}

        <div className={`mx-auto print:p-0 print:max-w-none transition-all ${project.currentStep === 2 && project.outline ? 'max-w-full p-0 md:px-6 md:py-12 md:max-w-6xl' : 'max-w-6xl px-4 py-8 md:px-6 md:py-12'}`}>
          
          {project.currentStep === 0 && (
            <div className="animate-in fade-in slide-in-from-bottom-2 print:hidden max-w-4xl mx-auto no-print">
              <div className="mb-10 text-center">
                <div className="w-12 h-12 bg-blue-50 rounded-xl flex items-center justify-center mx-auto mb-4 text-blue-600">
                   <FileAudio size={24} />
                </div>
                <h2 className="text-3xl font-serif font-bold text-slate-900 mb-3">Source Material</h2>
                <p className="text-slate-500 text-lg max-w-xl mx-auto leading-relaxed">Gather your raw thoughts and notes. This is the clay we will sculpt into your story.</p>
              </div>
              
              <SourceInput 
                sources={project.sources} 
                onUpdate={(newSources) => updateProject({ sources: newSources })} 
              />
              
              <div className="mt-12 bg-slate-50 border border-slate-100 rounded-xl p-6 space-y-6">
                 <div className="flex items-center gap-2 border-b border-slate-200 pb-3">
                    <Feather size={18} className="text-blue-600" />
                    <h3 className="font-bold text-slate-800 text-lg">Manuscript Writing Settings</h3>
                 </div>

                 {/* Style Selector */}
                 <div>
                   <label className="text-xs font-bold text-slate-500 uppercase tracking-wider mb-2 block">Writing Style & Tone</label>
                   <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-3">
                      {WRITING_STYLES.map(style => (
                         <button
                           key={style.id}
                           type="button"
                           onClick={() => setSelectedStyle(style.id)}
                           className={`text-left p-3 rounded-lg border transition-all ${selectedStyle === style.id ? 'bg-white border-blue-500 shadow-md ring-1 ring-blue-500' : 'bg-white border-slate-200 hover:border-blue-300 hover:shadow-sm'}`}
                         >
                            <div className={`font-bold text-sm mb-1 ${selectedStyle === style.id ? 'text-blue-700' : 'text-slate-700'}`}>{style.name}</div>
                            <div className="text-xs text-slate-500 leading-snug">{style.description}</div>
                         </button>
                      ))}
                   </div>
                 </div>

                 {/* Advanced Manuscript Selectors: POV, Tense, Chapter Depth */}
                 <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 pt-2">
                   <div>
                     <label className="text-xs font-bold text-slate-500 uppercase tracking-wider mb-2 block">Point of View (POV)</label>
                     <select
                       value={project.settings?.pov || 'third_limited'}
                       onChange={(e) => updateProject({ settings: { ...project.settings, pov: e.target.value as any } })}
                       className="w-full bg-white border border-slate-200 text-slate-800 text-sm rounded-lg px-3 py-2.5 outline-none focus:ring-2 focus:ring-blue-500 font-medium"
                     >
                       <option value="third_limited">Third-Person Limited (He/She)</option>
                       <option value="first">First-Person (I/We)</option>
                       <option value="second">Second-Person (You)</option>
                       <option value="omniscient">Third-Person Omniscient</option>
                     </select>
                   </div>

                   <div>
                     <label className="text-xs font-bold text-slate-500 uppercase tracking-wider mb-2 block">Narrative Tense</label>
                     <select
                       value={project.settings?.tense || 'past'}
                       onChange={(e) => updateProject({ settings: { ...project.settings, tense: e.target.value as any } })}
                       className="w-full bg-white border border-slate-200 text-slate-800 text-sm rounded-lg px-3 py-2.5 outline-none focus:ring-2 focus:ring-blue-500 font-medium"
                     >
                       <option value="past">Past Tense ("He walked into the room")</option>
                       <option value="present">Present Tense ("He walks into the room")</option>
                     </select>
                   </div>

                   <div>
                     <label className="text-xs font-bold text-slate-500 uppercase tracking-wider mb-2 block">Target Chapter Depth</label>
                     <select
                       value={project.settings?.targetDepth || 'standard'}
                       onChange={(e) => updateProject({ settings: { ...project.settings, targetDepth: e.target.value as any } })}
                       className="w-full bg-white border border-slate-200 text-slate-800 text-sm rounded-lg px-3 py-2.5 outline-none focus:ring-2 focus:ring-blue-500 font-medium"
                     >
                       <option value="short">Short (~1,200 – 1,500 words)</option>
                       <option value="standard">Standard (~2,200 – 2,800 words)</option>
                       <option value="epic">Epic (~3,200 – 4,000 words)</option>
                     </select>
                   </div>
                 </div>

                 {/* Two-Pass Generation Toggle */}
                 <div className="flex items-center justify-between bg-white p-3.5 rounded-lg border border-slate-200">
                   <div>
                     <div className="text-sm font-bold text-slate-800">Two-Pass AI Polish Pass</div>
                     <div className="text-xs text-slate-500">Automatically executes a secondary literary style refinement pass on every chapter to strip AI clichés.</div>
                   </div>
                   <input
                     type="checkbox"
                     checked={project.settings?.twoPassPolish !== false}
                     onChange={(e) => updateProject({ settings: { ...project.settings, twoPassPolish: e.target.checked } })}
                     className="w-5 h-5 text-blue-600 rounded border-slate-300 focus:ring-blue-500 cursor-pointer"
                   />
                 </div>
              </div>

              <div className="mt-6 bg-amber-50 border border-amber-100 rounded-xl p-6">
                  <div className="flex items-center gap-2 mb-3 text-amber-800">
                      <Sparkles size={18} />
                      <h3 className="font-bold">Special Instructions (Optional)</h3>
                  </div>
                  <textarea
                      value={project.customInstruction || ''}
                      onChange={(e) => updateProject({ customInstruction: e.target.value })}
                      placeholder="e.g., 'Focus heavily on the childhood years', 'Make it a dark thriller', 'Keep chapters short', 'Avoid metaphors'..."
                      className="w-full p-4 bg-white border border-amber-200 rounded-lg focus:ring-2 focus:ring-amber-400 outline-none text-slate-800 placeholder:text-slate-400 text-sm"
                      rows={3}
                  />
              </div>

              <div className="flex justify-center pt-8 mt-4">
                <button 
                  onClick={handleCreateOutline}
                  disabled={project.sources.length === 0 || isProcessing || project.sources.some(s => s.isProcessing)}
                  className="flex items-center gap-3 bg-blue-600 hover:bg-blue-500 text-white pl-8 pr-6 py-4 rounded-full font-bold text-lg transition-all shadow-lg shadow-blue-600/30 hover:shadow-blue-600/50 hover:-translate-y-1 disabled:opacity-50 disabled:shadow-none disabled:cursor-not-allowed disabled:translate-y-0"
                >
                  {isProcessing ? 'Analyzing...' : 'Generate Structure'}
                  {!isProcessing && <div className="bg-blue-500 rounded-full p-1"><ArrowRight size={16} /></div>}
                </button>
              </div>
            </div>
          )}

          {project.currentStep === 1 && project.outline && (
            <div className="animate-in fade-in slide-in-from-bottom-2 print:hidden no-print">
               <OutlineBuilder 
                 outline={project.outline} 
                 isGenerating={isProcessing && !project.outline} 
                 onRegenerate={handleCreateOutline}
                 onUpdateOutline={handleUpdateOutline}
               />
               
               <div className="flex flex-col items-center pt-16 pb-8">
                  <button 
                   onClick={() => updateProject({ currentStep: 2 })}
                   className="flex items-center gap-3 bg-blue-600 hover:bg-blue-500 text-white pl-8 pr-6 py-4 rounded-full font-bold text-lg transition-all shadow-lg shadow-blue-600/30 hover:shadow-blue-600/50 hover:-translate-y-1"
                 >
                   {project.chapters.length > 0 ? 'Continue Writing' : 'Start Writing Manuscript'}
                   <div className="bg-blue-500 rounded-full p-1"><Wand2 size={16} /></div>
                 </button>
                 {project.chapters.length === 0 && (
                   <p className="text-sm text-slate-400 mt-4 font-medium">
                      This process may take a few moments per chapter.
                   </p>
                 )}
               </div>
            </div>
          )}

          {project.currentStep === 2 && project.outline && (
            <BookReader 
              outline={project.outline} 
              chapters={project.chapters} 
              onChapterUpdate={(updatedChapter) => {
                 const newChapters = project.chapters.map(c => c.chapterNumber === updatedChapter.chapterNumber ? updatedChapter : c);
                 updateProject({ chapters: newChapters });
              }}
              user={user}
            />
          )}

        </div>
      </div>
    </div>
  );
};
