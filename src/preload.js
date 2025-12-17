const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  openFolder: () => ipcRenderer.invoke('dialog:openFolder'),
  openExternal: (url) => ipcRenderer.invoke('shell:openExternal', url),
});

