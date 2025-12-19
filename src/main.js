const { app, BrowserWindow, dialog, ipcMain, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn, spawnSync } = require('child_process');

// Active exports tracking
const activeExports = {};

// Main window reference
let mainWindow = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    title: 'Sentry Six Revamped',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false, // Required for FFmpeg operations
      webSecurity: false, // allow local asset fetch (dashcam.proto, etc.)
    },
  });

  mainWindow.setMenuBarVisibility(false);
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
}

// ============================================================
// FFmpeg Path Finding
// ============================================================
function findFFmpegPath() {
  const isMac = process.platform === 'darwin';
  const possiblePaths = isMac ? [
    path.join(__dirname, '..', 'ffmpeg_bin', 'mac', 'ffmpeg'),
    path.join(process.cwd(), 'ffmpeg_bin', 'mac', 'ffmpeg'),
    '/usr/local/bin/ffmpeg',
    '/opt/homebrew/bin/ffmpeg',
    'ffmpeg'
  ] : [
    path.join(__dirname, '..', 'ffmpeg_bin', 'ffmpeg.exe'),
    path.join(__dirname, '..', 'ffmpeg_bin', 'ffmpeg'),
    path.join(process.cwd(), 'ffmpeg_bin', 'ffmpeg.exe'),
    path.join(process.cwd(), 'ffmpeg_bin', 'ffmpeg'),
    'ffmpeg',
    '/usr/bin/ffmpeg'
  ];

  for (const ffmpegPath of possiblePaths) {
    try {
      const result = spawnSync(ffmpegPath, ['-version'], {
        timeout: 5000,
        windowsHide: true
      });
      if (result.status === 0) {
        console.log(`✅ Found FFmpeg at: ${ffmpegPath}`);
        return ffmpegPath;
      }
    } catch {
      // Continue to next path
    }
  }
  console.warn('❌ FFmpeg not found in any known location');
  return null;
}

// ============================================================
// Video Duration Utility
// ============================================================
function getVideoDuration(filePath, ffmpegPath) {
  try {
    const ffprobePath = ffmpegPath.replace(/ffmpeg(\.exe)?$/, process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe');
    const result = spawnSync(ffprobePath, [
      '-v', 'error',
      '-show_entries', 'format=duration',
      '-of', 'default=noprint_wrappers=1:nokey=1',
      filePath
    ], { timeout: 10000, windowsHide: true });
    
    if (result.status === 0) {
      const duration = parseFloat(result.stdout.toString().trim());
      return isNaN(duration) ? 60 : duration;
    }
  } catch (err) {
    console.warn('Error getting video duration:', err);
  }
  return 60; // Default 60 seconds
}

// Ensure dimensions are even (required for video encoding)
function makeEven(n) {
  return Math.floor(n / 2) * 2;
}

// ============================================================
// Video Export Implementation
// ============================================================
async function performVideoExport(event, exportId, exportData, ffmpegPath) {
  const { segments, startTimeMs, endTimeMs, outputPath, cameras } = exportData;
  const tempFiles = [];

  try {
    console.log('🎬 Starting video export...');
    console.log('📊 Export data:', { 
      segments: segments?.length, 
      startTimeMs, 
      endTimeMs, 
      outputPath,
      cameras 
    });

    const durationMs = endTimeMs - startTimeMs;
    const durationSeconds = durationMs / 1000;

    // Camera order for 3x2 grid layout (standard Tesla layout)
    const cameraOrder = ['left_pillar', 'front', 'right_pillar', 'left_repeater', 'back', 'right_repeater'];
    const activeCameras = cameras || cameraOrder;

    // Find segments that overlap with export range
    const relevantSegments = [];
    let cumulativeMs = 0;

    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i];
      const segDurationMs = (seg.durationSec || 60) * 1000;
      const segStartMs = cumulativeMs;
      const segEndMs = cumulativeMs + segDurationMs;

      // Check if segment overlaps with export range
      if (segEndMs > startTimeMs && segStartMs < endTimeMs) {
        relevantSegments.push({
          ...seg,
          index: i,
          segStartMs,
          segEndMs,
          segDurationMs
        });
      }
      cumulativeMs += segDurationMs;
    }

    console.log(`📹 Found ${relevantSegments.length} segments for export`);

    if (relevantSegments.length === 0) {
      throw new Error('No segments found in export range');
    }

    // Build input streams for each camera
    const inputs = [];
    const numCameras = activeCameras.length;

    for (let camIdx = 0; camIdx < numCameras; camIdx++) {
      const camera = activeCameras[camIdx];
      const cameraFiles = [];

      for (const seg of relevantSegments) {
        const filePath = seg.files?.[camera];
        if (filePath && fs.existsSync(filePath)) {
          cameraFiles.push({
            path: filePath,
            segStartMs: seg.segStartMs,
            segEndMs: seg.segEndMs
          });
        }
      }

      if (cameraFiles.length === 0) {
        console.log(`⚠️ No files for camera ${camera}, skipping`);
        continue;
      }

      if (cameraFiles.length === 1) {
        // Single file - direct input
        const clip = cameraFiles[0];
        const relativeOffset = Math.max(0, startTimeMs - clip.segStartMs) / 1000;
        
        inputs.push({
          camera,
          path: clip.path,
          relativeOffset,
          isConcat: false
        });
      } else {
        // Multiple files - create concat file
        const concatFilePath = path.join(os.tmpdir(), `sentry_export_${camera}_${Date.now()}.txt`);
        
        const concatContent = cameraFiles.map(clip => {
          const clipOffset = Math.max(0, startTimeMs - clip.segStartMs) / 1000;
          const clipEnd = Math.min(endTimeMs - clip.segStartMs, clip.segEndMs - clip.segStartMs) / 1000;
          return `file '${clip.path.replace(/\\/g, '/')}'`;
        }).join('\n');

        fs.writeFileSync(concatFilePath, concatContent, { encoding: 'utf8' });
        tempFiles.push(concatFilePath);
        
        console.log(`📝 Created concat file for ${camera}: ${concatFilePath}`);

        const firstClipOffset = Math.max(0, startTimeMs - cameraFiles[0].segStartMs) / 1000;
        
        inputs.push({
          camera,
          path: concatFilePath,
          relativeOffset: firstClipOffset,
          isConcat: true
        });
      }
    }

    if (inputs.length === 0) {
      throw new Error('No valid camera files found for export');
    }

    // Build FFmpeg command
    const cmd = [ffmpegPath, '-y'];
    const initialFilters = [];
    
    // Add input streams
    for (const input of inputs) {
      if (input.isConcat) {
        cmd.push('-f', 'concat', '-safe', '0');
      }
      if (input.relativeOffset > 0) {
        cmd.push('-ss', input.relativeOffset.toString());
      }
      cmd.push('-i', input.path);
    }

    // Standard Tesla camera resolution
    const w = 1280; // Smaller for faster export
    const h = 720;

    // Build filter chains
    const cameraStreams = [];
    
    for (let i = 0; i < inputs.length; i++) {
      const input = inputs[i];
      const isMirroredCamera = ['back', 'left_repeater', 'right_repeater'].includes(input.camera);
      
      let filterChain = 'setpts=PTS-STARTPTS';
      if (isMirroredCamera) {
        filterChain += ',hflip';
      }
      filterChain += `,scale=${makeEven(w)}:${makeEven(h)}`;
      
      initialFilters.push(`[${i}:v]${filterChain}[v${i}]`);
      cameraStreams.push(`[v${i}]`);
    }

    // Build grid layout using xstack
    const numStreams = cameraStreams.length;
    let mainProcessingChain = [];
    let lastOutputTag = '';

    if (numStreams > 1) {
      // Calculate grid layout (3x2 for 6 cameras, 2x2 for 4, etc.)
      let cols, rows;
      if (numStreams === 2) { cols = 2; rows = 1; }
      else if (numStreams === 3) { cols = 3; rows = 1; }
      else if (numStreams === 4) { cols = 2; rows = 2; }
      else if (numStreams === 5) { cols = 3; rows = 2; }
      else if (numStreams === 6) { cols = 3; rows = 2; }
      else { cols = 3; rows = Math.ceil(numStreams / 3); }

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

      console.log(`🔲 Grid layout: ${cols}x${rows}, total ${numStreams} cameras`);
    } else {
      lastOutputTag = cameraStreams[0];
    }

    // Final scaling
    const totalWidth = makeEven(w * (numStreams > 1 ? Math.min(3, numStreams) : 1));
    const totalHeight = makeEven(h * (numStreams > 3 ? 2 : 1));
    mainProcessingChain.push(`${lastOutputTag}scale=${totalWidth}:${totalHeight}[final]`);

    // Combine filter chains
    const filterComplex = [...initialFilters, ...mainProcessingChain].join(';');
    cmd.push('-filter_complex', filterComplex);
    cmd.push('-map', '[final]');

    // Encoding settings (software encoding for compatibility)
    cmd.push(
      '-c:v', 'libx264',
      '-preset', 'fast',
      '-crf', '23',
      '-t', durationSeconds.toString(),
      '-r', '30',
      outputPath
    );

    console.log('🚀 FFmpeg command:', cmd.join(' '));

    // Send initial progress
    event.sender.send('export:progress', exportId, {
      type: 'progress',
      percentage: 5,
      message: 'Starting export...'
    });

    // Execute FFmpeg
    return new Promise((resolve, reject) => {
      const proc = spawn(cmd[0], cmd.slice(1));
      let stderr = '';
      let lastProgressUpdate = 0;

      proc.stderr.on('data', (data) => {
        const dataStr = data.toString();
        stderr += dataStr;

        // Parse FFmpeg time output
        const timeMatch = dataStr.match(/time=(\d{2}):(\d{2}):(\d{2})\.(\d{2})/);
        if (timeMatch && durationSeconds > 0) {
          const hours = parseInt(timeMatch[1]);
          const minutes = parseInt(timeMatch[2]);
          const seconds = parseInt(timeMatch[3]);
          const currentSec = hours * 3600 + minutes * 60 + seconds;
          const percentage = Math.min(95, Math.floor((currentSec / durationSeconds) * 100));

          if (percentage > lastProgressUpdate) {
            lastProgressUpdate = percentage;
            event.sender.send('export:progress', exportId, {
              type: 'progress',
              percentage,
              message: `Exporting... ${percentage}%`
            });
          }
        }
      });

      proc.on('close', (code) => {
        delete activeExports[exportId];

        // Cleanup temp files
        tempFiles.forEach(f => {
          try { fs.unlinkSync(f); } catch {}
        });

        if (code === 0) {
          const stats = fs.statSync(outputPath);
          const sizeMB = (stats.size / (1024 * 1024)).toFixed(1);
          
          event.sender.send('export:progress', exportId, {
            type: 'complete',
            success: true,
            message: `Export complete! (${sizeMB} MB)`,
            outputPath
          });
          resolve(true);
        } else {
          const errorMsg = `Export failed with code ${code}`;
          console.error(errorMsg, stderr);
          event.sender.send('export:progress', exportId, {
            type: 'complete',
            success: false,
            message: errorMsg
          });
          reject(new Error(errorMsg));
        }
      });

      proc.on('error', (error) => {
        tempFiles.forEach(f => {
          try { fs.unlinkSync(f); } catch {}
        });
        const errorMsg = `Failed to start FFmpeg: ${error.message}`;
        event.sender.send('export:progress', exportId, {
          type: 'complete',
          success: false,
          message: errorMsg
        });
        reject(new Error(errorMsg));
      });

      activeExports[exportId] = proc;
    });

  } catch (error) {
    console.error('Export error:', error);
    tempFiles.forEach(f => {
      try { fs.unlinkSync(f); } catch {}
    });
    throw error;
  }
}

app.whenReady().then(() => {
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

ipcMain.handle('dialog:openFolder', async () => {
  const result = await dialog.showOpenDialog({
    properties: ['openDirectory'],
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  return result.filePaths[0];
});

ipcMain.handle('shell:openExternal', async (_event, url) => {
  await shell.openExternal(url);
});

// ============================================================
// Export IPC Handlers
// ============================================================
ipcMain.handle('dialog:saveFile', async (_event, options) => {
  const result = await dialog.showSaveDialog({
    title: options?.title || 'Save Export',
    defaultPath: options?.defaultPath || `tesla_export_${new Date().toISOString().slice(0, 10)}.mp4`,
    filters: options?.filters || [
      { name: 'Video Files', extensions: ['mp4'] },
      { name: 'All Files', extensions: ['*'] }
    ]
  });
  if (result.canceled) return null;
  return result.filePath;
});

ipcMain.handle('export:start', async (event, exportId, exportData) => {
  console.log('🚀 Starting export:', exportId);
  
  try {
    const ffmpegPath = findFFmpegPath();
    if (!ffmpegPath) {
      throw new Error('FFmpeg not found. Please install FFmpeg or place it in the ffmpeg_bin directory.');
    }

    const result = await performVideoExport(event, exportId, exportData, ffmpegPath);
    return result;
  } catch (error) {
    console.error('Export failed:', error);
    event.sender.send('export:progress', exportId, {
      type: 'complete',
      success: false,
      message: `Export failed: ${error.message}`
    });
    return false;
  }
});

ipcMain.handle('export:cancel', async (_event, exportId) => {
  const proc = activeExports[exportId];
  if (proc) {
    proc.kill('SIGTERM');
    delete activeExports[exportId];
    return true;
  }
  return false;
});

ipcMain.handle('fs:showItemInFolder', async (_event, filePath) => {
  shell.showItemInFolder(filePath);
});

ipcMain.handle('ffmpeg:check', async () => {
  const ffmpegPath = findFFmpegPath();
  return { available: !!ffmpegPath, path: ffmpegPath };
});

// Read directory contents (for folder traversal)
ipcMain.handle('fs:readDir', async (_event, dirPath) => {
  try {
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    return entries.map(entry => ({
      name: entry.name,
      isDirectory: entry.isDirectory(),
      isFile: entry.isFile(),
      path: path.join(dirPath, entry.name)
    }));
  } catch (err) {
    console.error('Error reading directory:', err);
    return [];
  }
});

// Check if path exists
ipcMain.handle('fs:exists', async (_event, filePath) => {
  return fs.existsSync(filePath);
});

// Get file stats
ipcMain.handle('fs:stat', async (_event, filePath) => {
  try {
    const stats = fs.statSync(filePath);
    return {
      size: stats.size,
      isDirectory: stats.isDirectory(),
      isFile: stats.isFile(),
      mtime: stats.mtime.toISOString()
    };
  } catch (err) {
    return null;
  }
});

