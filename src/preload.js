const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  openFolder: () => ipcRenderer.invoke('dialog:openFolder'),
  openExternal: (url) => ipcRenderer.invoke('shell:openExternal', url),
  platformInfo: () => ({
    // Use process instead of os module - process is available in sandboxed preload scripts
    platform: process.platform,
    arch: process.arch,
  }),
});

