
import React, { useState, useEffect } from 'react';
import { User } from '../types';
import { CloudService, BACKEND_URL } from '../services/cloud';
import { Feather, Loader2, Lock, User as UserIcon, Link } from 'lucide-react';

interface AuthScreenProps {
  onLogin: (user: User) => void;
}

export const AuthScreen: React.FC<AuthScreenProps> = ({ onLogin }) => {
  const [isLogin, setIsLogin] = useState(true);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Initialize URL: Prioritize the constant from code, then localStorage, then empty
  const [backendUrl, setBackendUrl] = useState('');
  
  useEffect(() => {
    if (BACKEND_URL && BACKEND_URL.trim() !== "") {
      setBackendUrl(BACKEND_URL);
    } else {
      setBackendUrl(localStorage.getItem('lore_backend_url') || '');
    }
  }, []);

  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!backendUrl) {
      setError("Please enter the Google Apps Script Web App URL.");
      return;
    }
    setError(null);
    setIsLoading(true);

    try {
      // Save URL for future convenience if it wasn't hardcoded
      if (!BACKEND_URL) {
        localStorage.setItem('lore_backend_url', backendUrl);
      }

      let user: User;
      if (isLogin) {
        user = await CloudService.login(backendUrl, username, password);
      } else {
        user = await CloudService.signup(backendUrl, username, password);
      }
      onLogin(user);
    } catch (err: any) {
      setError(err.message || "Authentication failed");
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-slate-50 flex items-center justify-center p-6">
      <div className="bg-white max-w-md w-full p-8 rounded-2xl shadow-xl border border-slate-100">
        <div className="text-center mb-8">
          <div className="w-16 h-16 bg-blue-900 rounded-xl flex items-center justify-center mx-auto mb-4 text-white shadow-lg shadow-blue-900/20">
             <Feather size={32} strokeWidth={2} />
          </div>
          <h1 className="text-3xl font-serif font-bold text-slate-900">Lore Cloud</h1>
          <p className="text-slate-500 mt-2">Sync your stories to Google Drive</p>
        </div>

        {error && (
          <div className="mb-6 p-4 bg-red-50 border border-red-100 text-red-600 text-sm rounded-lg">
            {error}
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-4">
          
          {/* Only show URL input if NOT hardcoded in source code */}
          {(!BACKEND_URL || BACKEND_URL === "") && (
            <div>
              <label className="block text-xs font-bold text-slate-400 uppercase tracking-widest mb-1.5">Backend URL</label>
              <div className="relative">
                <div className="absolute left-3 top-3 text-slate-400"><Link size={16} /></div>
                <input 
                  type="url" 
                  value={backendUrl}
                  onChange={(e) => setBackendUrl(e.target.value)}
                  placeholder="https://script.google.com/..."
                  className="w-full pl-10 pr-4 py-2.5 bg-slate-50 border border-slate-200 rounded-lg focus:ring-2 focus:ring-blue-500 outline-none text-sm"
                  required
                />
              </div>
              <p className="text-[10px] text-slate-400 mt-1">
                Deploy the provided Google Apps Script and paste the Web App URL here.
              </p>
            </div>
          )}

          <div>
            <label className="block text-xs font-bold text-slate-400 uppercase tracking-widest mb-1.5">Username</label>
            <div className="relative">
              <div className="absolute left-3 top-3 text-slate-400"><UserIcon size={16} /></div>
              <input 
                type="text" 
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                placeholder="Storyteller"
                className="w-full pl-10 pr-4 py-2.5 bg-slate-50 border border-slate-200 rounded-lg focus:ring-2 focus:ring-blue-500 outline-none"
                required
              />
            </div>
          </div>

          <div>
            <label className="block text-xs font-bold text-slate-400 uppercase tracking-widest mb-1.5">Password</label>
            <div className="relative">
              <div className="absolute left-3 top-3 text-slate-400"><Lock size={16} /></div>
              <input 
                type="password" 
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="••••••••"
                className="w-full pl-10 pr-4 py-2.5 bg-slate-50 border border-slate-200 rounded-lg focus:ring-2 focus:ring-blue-500 outline-none"
                required
              />
            </div>
          </div>

          <button 
            type="submit" 
            disabled={isLoading}
            className="w-full bg-blue-900 hover:bg-blue-800 text-white font-bold py-3 rounded-xl transition-all shadow-lg shadow-blue-900/20 flex items-center justify-center gap-2 mt-2"
          >
            {isLoading ? <Loader2 className="animate-spin" size={20} /> : (isLogin ? 'Login' : 'Create Account')}
          </button>
        </form>

        <div className="mt-6 text-center">
          <button 
            onClick={() => { setIsLogin(!isLogin); setError(null); }}
            className="text-sm text-slate-500 hover:text-blue-600 font-medium"
          >
            {isLogin ? "Need an account? Sign up" : "Already have an account? Login"}
          </button>
        </div>
      </div>
    </div>
  );
};
