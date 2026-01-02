const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  // Folder/file operations
  openFolder: () => ipcRenderer.invoke('dialog:openFolder'),
  openExternal: (url) => ipcRenderer.invoke('shell:openExternal', url),
  
  // File system operations
  readDir: (dirPath) => ipcRenderer.invoke('fs:readDir', dirPath),
  readFile: (filePath) => ipcRenderer.invoke('fs:readFile', filePath),
  exists: (filePath) => ipcRenderer.invoke('fs:exists', filePath),
  stat: (filePath) => ipcRenderer.invoke('fs:stat', filePath),
  showItemInFolder: (filePath) => ipcRenderer.invoke('fs:showItemInFolder', filePath),
  
  // Export operations
  saveFile: (options) => ipcRenderer.invoke('dialog:saveFile', options),
  startExport: (exportId, exportData) => ipcRenderer.invoke('export:start', exportId, exportData),
  cancelExport: (exportId) => ipcRenderer.invoke('export:cancel', exportId),
  checkFFmpeg: () => ipcRenderer.invoke('ffmpeg:check'),
  
  // Update operations (using electron-updater)
  checkForUpdates: () => ipcRenderer.invoke('update:check'),
  installUpdate: () => ipcRenderer.invoke('update:install'),
  installAndRestart: () => ipcRenderer.invoke('update:installAndRestart'),
  skipUpdate: () => ipcRenderer.invoke('update:skip'),
  exitApp: () => ipcRenderer.invoke('update:exit'),
  getChangelog: () => ipcRenderer.invoke('update:getChangelog'),
  
  // Developer settings operations
  devOpenDevTools: () => ipcRenderer.invoke('dev:openDevTools'),
  devResetSettings: () => ipcRenderer.invoke('dev:resetSettings'),
  devForceLatestVersion: () => ipcRenderer.invoke('dev:forceLatestVersion'),
  devSetOldVersion: () => ipcRenderer.invoke('dev:setOldVersion'),
  devGetCurrentVersion: () => ipcRenderer.invoke('dev:getCurrentVersion'),
  devGetAppPaths: () => ipcRenderer.invoke('dev:getAppPaths'),
  devReloadApp: () => ipcRenderer.invoke('dev:reloadApp'),
  
  // Settings storage (file-based for reliability)
  getSetting: (key) => ipcRenderer.invoke('settings:get', key),
  setSetting: (key, value) => ipcRenderer.invoke('settings:set', key, value),
  
  // Diagnostics & Support ID
  getDiagnostics: () => ipcRenderer.invoke('diagnostics:get'),
  writeDiagnosticFile: (filePath, content) => ipcRenderer.invoke('diagnostics:writeFile', filePath, content),
  uploadDiagnostics: (supportId, diagnostics) => ipcRenderer.invoke('diagnostics:upload', supportId, diagnostics),
  retrieveDiagnostics: (supportId, passcode) => ipcRenderer.invoke('diagnostics:retrieve', supportId, passcode),
  saveDiagnosticsLocally: (supportId, diagnostics) => ipcRenderer.invoke('diagnostics:saveLocal', supportId, diagnostics),
  
  // Feedback submission
  submitFeedback: (data) => ipcRenderer.invoke('feedback:submit', data),
  uploadFeedbackMedia: (data) => ipcRenderer.invoke('feedback:uploadMedia', data),
  
  // Event listeners
  on: (channel, callback) => {
    const allowedChannels = ['export:progress', 'update:available', 'update:progress', 'update:downloaded'];
    if (allowedChannels.includes(channel)) {
      ipcRenderer.on(channel, (event, ...args) => callback(...args));
    }
  },
  
  off: (channel, callback) => {
    ipcRenderer.removeListener(channel, callback);
  },
  
  removeAllListeners: (channel) => {
    ipcRenderer.removeAllListeners(channel);
  }
});
