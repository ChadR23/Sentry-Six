/**
 * Web API Layer for Sentry-Six
 * Replaces Electron IPC with REST API calls for Docker web mode
 * This file provides the same interface as electronAPI but uses fetch()
 */

(function() {
  'use strict';

  // Set web mode flag IMMEDIATELY before any other code runs
  // This must happen synchronously so ES modules can detect it
  if (typeof window.electronAPI === 'undefined') {
    window._sentryWebMode = true;
    console.log('[WebAPI] Web mode flag set: true');
  } else {
    window._sentryWebMode = false;
    console.log('[WebAPI] Electron mode detected, using native IPC');
    return; // Use native Electron API
  }

  console.log('[WebAPI] Web mode detected, initializing REST API layer');

  // Event listeners storage
  const eventListeners = new Map();
  let eventSource = null;

  // Helper function for API calls
  async function apiCall(endpoint, method = 'GET', body = null) {
    const options = {
      method,
      headers: {
        'Content-Type': 'application/json'
      }
    };
    
    if (body) {
      options.body = JSON.stringify(body);
    }
    
    try {
      const response = await fetch(`/api${endpoint}`, options);
      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || `HTTP ${response.status}`);
      }
      return await response.json();
    } catch (err) {
      console.error(`[WebAPI] API call failed: ${endpoint}`, err);
      throw err;
    }
  }

  // Create the web API object with the same interface as electronAPI
  window.electronAPI = {
    // ============================================
    // Folder/file operations
    // ============================================
    
    openFolder: async () => {
      // In web mode, we show a folder browser modal instead of native dialog
      return new Promise((resolve) => {
        window.showFolderBrowser((selectedPath) => {
          resolve(selectedPath);
        });
      });
    },
    
    openExternal: async (url) => {
      window.open(url, '_blank');
      return true;
    },
    
    // ============================================
    // File system operations
    // ============================================
    
    readDir: async (dirPath) => {
      console.log('[WebAPI] readDir:', dirPath);
      const result = await apiCall('/fs/readDir', 'POST', { dirPath });
      console.log('[WebAPI] readDir result:', result?.length, 'entries');
      return result;
    },
    
    readFile: async (filePath) => {
      const result = await apiCall('/fs/readFile', 'POST', { filePath });
      return result.data;
    },
    
    exists: async (filePath) => {
      const result = await apiCall('/fs/exists', 'POST', { filePath });
      return result.exists;
    },
    
    stat: async (filePath) => {
      const result = await apiCall('/fs/stat', 'POST', { filePath });
      return result;
    },
    
    showItemInFolder: async (filePath) => {
      // Not available in web mode - just log it
      console.log('[WebAPI] showItemInFolder not available in web mode:', filePath);
      return false;
    },
    
    // ============================================
    // Export operations
    // ============================================
    
    saveFile: async (options) => {
      // In web mode, we'll use the browser's download functionality
      // Return a path in the config directory
      const filename = options.defaultPath || `export_${Date.now()}.mp4`;
      return `/config/exports/${filename}`;
    },
    
    startExport: async (exportId, exportData) => {
      const result = await apiCall('/export/start', 'POST', { exportId, exportData });
      return result;
    },
    
    cancelExport: async (exportId) => {
      const result = await apiCall('/export/cancel', 'POST', { exportId });
      return result;
    },
    
    checkFFmpeg: async () => {
      const result = await apiCall('/ffmpeg/check', 'GET');
      return result;
    },
    
    // ============================================
    // Update operations (stub for web mode)
    // ============================================
    
    checkForUpdates: async () => {
      // Updates are handled via Docker image updates
      return { updateAvailable: false, isWebMode: true };
    },
    
    installUpdate: async () => {
      console.log('[WebAPI] Updates are handled via Docker image updates');
      return false;
    },
    
    installAndRestart: async () => {
      console.log('[WebAPI] Updates are handled via Docker image updates');
      return false;
    },
    
    skipUpdate: async () => {
      return true;
    },
    
    exitApp: async () => {
      console.log('[WebAPI] Exit not available in web mode');
      return false;
    },
    
    getChangelog: async () => {
      return '';
    },
    
    // ============================================
    // Developer settings operations
    // ============================================
    
    devOpenDevTools: async () => {
      console.log('[WebAPI] Use browser DevTools (F12)');
      return true;
    },
    
    devResetSettings: async () => {
      await apiCall('/settings/set', 'POST', { key: '_reset', value: true });
      window.location.reload();
      return true;
    },
    
    devForceLatestVersion: async () => {
      return true;
    },
    
    devSetOldVersion: async () => {
      return true;
    },
    
    devGetCurrentVersion: async () => {
      const result = await apiCall('/version', 'GET');
      return result.version;
    },
    
    devGetAppPaths: async () => {
      const result = await apiCall('/info', 'GET');
      return {
        userData: result.configPath,
        settings: result.configPath + '/settings.json',
        app: '/app',
        temp: '/tmp',
        isPackaged: true,
        isDocker: result.isDocker,
        isWebMode: true
      };
    },
    
    devReloadApp: async () => {
      window.location.reload();
      return true;
    },
    
    // ============================================
    // Settings storage
    // ============================================
    
    getSetting: async (key) => {
      const result = await apiCall('/settings/get', 'POST', { key });
      return result.value;
    },
    
    setSetting: async (key, value) => {
      const result = await apiCall('/settings/set', 'POST', { key, value });
      return result.success;
    },
    
    // ============================================
    // Diagnostics
    // ============================================
    
    getDiagnostics: async () => {
      const result = await apiCall('/diagnostics', 'GET');
      return result;
    },
    
    // ============================================
    // Support Chat (stub for web mode)
    // ============================================
    
    createSupportTicket: async (data) => {
      console.log('[WebAPI] Support tickets not available in web mode');
      return { success: false, error: 'Not available in web mode' };
    },
    
    sendSupportMessage: async (data) => {
      return { success: false, error: 'Not available in web mode' };
    },
    
    uploadSupportMedia: async (data) => {
      return { success: false, error: 'Not available in web mode' };
    },
    
    fetchSupportMessages: async (data) => {
      return { messages: [] };
    },
    
    closeSupportTicket: async (data) => {
      return { success: false };
    },
    
    markSupportRead: async (data) => {
      return { success: false };
    },
    
    // ============================================
    // Event listeners (using polling for web mode)
    // ============================================
    
    on: (channel, callback) => {
      const allowedChannels = ['export:progress', 'update:available', 'update:progress', 'update:downloaded', 'update:forceManual'];
      if (allowedChannels.includes(channel)) {
        if (!eventListeners.has(channel)) {
          eventListeners.set(channel, []);
        }
        eventListeners.get(channel).push(callback);
      }
    },
    
    off: (channel, callback) => {
      if (eventListeners.has(channel)) {
        const listeners = eventListeners.get(channel);
        const index = listeners.indexOf(callback);
        if (index > -1) {
          listeners.splice(index, 1);
        }
      }
    },
    
    removeAllListeners: (channel) => {
      eventListeners.delete(channel);
    }
  };

  // ============================================
  // Folder Browser Modal for Web Mode
  // ============================================
  
  window.showFolderBrowser = function(callback) {
    // Create modal overlay
    const overlay = document.createElement('div');
    overlay.id = 'folderBrowserOverlay';
    overlay.style.cssText = `
      position: fixed;
      top: 0;
      left: 0;
      right: 0;
      bottom: 0;
      background: rgba(0, 0, 0, 0.8);
      z-index: 10000;
      display: flex;
      align-items: center;
      justify-content: center;
    `;
    
    const modal = document.createElement('div');
    modal.style.cssText = `
      background: #1e1e2e;
      border-radius: 12px;
      padding: 20px;
      width: 500px;
      max-height: 70vh;
      display: flex;
      flex-direction: column;
      color: #fff;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    `;
    
    modal.innerHTML = `
      <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 15px;">
        <h3 style="margin: 0; font-size: 18px;">Select Folder</h3>
        <button id="closeFolderBrowser" style="background: none; border: none; color: #888; font-size: 24px; cursor: pointer;">&times;</button>
      </div>
      <div id="currentPath" style="background: #2a2a3e; padding: 10px; border-radius: 6px; margin-bottom: 10px; font-size: 12px; word-break: break-all;"></div>
      <div id="folderList" style="flex: 1; overflow-y: auto; max-height: 400px;"></div>
      <div style="display: flex; gap: 10px; margin-top: 15px;">
        <button id="selectFolderBtn" style="flex: 1; padding: 10px; background: #4a9eff; color: white; border: none; border-radius: 6px; cursor: pointer; font-size: 14px;">Select This Folder</button>
        <button id="cancelFolderBtn" style="padding: 10px 20px; background: #444; color: white; border: none; border-radius: 6px; cursor: pointer; font-size: 14px;">Cancel</button>
      </div>
    `;
    
    overlay.appendChild(modal);
    document.body.appendChild(overlay);
    
    let currentPath = '/data';
    
    async function loadFolder(path) {
      currentPath = path;
      document.getElementById('currentPath').textContent = path;
      
      try {
        const response = await fetch(`/api/browse?path=${encodeURIComponent(path)}`);
        const data = await response.json();
        
        const folderList = document.getElementById('folderList');
        folderList.innerHTML = '';
        
        // Add parent directory option
        if (data.parent && data.parent !== path) {
          const parentItem = document.createElement('div');
          parentItem.style.cssText = 'padding: 10px; cursor: pointer; border-radius: 6px; display: flex; align-items: center; gap: 10px;';
          parentItem.innerHTML = '<span style="font-size: 18px;">📁</span> <span>..</span>';
          parentItem.onmouseover = () => parentItem.style.background = '#3a3a4e';
          parentItem.onmouseout = () => parentItem.style.background = 'none';
          parentItem.onclick = () => loadFolder(data.parent);
          folderList.appendChild(parentItem);
        }
        
        // Add directories
        data.items.filter(item => item.isDirectory).forEach(item => {
          const itemEl = document.createElement('div');
          itemEl.style.cssText = 'padding: 10px; cursor: pointer; border-radius: 6px; display: flex; align-items: center; gap: 10px;';
          itemEl.innerHTML = `<span style="font-size: 18px;">📁</span> <span>${item.name}</span>`;
          itemEl.onmouseover = () => itemEl.style.background = '#3a3a4e';
          itemEl.onmouseout = () => itemEl.style.background = 'none';
          itemEl.onclick = () => loadFolder(item.path);
          folderList.appendChild(itemEl);
        });
        
        // Show message if no folders
        if (data.items.filter(item => item.isDirectory).length === 0) {
          const emptyMsg = document.createElement('div');
          emptyMsg.style.cssText = 'padding: 20px; text-align: center; color: #888;';
          emptyMsg.textContent = 'No subfolders';
          folderList.appendChild(emptyMsg);
        }
      } catch (err) {
        console.error('[WebAPI] Failed to load folder:', err);
      }
    }
    
    // Load initial folder
    loadFolder(currentPath);
    
    // Event handlers
    document.getElementById('closeFolderBrowser').onclick = () => {
      document.body.removeChild(overlay);
      callback(null);
    };
    
    document.getElementById('cancelFolderBtn').onclick = () => {
      document.body.removeChild(overlay);
      callback(null);
    };
    
    document.getElementById('selectFolderBtn').onclick = () => {
      document.body.removeChild(overlay);
      callback(currentPath);
    };
  };

  // ============================================
  // Video URL Helper
  // ============================================
  
  // Override video source handling for web mode
  window.getVideoUrl = function(filePath) {
    // Convert file path to API URL
    return `/api/video${filePath}`;
  };

  console.log('[WebAPI] Web API layer initialized successfully');
  
})();
