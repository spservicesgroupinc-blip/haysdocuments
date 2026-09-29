
import React, { useState, useEffect, useRef } from 'react';
import { BookProject, AppView, Source, SourceType, WritingStyle, ChapterContent, User } from './types';
import { Dashboard } from './components/Dashboard';
import { ProjectEditor } from './components/ProjectEditor';
import { AuthScreen } from './components/AuthScreen';
import { writeChapter, getDeepseekKey, setDeepseekKey } from './services/deepseek';
import { StorageService } from './services/storage';
import { CloudService } from './services/cloud';
import { Sparkles, Key, Loader2 } from 'lucide-react';
import { CostTracker } from './components/CostTracker';

// Extract a clean, sentence-aligned excerpt from the end of a chapter's
// written content, stripping markdown headings and rules so the seam the
// next chapter continues from is pure prose.
const extractChapterEnding = (content: string, maxChars: number): string => {
  let text = content
    .replace(/\r/g, '')
    .replace(/^#{1,6}\s.*$/gm, '')            // markdown headings
    .replace(/^\s*([-*_]\s*){3,}\s*$/gm, '')  // horizontal rules
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')     // image embeds
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  if (text.length <= maxChars) return text;

  let excerpt = text.slice(-maxChars);
  // Advance to the next sentence or paragraph boundary so we never start mid-sentence
  const boundary = excerpt.search(/[.!?…]["')\]]*(?:\s|$)/);
  if (boundary > 0 && boundary < excerpt.length - 1) {
    excerpt = excerpt.slice(boundary).replace(/^[.!?…]["')\]]*\s*/, '').trim();
  }
  return excerpt;
};

const App: React.FC = () => {
  const [view, setView] = useState<AppView>(AppView.AUTH);
  const [projects, setProjects] = useState<BookProject[]>([]);
  const [activeProjectId, setActiveProjectId] = useState<string | null>(null);
  const [isLoaded, setIsLoaded] = useState(false);
  const [user, setUser] = useState<User | undefined>(undefined);
  
  // API Key State
  const [hasApiKey, setHasApiKey] = useState(false);
  const [isKeyChecked, setIsKeyChecked] = useState(false);
  const [apiKeyInput, setApiKeyInput] = useState('');
  
  // Background Generation State
  const [generatingProjectId, setGeneratingProjectId] = useState<string | null>(null);
  const wakeLockRef = useRef<WakeLockSentinel | null>(null);

  // Sync State
  const [isLoggingIn, setIsLoggingIn] = useState(false);

  // Initial Key Check
  useEffect(() => {
    setHasApiKey(!!getDeepseekKey().trim());
    setIsKeyChecked(true);
  }, []);

  const handleSaveKey = () => {
    const key = apiKeyInput.trim();
    if (!key) return;
    setDeepseekKey(key);
    setApiKeyInput('');
    setHasApiKey(true);
  };

  // Initial Load from Storage
  useEffect(() => {
    const loadData = async () => {
      try {
        const savedUser = localStorage.getItem('lore_user');
        if (savedUser) {
          setUser(JSON.parse(savedUser));
        }

        const loadedProjects = await StorageService.getAllProjects();
        setProjects(loadedProjects);
        
        const lastActiveId = await StorageService.getActiveProjectId();
        if (lastActiveId && loadedProjects.find(p => p.id === lastActiveId)) {
          setActiveProjectId(lastActiveId);
          setView(AppView.EDITOR);
          window.history.replaceState({ view: AppView.EDITOR, projectId: lastActiveId }, '');
        } else if (savedUser) {
           setView(AppView.DASHBOARD);
        }
      } catch (e) {
        console.error("Failed to load data", e);
      } finally {
        setIsLoaded(true);
      }
    };
    loadData();
  }, []);

  // Save changes to Local Storage
  useEffect(() => {
    if (!isLoaded) return; 

    const saveData = async () => {
      try {
        await StorageService.saveAllProjects(projects);
        await StorageService.saveActiveProjectId(activeProjectId);
      } catch (e: any) {
        if (e.name === 'QuotaExceededError') {
           alert("⚠️ Disk Full! Your device storage is full.");
        } else {
           console.error("Failed to save project", e);
        }
      }
    };

    const timeout = setTimeout(saveData, 500);
    return () => clearTimeout(timeout);
  }, [projects, activeProjectId, isLoaded]);

  // Auto-save active project to Cloud (Debounced)
  useEffect(() => {
    if (!user || !activeProjectId) return;
    
    const projectToSave = projects.find(p => p.id === activeProjectId);
    if (!projectToSave) return;

    // We debounce cloud saves to avoid overwhelming Apps Script (which is slow)
    // 5 seconds after last change, we push to cloud
    const timeout = setTimeout(async () => {
        try {
            // Quietly sync up
            await CloudService.syncUp(user, projectToSave);
            console.log(`Cloud auto-save complete for ${projectToSave.title}`);
        } catch (e) {
            console.error("Cloud auto-save failed", e);
        }
    }, 5000); 

    return () => clearTimeout(timeout);
  }, [projects, activeProjectId, user]);

  // Handle Browser Back Button
  useEffect(() => {
    const handlePopState = (event: PopStateEvent) => {
      if (!user) {
        setView(AppView.AUTH);
        return;
      }
      if (event.state && event.state.view === AppView.EDITOR) {
        setActiveProjectId(event.state.projectId);
        setView(AppView.EDITOR);
      } else {
        setActiveProjectId(null);
        setView(AppView.DASHBOARD);
      }
    };

    window.addEventListener('popstate', handlePopState);
    return () => window.removeEventListener('popstate', handlePopState);
  }, [user]);

  // --- Background Generator Logic ---

  const requestWakeLock = async () => {
    try {
      if ('wakeLock' in navigator) {
        wakeLockRef.current = await navigator.wakeLock.request('screen');
      }
    } catch (err: any) {
      if (err.name !== 'NotAllowedError') {
        console.warn(`Wake Lock failed: ${err}`);
      }
    }
  };

  const releaseWakeLock = async () => {
    if (wakeLockRef.current) {
      try {
        await wakeLockRef.current.release();
        wakeLockRef.current = null;
      } catch (err) {
        console.error(`Wake Lock release failed: ${err}`);
      }
    }
  };

  const startBookGeneration = async (projectId: string, style: WritingStyle) => {
    const project = projects.find(p => p.id === projectId);
    if (!project || !project.outline) return;
    
    setGeneratingProjectId(projectId);
    await requestWakeLock();

    const currentChapters: ChapterContent[] = project.outline.chapters.map(outlineChap => {
      const existing = project.chapters.find(c => c.chapterNumber === outlineChap.chapterNumber);
      if (existing) {
        return { ...existing, title: outlineChap.title };
      }
      return {
        chapterNumber: outlineChap.chapterNumber,
        title: outlineChap.title,
        content: '',
        isGenerating: true
      };
    });

    handleUpdateProject({ ...project, chapters: currentChapters });

    let hasFatalError = false;

    for (const chapOutline of project.outline.chapters) {
      const chapterToGen = currentChapters.find(c => c.chapterNumber === chapOutline.chapterNumber);
      
      if (chapterToGen && chapterToGen.content && !chapterToGen.isGenerating) {
        continue;
      }
      
      if (hasFatalError) break;

      try {
        // Build continuity context from what has ACTUALLY been written:
        // 1. Seam: the final passage of the immediately previous chapter
        const prevChapterIndex = project.outline.chapters.findIndex(c => c.chapterNumber === chapOutline.chapterNumber) - 1;
        let previousChapterEnding = "";
        let previousChapterTitle = "";
        if (prevChapterIndex >= 0) {
          const prevChapNum = project.outline.chapters[prevChapterIndex].chapterNumber;
          const prevCompleted = currentChapters.find(c => c.chapterNumber === prevChapNum);
          if (prevCompleted && prevCompleted.content) {
             previousChapterEnding = extractChapterEnding(prevCompleted.content, 1500);
             previousChapterTitle = prevCompleted.title;
          }
        }

        // 2. Reader knowledge: one line per preceding chapter. Chapters that are
        //    already written contribute their ACTUAL final passage; unwritten
        //    chapters fall back to their outline summary. The most recent
        //    chapters always win within the budget.
        const MAX_RECAP_CHARS = 6000;
        const precedingChapters = project.outline.chapters.filter(c => c.chapterNumber < chapOutline.chapterNumber);
        const chapterSnips = precedingChapters.map(c => {
          const label = c.chapterNumber === 0 ? 'Intro' : `Ch. ${c.chapterNumber}`;
          const written = currentChapters.find(x => x.chapterNumber === c.chapterNumber && x.content && !x.isGenerating);
          if (written) {
            const ending = extractChapterEnding(written.content, 400);
            return `${label} "${c.title}" — ended with: "${ending}"`;
          }
          return `${label} "${c.title}" (planned): ${c.summary}`;
        });
        const recapLines: string[] = [];
        let recapBudget = 0;
        for (let i = chapterSnips.length - 1; i >= 0; i--) {
          if (recapBudget + chapterSnips[i].length > MAX_RECAP_CHARS) break;
          recapLines.unshift(chapterSnips[i]);
          recapBudget += chapterSnips[i].length;
        }
        const storySoFarRecap = recapLines.join('\n');

        const content = await writeChapter(chapOutline, project.outline, project.sources, {
          style: style,
          pov: project.settings?.pov || 'third_limited',
          tense: project.settings?.tense || 'past',
          targetDepth: project.settings?.targetDepth || 'standard',
          twoPassPolish: project.settings?.twoPassPolish !== false,
          previousChapterTitle: previousChapterTitle,
          previousChapterEnding: previousChapterEnding,
          storySoFarRecap: storySoFarRecap,
          loreVault: project.outline.loreVault || project.outline.loreBible
        });
        
        setProjects(prevProjects => prevProjects.map(p => {
          if (p.id !== projectId) return p;
          
          const updatedChapters = p.chapters.map(c => 
            c.chapterNumber === chapOutline.chapterNumber 
              ? { ...c, content, isGenerating: false }
              : c
          );
          
          return { ...p, chapters: updatedChapters, lastModified: Date.now() };
        }));

        const idx = currentChapters.findIndex(c => c.chapterNumber === chapOutline.chapterNumber);
        if (idx !== -1) {
            currentChapters[idx] = { ...currentChapters[idx], content, isGenerating: false };
        }

      } catch (e: any) {
         console.error(`Error generating chapter ${chapOutline.chapterNumber}`, e);
         const isFatal = e?.status === 401 || e?.status === 402 || e?.status === 403 ||
           e?.message?.includes('Invalid API key') || e?.message?.includes('Insufficient Balance') ||
           e?.message?.includes('No DeepSeek API key');
         
         if (isFatal) {
             hasFatalError = true;
             alert(`Generation Stopped: ${e.message}`);
         }

         setProjects(prevProjects => prevProjects.map(p => {
            if (p.id !== projectId) return p;
            const updatedChapters = p.chapters.map(c => 
              c.chapterNumber === chapOutline.chapterNumber 
                ? { ...c, isGenerating: false, content: isFatal ? "Stopped due to API error." : "Generation failed. Please retry." }
                : c
            );
            return { ...p, chapters: updatedChapters };
         }));
      }
    }

    setGeneratingProjectId(null);
    await releaseWakeLock();
  };

  // --- End Generator Logic ---

  const handleCreateProject = () => {
    const newProject: BookProject = {
      id: crypto.randomUUID(),
      title: 'Untitled Manuscript',
      lastModified: Date.now(),
      sources: [],
      outline: null,
      chapters: [],
      currentStep: 0,
    };
    
    setProjects(prev => [newProject, ...prev]);
    setActiveProjectId(newProject.id);
    setView(AppView.EDITOR);
    window.history.pushState({ view: AppView.EDITOR, projectId: newProject.id }, '');
  };

  const handleCreateSequel = (originalProject: BookProject) => {
     const seriesId = originalProject.seriesId || crypto.randomUUID();
     const nextIndex = (originalProject.seriesIndex || 1) + 1;

     if (!originalProject.seriesId) {
        const updatedOriginal = { ...originalProject, seriesId, seriesIndex: 1 };
        handleUpdateProject(updatedOriginal);
     }

     const contextContent = `PREVIOUS BOOK CONTEXT:
Title: ${originalProject.title}
Description: ${originalProject.outline?.description || 'No description available.'}

CHAPTER SUMMARIES:
${originalProject.outline?.chapters.map(c => `Chapter ${c.chapterNumber}: ${c.title}\n${c.summary}`).join('\n\n') || 'No chapters available.'}
`;

    const contextSource: Source = {
      id: crypto.randomUUID(),
      type: SourceType.TEXT,
      name: `Context: ${originalProject.title}`,
      content: contextContent,
      isProcessing: false
    };

    const newProject: BookProject = {
      id: crypto.randomUUID(),
      title: `Sequel to ${originalProject.title}`,
      lastModified: Date.now(),
      sources: [contextSource],
      outline: null,
      chapters: [],
      currentStep: 0,
      seriesId: seriesId,
      seriesIndex: nextIndex
    };

    setProjects(prev => [newProject, ...prev]);
    setActiveProjectId(newProject.id);
    setView(AppView.EDITOR);
    window.history.pushState({ view: AppView.EDITOR, projectId: newProject.id }, '');
  };

  const handleUpdateProject = (updatedProject: BookProject) => {
    setProjects(prev => prev.map(p => p.id === updatedProject.id ? updatedProject : p));
  };

  const handleDeleteProject = (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    if (window.confirm('Are you sure you want to delete this project? This action cannot be undone.')) {
      setProjects(prev => prev.filter(p => p.id !== id));
      if (activeProjectId === id) {
        setActiveProjectId(null);
        setView(AppView.DASHBOARD);
        window.history.replaceState({ view: AppView.DASHBOARD }, '');
      }
    }
  };

  const handleSelectProject = (project: BookProject) => {
    setActiveProjectId(project.id);
    setView(AppView.EDITOR);
    window.history.pushState({ view: AppView.EDITOR, projectId: project.id }, '');
  };

  const handleBackToDashboard = () => {
    setActiveProjectId(null);
    setView(AppView.DASHBOARD);
    window.history.pushState({ view: AppView.DASHBOARD }, '');
  };

  const handleLogin = async (user: User) => {
    setIsLoggingIn(true);
    setUser(user);
    localStorage.setItem('lore_user', JSON.stringify(user));

    try {
        // Automatically sync down from cloud to get previous books
        const cloudProjects = await CloudService.syncDown(user);
        
        // Merge Strategy: Combine cloud and local. If ID exists in both, prefer the one with newer timestamp.
        setProjects(prev => {
            const merged = [...prev];
            cloudProjects.forEach(cp => {
                const existingIdx = merged.findIndex(p => p.id === cp.id);
                if (existingIdx !== -1) {
                    // Update if cloud version is newer
                    if (cp.lastModified > merged[existingIdx].lastModified) {
                        merged[existingIdx] = cp;
                    }
                } else {
                    // Add new from cloud
                    merged.push(cp);
                }
            });
            // Persist merged state to local storage immediately
            StorageService.saveAllProjects(merged);
            return merged;
        });

    } catch(e) {
        console.error("Auto-sync on login failed", e);
        // We continue to dashboard even if sync fails, so user isn't stuck
    } finally {
        setIsLoggingIn(false);
        setView(AppView.DASHBOARD);
    }
  };

  const handleLogout = () => {
    setUser(undefined);
    localStorage.removeItem('lore_user');
    setView(AppView.AUTH);
  };

  const handleSyncProjects = (cloudProjects: BookProject[]) => {
      const merged = [...projects];
      cloudProjects.forEach(cp => {
          const idx = merged.findIndex(p => p.id === cp.id);
          if (idx !== -1) {
              if (cp.lastModified > merged[idx].lastModified) {
                  merged[idx] = cp;
              }
          } else {
              merged.push(cp);
          }
      });
      setProjects(merged);
  };

  const activeProject = projects.find(p => p.id === activeProjectId);

  // Loading State for API Key and Data
  if (!isKeyChecked || !isLoaded) {
     return (
        <div className="min-h-screen bg-slate-50 flex items-center justify-center">
           <div className="animate-pulse flex flex-col items-center">
              <div className="w-12 h-12 bg-blue-200 rounded-full mb-4"></div>
              <div className="text-slate-400 font-medium">Initializing Lore...</div>
           </div>
        </div>
     );
  }
  
  // Login loading state
  if (isLoggingIn) {
     return (
        <div className="min-h-screen bg-slate-50 flex items-center justify-center">
           <div className="flex flex-col items-center">
              <Loader2 className="w-12 h-12 text-blue-600 animate-spin mb-4" />
              <div className="text-slate-800 font-bold text-lg">Syncing Library...</div>
              <p className="text-slate-500 text-sm mt-1">Retrieving your books from the cloud.</p>
           </div>
        </div>
     );
  }

  // API Key Screen (Priority 1)
  if (!hasApiKey) {
    return (
      <div className="min-h-screen bg-slate-50 flex flex-col items-center justify-center p-6 text-center animate-in fade-in">
        <div className="bg-white p-10 rounded-2xl shadow-xl border border-slate-200 max-w-lg w-full">
           <div className="w-16 h-16 bg-blue-100 text-blue-600 rounded-2xl flex items-center justify-center mx-auto mb-6">
              <Sparkles size={32} />
           </div>
           <h1 className="text-3xl font-serif font-bold text-slate-900 mb-3">Welcome to Lore</h1>
           <p className="text-slate-600 mb-8 leading-relaxed">
             To write full-length manuscripts, Lore uses the <span className="font-semibold text-slate-500">DeepSeek</span> AI API. Paste your API key below.
           </p>
           
           <div className="space-y-3">
             <input
               type="password"
               value={apiKeyInput}
               onChange={(e) => setApiKeyInput(e.target.value)}
               onKeyDown={(e) => { if (e.key === 'Enter') handleSaveKey(); }}
               placeholder="sk-..."
               autoFocus
               className="w-full border border-slate-200 rounded-xl px-4 py-3 text-slate-800 text-sm outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent font-mono"
             />
             <button 
               onClick={handleSaveKey}
               disabled={!apiKeyInput.trim()}
               className="w-full bg-blue-600 hover:bg-blue-500 disabled:opacity-40 disabled:cursor-not-allowed text-white font-bold text-lg py-4 rounded-xl transition-all shadow-lg shadow-blue-600/20 hover:scale-[1.02] flex items-center justify-center gap-2"
             >
               <Key size={20} />
               Save &amp; Continue
             </button>
           </div>

           <div className="mt-6 text-xs text-slate-400">
             <p className="mb-2">Your key is stored only on this device (localStorage) and sent directly to the DeepSeek API.</p>
             <p>
               Need a key? Create one at <a href="https://platform.deepseek.com/api_keys" target="_blank" rel="noreferrer" className="underline hover:text-blue-600">platform.deepseek.com</a>.
             </p>
           </div>
        </div>
      </div>
    );
  }

  return (
    <>
      <CostTracker />
      {/* Auth Screen (Priority 2) */}
      {(!user || view === AppView.AUTH) ? (
        <AuthScreen onLogin={handleLogin} />
      ) : (
        /* Main App */
        (view === AppView.EDITOR && activeProject) ? (
          <ProjectEditor 
            project={activeProject} 
            onUpdateProject={handleUpdateProject}
            onBack={handleBackToDashboard}
            onStartGeneration={(style) => startBookGeneration(activeProject.id, style)}
            isGeneratingGlobal={generatingProjectId === activeProject.id}
            user={user}
          />
        ) : (
          <Dashboard 
            projects={projects} 
            user={user}
            onCreateProject={handleCreateProject}
            onSelectProject={handleSelectProject}
            onDeleteProject={handleDeleteProject}
            onCreateSequel={handleCreateSequel}
            onSyncProjects={handleSyncProjects}
            onLogout={handleLogout}
            generatingProjectId={generatingProjectId}
          />
        )
      )}
    </>
  );
};

export default App;
