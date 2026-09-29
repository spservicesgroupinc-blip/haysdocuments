
import React, { useState } from 'react';
import { BookProject, User } from '../types';
import { Plus, Clock, Trash2, Download, BookCopy, Layers, Feather, Loader2, TrendingUp, X, ExternalLink, Globe, Lightbulb, Cloud, LogOut } from 'lucide-react';
import { researchBookTrends, TrendResult } from '../services/gemini';
import { CloudService } from '../services/cloud';
import { StorageService } from '../services/storage';
import ReactMarkdown from 'react-markdown';

interface DashboardProps {
  projects: BookProject[];
  user?: User;
  onCreateProject: () => void;
  onSelectProject: (project: BookProject) => void;
  onDeleteProject: (id: string, e: React.MouseEvent) => void;
  onCreateSequel?: (project: BookProject) => void;
  onSyncProjects?: (projects: BookProject[]) => void;
  onLogout?: () => void;
  generatingProjectId?: string | null;
}

export const Dashboard: React.FC<DashboardProps> = ({ 
  projects, 
  user,
  onCreateProject, 
  onSelectProject,
  onDeleteProject,
  onCreateSequel,
  onSyncProjects,
  onLogout,
  generatingProjectId
}) => {
  const [showTrends, setShowTrends] = useState(false);
  const [isResearching, setIsResearching] = useState(false);
  const [isSyncing, setIsSyncing] = useState(false);
  const [trendData, setTrendData] = useState<TrendResult | null>(null);

  const formatDate = (timestamp: number) => {
    return new Date(timestamp).toLocaleDateString('en-US', {
      month: 'long',
      day: 'numeric',
      year: 'numeric'
    });
  };

  const handleBackup = (e: React.MouseEvent, project: BookProject) => {
    e.stopPropagation();
    const element = document.createElement("a");
    const file = new Blob([JSON.stringify(project, null, 2)], {type: 'application/json'});
    element.href = URL.createObjectURL(file);
    element.download = `backup_${project.title.replace(/[^a-z0-9]/gi, '_').toLowerCase()}.json`;
    document.body.appendChild(element);
    element.click();
    document.body.removeChild(element);
  };

  const handleCloudSync = async () => {
    if (!user || !onSyncProjects) return;
    setIsSyncing(true);
    try {
        // 1. Sync Up: Save all local projects to Drive
        // (In a real app, you'd only sync modified ones, but for this demo we just push all)
        for (const p of projects) {
            await CloudService.syncUp(user, p);
        }

        // 2. Sync Down: Get everything from Drive
        const cloudProjects = await CloudService.syncDown(user);
        
        // Merge strategy: Cloud wins conflicts, or simple union based on ID
        // For simplicity: We use cloud list, but if local has newer modification, we keep local?
        // Let's just trust cloud as "source of truth" for the sync button action
        onSyncProjects(cloudProjects);
        
        alert(`Sync Complete! ${cloudProjects.length} projects synced.`);
    } catch (e: any) {
        alert("Sync Failed: " + e.message);
    } finally {
        setIsSyncing(false);
    }
  };

  const handleResearch = async () => {
    setIsResearching(true);
    setTrendData(null);
    try {
      const data = await researchBookTrends();
      setTrendData(data);
    } catch (e) {
      console.error(e);
      // Fallback simple message in data
      setTrendData({ content: "Unable to retrieve trends at this time. Please try again later.", sources: [] });
    } finally {
      setIsResearching(false);
    }
  };

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900">
      {/* Header */}
      <div className="bg-blue-950 border-b border-blue-900 text-white shadow-md">
        <div className="max-w-6xl mx-auto px-6 md:px-12 h-20 flex items-center justify-between">
          <div className="flex items-center gap-3">
             <div className="bg-white/10 text-blue-100 p-2 rounded-lg backdrop-blur-sm border border-white/10">
               <Feather size={20} strokeWidth={2} />
             </div>
             <div>
                <h1 className="font-serif text-2xl font-bold tracking-tight">Lore</h1>
                {user && <p className="text-[10px] text-blue-200 opacity-80 uppercase tracking-widest">{user.username}</p>}
             </div>
          </div>
          <div className="flex items-center gap-3">
            {user && (
                <>
                <button 
                    onClick={handleCloudSync}
                    disabled={isSyncing}
                    className="bg-blue-900/50 hover:bg-blue-800 text-blue-100 border border-blue-800 px-3 py-2.5 rounded-lg font-medium text-xs flex items-center gap-2 transition-all"
                    title="Sync to Drive"
                >
                    <Cloud size={16} className={isSyncing ? 'animate-bounce' : ''} />
                    {isSyncing ? 'Syncing...' : 'Sync'}
                </button>
                <button 
                    onClick={onLogout}
                    className="bg-blue-900/50 hover:bg-red-900/50 text-blue-100 hover:text-red-100 border border-blue-800 hover:border-red-800 p-2.5 rounded-lg transition-all"
                    title="Logout"
                >
                    <LogOut size={16} />
                </button>
                <div className="h-6 w-px bg-blue-800 mx-1"></div>
                </>
            )}

            <button 
              onClick={() => setShowTrends(true)}
              className="bg-blue-900/50 hover:bg-blue-800 text-blue-100 border border-blue-800 px-4 py-2.5 rounded-lg font-medium text-sm flex items-center gap-2 transition-all"
            >
              <TrendingUp size={16} />
              <span className="hidden md:inline">Market Trends</span>
            </button>
            <button 
              onClick={onCreateProject}
              className="bg-blue-600 hover:bg-blue-500 text-white px-5 py-2.5 rounded-lg font-medium text-sm flex items-center gap-2 transition-all shadow-lg shadow-blue-900/20 hover:shadow-blue-600/20 hover:-translate-y-0.5"
            >
              <Plus size={18} />
              <span className="hidden md:inline">New Manuscript</span>
              <span className="md:hidden">New</span>
            </button>
          </div>
        </div>
      </div>

      {/* Projects List */}
      <div className="max-w-6xl mx-auto px-6 md:px-12 py-12">
        <div className="flex items-end justify-between mb-8">
          <h2 className="text-2xl font-serif font-bold text-slate-900">My Library</h2>
          <div className="text-sm text-slate-500 font-medium">
            {projects.length} {projects.length === 1 ? 'Project' : 'Projects'}
          </div>
        </div>
        
        {projects.length === 0 ? (
          <div className="text-center py-24 bg-white rounded-xl border-2 border-dashed border-slate-200 shadow-sm">
            <div className="w-20 h-20 bg-blue-50 rounded-full flex items-center justify-center mx-auto mb-6 text-blue-500">
              <Feather size={32} strokeWidth={1.5} />
            </div>
            <h3 className="text-lg font-bold text-slate-900 mb-2">No manuscripts yet</h3>
            <p className="text-slate-500 max-w-md mx-auto mb-8 font-light leading-relaxed">
              Begin your journey by creating a new project. Transform your spoken stories into a written masterpiece.
            </p>
            <button 
              onClick={onCreateProject}
              className="text-blue-600 font-semibold border-b-2 border-blue-100 hover:border-blue-600 pb-0.5 transition-all"
            >
              Start Writing &rarr;
            </button>
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
            {projects.map(project => {
              const isGenerating = generatingProjectId === project.id;
              
              return (
              <div 
                key={project.id}
                onClick={() => onSelectProject(project)}
                className={`group bg-white rounded-xl border border-slate-200 shadow-sm hover:shadow-xl hover:shadow-blue-900/5 hover:border-blue-200 transition-all cursor-pointer flex flex-col h-72 relative overflow-hidden ${isGenerating ? 'ring-2 ring-blue-500 ring-offset-2' : ''}`}
              >
                <div className="absolute top-0 left-0 w-full h-1.5 bg-gradient-to-r from-blue-600 to-blue-400 opacity-0 group-hover:opacity-100 transition-opacity"></div>
                
                <div className="p-8 flex-1 flex flex-col relative z-10">
                   {/* Decorative background letter */}
                   <span className="font-serif text-8xl text-slate-50 font-bold absolute -bottom-4 -right-4 select-none group-hover:text-blue-50 transition-colors duration-300 -z-10">
                      {project.title.charAt(0).toUpperCase()}
                   </span>

                  <div className="relative">
                    <div className="flex items-center justify-between mb-3">
                      <div className="flex items-center gap-2 text-xs text-blue-600 font-bold uppercase tracking-wider">
                        <div className={`w-2 h-2 rounded-full ${isGenerating ? 'bg-blue-500 animate-pulse' : 'bg-blue-500'}`}></div>
                        {isGenerating ? 'Writing Now...' : project.outline ? 'In Progress' : 'Drafting'}
                      </div>
                      {project.seriesId && (
                         <div className="flex items-center gap-1 text-[10px] text-purple-600 font-bold uppercase tracking-wider bg-purple-50 px-2 py-0.5 rounded-full border border-purple-100">
                            <Layers size={10} />
                            {project.seriesIndex ? `Vol. ${project.seriesIndex}` : 'Series'}
                         </div>
                      )}
                    </div>
                    <h3 className="font-serif font-bold text-xl text-slate-900 mb-3 line-clamp-2 leading-tight group-hover:text-blue-700 transition-colors">
                      {project.title}
                    </h3>
                    <div className="flex items-center gap-2 text-xs text-slate-400 font-medium">
                      {isGenerating ? (
                        <div className="text-blue-600 flex items-center gap-1">
                           <Loader2 size={12} className="animate-spin" /> Auto-Saving...
                        </div>
                      ) : (
                        <>
                          <Clock size={12} />
                          Edited {formatDate(project.lastModified)}
                        </>
                      )}
                    </div>
                  </div>
                </div>

                <div className="bg-slate-50/50 border-t border-slate-100 px-6 py-4 flex items-center justify-between backdrop-blur-sm relative z-20">
                   <div className="flex gap-2">
                      <span className="text-xs font-semibold px-2.5 py-1 bg-white border border-slate-200 rounded-md text-slate-600 shadow-sm group-hover:border-blue-200 group-hover:text-blue-700 transition-colors">
                        {project.outline ? `${project.outline.chapters.length} Chapters` : 'Source Gathering'}
                      </span>
                   </div>
                   
                   <div className="flex gap-1 transform translate-y-0 transition-all duration-200">
                      {onCreateSequel && project.outline && (
                        <button 
                          onClick={(e) => { e.stopPropagation(); onCreateSequel(project); }}
                          className="p-2 text-slate-400 hover:text-purple-600 hover:bg-purple-50 rounded-md transition-colors relative z-30"
                          title="Create Sequel / Next in Series"
                        >
                          <BookCopy size={16} />
                        </button>
                      )}
                      <button 
                        onClick={(e) => handleBackup(e, project)}
                        className="p-2 text-slate-400 hover:text-blue-600 hover:bg-blue-50 rounded-md transition-colors relative z-30"
                        title="Backup"
                      >
                        <Download size={16} />
                      </button>
                      <button 
                        onClick={(e) => onDeleteProject(project.id, e)}
                        className="p-2 text-slate-400 hover:text-red-600 hover:bg-red-50 rounded-md transition-colors relative z-30"
                        title="Delete"
                      >
                        <Trash2 size={16} />
                      </button>
                   </div>
                </div>
              </div>
            )})}
          </div>
        )}
      </div>

      {/* Market Trends Modal */}
      {showTrends && (
        <div className="fixed inset-0 z-50 bg-slate-900/60 backdrop-blur-sm flex items-center justify-center p-4 animate-in fade-in">
          <div className="bg-white w-full max-w-4xl h-[80vh] rounded-2xl shadow-2xl flex flex-col overflow-hidden border border-slate-200">
             
             {/* Modal Header */}
             <div className="bg-blue-950 text-white p-6 flex justify-between items-start shrink-0">
                <div>
                   <h2 className="text-2xl font-serif font-bold flex items-center gap-2">
                     <Globe size={24} className="text-blue-300" />
                     E-Book Market Research
                   </h2>
                   <p className="text-blue-200 text-sm mt-1">Deep web analysis of current sales trends and popular genres.</p>
                </div>
                <button 
                  onClick={() => setShowTrends(false)}
                  className="p-2 text-blue-200 hover:text-white hover:bg-white/10 rounded-lg transition-colors"
                >
                  <X size={24} />
                </button>
             </div>

             {/* Modal Body */}
             <div className="flex-1 overflow-y-auto p-8 bg-slate-50">
                {!trendData && !isResearching && (
                  <div className="flex flex-col items-center justify-center h-full text-center space-y-6">
                     <div className="w-20 h-20 bg-blue-100 rounded-full flex items-center justify-center text-blue-600">
                        <TrendingUp size={40} />
                     </div>
                     <div className="max-w-md">
                       <h3 className="text-xl font-bold text-slate-900 mb-2">Discover Your Next Bestseller</h3>
                       <p className="text-slate-500 mb-8">
                         Our AI will scour the web for real-time data on gross sales, trending tropes, and rising niches to help you find a profitable story idea.
                       </p>
                       <button 
                         onClick={handleResearch}
                         className="bg-blue-600 hover:bg-blue-500 text-white px-8 py-4 rounded-xl font-bold text-lg shadow-xl shadow-blue-600/20 hover:scale-105 transition-all flex items-center gap-3 mx-auto"
                       >
                         <Lightbulb size={20} />
                         Analyze Market Trends
                       </button>
                     </div>
                  </div>
                )}

                {isResearching && (
                  <div className="flex flex-col items-center justify-center h-full text-center space-y-6 animate-pulse">
                     <Loader2 size={48} className="animate-spin text-blue-600" />
                     <h3 className="text-xl font-bold text-slate-700">Analyzing Global Sales Data...</h3>
                     <div className="flex gap-2">
                       <span className="w-2 h-2 bg-slate-300 rounded-full animate-bounce delay-0"></span>
                       <span className="w-2 h-2 bg-slate-300 rounded-full animate-bounce delay-100"></span>
                       <span className="w-2 h-2 bg-slate-300 rounded-full animate-bounce delay-200"></span>
                     </div>
                  </div>
                )}

                {trendData && (
                  <div className="animate-in fade-in slide-in-from-bottom-4">
                    <div className="prose prose-slate max-w-none prose-headings:font-serif prose-headings:text-blue-900 prose-a:text-blue-600">
                      <ReactMarkdown>{trendData.content}</ReactMarkdown>
                    </div>
                    
                    {trendData.sources.length > 0 && (
                      <div className="mt-12 pt-8 border-t border-slate-200">
                        <h4 className="text-xs font-bold text-slate-400 uppercase tracking-widest mb-4">Sources & References</h4>
                        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                          {trendData.sources.map((source, idx) => (
                            <a 
                              key={idx} 
                              href={source.uri} 
                              target="_blank" 
                              rel="noopener noreferrer"
                              className="flex items-center gap-2 p-3 bg-white border border-slate-200 rounded-lg text-sm text-slate-600 hover:text-blue-600 hover:border-blue-300 transition-all group"
                            >
                              <ExternalLink size={14} className="shrink-0 group-hover:text-blue-500" />
                              <span className="truncate">{source.title}</span>
                            </a>
                          ))}
                        </div>
                      </div>
                    )}

                    <div className="mt-8 flex justify-center">
                       <button 
                         onClick={handleResearch}
                         className="text-blue-600 hover:text-blue-800 font-bold text-sm flex items-center gap-2 bg-blue-50 hover:bg-blue-100 px-4 py-2 rounded-lg transition-colors"
                       >
                         <TrendingUp size={14} /> Refresh Analysis
                       </button>
                    </div>
                  </div>
                )}
             </div>
          </div>
        </div>
      )}
    </div>
  );
};
