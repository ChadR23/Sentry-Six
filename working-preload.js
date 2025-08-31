// Working Preload Script
// Simplified version for immediate functionality

const { contextBridge, ipcRenderer } = require('electron');

// Expose safe APIs to the renderer
contextBridge.exposeInMainWorld('electronAPI', {
    // Tesla file operations
    tesla: {
        selectFolder: () => ipcRenderer.invoke('tesla:select-folder'),
        getVideoFiles: (folderPath) => ipcRenderer.invoke('tesla:get-video-files', folderPath),
        refilterClips: (clipData) => ipcRenderer.invoke('tesla:refilter-clips', clipData),
        getEventData: (folderPath) => ipcRenderer.invoke('tesla:get-event-data', folderPath),
        getEventThumbnail: (thumbnailPath) => ipcRenderer.invoke('tesla:get-event-thumbnail', thumbnailPath),
        exportVideo: (exportId, exportData) => ipcRenderer.invoke('tesla:export-video', exportId, exportData),
        cancelExport: (exportId) => ipcRenderer.invoke('tesla:cancel-export', exportId),
        getExportStatus: (exportId) => ipcRenderer.invoke('tesla:get-export-status', exportId)
    },

    // File system operations
    fs: {
        exists: (filePath) => ipcRenderer.invoke('fs:exists', filePath),
        showItemInFolder: (filePath) => ipcRenderer.invoke('fs:show-item-in-folder', filePath)
    },

    // Dialog operations
    dialog: {
        saveFile: (options) => ipcRenderer.invoke('dialog:save-file', options)
    },

    // Application info
    app: {
        getVersion: () => ipcRenderer.invoke('app:get-version')
    },

    // Video duration operations
    getVideoDuration: (filePath) => ipcRenderer.invoke('get-video-duration', filePath),
    getCachedDurations: (filePaths, onlyFromCache = true) => ipcRenderer.invoke('cache:get-durations', { filePaths, onlyFromCache }),
    batchProcessDurations: (filePaths) => ipcRenderer.invoke('cache:batch-process-durations', { filePaths }),

    // Event listeners
    on: (channel, callback) => {
        const allowedChannels = ['folder-selected', 'videos-loaded', 'tesla:export-progress'];
        if (allowedChannels.includes(channel)) {
            ipcRenderer.on(channel, callback);
        }
    },

    off: (channel, callback) => {
        ipcRenderer.off(channel, callback);
    },

    removeListener: (channel, callback) => {
        ipcRenderer.removeListener(channel, callback);
    },

    // Generic invoke for any IPC call
    invoke: (channel, ...args) => {
        return ipcRenderer.invoke(channel, ...args);
    },

    // Utility functions
    log: (message) => {
        console.log('[Renderer]', message);
    }
});

console.log('Preload script loaded successfully');
