
import { BookProject } from '../types';

const DB_NAME = 'LoreDB';
const STORE_PROJECTS = 'projects';
const STORE_SETTINGS = 'settings';
const VERSION = 1;

const initDB = (): Promise<IDBDatabase> => {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, VERSION);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result);
    request.onupgradeneeded = (event) => {
      const db = (event.target as IDBOpenDBRequest).result;
      if (!db.objectStoreNames.contains(STORE_PROJECTS)) {
        db.createObjectStore(STORE_PROJECTS, { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains(STORE_SETTINGS)) {
        db.createObjectStore(STORE_SETTINGS);
      }
    };
  });
};

export const StorageService = {
  async getAllProjects(): Promise<BookProject[]> {
    // 1. Attempt Legacy Migration (LocalStorage -> IndexedDB)
    try {
        const legacy = localStorage.getItem('storyforge_projects');
        if (legacy) {
            console.log("Migrating legacy data to IndexedDB...");
            const projects = JSON.parse(legacy);
            await this.saveAllProjects(projects); 
            localStorage.removeItem('storyforge_projects'); // Clear legacy to free up space
            return projects;
        }
    } catch(e) { console.error("Migration failed", e); }

    // 2. Load from IndexedDB
    const db = await initDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_PROJECTS, 'readonly');
      const store = tx.objectStore(STORE_PROJECTS);
      const request = store.getAll();
      request.onsuccess = () => resolve(request.result || []);
      request.onerror = () => reject(request.error);
    });
  },

  async saveAllProjects(projects: BookProject[]): Promise<void> {
    const db = await initDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_PROJECTS, 'readwrite');
      const store = tx.objectStore(STORE_PROJECTS);
      
      // Clear and rewrite ensures sync with React state. 
      // Since IDB is fast, this is acceptable for typical usage.
      const clearReq = store.clear();
      
      clearReq.onsuccess = () => {
         projects.forEach(p => store.put(p));
      };

      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  },
  
  async getActiveProjectId(): Promise<string | null> {
    // Check legacy first
    const legacyId = localStorage.getItem('storyforge_active_project');
    if (legacyId) {
        localStorage.removeItem('storyforge_active_project');
        await this.saveActiveProjectId(legacyId);
        return legacyId;
    }

    const db = await initDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_SETTINGS, 'readonly');
      const store = tx.objectStore(STORE_SETTINGS);
      const request = store.get('activeProjectId');
      request.onsuccess = () => resolve(request.result || null);
      request.onerror = () => resolve(null);
    });
  },

  async saveActiveProjectId(id: string | null): Promise<void> {
    const db = await initDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_SETTINGS, 'readwrite');
      const store = tx.objectStore(STORE_SETTINGS);
      if (id) store.put(id, 'activeProjectId');
      else store.delete('activeProjectId');
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }
};
