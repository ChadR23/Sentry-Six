// Working Sentry-Six Electron Main Process
// Simplified JavaScript version to get the app running

const path = require('path');
const fs = require('fs');
const os = require('os');
const https = require('https');
const AdmZip = require('adm-zip');
const { rmSync } = require('fs'); // For recursive directory removal
const treeKill = require('tree-kill');
const activeExports = {};
const wasCancelled = {};

// Try different ways to import Electron
let electron;
try {
    electron = require('electron');
    console.log('Electron loaded successfully');
} catch (error) {
    console.error('Failed to load Electron:', error);
    process.exit(1);
}

const { app, BrowserWindow, ipcMain, dialog, Menu } = electron;

if (!app) {
    console.error('Electron app is undefined - this might be a version compatibility issue');
    process.exit(1);
}

// Global log buffer for all console output (except corruption checking)
global.terminalLogBuffer = [];
const originalLog = console.log;
const originalError = console.error;
const originalWarn = console.warn;

function bufferTerminalLog(type, ...args) {
    const msg = args.map(a => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ');
    if (!/corrupt/i.test(msg) && !/corruption/i.test(msg)) {
        const line = `[${type}] ${msg}`;
        global.terminalLogBuffer.push(line);
    }
}

console.log = (...args) => {
    bufferTerminalLog('LOG', ...args);
    originalLog.apply(console, args);
};
console.error = (...args) => {
    bufferTerminalLog('ERROR', ...args);
    originalError.apply(console, args);
};
console.warn = (...args) => {
    bufferTerminalLog('WARN', ...args);
    originalWarn.apply(console, args);
};

function downloadWithRedirect(url, dest, cb) {
    const https = require('https');
    const fs = require('fs');
    https.get(url, (response) => {
        if (response.statusCode === 302 && response.headers.location) {
            // Follow redirect
            downloadWithRedirect(response.headers.location, dest, cb);
        } else if (response.statusCode === 200) {
            const file = fs.createWriteStream(dest);
            response.pipe(file);
            file.on('finish', () => file.close(cb));
        } else {
            cb(new Error('Failed to download update ZIP: ' + response.statusCode));
        }
    }).on('error', cb);
}

function makeEven(n) {
    n = Math.round(n);
    return n % 2 === 0 ? n : n - 1;
}

// Helper to get video duration using ffprobe
function getVideoDuration(filePath, ffmpegPath) {
    try {
        // Use the provided ffmpegPath to construct ffprobe path
        const ffprobePath = ffmpegPath ? ffmpegPath.replace('ffmpeg.exe', 'ffprobe.exe') : 'ffprobe';
        console.log(`🔍 getVideoDuration: ffmpegPath=${ffmpegPath}, ffprobePath=${ffprobePath}, filePath=${filePath}`);
        
        const result = require('child_process').spawnSync(ffprobePath, [
            '-v', 'error',
            '-show_entries', 'format=duration',
            '-of', 'default=noprint_wrappers=1:nokey=1',
            filePath
        ], { encoding: 'utf8' });
        
        console.log(`🔍 getVideoDuration result: status=${result.status}, stdout="${result.stdout}", stderr="${result.stderr}"`);
        
        if (result.status === 0 && result.stdout) {
            const duration = parseFloat(result.stdout.trim());
            console.log(`✅ getVideoDuration: duration=${duration}s for ${filePath}`);
            return duration;
        } else {
            console.warn(`❌ getVideoDuration failed: status=${result.status}, stderr="${result.stderr}"`);
        }
    } catch (e) {
        console.warn('Failed to get duration for', filePath, e);
    }
    return 0;
}

// ---- Clip metadata caching helpers ----
const CACHE_FILENAME = 'Sen6ClipsInfo.json';

function isEligibleVideoFilename(name) {
    if (!name || typeof name !== 'string') return false;
    const lower = name.toLowerCase();
    if (!lower.endsWith('.mp4')) return false;
    const skip = ['event.mp4', 'temp_scaled.mp4'];
    if (skip.includes(lower)) return false;
    if (lower.startsWith('._') || lower === '.ds_store') return false;
    return true;
}

function getCachePath(folderPath) {
    return path.join(folderPath, CACHE_FILENAME);
}

function readFolderCache(folderPath) {
    try {
        const cachePath = getCachePath(folderPath);
        if (!fs.existsSync(cachePath)) return null;
        const raw = fs.readFileSync(cachePath, 'utf8');
        const data = JSON.parse(raw);
        if (!data || typeof data !== 'object') return null;
        if (!data.files || typeof data.files !== 'object') data.files = {};
        return data;
    } catch (e) {
        console.warn('⚠️ Failed to read cache for', folderPath, e.message);
        return null;
    }
}

function writeFolderCache(folderPath, cache) {
    try {
        const cachePath = getCachePath(folderPath);
        const safe = {
            version: cache.version || 1,
            folderPath,
            createdAt: cache.createdAt || new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            totalClips: cache.totalClips || 0,
            files: cache.files || {}
        };
        fs.writeFileSync(cachePath, JSON.stringify(safe, null, 2), 'utf8');
        return true;
    } catch (e) {
        console.warn('⚠️ Failed to write cache for', folderPath, e.message);
        return false;
    }
}

function listEligibleFolderFiles(folderPath) {
    try {
        if (!fs.existsSync(folderPath)) return [];
        const items = fs.readdirSync(folderPath);
        const files = [];
        for (const name of items) {
            if (!isEligibleVideoFilename(name)) continue;
            const p = path.join(folderPath, name);
            const stat = fs.statSync(p);
            if (!stat.isFile()) continue;
            files.push({ name, path: p, size: stat.size, mtimeMs: stat.mtimeMs });
        }
        return files;
    } catch (e) {
        console.warn('⚠️ Failed to list files for cache in', folderPath, e.message);
        return [];
    }
}

function getDurationWithCache(filePath, ffmpegPath) {
    const folderPath = path.dirname(filePath);
    const filename = path.basename(filePath);

    // Load cache
    let cache = readFolderCache(folderPath);
    const actualFiles = listEligibleFolderFiles(folderPath);
    const actualCount = actualFiles.length;

    if (!cache) {
        cache = {
            version: 1,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            totalClips: actualCount,
            files: {}
        };
    } else {
        // Update totalClips if changed
        if (cache.totalClips !== actualCount) {
            console.log(`📦 Cache count mismatch in ${folderPath}: cache=${cache.totalClips} actual=${actualCount}. Will update as we probe.`);
            cache.totalClips = actualCount;
        }
    }

    if (!cache.files[filename]) cache.files[filename] = {};

    // Validate cache entry against size/mtime
    try {
        const stat = fs.statSync(filePath);
        const entry = cache.files[filename];
        const hasMatchingMeta = entry && entry.size === stat.size && Math.abs((entry.mtimeMs || 0) - stat.mtimeMs) < 1;
        if (hasMatchingMeta && typeof entry.duration === 'number' && entry.duration > 0) {
            // Check if this cached entry indicates corruption
            const isCorrupted = entry.isCorrupted || (entry.duration < 4);
            if (isCorrupted) {
                console.log(`🔍 Cached corrupted clip: ${filename} (${entry.duration}s)`);
            }
            // Fast path: return cached duration
            return entry.duration;
        }
    } catch (e) {
        // If stat fails, fall back to probing
    }

    // Probe and update cache
    const duration = getVideoDuration(filePath, ffmpegPath) || 0;
    const stat = fs.statSync(filePath);
    const isCorrupted = (duration > 0 && duration < 4) || stat.size < 5 * 1024 * 1024; // Corrupted if duration < 4 seconds OR file size < 5MB
    
    if (isCorrupted) {
        console.log(`🔍 Corrupted clip detected during probing: ${filename} (${duration}s)`);
        
        // If this is a front camera clip, mark all 6 cameras for this timestamp as corrupted
        if (filename.includes('-front.mp4')) {
            markTimestampGroupAsCorrupted(folderPath, null, filename);
        }
    }
    
    try {
        const stat = fs.statSync(filePath);
        cache.files[filename] = {
            path: filePath,
            duration,
            size: stat.size,
            mtimeMs: stat.mtimeMs,
            isCorrupted: isCorrupted
        };
        writeFolderCache(folderPath, cache);
    } catch (e) {
        console.warn('⚠️ Failed to update cache entry for', filePath, e.message);
    }
    return duration;
}


function getDurationWithoutCacheWrite(filePath, ffmpegPath) {
    const folderPath = path.dirname(filePath);
    const filename = path.basename(filePath);

    // Load cache to check if already cached
    const cache = readFolderCache(folderPath);
    if (cache && cache.files && cache.files[filename]) {
        try {
            const stat = fs.statSync(filePath);
            const entry = cache.files[filename];
            const hasMatchingMeta = entry && entry.size === stat.size && Math.abs((entry.mtimeMs || 0) - stat.mtimeMs) < 1;
            if (hasMatchingMeta && typeof entry.duration === 'number' && entry.duration > 0) {
                return { duration: entry.duration, fromCache: true };
            }
        } catch (e) {
            // If stat fails, fall back to probing
        }
    }

    const duration = getVideoDuration(filePath, ffmpegPath) || 0;
    return { duration, fromCache: false };
}

function batchUpdateFolderCache(folderPath, fileUpdates, ffmpegPath) {
    try {
        let cache = readFolderCache(folderPath);
        const actualFiles = listEligibleFolderFiles(folderPath);
        const actualCount = actualFiles.length;

        if (!cache) {
            cache = {
                version: 1,
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString(),
                totalClips: actualCount,
                files: {}
            };
        } else {
            // Update totalClips if changed
            if (cache.totalClips !== actualCount) {
                console.log(`📦 Cache count mismatch in ${folderPath}: cache=${cache.totalClips} actual=${actualCount}. Updating.`);
                cache.totalClips = actualCount;
            }
        }

        let updatedCount = 0;
        for (const { filePath, duration } of fileUpdates) {
            const filename = path.basename(filePath);
            try {
                const stat = fs.statSync(filePath);
                cache.files[filename] = {
                    path: filePath,
                    duration,
                    size: stat.size,
                    mtimeMs: stat.mtimeMs,
                    isCorrupted: (duration > 0 && duration < 4) || stat.size < 5 * 1024 * 1024
                };
                updatedCount++;
            } catch (e) {
                console.warn('⚠️ Failed to stat file for batch cache update:', filePath, e.message);
            }
        }

        const success = writeFolderCache(folderPath, cache);
        console.log(`📦 Batch updated cache for ${folderPath}: ${updatedCount} files updated, write ${success ? 'successful' : 'failed'}`);
        return success;
    } catch (e) {
        console.warn('⚠️ Failed to batch update cache for', folderPath, e.message);
        return false;
    }
}

function markTimestampGroupAsCorrupted(folderPath, timestamp, frontCameraFilename) {
    try {
        let cache = readFolderCache(folderPath);
        if (!cache) return false;

        const allCameras = ['front', 'back', 'left_repeater', 'right_repeater', 'left_pillar', 'right_pillar'];
        
        // Parse the front camera filename to get the timestamp pattern
        const match = frontCameraFilename.match(/^(\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2})-front\.mp4$/);
        if (!match) return false;
        
        const timestampPattern = match[1];
        
        // Mark all 6 cameras for this timestamp as corrupted
        let updatedCount = 0;
        for (const camera of allCameras) {
            const expectedFilename = `${timestampPattern}-${camera}.mp4`;
            if (cache.files[expectedFilename]) {
                cache.files[expectedFilename].isCorrupted = true;
                updatedCount++;
                console.log(`🔍 Marked ${expectedFilename} as corrupted (group corruption)`);
            }
        }
        
        if (updatedCount > 0) {
            const success = writeFolderCache(folderPath, cache);
            console.log(`📦 Marked ${updatedCount} cameras as corrupted for timestamp ${timestampPattern}, write ${success ? 'successful' : 'failed'}`);
            return success;
        }
        
        return false;
    } catch (e) {
        console.warn('⚠️ Failed to mark timestamp group as corrupted:', e.message);
        return false;
    }
}

class SentrySixApp {
    constructor() {
        this.mainWindow = null;
        this.initializeApp();
    }

    initializeApp() {
        console.log('Initializing Sentry-Six...');
        
        // Handle app ready
        app.whenReady().then(() => {
            console.log('App is ready, creating window...');
            this.createMainWindow();
            this.setupIpcHandlers();
            this.createApplicationMenu();

            app.on('activate', () => {
                if (BrowserWindow.getAllWindows().length === 0) {
                    this.createMainWindow();
                }
            });
        });

        // Handle app window closed
        app.on('window-all-closed', () => {
            if (process.platform !== 'darwin') {
                app.quit();
            }
        });
    }

    createMainWindow() {
        console.log('Creating main window...');
        
        this.mainWindow = new BrowserWindow({
            width: 1400,
            height: 900,
            minWidth: 1200,
            minHeight: 700,
            webPreferences: {
                nodeIntegration: false,
                contextIsolation: true,
                preload: path.join(__dirname, 'working-preload.js')
            },
            title: 'Sentry-Six - Tesla Dashcam Viewer',
            show: false
        });

        // Load the renderer HTML
        this.mainWindow.loadFile(path.join(__dirname, 'src', 'renderer', 'index.html'));

        // Show window when ready
        this.mainWindow.once('ready-to-show', () => {
            console.log('Window ready to show');
            this.mainWindow.show();
        });

        // Handle window closed
        this.mainWindow.on('closed', () => {
            this.mainWindow = null;
        });

        console.log('Main window created successfully');
    }

    setupIpcHandlers() {
        console.log('Setting up IPC handlers...');
        
        // Tesla file operations
        ipcMain.handle('tesla:select-folder', async () => {
            const result = await dialog.showOpenDialog(this.mainWindow, {
                properties: ['openDirectory'],
                title: 'Select Tesla Dashcam Folder'
            });

            if (!result.canceled && result.filePaths.length > 0) {
                const selectedPath = result.filePaths[0];
                console.log('Selected folder:', selectedPath);

                // Scan for Tesla video files
                const videoFiles = await this.scanTeslaFolder(selectedPath);
                console.log(`Found ${videoFiles.length} Tesla video files`);

                return {
                    success: true,
                    path: selectedPath,
                    videoFiles: videoFiles
                };
            }
            return { success: false };
        });

        // Get video files for a specific folder
        ipcMain.handle('tesla:get-video-files', async (_, folderPath) => {
            console.log('Getting video files for folder:', folderPath);
            const videoFiles = await this.scanTeslaFolder(folderPath);
            return videoFiles;
        });

        ipcMain.handle('tesla:refilter-clips', async (_, clipData) => {
            console.log('Re-filtering clips after corruption detection');
            try {
                const filteredClips = this.filterCorruptedTimestampGroups(clipData.clips);
                return {
                    success: true,
                    filteredClips: filteredClips,
                    originalCount: clipData.clips.length,
                    filteredCount: filteredClips.length
                };
            } catch (error) {
                console.error('Error re-filtering clips:', error);
                return { success: false, error: error.message };
            }
        });

        // Simple file system check
        ipcMain.handle('fs:exists', async (_, filePath) => {
            return fs.existsSync(filePath);
        });

        // Show item in folder
        ipcMain.handle('fs:show-item-in-folder', async (_, filePath) => {
            const { shell } = require('electron');
            shell.showItemInFolder(filePath);
        });

        // File save dialog for exports
        ipcMain.handle('dialog:save-file', async (_, options) => {
            const result = await dialog.showSaveDialog(this.mainWindow, {
                title: options.title || 'Save Export',
                defaultPath: options.defaultPath || 'tesla_export.mp4',
                filters: options.filters || [
                    { name: 'Video Files', extensions: ['mp4'] },
                    { name: 'All Files', extensions: ['*'] }
                ]
            });

            return result.canceled ? null : result.filePath;
        });

        // Get app version
        ipcMain.handle('app:get-version', async () => {
            return app.getVersion();
        });

        // Get video duration (with caching)
        ipcMain.handle('get-video-duration', async (_, filePath) => {
            console.log('🔍 get-video-duration IPC handler called with filePath:', filePath);
            try {
                const ffmpegPath = this.findFFmpegPath();
                if (!ffmpegPath) {
                    console.log('❌ FFmpeg not found in get-video-duration handler');
                    throw new Error('FFmpeg not found');
                }
                console.log('🔍 Calling getDurationWithCache with ffmpegPath:', ffmpegPath);
                const duration = getDurationWithCache(filePath, ffmpegPath);
                console.log('🔍 getVideoDuration returned:', duration);
                return duration;
            } catch (error) {
                console.error('Error getting video duration:', error);
                return null;
            }
        });

        // Bulk get durations from cache without probing (fast prefill)
        ipcMain.handle('cache:get-durations', async (_, payload) => {
            try {
                const { filePaths, onlyFromCache } = payload || {};
                if (!Array.isArray(filePaths) || filePaths.length === 0) {
                    return { durations: [], allCached: false };
                }

                const durations = [];
                let allCached = true;

                for (const filePath of filePaths) {
                    try {
                        const folderPath = path.dirname(filePath);
                        const filename = path.basename(filePath);
                        const cache = readFolderCache(folderPath);
                        const stat = fs.existsSync(filePath) ? fs.statSync(filePath) : null;

                        if (cache && cache.files && cache.files[filename] && stat) {
                            const entry = cache.files[filename];
                            const valid = entry.size === stat.size && Math.abs((entry.mtimeMs || 0) - stat.mtimeMs) < 1 && typeof entry.duration === 'number' && entry.duration > 0;
                            if (valid) {
                                durations.push(entry.duration);
                                continue;
                            }
                        }

                        // Not cached or invalid
                        allCached = false;
                        if (onlyFromCache) {
                            durations.push(null);
                        } else {
                            const ffmpegPath = this.findFFmpegPath();
                            const d = ffmpegPath ? getDurationWithCache(filePath, ffmpegPath) : 0;
                            durations.push(d || null);
                        }
                    } catch (e) {
                        allCached = false;
                        durations.push(null);
                    }
                }

                return { durations, allCached };
            } catch (e) {
                console.error('cache:get-durations failed:', e);
                return { durations: [], allCached: false };
            }
        });

        ipcMain.handle('cache:batch-process-durations', async (_, payload) => {
            try {
                const { filePaths } = payload || {};
                if (!Array.isArray(filePaths) || filePaths.length === 0) {
                    return { durations: [], success: false, error: 'No file paths provided' };
                }

                const ffmpegPath = this.findFFmpegPath();
                if (!ffmpegPath) {
                    return { durations: [], success: false, error: 'FFmpeg not found' };
                }

                console.log(`📦 Batch processing ${filePaths.length} files for durations`);
                
                const results = [];
                const folderUpdates = new Map();

                for (const filePath of filePaths) {
                    try {
                        const result = getDurationWithoutCacheWrite(filePath, ffmpegPath);
                        results.push(result.duration);

                        if (!result.fromCache) {
                            const folderPath = path.dirname(filePath);
                            if (!folderUpdates.has(folderPath)) {
                                folderUpdates.set(folderPath, []);
                            }
                            folderUpdates.get(folderPath).push({
                                filePath,
                                duration: result.duration
                            });
                        }
                    } catch (e) {
                        console.warn('Failed to process duration for', filePath, e.message);
                        results.push(0);
                    }
                }

                let allUpdatesSuccessful = true;
                for (const [folderPath, fileUpdates] of folderUpdates) {
                    const success = batchUpdateFolderCache(folderPath, fileUpdates, ffmpegPath);
                    if (!success) {
                        allUpdatesSuccessful = false;
                        console.warn('Failed to batch update cache for folder:', folderPath);
                    }
                }

                console.log(`📦 Batch processing completed: ${results.length} durations processed, cache updates ${allUpdatesSuccessful ? 'successful' : 'had errors'}`);
                
                return { 
                    durations: results, 
                    success: allUpdatesSuccessful,
                    processedCount: results.length,
                    cacheUpdatedFolders: folderUpdates.size
                };
            } catch (e) {
                console.error('cache:batch-process-durations failed:', e);
                return { durations: [], success: false, error: e.message };
            }
        });

        // Hardware acceleration detection
        ipcMain.handle('tesla:detect-hwaccel', async () => {
            try {
                const ffmpegPath = this.findFFmpegPath();
                if (!ffmpegPath) {
                    return { available: false, type: null, encoder: null, error: 'FFmpeg not found' };
                }

                const hwAccel = await this.detectHardwareAcceleration(ffmpegPath);
                return hwAccel;
            } catch (error) {
                console.error('Error detecting hardware acceleration:', error);
                return { available: false, type: null, encoder: null, error: error.message };
            }
        });

        // Tesla video export
        ipcMain.handle('tesla:export-video', async (event, exportId, exportData) => {
            console.log('🚀 Starting Tesla video export:', exportId);
            
            try {
                console.log('📋 Export data received:', exportData);
                
                // Validate export data
                if (!exportData.timeline || !exportData.outputPath) {
                    throw new Error('Invalid export data: missing timeline or output path');
                }

                console.log('🔍 Validating FFmpeg availability...');
                // Check if FFmpeg is available
                const { spawn } = require('child_process');
                const ffmpegPath = this.findFFmpegPath();
                
                console.log('🔍 FFmpeg path found:', ffmpegPath);
                
                if (!ffmpegPath) {
                    throw new Error('FFmpeg not found. Please install FFmpeg or place it in the ffmpeg_bin directory.');
                }

                console.log('🔍 Starting video export process...');
                // Start the export process
                const result = await this.performVideoExport(event, exportId, exportData, ffmpegPath);
                console.log('🔍 Export process completed with result:', result);

                return result;
            } catch (error) {
                console.error('💥 Export failed:', error);
                event.sender.send('tesla:export-progress', exportId, {
                    type: 'complete',
                    success: false,
                    message: `Export failed: ${error.message}`
                });
                return false;
            }
        });

        // Tesla export cancellation
        ipcMain.handle('tesla:cancel-export', async (_, exportId) => {
            console.log('Main: Attempting to cancel export:', exportId);
            const proc = activeExports[exportId];
            if (proc) {
                wasCancelled[exportId] = true;
                treeKill(proc.pid, 'SIGKILL', (err) => {
                    if (err) {
                        console.warn('tree-kill error:', err);
                    } else {
                        console.log('tree-kill sent SIGKILL to export:', exportId);
                    }
                });
                // Do not delete activeExports[exportId] here; let process.on('close') handle it
                return true;
            } else {
                console.warn('No active export found for exportId:', exportId, 'Current active:', Object.keys(activeExports));
            }
            return false;
        });

        // Tesla export status
        ipcMain.handle('tesla:get-export-status', async (_, exportId) => {
            console.log('📊 Getting export status:', exportId);
            return false; // Not currently exporting
        });

        // Tesla event data (legacy - loads all events)
        ipcMain.handle('tesla:get-event-data', async (_, folderPath) => {
            console.log('📅 Getting event data for:', folderPath);
            try {
                const events = await this.scanTeslaEvents(folderPath);
                console.log(`Found ${events.length} events`);
                return events;
            } catch (error) {
                console.error('Error getting event data:', error);
                return [];
            }
        });

        // Tesla event data for specific date (optimized)
        ipcMain.handle('tesla:get-events-for-date', async (_, folderPath, targetDate, folderType) => {
            console.log(`📅 Getting events for date ${targetDate} in ${folderType} folder:`, folderPath);
            try {
                const events = await this.scanEventsForSpecificDate(folderPath, targetDate, folderType);
                console.log(`Found ${events.length} events for ${targetDate}`);
                return events;
            } catch (error) {
                console.error('Error getting events for date:', error);
                return [];
            }
        });

        // Tesla event thumbnail
        ipcMain.handle('tesla:get-event-thumbnail', async (_, thumbnailPath) => {
            console.log('🖼️ Getting event thumbnail:', thumbnailPath);
            try {
                if (fs.existsSync(thumbnailPath)) {
                    const imageBuffer = fs.readFileSync(thumbnailPath);
                    return `data:image/png;base64,${imageBuffer.toString('base64')}`;
                }
                return null;
            } catch (error) {
                console.error('Error reading event thumbnail:', error);
                return null;
            }
        });

        console.log('Registering debug:get-terminal-log handler');
        ipcMain.handle('debug:get-terminal-log', async () => {
            return global.terminalLogBuffer.join('\n');
        });

        ipcMain.handle('app:update-to-commit', async () => {
            let tmpZipPath, extractDir;
            try {
                // Get current commit SHA
                const { execSync } = require('child_process');
                let currentSha;
                try {
                    currentSha = execSync('git rev-parse HEAD', { cwd: process.cwd(), encoding: 'utf8' }).trim();
                    console.log('Current commit SHA:', currentSha);
                } catch (gitError) {
                    console.warn('Could not get current commit SHA:', gitError.message);
                    currentSha = null;
                }

                // Fetch latest commit SHA from GitHub API (Electron-rebuld dev branch)
                const apiUrl = 'https://api.github.com/repos/ChadR23/Sentry-Six/commits/Electron-rebuld';
                const https = require('https');
                const fetchLatestSha = () => new Promise((resolve, reject) => {
                    https.get(apiUrl, { headers: { 'User-Agent': 'Sentry-Six-Updater' } }, (res) => {
                        let data = '';
                        res.on('data', chunk => data += chunk);
                        res.on('end', () => {
                            if (res.statusCode === 200) {
                                try {
                                    const json = JSON.parse(data);
                                    const sha = json.sha || (json[0] && json[0].sha);
                                    if (sha) resolve(sha);
                                    else reject(new Error('Could not parse latest commit SHA'));
                                } catch (e) {
                                    reject(e);
                                }
                            } else {
                                reject(new Error('Failed to fetch latest commit: ' + res.statusCode));
                            }
                        });
                    }).on('error', reject);
                });
                const latestSha = await fetchLatestSha();
                console.log('Latest commit SHA (Electron-rebuld):', latestSha);

                // Check if we're already up to date
                if (currentSha && currentSha === latestSha) {
                    console.log('Already up to date!');
                    return { 
                        success: true, 
                        alreadyUpToDate: true, 
                        message: 'You are already running the latest version!' 
                    };
                }

                const zipUrl = `https://github.com/ChadR23/Sentry-Six/archive/${latestSha}.zip`;
                tmpZipPath = path.join(os.tmpdir(), `sentry-six-update-${latestSha}.zip`);
                extractDir = path.join(os.tmpdir(), `sentry-six-update-${latestSha}`);
                console.log('Downloading update ZIP from:', zipUrl);

                // Download ZIP
                await new Promise((resolve, reject) => {
                    downloadWithRedirect(zipUrl, tmpZipPath, (err) => {
                        if (err) reject(err);
                        else resolve();
                    });
                });
                console.log('ZIP downloaded to:', tmpZipPath);

                // Extract ZIP
                const zip = new AdmZip(tmpZipPath);
                zip.extractAllTo(extractDir, true);
                console.log('ZIP extracted to:', extractDir);

                // Overwrite files (skip user data/configs)
                const updateRoot = path.join(extractDir, `Sentry-Six-${latestSha}`);
                const skipDirs = ['user_data', 'config', 'ffmpeg_bin'];
                function copyRecursive(src, dest) {
                    if (!fs.existsSync(src)) return;
                    const stat = fs.statSync(src);
                    if (stat.isDirectory()) {
                        if (!fs.existsSync(dest)) fs.mkdirSync(dest);
                        const items = fs.readdirSync(src);
                        for (const item of items) {
                            if (skipDirs.includes(item)) continue;
                            copyRecursive(path.join(src, item), path.join(dest, item));
                        }
                    } else {
                        fs.copyFileSync(src, dest);
                    }
                }
                copyRecursive(updateRoot, process.cwd());
                console.log('Update applied.');
                // Cleanup temp files
                try { if (fs.existsSync(tmpZipPath)) fs.unlinkSync(tmpZipPath); } catch (e) { console.warn('Failed to delete temp zip:', e); }
                try { if (fs.existsSync(extractDir)) rmSync(extractDir, { recursive: true, force: true }); } catch (e) { console.warn('Failed to delete temp extract dir:', e); }
                return { 
                    success: true, 
                    alreadyUpToDate: false, 
                    message: 'Update downloaded and applied successfully!' 
                };
            } catch (err) {
                console.error('Update failed:', err);
                // Cleanup temp files on failure too
                try { if (tmpZipPath && fs.existsSync(tmpZipPath)) fs.unlinkSync(tmpZipPath); } catch (e) { console.warn('Failed to delete temp zip:', e); }
                try { if (extractDir && fs.existsSync(extractDir)) rmSync(extractDir, { recursive: true, force: true }); } catch (e) { console.warn('Failed to delete temp extract dir:', e); }
                return { success: false, error: err.message || String(err) };
            }
        });

        console.log('IPC handlers set up successfully');
    }

    // FFmpeg path finding
    findFFmpegPath() {
        const isMac = process.platform === 'darwin';
        const possiblePaths = [
            // Prioritize bundled FFmpeg over system PATH
            ...(isMac ? [
                path.join(__dirname, 'ffmpeg_bin', 'mac', 'ffmpeg'), // Bundled Mac
                path.join(process.cwd(), 'ffmpeg_bin', 'mac', 'ffmpeg') // CWD Mac
            ] : [
                path.join(__dirname, 'ffmpeg_bin', 'ffmpeg.exe'), // Bundled Windows
                path.join(__dirname, 'ffmpeg_bin', 'ffmpeg'), // Bundled Unix
                path.join(process.cwd(), 'ffmpeg_bin', 'ffmpeg.exe'), // Current working directory
                path.join(process.cwd(), 'ffmpeg_bin', 'ffmpeg') // Current working directory Unix
            ]),
            'ffmpeg', // System PATH (fallback)
            '/usr/local/bin/ffmpeg', // Homebrew macOS
            '/usr/bin/ffmpeg' // Linux
        ];

        for (const ffmpegPath of possiblePaths) {
            try {
                const { spawnSync } = require('child_process');
                const result = spawnSync(ffmpegPath, ['-version'], { 
                    timeout: 5000,
                    stdio: 'pipe'
                });
                if (result.status === 0) {
                    console.log(`✅ Found FFMPEG at: ${ffmpegPath}`);
                    return ffmpegPath;
                }
            } catch (error) {
                // Continue to next path
            }
        }

        return null;
    }

    // Detect available hardware acceleration
    async detectHardwareAcceleration(ffmpegPath) {
        if (!ffmpegPath) return { available: false, type: null, encoder: null };

        const { spawnSync } = require('child_process');

        try {
            // Get FFmpeg encoders list
            const result = spawnSync(ffmpegPath, ['-encoders'], {
                timeout: 10000,
                stdio: 'pipe'
            });

            if (result.status !== 0) {
                return { available: false, type: null, encoder: null };
            }

            const encodersOutput = result.stdout.toString();
            const platform = process.platform;

            console.log('🔍 Checking hardware acceleration availability...');

            // Test each hardware encoder by actually trying to use it
            const hwAccelOptions = [];

            // Test NVIDIA NVENC (Windows/Linux)
            if (encodersOutput.includes('h264_nvenc')) {
                console.log('🔍 Testing NVIDIA NVENC...');
                if (await this.testHardwareEncoder(ffmpegPath, 'h264_nvenc')) {
                    hwAccelOptions.push({
                        type: 'NVIDIA NVENC',
                        encoder: 'h264_nvenc',
                        decoder: 'h264_cuvid',
                        priority: 1
                    });
                    console.log('✅ NVIDIA NVENC test passed');
                } else {
                    console.log('❌ NVIDIA NVENC test failed');
                }
            }

            // Test AMD AMF (Windows)
            if (encodersOutput.includes('h264_amf') && platform === 'win32') {
                console.log('🔍 Testing AMD AMF...');
                if (await this.testHardwareEncoder(ffmpegPath, 'h264_amf')) {
                    hwAccelOptions.push({
                        type: 'AMD AMF',
                        encoder: 'h264_amf',
                        decoder: null,
                        priority: 2
                    });
                    console.log('✅ AMD AMF test passed');
                } else {
                    console.log('❌ AMD AMF test failed');
                }
            }

            // Test Intel Quick Sync (Windows/Linux)
            if (encodersOutput.includes('h264_qsv')) {
                console.log('🔍 Testing Intel Quick Sync...');
                if (await this.testHardwareEncoder(ffmpegPath, 'h264_qsv')) {
                    hwAccelOptions.push({
                        type: 'Intel Quick Sync',
                        encoder: 'h264_qsv',
                        decoder: 'h264_qsv',
                        priority: 3
                    });
                    console.log('✅ Intel Quick Sync test passed');
                } else {
                    console.log('❌ Intel Quick Sync test failed');
                }
            }

            // Test Apple VideoToolbox (macOS)
            if (encodersOutput.includes('h264_videotoolbox') && platform === 'darwin') {
                console.log('🔍 Testing Apple VideoToolbox...');
                if (await this.testHardwareEncoder(ffmpegPath, 'h264_videotoolbox')) {
                    hwAccelOptions.push({
                        type: 'Apple VideoToolbox',
                        encoder: 'h264_videotoolbox',
                        decoder: null,
                        priority: 1
                    });
                    console.log('✅ Apple VideoToolbox test passed');
                } else {
                    console.log('❌ Apple VideoToolbox test failed');
                }
            }

            // Sort by priority and return the best option
            if (hwAccelOptions.length > 0) {
                const bestOption = hwAccelOptions.sort((a, b) => a.priority - b.priority)[0];
                console.log(`🚀 Hardware acceleration detected: ${bestOption.type}`);
                return {
                    available: true,
                    type: bestOption.type,
                    encoder: bestOption.encoder,
                    decoder: bestOption.decoder
                };
            }

            console.log('⚠️ No hardware acceleration detected');
            return { available: false, type: null, encoder: null };

        } catch (error) {
            console.error('Error detecting hardware acceleration:', error);
            return { available: false, type: null, encoder: null };
        }
    }

    // Test if a hardware encoder actually works
    async testHardwareEncoder(ffmpegPath, encoder) {
        const { spawnSync } = require('child_process');

        try {
            // Create a minimal test command to see if the encoder initializes
            const testArgs = [
                '-f', 'lavfi',
                '-i', 'testsrc2=duration=1:size=320x240:rate=1',
                '-c:v', encoder,
                ...(encoder.includes('videotoolbox') ? ['-b:v', '2M'] : []),
                '-frames:v', '1',
                '-f', 'null',
                '-'
            ];

            const result = spawnSync(ffmpegPath, testArgs, {
                timeout: 5000,
                stdio: 'pipe'
            });

            // If the command succeeds (exit code 0), the encoder works
            return result.status === 0;

        } catch (error) {
            console.log(`❌ Hardware encoder test failed for ${encoder}:`, error.message);
            return false;
        }
    }

    // Video export implementation
    async performVideoExport(event, exportId, exportData, ffmpegPath) {
        const { spawn } = require('child_process');
        const fs = require('fs');
        const os = require('os');
        const { timeline, startTime, endTime, quality, cameras, timestamp, outputPath, hwaccel, timelapse } = exportData;

        // Debug: Log timelapse data received
        console.log('🎬 Timelapse data received:', timelapse);

        // Initialize tempFiles array for cleanup
        const tempFiles = [];

        try {
            console.log('🔍 Starting performVideoExport...');
            console.log('🔍 Timeline clips:', timeline.clips?.length);
            console.log('🔍 Selected cameras:', cameras);
            
            // Calculate duration and offset
            const durationMs = endTime - startTime;
            const durationSeconds = durationMs / 1000;
            const offsetSeconds = startTime / 1000;

            console.log(`🎬 Building export command: ${durationSeconds}s duration, ${offsetSeconds}s offset`);
            console.log(`📍 Export range: ${offsetSeconds}s to ${offsetSeconds + durationSeconds}s (${durationSeconds}s total)`);

            // Create input streams for all selected cameras from the relevant clips
            const inputs = [];

            // Group clips by their timeline position to maintain synchronization
            const timelineClips = [];
            
            // Calculate timeline start time for accurate positioning
            const timelineStartTime = timeline.startTime.getTime();
            
            // Use accurate timeline logic if available
            if (timeline.accurateTimeline && timeline.sortedClips) {
                console.log(`✅ Using accurate timeline with ${timeline.sortedClips.length} sorted clips`);
                
                for (let i = 0; i < timeline.sortedClips.length; i++) {
                    const clip = timeline.sortedClips[i];
                    if (!clip || !clip.timestamp) continue;

                    // Calculate clip position using accurate timeline logic
                    const clipStartTime = new Date(clip.timestamp).getTime();
                    const clipRelativeStart = clipStartTime - timelineStartTime;
                    
                    // Use actual duration from timeline if available, otherwise estimate
                    let clipDuration = 60000; // Default 60 seconds
                    if (timeline.actualDurations && timeline.actualDurations[i]) {
                        clipDuration = timeline.actualDurations[i];
                    }

                    const clipRelativeEnd = clipRelativeStart + clipDuration;

                    // Check if clip overlaps with export range
                    const clipOverlaps = (clipRelativeStart < endTime) && (clipRelativeEnd > startTime);

                    if (clipOverlaps) {
                        console.log(`📹 Clip ${i} (${clip.timestamp}) overlaps with export range (${clipRelativeStart}-${clipRelativeEnd}ms)`);
                        timelineClips.push({
                            ...clip,
                            clipIndex: i,
                            clipRelativeStart: clipRelativeStart,
                            clipDuration: clipDuration
                        });
                    }
                }
            } else {
                // Fallback to legacy sequential positioning
                console.log(`⚠️ Using legacy sequential positioning`);
                let currentPosition = 0;

                for (let i = 0; i < timeline.clips.length; i++) {
                    const clip = timeline.clips[i];
                    if (!clip || !clip.timestamp) continue;

                    // Use actual duration from timeline if available, otherwise estimate
                    let clipDuration = 60000; // Default 60 seconds
                    if (timeline.actualDurations && timeline.actualDurations[i]) {
                        clipDuration = timeline.actualDurations[i];
                    }

                    const clipRelativeStart = currentPosition;
                    const clipRelativeEnd = currentPosition + clipDuration;

                    // Check if clip overlaps with export range
                    const clipOverlaps = (clipRelativeStart < endTime) && (clipRelativeEnd > startTime);

                    if (clipOverlaps) {
                        console.log(`📹 Clip ${i} (${clip.timestamp}) overlaps with export range (${clipRelativeStart}-${clipRelativeEnd}ms)`);
                        timelineClips.push({
                            ...clip,
                            clipIndex: i,
                            clipRelativeStart: clipRelativeStart,
                            clipDuration: clipDuration
                        });
                    }

                    currentPosition += clipDuration;
                }
            }

            console.log(`📊 Found ${timelineClips.length} timeline clips for export range`);

            // Create synchronized input streams for each camera
            for (let i = 0; i < cameras.length; i++) {
                const camera = cameras[i];

                // Collect clips for this camera from the timeline clips
                const cameraClips = timelineClips
                    .filter(clip => clip.files && clip.files[camera])
                    .map(clip => ({
                        path: clip.files[camera].path,
                        clipRelativeStart: clip.clipRelativeStart || 0,
                        clipDuration: clip.clipDuration || 60000,
                        timelineIndex: clip.clipIndex
                    }))
                    .sort((a, b) => a.timelineIndex - b.timelineIndex);

                if (cameraClips.length === 0) {
                    console.log(`⚠️ Skipping camera ${camera}: no files available in export range`);
                    continue;
                }

                if (cameraClips.length === 1) {
                    // Single clip - use existing logic
                    const clip = cameraClips[0];
                    const relativeOffset = Math.max(0, startTime - clip.clipRelativeStart) / 1000;

                    console.log(`🔍 Adding camera ${camera}: ${clip.path}`);
                    console.log(`📍 Camera ${camera}: clip starts at ${clip.clipRelativeStart}ms, relative offset: ${relativeOffset}s`);

                    inputs.push({
                        camera: camera,
                        path: clip.path,
                        index: i,
                        relativeOffset: relativeOffset
                    });
                } else {
                    // Multiple clips - create synchronized concat file
                    console.log(`🔗 Camera ${camera}: creating synchronized concat file for ${cameraClips.length} clips`);

                    const concatFilePath = path.join(os.tmpdir(), `tesla_export_${camera}_${Date.now()}.txt`);
                    
                    // Create simplified concat content for better timelapse reliability
                    const isTimelapseExport = timelapse && timelapse.enabled && timelapse.speed;

                    let concatContent;
                    if (isTimelapseExport) {
                        // Timelapse-specific: Use simple file listing without complex timing
                        // The PTS filter will handle the speed adjustment
                        console.log(`🎬 Creating timelapse-optimized concat for ${camera}`);
                        concatContent = cameraClips.map(clip => {
                            console.log(`📹 Camera ${camera} timelapse clip: ${clip.path}`);
                            return `file '${clip.path.replace(/\\/g, '/')}'`; // Forward slashes for Windows compatibility
                        }).join('\n');
                    } else {
                        // Standard export: Use the complex timing logic
                        concatContent = cameraClips.map(clip => {
                            const clipStartInExport = Math.max(0, clip.clipRelativeStart - startTime);
                            const clipEndInExport = Math.min(endTime - startTime, clip.clipRelativeStart + clip.clipDuration - startTime);

                            // Skip clips that don't contribute to the export
                            if (clipEndInExport <= 0 || clipStartInExport >= (endTime - startTime)) {
                                return null;
                            }

                            // Calculate the offset within this specific clip
                            const clipOffset = Math.max(0, startTime - clip.clipRelativeStart) / 1000;
                            const clipDuration = (clipEndInExport - clipStartInExport) / 1000;

                            console.log(`📹 Camera ${camera} clip ${clip.timelineIndex}: ${clip.path}, offset: ${clipOffset}s, duration: ${clipDuration}s`);

                            // Use inpoint and outpoint to handle timing within the concat demuxer
                            return `file '${clip.path}'\ninpoint ${clipOffset}\noutpoint ${clipOffset + clipDuration}\nduration ${clipDuration}`;
                        }).filter(Boolean).join('\n');
                    }

                    try {
                        fs.writeFileSync(concatFilePath, concatContent, { encoding: 'utf8', mode: 0o644 });
                        tempFiles.push(concatFilePath);
                        console.log(`✅ Created ${isTimelapseExport ? 'timelapse-optimized' : 'standard'} concat file: ${concatFilePath}`);
                    } catch (error) {
                        console.error(`❌ Failed to create concat file for ${camera}:`, error);
                        throw new Error(`Failed to create concat file for ${camera}: ${error.message}`);
                    }

                    // Calculate offset for the concatenated stream
                    const firstClipStart = cameraClips[0].clipRelativeStart;
                    const relativeOffset = Math.max(0, startTime - firstClipStart) / 1000;

                    console.log(`🔍 Adding camera ${camera}: synchronized concat file with ${cameraClips.length} clips`);
                    console.log(`📍 Camera ${camera}: concat starts at ${firstClipStart}ms, relative offset: ${relativeOffset}s`);

                    inputs.push({
                        camera: camera,
                        path: concatFilePath,
                        index: i,
                        relativeOffset: relativeOffset,
                        isConcat: true
                    });
                }
            }
            
            if (inputs.length === 0) {
                throw new Error('No valid camera files found for export');
            }

            // Build FFmpeg command with multi-camera support
            const cmd = [ffmpegPath, '-y'];
            const initialFilters = [];
            const streamMaps = [];
            let inputIndex = 0;
            
            // Add input streams with individual relative offsets and HWACCEL if needed
            for (let i = 0; i < inputs.length; i++) {
                const input = inputs[i];
                
                if (input.isConcat) {
                    // Handle concatenated input streams
                    // Timing is handled by inpoint/outpoint in the concat file
                    // Use concat demuxer for multiple clips
                    cmd.push('-f', 'concat', '-safe', '0', '-i', input.path);
                } else {
                    // Single input (existing logic)
                    let offset = input.relativeOffset;
                    let firstFile = input.path;
                    console.log(`🔍 getVideoDuration call: ffmpegPath=${ffmpegPath}, firstFile=${firstFile}`);
                    let duration = firstFile ? getVideoDuration(firstFile, ffmpegPath) : 0;
                    console.log(`🔍 getVideoDuration result: duration=${duration}s for ${firstFile}`);
                    
                    if (offset > duration) {
                        console.warn(`Offset (${offset}s) exceeds input duration (${duration}s) for ${firstFile}. Setting offset to 0.`);
                        offset = 0;
                    }
                    
                    if (offset > 0 && offset < duration) {
                        cmd.push('-ss', offset.toString());
                    }

                    cmd.push('-i', input.path);
                }
            }

            // Build filter chains for each input stream
            let totalInputIndex = 0;
            const cameraStreams = [];

            for (let i = 0; i < inputs.length; i++) {
                const input = inputs[i];

                // Apply camera-specific sync adjustments and timelapse speed
                let ptsFilter = 'setpts=PTS-STARTPTS';

                // Apply timelapse speed if enabled
                console.log(`🎬 Debug: timelapse=${JSON.stringify(timelapse)}, input.camera=${input.camera}`);
                if (timelapse && timelapse.enabled && timelapse.speed) {
                    const speedMultiplier = parseInt(timelapse.speed);
                    const ptsValue = 1.0 / speedMultiplier;
                    ptsFilter = `setpts=${ptsValue}*PTS`;
                    console.log(`🎬 Applying ${speedMultiplier}x timelapse speed to ${input.camera} (PTS=${ptsValue})`);
                } else {
                    console.log(`🔍 No timelapse for ${input.camera} - using natural timing (enabled=${timelapse?.enabled}, speed=${timelapse?.speed})`);
                }

                // Check if camera should be mirrored (Tesla back and repeater cameras are mirrored)
                const isMirroredCamera = ['back', 'left_repeater', 'right_repeater'].includes(input.camera);
                let filterChain = ptsFilter;

                if (isMirroredCamera) {
                    // Add horizontal flip for mirrored cameras
                    filterChain += ',hflip';
                    console.log(`🔍 Applying horizontal flip to ${input.camera}`);
                }

                // Scale each stream to standard Tesla camera resolution
                const scaleFilter = `[${totalInputIndex}:v]${filterChain},scale=${makeEven(1448)}:${makeEven(938)}[v${totalInputIndex}]`;
                initialFilters.push(scaleFilter);
                cameraStreams.push(`[v${totalInputIndex}]`);
                totalInputIndex++;
            }

            // Add frame rate synchronization to ensure all streams are aligned
            if (cameraStreams.length > 1) {
                console.log(`🔍 Adding frame rate synchronization for ${cameraStreams.length} cameras`);
                
                // Calculate optimal frame rate for timelapse or use standard 30fps
                let targetFPS = 30;
                if (timelapse && timelapse.enabled && timelapse.speed) {
                    const speedMultiplier = parseInt(timelapse.speed);
                    // For timelapse, we can use higher frame rates for smoother playback
                    // But cap it at 60fps to avoid excessive processing
                    targetFPS = Math.min(60, Math.max(24, 30 * Math.log10(speedMultiplier)));
                    console.log(`🎬 Using ${targetFPS}fps for ${speedMultiplier}x timelapse`);
                }

                // Force all streams to target fps for consistent timing
                const fpsSyncFilters = cameraStreams.map((stream, index) => {
                    return `${stream}fps=fps=${targetFPS}:round=near[fps${index}]`;
                });
                
                // Update camera streams to use fps-synchronized versions
                const fpsSyncStreams = cameraStreams.map((_, index) => `[fps${index}]`);
                
                // Add fps sync filters to the chain
                initialFilters.push(...fpsSyncFilters);
                
                // Use fps-synchronized streams for grid layout
                cameraStreams.length = 0;
                cameraStreams.push(...fpsSyncStreams);
            }

            // Build grid layout using xstack
            const numStreams = cameraStreams.length;
            const w = 1448; // Camera width
            const h = 938;  // Camera height
            
            let mainProcessingChain = [];
            let lastOutputTag = '';
            
            if (numStreams > 1) {
                // Check if custom camera layout is provided
                if (exportData.cameraLayout && exportData.cameraLayout.cameras && exportData.cameraLayout.cameras.length > 0) {
                    // Use custom camera layout from frontend
                    console.log(`🎬 Using custom camera layout with ${exportData.cameraLayout.cameras.length} cameras`);
                    
                    // Create layout positions from custom layout
                    const layout = [];
                    const cameraOrder = cameras; // Use the order of cameras as provided
                    
                    for (let i = 0; i < cameraOrder.length; i++) {
                        const camera = cameraOrder[i];
                        const cameraLayout = exportData.cameraLayout.cameras.find(c => c.camera === camera);
                        
                        if (cameraLayout) {
                            // Use the custom position from the layout
                            layout.push(`${cameraLayout.x}_${cameraLayout.y}`);
                            console.log(`🎬 Camera ${camera}: position (${cameraLayout.x}, ${cameraLayout.y})`);
                        } else {
                            // Fallback to default position if camera not found in layout
                            const row = Math.floor(i / 2);
                            const col = i % 2;
                            layout.push(`${col * w}_${row * h}`);
                            console.log(`⚠️ Camera ${camera}: using fallback position (${col * w}, ${row * h})`);
                        }
                    }
                    
                    const layoutStr = layout.join('|');
                    const xstackFilter = `${cameraStreams.join('')}xstack=inputs=${numStreams}:layout=${layoutStr}[stacked]`;
                    mainProcessingChain.push(xstackFilter);
                    lastOutputTag = '[stacked]';
                    
                    console.log(`🎬 Custom layout: ${numStreams} cameras, layout: ${layoutStr}`);
                } else {
                    // Fallback to default grid layout calculation
                    console.log(`🎬 Using default grid layout for ${numStreams} cameras`);
                    
                    // Calculate grid layout for better aspect ratio (16:9)
                    let cols, rows;
                    
                    if (numStreams === 2) {
                        cols = 2; rows = 1; // 2x1 layout
                    } else if (numStreams === 3) {
                        cols = 3; rows = 1; // 3x1 layout
                    } else if (numStreams === 4) {
                        cols = 2; rows = 2; // 2x2 layout
                    } else if (numStreams === 5) {
                        cols = 3; rows = 2; // 3x2 layout (one empty space)
                    } else if (numStreams === 6) {
                        cols = 3; rows = 2; // 3x2 layout (16:9 aspect ratio)
                    } else {
                        // For more than 6 cameras, use 3 columns
                        cols = 3; rows = Math.ceil(numStreams / 3);
                    }
                    
                    // Create layout positions
                    const layout = [];
                    for (let i = 0; i < numStreams; i++) {
                        const row = Math.floor(i / cols);
                        const col = i % cols;
                        layout.push(`${col * w}_${row * h}`);
                    }
                    
                    const layoutStr = layout.join('|');
                    const xstackFilter = `${cameraStreams.join('')}xstack=inputs=${numStreams}:layout=${layoutStr}[stacked]`;
                    mainProcessingChain.push(xstackFilter);
                    lastOutputTag = '[stacked]';
                    
                    console.log(`🔍 Grid layout: ${cols}x${rows}, cameras: ${numStreams}, layout: ${layoutStr}`);
                }
            } else {
                lastOutputTag = cameraStreams[0];
            }
            
            // Add timestamp overlay if enabled
            if (timestamp.enabled) {
                // Calculate the actual timestamp for the export start time
                const timelineStartUnix = new Date(timeline.startTime).getTime();
                const exportStartUnix = (timelineStartUnix + startTime) / 1000; // startTime is in milliseconds
                const basetimeUs = Math.floor(exportStartUnix * 1000000);

                console.log(`🕐 Timestamp calculation: timeline start=${new Date(timelineStartUnix).toISOString()}, export offset=${startTime}ms, export start=${new Date(exportStartUnix * 1000).toISOString()}`);
                
                const drawtextFilter = [
                    'drawtext=font=Arial',
                    'expansion=strftime',
                    `basetime=${basetimeUs}`,
                    "text='%m/%d/%Y %I\\:%M\\:%S %p'",
                    'fontcolor=white',
                    'fontsize=36',
                    'box=1',
                    'boxcolor=black@0.4',
                    'boxborderw=5',
                    'x=(w-text_w)/2:y=h-th-10'
                ].join(':');
                
                mainProcessingChain.push(`${lastOutputTag}${drawtextFilter}[timestamped]`);
                lastOutputTag = '[timestamped]';
            }
            
            // Add mobile scaling if requested
            if (quality === 'mobile') {
                // Use custom layout dimensions if available, otherwise calculate grid dimensions
                let totalWidth, totalHeight;
                
                if (exportData.cameraLayout && exportData.cameraLayout.totalWidth && exportData.cameraLayout.totalHeight) {
                    // Use custom layout dimensions
                    totalWidth = makeEven(exportData.cameraLayout.totalWidth);
                    totalHeight = makeEven(exportData.cameraLayout.totalHeight);
                    console.log(`🎬 Using custom layout dimensions: ${totalWidth}x${totalHeight}`);
                } else {
                    // Calculate grid dimensions for proper scaling
                    let cols, rows;
                    if (numStreams === 2) {
                        cols = 2; rows = 1;
                    } else if (numStreams === 3) {
                        cols = 3; rows = 1;
                    } else if (numStreams === 4) {
                        cols = 2; rows = 2;
                    } else if (numStreams === 5) {
                        cols = 3; rows = 2;
                    } else if (numStreams === 6) {
                        cols = 3; rows = 2;
                    } else {
                        cols = 3; rows = Math.ceil(numStreams / 3);
                    }
                    
                    totalWidth = makeEven(w * cols);
                    totalHeight = makeEven(h * rows);
                    console.log(`🎬 Using default grid dimensions: ${totalWidth}x${totalHeight}`);
                }
                
                const mobileWidth = makeEven(Math.floor(1080 * (totalWidth / totalHeight) / 2) * 2); // Ensure even width
                
                mainProcessingChain.push(`${lastOutputTag}scale=${mobileWidth}:1080[final]`);
                lastOutputTag = '[final]';
            } else {
                // For 'full' quality, scale the output grid to 1448p height for ALL hardware encoders (NVENC, QSV, VideoToolbox, AMF)
                // Use custom layout dimensions if available, otherwise calculate grid dimensions
                let totalWidth, totalHeight;
                
                if (exportData.cameraLayout && exportData.cameraLayout.totalWidth && exportData.cameraLayout.totalHeight) {
                    // Use custom layout dimensions
                    totalWidth = makeEven(exportData.cameraLayout.totalWidth);
                    totalHeight = makeEven(exportData.cameraLayout.totalHeight);
                    console.log(`🎬 Using custom layout dimensions: ${totalWidth}x${totalHeight}`);
                } else {
                    // Calculate grid dimensions as in mobile
                    let cols, rows;
                    if (numStreams === 2) {
                        cols = 2; rows = 1;
                    } else if (numStreams === 3) {
                        cols = 3; rows = 1;
                    } else if (numStreams === 4) {
                        cols = 2; rows = 2;
                    } else if (numStreams === 5) {
                        cols = 3; rows = 2;
                    } else if (numStreams === 6) {
                        cols = 3; rows = 2;
                    } else {
                        cols = 3; rows = Math.ceil(numStreams / 3);
                    }
                    totalWidth = makeEven(w * cols);
                    totalHeight = makeEven(h * rows);
                    console.log(`🎬 Using default grid dimensions: ${totalWidth}x${totalHeight}`);
                }
                
                const fullWidth = makeEven(Math.floor(1448 * (totalWidth / totalHeight) / 2) * 2); // Ensure even width
                mainProcessingChain.push(`${lastOutputTag}scale=${fullWidth}:1448[final]`);
                lastOutputTag = '[final]';
            }
            
            // Combine all filter chains
            const filterComplex = [...initialFilters, ...mainProcessingChain].join(';');
            cmd.push('-filter_complex', filterComplex);
            cmd.push('-map', '[final]');
            
            // Audio export is not needed for Tesla clips
            // Add encoding settings with hardware acceleration support
            let vCodec;

            if (hwaccel && hwaccel.enabled && hwaccel.encoder) {
                console.log(`🚀 Using hardware acceleration: ${hwaccel.type}`);

                // Hardware encoder settings
                switch (hwaccel.encoder) {
                    case 'h264_nvenc':
                        vCodec = quality === 'mobile' ?
                            ['-c:v', 'h264_nvenc', '-preset', 'fast', '-cq', '25'] :
                            ['-c:v', 'h264_nvenc', '-preset', 'medium', '-cq', '20'];
                        break;
                    case 'h264_amf':
                        vCodec = ['-c:v', 'h264_amf', '-pix_fmt', 'yuv420p', '-rc', 'cqp', '-qp_i', '22', '-qp_p', '22'];
                        break;
                    case 'h264_qsv':
                        vCodec = quality === 'mobile' ?
                            ['-c:v', 'h264_qsv', '-preset', 'fast', '-global_quality', '25'] :
                            ['-c:v', 'h264_qsv', '-preset', 'medium', '-global_quality', '20'];
                        break;
                    case 'h264_videotoolbox':
                        vCodec = quality === 'mobile' ?
                            ['-c:v', 'h264_videotoolbox', '-q:v', '65'] :
                            ['-c:v', 'h264_videotoolbox', '-q:v', '55'];
                        break;
                    default:
                        // Fallback to software encoding
                        vCodec = quality === 'mobile' ?
                            ['-c:v', 'libx264', '-preset', 'fast', '-crf', '23'] :
                            ['-c:v', 'libx264', '-preset', 'medium', '-crf', '18'];
                }
            } else {
                // Software encoding (default)
                console.log('🔧 Using software encoding (CPU)');
                vCodec = quality === 'mobile' ?
                    ['-c:v', 'libx264', '-preset', 'fast', '-crf', '23'] :
                    ['-c:v', 'libx264', '-preset', 'medium', '-crf', '18'];
            }
            
            // Calculate final output frame rate and duration
            let outputFPS = 30;
            let outputDuration = durationSeconds;

            if (timelapse && timelapse.enabled && timelapse.speed) {
                const speedMultiplier = parseInt(timelapse.speed);
                // For timelapse, adjust duration and frame rate
                outputDuration = durationSeconds / speedMultiplier;
                outputFPS = Math.min(60, Math.max(24, 30 * Math.log10(speedMultiplier)));
                console.log(`🎬 Timelapse output: ${outputDuration.toFixed(2)}s duration at ${outputFPS}fps (${speedMultiplier}x speed)`);
            }

            // Use the calculated duration and frame rate for the export
            cmd.push('-t', outputDuration.toString(), ...vCodec, '-r', outputFPS.toString(), outputPath);
            
            console.log('🚀 FFmpeg command:', cmd.join(' '));

            // Send initial progress
            event.sender.send('tesla:export-progress', exportId, {
                type: 'progress',
                percentage: 10,
                message: 'Starting multi-camera video export...'
            });

            // Execute FFmpeg
            return new Promise((resolve, reject) => {
                const process = spawn(cmd[0], cmd.slice(1));
                let stderr = '';
                let startTime = Date.now();
                let lastProgressUpdate = 0;
                let lastProgressTime = 0;
                let ffmpegProgressStarted = false;
                
                // Fallback timer that only runs if FFmpeg doesn't provide progress
                const fallbackTimer = setInterval(() => {
                    if (!ffmpegProgressStarted) {
                        const elapsed = (Date.now() - startTime) / 1000;
                        const estimatedTotal = durationSeconds * 2; // Assume 2x real-time
                        const progress = Math.min(90, Math.floor((elapsed / estimatedTotal) * 100));
                        
                        if (progress > lastProgressUpdate) {
                            lastProgressUpdate = progress;
                            event.sender.send('tesla:export-progress', exportId, {
                                type: 'progress',
                                percentage: progress,
                                message: `Initializing... (${progress}%)`
                            });
                        }
                    }
                }, 2000); // Update every 2 seconds
                
                const MAX_EXPORT_TIME_MS = 2 * 60 * 60 * 1000; // 2 hours
                let timeout = setTimeout(() => {
                    console.log('⚠️ Export timeout - killing process');
                    process.kill('SIGTERM');
                    clearInterval(fallbackTimer);
                    event.sender.send('tesla:export-progress', exportId, {
                        type: 'complete',
                        success: false,
                        message: 'Export timed out after 2 hours (no progress)'
                    });
                    reject(new Error('Export timed out'));
                }, MAX_EXPORT_TIME_MS);

                process.stderr.on('data', (data) => {
                    const dataStr = data.toString();
                    stderr += dataStr;
                    
                    // Debug: Log all FFmpeg output to see what we're getting
                    console.log(`[FFmpeg stderr]: ${dataStr.trim()}`);
                    
                    // Reset the timeout on every progress update
                    clearTimeout(timeout);
                    timeout = setTimeout(() => {
                        console.log('⚠️ Export timeout - killing process');
                        process.kill('SIGTERM');
                        clearInterval(fallbackTimer);
                        event.sender.send('tesla:export-progress', exportId, {
                            type: 'complete',
                            success: false,
                            message: 'Export timed out after 2 hours (no progress)'
                        });
                        reject(new Error('Export timed out'));
                    }, MAX_EXPORT_TIME_MS);

                    // Parse FFmpeg time output like PyQt6 version
                    const timeMatch = dataStr.match(/time=(\d{2}):(\d{2}):(\d{2})\.(\d{2})/);
                    if (timeMatch && durationSeconds > 0) {
                        const hours = parseInt(timeMatch[1]);
                        const minutes = parseInt(timeMatch[2]);
                        const seconds = parseInt(timeMatch[3]);
                        const centiseconds = parseInt(timeMatch[4]);
                        
                        const currentProgressSeconds = (hours * 3600) + (minutes * 60) + seconds + (centiseconds / 100);

                        // Use timelapse-adjusted duration for progress calculation
                        let progressDuration = durationSeconds;
                        if (timelapse && timelapse.enabled && timelapse.speed) {
                            const speedMultiplier = parseInt(timelapse.speed);
                            progressDuration = durationSeconds / speedMultiplier;
                            console.log(`🎬 Progress: Using timelapse duration ${progressDuration.toFixed(2)}s instead of ${durationSeconds}s`);
                        }

                        const percentage = Math.max(0, Math.min(90, Math.floor((currentProgressSeconds / progressDuration) * 100)));
                        
                        const isTimelapseExport = timelapse && timelapse.enabled && timelapse.speed;
                        const progressType = isTimelapseExport ? 'Timelapse' : 'Standard';
                        console.log(`[${progressType} Progress] Time: ${hours}:${minutes}:${seconds}.${centiseconds}, Progress: ${percentage}% (${currentProgressSeconds.toFixed(1)}s/${progressDuration.toFixed(1)}s)`);
                        
                        // Only update if progress has increased
                        if (percentage > lastProgressUpdate) {
                            lastProgressUpdate = percentage;
                            ffmpegProgressStarted = true;
                            
                            event.sender.send('tesla:export-progress', exportId, {
                                type: 'progress',
                                percentage: percentage,
                                message: `Exporting... (${percentage}%)`
                            });
                        }
                    }
                });

                process.on('close', (code) => {
                    console.log('FFmpeg process closed for exportId:', exportId, 'exit code:', code);
                    delete activeExports[exportId];
                    // Clear the timeout and fallback timer
                    clearTimeout(timeout);
                    clearInterval(fallbackTimer);
                    
                    if (code === 0) {
                        // Get final file size and show comparison
                        try {
                            const stats = fs.statSync(outputPath);
                            const fileSizeMB = (stats.size / (1024 * 1024)).toFixed(1);
                            
                            // Calculate estimated size for comparison using unified formula
                            const numCameras = inputs.length;

                            let estimatedSize;

                            // Check if this was a timelapse export
                            if (timelapse && timelapse.enabled && timelapse.speed > 1) {
                                // Timelapse calculation based on OUTPUT duration
                                // Calibrated from actual result: 59 seconds output = 700.6 MB
                                let baseSizePerMinute;
                                if (quality === 'full') {
                                    baseSizePerMinute = numCameras <= 2 ? 400 :
                                                       numCameras <= 4 ? 600 :
                                                       numCameras <= 6 ? 1000 : 1200;
                                } else {
                                    baseSizePerMinute = numCameras <= 2 ? 250 :
                                                       numCameras <= 4 ? 450 :
                                                       numCameras <= 6 ? 715 : 850; // 715 MB/min output
                                }

                                const outputDurationMinutes = durationSeconds / timelapse.speed / 60;
                                estimatedSize = Math.round(outputDurationMinutes * baseSizePerMinute);
                            } else {
                                // Regular export calculation based on INPUT duration
                                let baseSizePerMinute;
                                if (quality === 'full') {
                                    baseSizePerMinute = numCameras <= 2 ? 60 :
                                                       numCameras <= 4 ? 120 :
                                                       numCameras <= 6 ? 180 : 220;
                                } else {
                                    baseSizePerMinute = numCameras <= 2 ? 25 :
                                                       numCameras <= 4 ? 45 :
                                                       numCameras <= 6 ? 70 : 90;
                                }

                                const inputDurationMinutes = durationSeconds / 60;
                                const durationFactor = inputDurationMinutes < 1 ? 1.1 :
                                                      inputDurationMinutes < 5 ? 1.0 :
                                                      inputDurationMinutes < 15 ? 0.95 : 0.9;

                                estimatedSize = Math.round(inputDurationMinutes * baseSizePerMinute * durationFactor);
                            }
                            
                            const sizeDifference = Math.abs(parseFloat(fileSizeMB) - estimatedSize);
                            const accuracy = sizeDifference < 10 ? 'accurate' : sizeDifference < 30 ? 'close' : 'off';
                            
                            let message = `Export completed! File size: ${fileSizeMB} MB (${numCameras} cameras)`;
                            if (accuracy !== 'accurate') {
                                message += ` (estimated: ~${estimatedSize} MB)`;
                            }
                            
                            event.sender.send('tesla:export-progress', exportId, {
                                type: 'complete',
                                success: true,
                                message: message,
                                outputPath: outputPath
                            });
                        } catch (error) {
                            event.sender.send('tesla:export-progress', exportId, {
                                type: 'complete',
                                success: true,
                                message: `Export completed successfully! (${inputs.length} cameras)`,
                                outputPath: outputPath
                            });
                        }
                        // Clean up temporary concat files on success
                        tempFiles.forEach(tempFile => {
                            try {
                                fs.unlinkSync(tempFile);
                                console.log(`🗑️ Cleaned up temp file: ${tempFile}`);
                            } catch (error) {
                                console.warn(`⚠️ Failed to clean up temp file ${tempFile}:`, error.message);
                            }
                        });
                        resolve(true);
                    } else {
                        const error = `FFmpeg failed with code ${code}: ${stderr}`;
                        console.error(error);
                        event.sender.send('tesla:export-progress', exportId, {
                            type: 'complete',
                            success: false,
                            message: `Export failed: ${error}`
                        });
                        // Clean up temporary concat files on failure
                        tempFiles.forEach(tempFile => {
                            try {
                                fs.unlinkSync(tempFile);
                                console.log(`🗑️ Cleaned up temp file: ${tempFile}`);
                            } catch (error) {
                                console.warn(`⚠️ Failed to clean up temp file ${tempFile}:`, error.message);
                            }
                        });
                        reject(new Error(error));
                    }
                });

                process.on('error', (error) => {
                    // Clear the timeout and fallback timer
                    clearTimeout(timeout);
                    clearInterval(fallbackTimer);

                    const errorMsg = `Failed to start FFmpeg: ${error.message}`;
                    console.error(errorMsg);
                    event.sender.send('tesla:export-progress', exportId, {
                        type: 'complete',
                        success: false,
                        message: errorMsg
                    });
                    // Clean up temporary concat files on error
                    tempFiles.forEach(tempFile => {
                        try {
                            fs.unlinkSync(tempFile);
                            console.log(`🗑️ Cleaned up temp file: ${tempFile}`);
                        } catch (error) {
                            console.warn(`⚠️ Failed to clean up temp file ${tempFile}:`, error.message);
                        }
                    });
                    reject(new Error(errorMsg));
                });

                activeExports[exportId] = process;
                if (this.mainWindow && this.mainWindow.webContents) {
                    this.mainWindow.webContents.send('export:process-started', exportId);
                    console.log('Sent export:process-started for exportId:', exportId);
                }
            });

        } catch (error) {
            console.error('💥 Export process failed:', error);
            event.sender.send('tesla:export-progress', exportId, {
                type: 'complete',
                success: false,
                message: `Export failed: ${error.message}`
            });
            throw error;
        }
    }

    createApplicationMenu() {
        const template = [
            {
                label: 'File',
                submenu: [
                    {
                        label: 'Open Tesla Folder...',
                        accelerator: 'CmdOrCtrl+O',
                        click: async () => {
                            const result = await dialog.showOpenDialog(this.mainWindow, {
                                properties: ['openDirectory'],
                                title: 'Select Tesla Dashcam Folder'
                            });

                            if (!result.canceled && result.filePaths.length > 0) {
                                this.mainWindow.webContents.send('folder-selected', result.filePaths[0]);
                            }
                        }
                    },
                    { type: 'separator' },
                    {
                        label: 'Exit',
                        accelerator: process.platform === 'darwin' ? 'Cmd+Q' : 'Ctrl+Q',
                        click: () => {
                            app.quit();
                        }
                    }
                ]
            },
            {
                label: 'View',
                submenu: [
                    { role: 'reload' },
                    { role: 'forceReload' },
                    { role: 'toggleDevTools' },
                    { type: 'separator' },
                    { role: 'resetZoom' },
                    { role: 'zoomIn' },
                    { role: 'zoomOut' },
                    { type: 'separator' },
                    { role: 'togglefullscreen' }
                ]
            },
            {
                label: 'Help',
                submenu: [
                    {
                        label: 'About Sentry-Six',
                        click: () => {
                            dialog.showMessageBox(this.mainWindow, {
                                type: 'info',
                                title: 'About Sentry-Six',
                                message: 'Sentry-Six - Tesla Dashcam Viewer',
                                detail: `Version: ${app.getVersion()}\nElectron Edition - No more freezing!`
                            });
                        }
                    }
                ]
            }
        ];

        const menu = Menu.buildFromTemplate(template);
        Menu.setApplicationMenu(menu);
    }

    // Tesla file scanning functionality
    async scanTeslaFolder(folderPath) {
        console.log(`📁 Scanning Tesla folder: ${folderPath}`);
        console.time('Total folder scan time');
        const allVideoFiles = [];

        try {
            // Check if this is a direct SavedClips/RecentClips/SentryClips folder
            const isDirectClipFolder = ['SavedClips', 'RecentClips', 'SentryClips'].some(folder =>
                folderPath.toLowerCase().includes(folder.toLowerCase())
            );

            if (isDirectClipFolder) {
                // Scan the selected folder directly
                const folderName = path.basename(folderPath);
                console.log(`📂 Scanning direct folder: ${folderName}`);
                
                // Send "start scanning" progress update for direct folder
                if (this.mainWindow && !this.mainWindow.isDestroyed()) {
                    this.mainWindow.webContents.send('scan-progress', {
                        folder: folderName,
                        filesFound: 0,
                        totalFiles: 0,
                        status: 'scanning'
                    });
                }
                
                const files = await this.scanVideoFiles(folderPath, folderName);
                if (files && files.length) {
                    allVideoFiles.push(...files);
                    console.log(`✅ Found ${files.length} files in ${folderName}`);
                    
                    // Send "completed scanning" progress update for direct folder
                    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
                        this.mainWindow.webContents.send('scan-progress', {
                            folder: folderName,
                            filesFound: files.length,
                            totalFiles: files.length,
                            status: 'completed'
                        });
                    }
                }
            } else {
                // Scan for Tesla subfolders with progress reporting
                const subFolders = ['SavedClips', 'RecentClips', 'SentryClips'];
                let totalFilesFound = 0;

                for (const subFolder of subFolders) {
                    const subFolderPath = path.join(folderPath, subFolder);
                    if (fs.existsSync(subFolderPath)) {
                        console.log(`📂 Scanning ${subFolder}...`);
                        
                        // Send "start scanning" progress update to renderer
                        if (this.mainWindow && !this.mainWindow.isDestroyed()) {
                            this.mainWindow.webContents.send('scan-progress', {
                                folder: subFolder,
                                filesFound: 0,
                                totalFiles: totalFilesFound,
                                status: 'scanning'
                            });
                        }
                        
                        const files = await this.scanVideoFiles(subFolderPath, subFolder);
                        if (files && files.length) {
                            allVideoFiles.push(...files);
                            totalFilesFound += files.length;
                            console.log(`✅ Found ${files.length} files in ${subFolder} (Total so far: ${totalFilesFound})`);
                            
                            // Send "completed scanning" progress update to renderer
                            if (this.mainWindow && !this.mainWindow.isDestroyed()) {
                                this.mainWindow.webContents.send('scan-progress', {
                                    folder: subFolder,
                                    filesFound: files.length,
                                    totalFiles: totalFilesFound,
                                    status: 'completed'
                                });
                            }
                        } else {
                            console.log(`📭 No files found in ${subFolder}`);
                            
                            // Send "completed scanning" even for empty folders
                            if (this.mainWindow && !this.mainWindow.isDestroyed()) {
                                this.mainWindow.webContents.send('scan-progress', {
                                    folder: subFolder,
                                    filesFound: 0,
                                    totalFiles: totalFilesFound,
                                    status: 'completed'
                                });
                            }
                        }
                    }
                }
            }

            console.log(`🔍 Total video files found: ${allVideoFiles.length}`);

            // Group files by date and folder type
            console.log(`📊 Organizing ${allVideoFiles.length} video files...`);
            const groupedByDateAndType = this.groupVideosByDateAndType(allVideoFiles);
            
            const sectionCount = Object.keys(groupedByDateAndType).length;
            const totalDays = Object.values(groupedByDateAndType).reduce((sum, section) => sum + section.length, 0);
            
            console.log(`✅ Organized into ${sectionCount} sections with ${totalDays} date groups`);
            console.timeEnd('Total folder scan time');

            // Send scan completion event to renderer
            if (this.mainWindow && !this.mainWindow.isDestroyed()) {
                this.mainWindow.webContents.send('scan-complete', {
                    success: true,
                    totalFiles: allVideoFiles.length,
                    sections: sectionCount,
                    totalDays: totalDays
                });
            }

            return groupedByDateAndType;

        } catch (error) {
            console.error('❌ Error scanning Tesla folder:', error);
            console.timeEnd('Total folder scan time');
            
            // Send scan completion event even on error
            if (this.mainWindow && !this.mainWindow.isDestroyed()) {
                this.mainWindow.webContents.send('scan-complete', {
                    success: false,
                    error: error.message
                });
            }
            
            return {};
        }
    }

    async scanVideoFiles(folderPath, folderType) {
        const videoFiles = [];
        console.time(`Scanning ${folderType}`);

        try {
            if (folderType.toLowerCase() === 'recentclips') {
                // RecentClips can have either direct MP4 files OR date subfolders
                const items = await this.readDirAsync(folderPath);

                // Check if RecentClips has date subfolders (YYYY-MM-DD pattern) - optimized check
                const hasDateSubfolders = await this.checkForDateSubfolders(items, folderPath);

                if (hasDateSubfolders) {
                    console.log('RecentClips with date subfolders detected');
                    // Handle RecentClips with date subfolders (like SavedClips/SentryClips) - OPTIMIZED
                    const dateDirectories = items.filter(item => /^\d{4}-\d{2}-\d{2}$/.test(item));
                    
                    // Sort directories by date (newest first) for early loading of recent content
                    dateDirectories.sort((a, b) => b.localeCompare(a));
                    
                    // Process directories in batches to avoid blocking
                    const batchSize = 3;
                    for (let i = 0; i < dateDirectories.length; i += batchSize) {
                        const batch = dateDirectories.slice(i, i + batchSize);
                        const batchPromises = batch.map(async (item) => {
                            const itemPath = path.join(folderPath, item);
                            console.log(`Scanning RecentClips date folder: ${item}`);
                            
                            try {
                                const subFiles = await this.readDirAsync(itemPath);
                                const mp4Files = subFiles.filter(filename => 
                                    filename.toLowerCase().endsWith('.mp4') && !this.shouldSkipFile(filename)
                                );
                                
                                return await this.processBatchFiles(mp4Files, itemPath, folderType);
                            } catch (error) {
                                console.warn(`Failed to scan date folder ${item}:`, error.message);
                                return [];
                            }
                        });
                        
                        const batchResults = await Promise.all(batchPromises);
                        batchResults.forEach(result => videoFiles.push(...result));
                        
                        // Yield control back to event loop between batches
                        await new Promise(resolve => setImmediate(resolve));
                    }
                } else {
                    console.log('RecentClips with direct files detected');
                    // Handle RecentClips with direct MP4 files (original behavior) - OPTIMIZED
                    const mp4Files = items.filter(filename => 
                        filename.toLowerCase().endsWith('.mp4') && !this.shouldSkipFile(filename)
                    );
                    
                    const directFiles = await this.processBatchFiles(mp4Files, folderPath, folderType);
                    videoFiles.push(...directFiles);
                }
            } else {
                // SavedClips and SentryClips have date subfolders - OPTIMIZED
                const items = await this.readDirAsync(folderPath);
                const { directories, files } = await this.separateDirectoriesAndFiles(items, folderPath);
                
                // Process direct MP4 files first (if any)
                const directMp4Files = files.filter(item => 
                    item.toLowerCase().endsWith('.mp4') && !this.shouldSkipFile(item)
                );
                
                if (directMp4Files.length > 0) {
                    const directFiles = await this.processBatchFiles(directMp4Files, folderPath, folderType);
                    videoFiles.push(...directFiles);
                }
                
                // Sort directories by date (newest first)
                directories.sort((a, b) => b.localeCompare(a));
                
                // Process directories in batches
                const batchSize = 3;
                for (let i = 0; i < directories.length; i += batchSize) {
                    const batch = directories.slice(i, i + batchSize);
                    const batchPromises = batch.map(async (item) => {
                        const itemPath = path.join(folderPath, item);
                        
                        try {
                            const subFiles = await this.readDirAsync(itemPath);
                            const mp4Files = subFiles.filter(filename => 
                                filename.toLowerCase().endsWith('.mp4') && !this.shouldSkipFile(filename)
                            );
                            
                            return await this.processBatchFiles(mp4Files, itemPath, folderType);
                        } catch (error) {
                            console.warn(`Failed to scan directory ${item}:`, error.message);
                            return [];
                        }
                    });
                    
                    const batchResults = await Promise.all(batchPromises);
                    batchResults.forEach(result => videoFiles.push(...result));
                    
                    // Yield control back to event loop between batches
                    await new Promise(resolve => setImmediate(resolve));
                }
            }

        } catch (error) {
            console.error(`Error scanning ${folderPath}:`, error);
        }

        console.timeEnd(`Scanning ${folderType}`);
        console.log(`Found ${videoFiles.length} video files in ${folderType}`);
        return videoFiles;
    }

    shouldSkipFile(filename) {
        const skipPatterns = [
            'event.mp4',           // Tesla's compiled event video
            'temp_scaled.mp4',     // Temporary scaled video
            '._',                  // macOS metadata files
            '.DS_Store'            // macOS system files
        ];

        const lowerFilename = filename.toLowerCase();
        return skipPatterns.some(pattern =>
            lowerFilename === pattern || lowerFilename.startsWith(pattern)
        );
    }

    // Async wrapper for fs.readdir to avoid blocking main thread
    async readDirAsync(folderPath) {
        return new Promise((resolve, reject) => {
            fs.readdir(folderPath, (err, files) => {
                if (err) reject(err);
                else resolve(files);
            });
        });
    }

    // Optimized check for date subfolders without multiple statSync calls
    async checkForDateSubfolders(items, folderPath) {
        const checkPromises = items.slice(0, 10).map(async (item) => { // Only check first 10 items for efficiency
            return new Promise((resolve) => {
                const itemPath = path.join(folderPath, item);
                fs.stat(itemPath, (err, stats) => {
                    if (err) {
                        resolve(false);
                    } else {
                        resolve(stats.isDirectory() && /^\d{4}-\d{2}-\d{2}$/.test(item));
                    }
                });
            });
        });

        const results = await Promise.all(checkPromises);
        return results.some(result => result);
    }

    // Separate directories and files in one pass to avoid multiple stat calls
    async separateDirectoriesAndFiles(items, folderPath) {
        const statPromises = items.map(async (item) => {
            return new Promise((resolve) => {
                const itemPath = path.join(folderPath, item);
                fs.stat(itemPath, (err, stats) => {
                    if (err) {
                        resolve({ item, isDirectory: false, error: true });
                    } else {
                        resolve({ item, isDirectory: stats.isDirectory(), error: false });
                    }
                });
            });
        });

        const results = await Promise.all(statPromises);
        const directories = [];
        const files = [];

        results.forEach(({ item, isDirectory, error }) => {
            if (!error) {
                if (isDirectory) {
                    directories.push(item);
                } else {
                    files.push(item);
                }
            }
        });

        return { directories, files };
    }

    // Process files in batches to avoid blocking and improve performance
    async processBatchFiles(filenames, folderPath, folderType) {
        const batchSize = 20; // Process 20 files at a time
        const results = [];

        for (let i = 0; i < filenames.length; i += batchSize) {
            const batch = filenames.slice(i, i + batchSize);
            const batchPromises = batch.map(async (filename) => {
                const filePath = path.join(folderPath, filename);
                return this.parseTeslaFilenameAsync(filePath, filename, folderType);
            });

            const batchResults = await Promise.all(batchPromises);
            results.push(...batchResults.filter(result => result !== null));

            // Yield control to prevent blocking
            if (i + batchSize < filenames.length) {
                await new Promise(resolve => setImmediate(resolve));
            }
        }

        return results;
    }

    parseTeslaFilename(filePath, filename, folderType) {
        // Parse Tesla filename format: YYYY-MM-DD_HH-MM-SS-camera.mp4
        const match = filename.match(/^(\d{4}-\d{2}-\d{2})_(\d{2}-\d{2}-\d{2})-(.+)\.mp4$/);

        if (!match) {
            console.warn(`Invalid Tesla filename format: ${filename}`);
            return null;
        }

        const [, datePart, timePart, cameraPart] = match;

        // Parse timestamp
        const timestamp = this.parseTimestamp(datePart, timePart);
        if (!timestamp) {
            console.warn(`Could not parse timestamp from: ${filename}`);
            return null;
        }

        // Parse camera type
        const camera = this.parseCamera(cameraPart);
        if (!camera) {
            console.warn(`Unknown camera type: ${cameraPart}`);
            return null;
        }

        const stats = fs.statSync(filePath);

        return {
            path: filePath,
            filename,
            camera,
            timestamp,
            size: stats.size,
            type: folderType
        };
    }

    // Async version of parseTeslaFilename to avoid blocking
    async parseTeslaFilenameAsync(filePath, filename, folderType) {
        // Parse Tesla filename format: YYYY-MM-DD_HH-MM-SS-camera.mp4
        const match = filename.match(/^(\d{4}-\d{2}-\d{2})_(\d{2}-\d{2}-\d{2})-(.+)\.mp4$/);

        if (!match) {
            console.warn(`Invalid Tesla filename format: ${filename}`);
            return null;
        }

        const [, datePart, timePart, cameraPart] = match;

        // Parse timestamp
        const timestamp = this.parseTimestamp(datePart, timePart);
        if (!timestamp) {
            console.warn(`Could not parse timestamp from: ${filename}`);
            return null;
        }

        // Parse camera type
        const camera = this.parseCamera(cameraPart);
        if (!camera) {
            console.warn(`Unknown camera type: ${cameraPart}`);
            return null;
        }

        // Use async stat to avoid blocking
        const stats = await new Promise((resolve, reject) => {
            fs.stat(filePath, (err, stats) => {
                if (err) reject(err);
                else resolve(stats);
            });
        });

        return {
            path: filePath,
            filename,
            camera,
            timestamp,
            size: stats.size,
            type: folderType
        };
    }

    parseTimestamp(datePart, timePart) {
        try {
            // Parse as local time to avoid timezone offset issues
            // Split the date and time parts
            const [year, month, day] = datePart.split('-').map(Number);
            const [hour, minute, second] = timePart.split('-').map(Number);

            // Create Date object in local timezone (not UTC)
            const timestamp = new Date(year, month - 1, day, hour, minute, second);

            return isNaN(timestamp.getTime()) ? null : timestamp;
        } catch (error) {
            console.error('Error parsing timestamp:', error);
            return null;
        }
    }

    parseCamera(cameraPart) {
        const cameraMap = {
            'front': 'front',
            'left_repeater': 'left_repeater',
            'right_repeater': 'right_repeater',
            'left_pillar': 'left_pillar',      // Keep pillar cameras separate
            'right_pillar': 'right_pillar',    // Keep pillar cameras separate
            'back': 'back'
        };

        return cameraMap[cameraPart] || null;
    }

    isClipCorrupted(fileSize, filename, duration = null) {
        if (duration !== null && duration > 0 && duration < 4) {
            return true;
        }
        
        // Tesla clips are typically 40-80MB for 60-second recordings
        // Corrupted clips are usually under 5MB
        const MIN_VALID_SIZE = 5 * 1024 * 1024; // 5MB threshold

        if (fileSize < MIN_VALID_SIZE) {
            // Additional check: very small files (under 2MB) are almost certainly corrupted
            const VERY_SMALL_SIZE = 2 * 1024 * 1024; // 2MB
            if (fileSize < VERY_SMALL_SIZE) {
                return true; // Definitely corrupted
            }

            // For files between 2-5MB, be more lenient for legitimate short clips
            // But still flag extremely small ones
            const TINY_SIZE = 1.5 * 1024 * 1024; // 1.5MB
            if (fileSize < TINY_SIZE) {
                return true; // Likely corrupted
            }

            // Log suspicious files for user awareness
            console.log(`🔍 Suspicious small file: ${filename} (${Math.round(fileSize/1024)}KB) - including but monitoring`);
        }

        return false; // File appears valid
    }

    filterCorruptedTimestampGroups(clips) {
        // Return all clips without any corruption filtering
        return clips;
    }

    groupVideosByDateAndType(videoFiles) {
        console.time('Grouping videos by date and type');
        
        const sections = {
            'User Saved': [],
            'Sentry Detection': [],
            'Recent Clips': []
        };

        // Pre-calculate section keys to avoid repeated function calls
        const sectionKeyMap = {
            'savedclips': 'User Saved',
            'sentryclips': 'Sentry Detection', 
            'recentclips': 'Recent Clips'
        };

        // Group files by date and type - OPTIMIZED
        const dateGroups = new Map();

        // Process files in batches to avoid blocking the main thread with large datasets
        const batchSize = 500;
        
        for (let i = 0; i < videoFiles.length; i += batchSize) {
            const batch = videoFiles.slice(i, i + batchSize);
            
            for (const file of batch) {
                // Create date key using local time (not UTC) - optimized string construction
                const timestamp = file.timestamp;
                const dateKey = `${timestamp.getFullYear()}-${String(timestamp.getMonth() + 1).padStart(2, '0')}-${String(timestamp.getDate()).padStart(2, '0')}`;
                const sectionKey = sectionKeyMap[file.type.toLowerCase()] || 'User Saved';

                // Optimized nested map access
                let sectionMap = dateGroups.get(sectionKey);
                if (!sectionMap) {
                    sectionMap = new Map();
                    dateGroups.set(sectionKey, sectionMap);
                }

                let dayMap = sectionMap.get(dateKey);
                if (!dayMap) {
                    dayMap = new Map();
                    sectionMap.set(dateKey, dayMap);
                }

                // Create timestamp key using local time (not UTC)
                const timestampKey = timestamp.getTime(); // Use number instead of string for better performance

                let group = dayMap.get(timestampKey);
                if (!group) {
                    group = {
                        timestamp: timestamp,
                        files: {},
                        type: file.type,
                        date: dateKey
                    };
                    dayMap.set(timestampKey, group);
                }

                group.files[file.camera] = file;
            }
        }

        // Convert to organized structure - OPTIMIZED
        for (const [sectionKey, sectionMap] of dateGroups) {
            for (const [dateKey, dayMap] of sectionMap) {
                const allClips = Array.from(dayMap.values()).sort((a, b) =>
                    a.timestamp.getTime() - b.timestamp.getTime()
                );

                // Filter out timestamp groups where majority of cameras are corrupted
                const clips = this.filterCorruptedTimestampGroups(allClips);

                // Optimized date parsing - avoid string splitting and multiple Date constructions
                const year = parseInt(dateKey.substring(0, 4));
                const month = parseInt(dateKey.substring(5, 7));
                const day = parseInt(dateKey.substring(8, 10));
                const dateObj = new Date(year, month - 1, day); // Local time
                const displayDate = dateObj.toLocaleDateString('en-US', {
                    month: '2-digit',
                    day: '2-digit',
                    year: '2-digit'
                });

                // Skip expensive duration calculation during initial scan - will be calculated on-demand
                // This significantly improves performance for large folders
                const actualTotalDuration = null;

                sections[sectionKey].push({
                    date: dateKey,
                    displayDate: displayDate,
                    clips: clips,
                    totalClips: clips.length,
                    originalClipCount: allClips.length,
                    filteredClipCount: clips.length,
                    actualTotalDuration: actualTotalDuration
                });
            }
        }

        // Sort dates within each section (newest first) - optimized comparison
        for (const sectionKey in sections) {
            sections[sectionKey].sort((a, b) => b.date.localeCompare(a.date)); // String comparison is faster than Date construction
        }

        console.timeEnd('Grouping videos by date and type');
        return sections;
    }

    getSectionKey(folderType) {
        switch (folderType.toLowerCase()) {
            case 'savedclips':
                return 'User Saved';
            case 'sentryclips':
                return 'Sentry Detection';
            case 'recentclips':
                return 'Recent Clips';
            default:
                return 'User Saved';
        }
    }

    groupVideosByTimestamp(videoFiles) {
        const groups = new Map();

        for (const file of videoFiles) {
            // Use timestamp as key for grouping
            const groupKey = file.timestamp.toISOString();

            if (!groups.has(groupKey)) {
                groups.set(groupKey, {
                    timestamp: file.timestamp,
                    files: {},
                    type: file.type
                });
            }

            const group = groups.get(groupKey);
            group.files[file.camera] = file;
        }

        // Convert to array and sort by timestamp
        return Array.from(groups.values()).sort((a, b) =>
            a.timestamp.getTime() - b.timestamp.getTime()
        );
    }

    // Tesla event scanning functionality
    async scanTeslaEvents(folderPath) {
        console.log('Scanning Tesla events in:', folderPath);
        const events = [];

        try {
            const teslaFolders = ['SavedClips', 'SentryClips']; // Skip RecentClips as per requirements
            
            // Check if this is a direct SavedClips/SentryClips folder (same logic as scanTeslaFolder)
            const isDirectClipFolder = teslaFolders.some(folder =>
                folderPath.toLowerCase().includes(folder.toLowerCase())
            );

            if (isDirectClipFolder) {
                // User selected a specific SavedClips or SentryClips folder
                const folderType = teslaFolders.find(folder => 
                    folderPath.toLowerCase().includes(folder.toLowerCase())
                );
                const clipEvents = await this.scanClipFoldersForEvents(folderPath, folderType);
                events.push(...clipEvents);
            } else {
                // User selected the root TeslaCam folder, scan for subdirectories
                for (const folderType of teslaFolders) {
                    const subFolderPath = path.join(folderPath, folderType);

                    if (fs.existsSync(subFolderPath)) {
                        const clipEvents = await this.scanClipFoldersForEvents(subFolderPath, folderType);
                        events.push(...clipEvents);
                    }
                }
            }

            console.log(`Found ${events.length} events`);
            return events.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));

        } catch (error) {
            console.error('Error scanning Tesla events:', error);
            return [];
        }
    }

    async scanEventsForSpecificDate(folderPath, targetDate, folderType) {
        const events = [];

        try {
            // Determine the correct folder type name for the path
            const folderTypeMap = {
                'User Saved': 'SavedClips',
                'Sentry Detection': 'SentryClips'
            };
            
            const actualFolderType = folderTypeMap[folderType] || folderType;
            
            // Check if this is a direct SavedClips/SentryClips folder
            const isDirectClipFolder = actualFolderType && 
                folderPath.toLowerCase().includes(actualFolderType.toLowerCase());

            let searchPath;
            if (isDirectClipFolder) {
                // User selected a specific SavedClips or SentryClips folder
                searchPath = folderPath;
            } else {
                // User selected the root TeslaCam folder, look in subfolder
                searchPath = path.join(folderPath, actualFolderType);
                if (!fs.existsSync(searchPath)) {
                    return [];
                }
            }

            // Look for all folders that start with the target date (YYYY-MM-DD format)
            // This handles cases like "2025-07-28", "2025-07-28_14-50-51", "2025-07-28_15-30-22", etc.
            const entries = fs.readdirSync(searchPath, { withFileTypes: true });
            const dateFolders = entries.filter(entry => 
                entry.isDirectory() && entry.name.startsWith(targetDate)
            );

            if (dateFolders.length === 0) {
                return [];
            }

            // Scan for event.json files in all date folders
            for (const dateFolder of dateFolders) {
                const dateFolderPath = path.join(searchPath, dateFolder.name);
                const subEntries = fs.readdirSync(dateFolderPath, { withFileTypes: true });
                
                // First, check for event.json directly in the date folder
                const directEventJsonPath = path.join(dateFolderPath, 'event.json');
                if (fs.existsSync(directEventJsonPath)) {
                    try {
                        const eventData = JSON.parse(fs.readFileSync(directEventJsonPath, 'utf8'));

                        if (eventData.timestamp && eventData.reason) {
                            const thumbnailPath = path.join(dateFolderPath, 'thumb.png');
                            const hasThumbnail = fs.existsSync(thumbnailPath);

                            events.push({
                                timestamp: eventData.timestamp,
                                reason: eventData.reason,
                                city: eventData.city,
                                est_lat: eventData.est_lat,
                                est_lon: eventData.est_lon,
                                camera: eventData.camera,
                                folderPath: dateFolderPath,
                                thumbnailPath: hasThumbnail ? thumbnailPath : null,
                                timestampDate: new Date(eventData.timestamp),
                                type: actualFolderType
                            });
                        }
                    } catch (parseError) {
                        console.warn(`Error parsing event.json in ${dateFolderPath}:`, parseError);
                    }
                }

                // Also check subdirectories for event.json files (for other folder structures)
                for (const entry of subEntries) {
                    if (entry.isDirectory()) {
                        const clipFolderPath = path.join(dateFolderPath, entry.name);
                        const eventJsonPath = path.join(clipFolderPath, 'event.json');

                        if (fs.existsSync(eventJsonPath)) {
                            try {
                                const eventData = JSON.parse(fs.readFileSync(eventJsonPath, 'utf8'));

                                if (eventData.timestamp && eventData.reason) {
                                    const thumbnailPath = path.join(clipFolderPath, 'thumb.png');
                                    const hasThumbnail = fs.existsSync(thumbnailPath);

                                    events.push({
                                        timestamp: eventData.timestamp,
                                        reason: eventData.reason,
                                        city: eventData.city,
                                        est_lat: eventData.est_lat,
                                        est_lon: eventData.est_lon,
                                        camera: eventData.camera,
                                        folderPath: clipFolderPath,
                                        thumbnailPath: hasThumbnail ? thumbnailPath : null,
                                        timestampDate: new Date(eventData.timestamp),
                                        type: actualFolderType
                                    });
                                }
                            } catch (parseError) {
                                console.warn(`Error parsing event.json in ${clipFolderPath}:`, parseError);
                            }
                        }
                    }
                }
            }

            return events.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));

        } catch (error) {
            console.error(`Error scanning events for ${targetDate}:`, error);
            return [];
        }
    }

    async scanClipFoldersForEvents(subFolderPath, folderType) {
        const events = [];

        try {
            const entries = fs.readdirSync(subFolderPath, { withFileTypes: true });

            for (const entry of entries) {
                if (entry.isDirectory()) {
                    const clipFolderPath = path.join(subFolderPath, entry.name);
                    const eventJsonPath = path.join(clipFolderPath, 'event.json');

                    if (fs.existsSync(eventJsonPath)) {
                        try {
                            const eventData = JSON.parse(fs.readFileSync(eventJsonPath, 'utf8'));

                            if (eventData.timestamp && eventData.reason) {
                                const thumbnailPath = path.join(clipFolderPath, 'thumb.png');
                                const hasThumbnail = fs.existsSync(thumbnailPath);

                                events.push({
                                    timestamp: eventData.timestamp,
                                    reason: eventData.reason,
                                    city: eventData.city,
                                    est_lat: eventData.est_lat,
                                    est_lon: eventData.est_lon,
                                    camera: eventData.camera,
                                    folderPath: clipFolderPath,
                                    thumbnailPath: hasThumbnail ? thumbnailPath : null,
                                    timestampDate: new Date(eventData.timestamp),
                                    type: folderType
                                });
                            }
                        } catch (parseError) {
                            console.warn(`Error parsing event.json in ${clipFolderPath}:`, parseError);
                        }
                    }
                }
            }
        } catch (error) {
            console.error(`Error scanning clip folders in ${subFolderPath}:`, error);
        }

        return events;
    }

    // Find clips that overlap with the export range
    findClipsForExportRange(timeline, startTime, endTime) {
        const timelineStartTime = timeline.startTime.getTime();
        const exportClips = [];
        
        console.log(`🔍 Finding clips for export range: ${startTime}ms to ${endTime}ms`);
        console.log(`📅 Timeline start: ${new Date(timelineStartTime).toISOString()}`);
        console.log(`📊 Timeline has ${timeline.clips?.length || 0} clips, accurateTimeline: ${timeline.accurateTimeline}`);

        // Use accurate timeline logic if available
        if (timeline.accurateTimeline && timeline.sortedClips) {
            console.log(`✅ Using accurate timeline with ${timeline.sortedClips.length} sorted clips`);
            
            for (let i = 0; i < timeline.sortedClips.length; i++) {
                const clip = timeline.sortedClips[i];
                if (!clip || !clip.timestamp) continue;

                // Calculate clip position using accurate timeline logic
                const clipStartTime = new Date(clip.timestamp).getTime();
                const clipRelativeStart = clipStartTime - timelineStartTime;
                
                // Use actual duration from timeline if available, otherwise estimate
                let clipDuration = 60000; // Default 60 seconds
                if (timeline.actualDurations && timeline.actualDurations[i]) {
                    clipDuration = timeline.actualDurations[i];
                }

                const clipRelativeEnd = clipRelativeStart + clipDuration;

                // Check if clip overlaps with export range
                const clipOverlaps = (clipRelativeStart < endTime) && (clipRelativeEnd > startTime);

                if (clipOverlaps) {
                    console.log(`📹 Clip ${i} (${clip.timestamp}) overlaps with export range (${clipRelativeStart}-${clipRelativeEnd}ms)`);
                    exportClips.push({
                        ...clip,
                        clipIndex: i,
                        clipRelativeStart: clipRelativeStart,
                        clipDuration: clipDuration
                    });
                }
            }
        } else {
            // Fallback to legacy sequential positioning
            console.log(`⚠️ Using legacy sequential positioning`);
            let currentPosition = 0;

            for (let i = 0; i < timeline.clips.length; i++) {
                const clip = timeline.clips[i];
                if (!clip || !clip.timestamp) continue;

                // Use actual duration from timeline if available, otherwise estimate
                let clipDuration = 60000; // Default 60 seconds
                if (timeline.actualDurations && timeline.actualDurations[i]) {
                    clipDuration = timeline.actualDurations[i];
                }

                const clipRelativeStart = currentPosition;
                const clipRelativeEnd = currentPosition + clipDuration;

                // Check if clip overlaps with export range
                const clipOverlaps = (clipRelativeStart < endTime) && (clipRelativeEnd > startTime);

                if (clipOverlaps) {
                    console.log(`📹 Clip ${i} (${clip.timestamp}) overlaps with export range (${clipRelativeStart}-${clipRelativeEnd}ms)`);
                    exportClips.push({
                        ...clip,
                        clipIndex: i,
                        clipRelativeStart: clipRelativeStart,
                        clipDuration: clipDuration
                    });
                }

                currentPosition += clipDuration;
            }
        }

        console.log(`📊 Found ${exportClips.length} clips for export range`);
        return exportClips;
    }
}

// Initialize the application
console.log('Starting Sentry-Six Electron application...');
new SentrySixApp();
