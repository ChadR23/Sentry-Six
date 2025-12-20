const { app, BrowserWindow, dialog, ipcMain, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn, spawnSync, execSync } = require('child_process');
const https = require('https');
const { createWriteStream, mkdirSync, rmSync, copyFileSync } = require('fs');

// ============================================================
// Auto-Update Configuration
// ============================================================
const UPDATE_CONFIG = {
  owner: 'ChadR23',
  repo: 'Sentry-Six',
  branch: 'Dev-SEI',
  versionFile: path.join(app.getPath('userData'), 'current-version.json')
};

// Active exports tracking
const activeExports = {};
let mainWindow = null;
let gpuEncoder = null; // Cached GPU encoder detection

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    title: 'Sentry Six Revamped',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      webSecurity: false,
    },
  });
  mainWindow.setMenuBarVisibility(false);
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
}

// ============================================================
// FFmpeg Utilities
// ============================================================
function findFFmpegPath() {
  const isMac = process.platform === 'darwin';
  const isWin = process.platform === 'win32';
  
  // Build list of paths to check
  const paths = [];
  
  if (isMac) {
    // macOS: Check common install locations
    // Electron apps don't inherit shell PATH, so we check explicit paths
    const macPaths = [
      '/opt/homebrew/bin/ffmpeg',  // Homebrew Apple Silicon
      '/usr/local/bin/ffmpeg',      // Homebrew Intel Mac
      '/opt/local/bin/ffmpeg',      // MacPorts
      '/usr/bin/ffmpeg',            // System
      // Also check user's local bin
      path.join(os.homedir(), '.local', 'bin', 'ffmpeg'),
      path.join(os.homedir(), 'bin', 'ffmpeg')
    ];
    
    // Log what we're checking for debugging
    console.log('🍎 macOS detected, checking FFmpeg paths:');
    for (const p of macPaths) {
      const exists = fs.existsSync(p);
      console.log(`   ${exists ? '✓' : '✗'} ${p}`);
      if (exists) paths.push(p);
    }
    
    // If no explicit paths found, still add them for spawn check (might be symlinked)
    if (paths.length === 0) {
      paths.push(...macPaths);
    }
  } else if (isWin) {
    // Windows: Check bundled paths first, then system
    paths.push(
      path.join(__dirname, '..', 'ffmpeg_bin', 'ffmpeg.exe'),
      path.join(__dirname, 'ffmpeg_bin', 'ffmpeg.exe'),
      path.join(process.cwd(), 'ffmpeg_bin', 'ffmpeg.exe'),
      path.join(app.getAppPath(), 'ffmpeg_bin', 'ffmpeg.exe'),
      path.join(app.getAppPath(), '..', 'ffmpeg_bin', 'ffmpeg.exe')
    );
  } else {
    // Linux: Check bundled paths and system paths
    paths.push(
      path.join(__dirname, '..', 'ffmpeg_bin', 'ffmpeg'),
      path.join(__dirname, 'ffmpeg_bin', 'ffmpeg'),
      path.join(process.cwd(), 'ffmpeg_bin', 'ffmpeg'),
      '/usr/bin/ffmpeg',
      '/usr/local/bin/ffmpeg'
    );
  }
  
  // Always try PATH as last resort
  paths.push('ffmpeg');

  console.log('🔍 Searching for FFmpeg in:', paths);

  for (const p of paths) {
    try {
      // First check if file exists (skip for bare 'ffmpeg' which relies on PATH)
      const exists = p === 'ffmpeg' || fs.existsSync(p);
      console.log(`  Checking ${p}: exists=${exists}`);
      
      if (!exists) continue;
      
      const result = spawnSync(p, ['-version'], { 
        timeout: 5000, 
        windowsHide: true,
        encoding: 'utf8',
        shell: true  // Use shell on macOS to handle symlinks properly
      });
      
      console.log(`  Spawn result: status=${result.status}, error=${result.error?.message || 'none'}`);
      
      if (result.status === 0) {
        console.log(`✅ Found FFmpeg at: ${p}`);
        return p;
      }
    } catch (err) {
      console.log(`  Error checking ${p}: ${err.message}`);
    }
  }
  
  console.warn('❌ FFmpeg not found in any of the checked paths');
  return null;
}

function detectGpuEncoder(ffmpegPath) {
  if (gpuEncoder !== null) return gpuEncoder;
  
  try {
    const result = spawnSync(ffmpegPath, ['-encoders'], { timeout: 5000, windowsHide: true });
    const output = result.stdout?.toString() || '';
    
    // Check for GPU encoders in order of preference
    if (process.platform === 'darwin' && output.includes('h264_videotoolbox')) {
      gpuEncoder = { codec: 'h264_videotoolbox', name: 'Apple VideoToolbox' };
    } else if (output.includes('h264_nvenc')) {
      gpuEncoder = { codec: 'h264_nvenc', name: 'NVIDIA NVENC' };
    } else if (output.includes('h264_amf')) {
      gpuEncoder = { codec: 'h264_amf', name: 'AMD AMF' };
    } else if (output.includes('h264_qsv')) {
      gpuEncoder = { codec: 'h264_qsv', name: 'Intel QuickSync' };
    } else {
      gpuEncoder = null;
    }
    
    if (gpuEncoder) console.log(`🎮 GPU encoder available: ${gpuEncoder.name}`);
  } catch {
    gpuEncoder = null;
  }
  return gpuEncoder;
}

function makeEven(n) {
  return Math.floor(n / 2) * 2;
}

// ============================================================
// Video Export Implementation
// ============================================================
async function performVideoExport(event, exportId, exportData, ffmpegPath) {
  const { segments, startTimeMs, endTimeMs, outputPath, cameras, mobileExport, quality } = exportData;
  const tempFiles = [];
  const CAMERA_ORDER = ['left_pillar', 'front', 'right_pillar', 'left_repeater', 'back', 'right_repeater'];
  const FPS = 36; // Tesla cameras record at ~36fps

  const sendProgress = (percentage, message) => {
    event.sender.send('export:progress', exportId, { type: 'progress', percentage, message });
  };

  const sendComplete = (success, message) => {
    event.sender.send('export:progress', exportId, { type: 'complete', success, message, outputPath });
  };

  const cleanup = () => tempFiles.forEach(f => { try { fs.unlinkSync(f); } catch {} });

  try {
    console.log('🎬 Starting video export...');
    sendProgress(2, 'Analyzing segments...');

    const durationSec = (endTimeMs - startTimeMs) / 1000;
    const selectedCameras = new Set(cameras || CAMERA_ORDER);

    // Find overlapping segments
    const relevantSegments = [];
    let cumMs = 0;
    for (const seg of segments) {
      const segDur = (seg.durationSec || 60) * 1000;
      const segStart = cumMs, segEnd = cumMs + segDur;
      if (segEnd > startTimeMs && segStart < endTimeMs) {
        relevantSegments.push({ ...seg, segStartMs: segStart, segEndMs: segEnd });
      }
      cumMs += segDur;
    }

    if (!relevantSegments.length) throw new Error('No segments found in export range');
    console.log(`📹 Found ${relevantSegments.length} segments for export`);

    // Build camera inputs for ALL cameras in order (use black for missing/unselected)
    const inputs = [];
    const cameraInputMap = new Map(); // Maps camera name to input index

    for (const camera of CAMERA_ORDER) {
      // Skip if not selected
      if (!selectedCameras.has(camera)) continue;
      
      const files = relevantSegments
        .map(seg => seg.files?.[camera])
        .filter(p => p && fs.existsSync(p));

      if (!files.length) continue; // Will use black source

      if (files.length === 1) {
        const seg = relevantSegments.find(s => s.files?.[camera] === files[0]);
        cameraInputMap.set(camera, inputs.length);
        inputs.push({
          camera,
          path: files[0],
          offset: Math.max(0, startTimeMs - seg.segStartMs) / 1000,
          isConcat: false
        });
      } else {
        const concatPath = path.join(os.tmpdir(), `export_${camera}_${Date.now()}.txt`);
        fs.writeFileSync(concatPath, files.map(f => `file '${f.replace(/\\/g, '/')}'`).join('\n'));
        tempFiles.push(concatPath);
        
        const firstSeg = relevantSegments.find(s => s.files?.[camera] === files[0]);
        cameraInputMap.set(camera, inputs.length);
        inputs.push({
          camera,
          path: concatPath,
          offset: Math.max(0, startTimeMs - firstSeg.segStartMs) / 1000,
          isConcat: true
        });
      }
    }

    if (!inputs.length) throw new Error('No valid camera files found for export');

    sendProgress(5, 'Building export...');

    // Quality settings based on quality option (per-camera resolution)
    // Tesla cameras: Front=2896×1876, Others=1448×938 (both ~1.54:1 aspect ratio)
    // Multi-cam: scale to side camera res (1448×938) to avoid upscaling artifacts
    // Front-only: use full front camera resolution for max quality
    const isFrontOnly = selectedCameras.size === 1 && selectedCameras.has('front');
    let w, h, crf;
    const q = quality || (mobileExport ? 'mobile' : 'high');
    
    if (isFrontOnly) {
      // Front camera only - use full front camera resolution
      switch (q) {
        case 'mobile':   w = 724;  h = 469;  crf = 28; break;
        case 'medium':   w = 1448; h = 938;  crf = 26; break;
        case 'high':     w = 2172; h = 1407; crf = 23; break;
        case 'max':      w = 2896; h = 1876; crf = 20; break;  // Full front native
        default:         w = 1448; h = 938;  crf = 23;
      }
      console.log('📹 Front camera only - using full front camera resolution');
    } else {
      // Multi-camera - scale to side camera resolution
      switch (q) {
        case 'mobile':   w = 484;  h = 314;  crf = 28; break;  // 0.33x side native
        case 'medium':   w = 724;  h = 469;  crf = 26; break;  // 0.5x side native
        case 'high':     w = 1086; h = 704;  crf = 23; break;  // 0.75x side native
        case 'max':      w = 1448; h = 938;  crf = 20; break;  // Side native (front scaled down)
        default:         w = 1086; h = 704;  crf = 23;
      }
    }

    // Detect GPU encoder
    const gpu = detectGpuEncoder(ffmpegPath);

    // Build FFmpeg command
    const cmd = [ffmpegPath, '-y'];

    // Add video inputs
    for (const input of inputs) {
      if (input.isConcat) cmd.push('-f', 'concat', '-safe', '0');
      if (input.offset > 0) cmd.push('-ss', input.offset.toString());
      cmd.push('-i', input.path);
    }

    // Always add black source for missing cameras
    const blackInputIdx = inputs.length;
    cmd.push('-f', 'lavfi', '-i', `color=c=black:s=${w}x${h}:r=${FPS}:d=${durationSec}`);

    // Build filter complex - always use full 6-camera grid
    const filters = [];
    const streamTags = [];
    const activeCamerasForGrid = CAMERA_ORDER.filter(c => selectedCameras.has(c));

    for (let i = 0; i < activeCamerasForGrid.length; i++) {
      const camera = activeCamerasForGrid[i];
      const inputIdx = cameraInputMap.get(camera);
      const hasVideo = inputIdx !== undefined;
      const srcIdx = hasVideo ? inputIdx : blackInputIdx;
      const isMirrored = ['back', 'left_repeater', 'right_repeater'].includes(camera);

      // Force constant frame rate (Tesla cameras use VFR which causes playback issues)
      let chain = `[${srcIdx}:v]fps=${FPS},setpts=PTS-STARTPTS`;
      if (hasVideo && isMirrored) chain += ',hflip';
      chain += `,scale=${w}:${h}:force_original_aspect_ratio=disable,setsar=1[v${i}]`;
      
      filters.push(chain);
      streamTags.push(`[v${i}]`);
    }

    // Grid layout
    const numStreams = streamTags.length;
    let cols, rows;
    if (numStreams <= 1) { cols = 1; rows = 1; }
    else if (numStreams === 2) { cols = 2; rows = 1; }
    else if (numStreams === 3) { cols = 3; rows = 1; }
    else if (numStreams === 4) { cols = 2; rows = 2; }
    else { cols = 3; rows = 2; }

    if (numStreams > 1) {
      const layout = [];
      for (let i = 0; i < numStreams; i++) {
        layout.push(`${(i % cols) * w}_${Math.floor(i / cols) * h}`);
      }
      filters.push(`${streamTags.join('')}xstack=inputs=${numStreams}:layout=${layout.join('|')}:fill=black[out]`);
    } else {
      filters.push(`${streamTags[0]}copy[out]`);
    }

    cmd.push('-filter_complex', filters.join(';'));
    cmd.push('-map', '[out]');

    // Calculate total output resolution for GPU limit check
    const totalW = w * cols;
    const totalH = h * rows;
    const gpuMaxRes = 4096; // Most GPU encoders have 4096 limit on one dimension
    const useGpu = gpu && !mobileExport && totalW <= gpuMaxRes && totalH <= gpuMaxRes;

    // Encoding settings
    if (useGpu) {
      cmd.push('-c:v', gpu.codec);
      if (gpu.codec === 'h264_nvenc') {
        cmd.push('-preset', 'p4', '-rc', 'vbr', '-cq', crf.toString());
      } else if (gpu.codec === 'h264_amf') {
        cmd.push('-quality', 'balanced', '-rc', 'vbr_latency');
      } else if (gpu.codec === 'h264_videotoolbox') {
        cmd.push('-q:v', Math.max(40, 100 - crf * 2).toString());
      } else {
        cmd.push('-preset', 'fast', '-crf', crf.toString());
      }
      console.log(`🎮 Using GPU encoder: ${gpu.name}`);
    } else {
      if (gpu && (totalW > gpuMaxRes || totalH > gpuMaxRes)) {
        console.log(`⚠️ Resolution ${totalW}×${totalH} exceeds GPU limit (${gpuMaxRes}), using CPU encoder`);
      }
      cmd.push('-c:v', 'libx264', '-preset', mobileExport ? 'faster' : 'fast', '-crf', crf.toString());
    }

    cmd.push('-r', FPS.toString(), '-t', durationSec.toString());
    cmd.push('-movflags', '+faststart'); // Better streaming
    cmd.push('-pix_fmt', 'yuv420p'); // Compatibility
    cmd.push(outputPath);

    console.log('🚀 FFmpeg:', cmd.slice(0, 20).join(' ') + '...');
    sendProgress(8, useGpu ? `Exporting with ${gpu.name}...` : 'Exporting with CPU...');

    // Execute
    return new Promise((resolve, reject) => {
      const proc = spawn(cmd[0], cmd.slice(1));
      let stderr = '', lastPct = 0;

      proc.stderr.on('data', (data) => {
        stderr += data.toString();
        const match = data.toString().match(/time=(\d+):(\d+):(\d+)/);
        if (match && durationSec > 0) {
          const sec = +match[1] * 3600 + +match[2] * 60 + +match[3];
          const pct = Math.min(95, Math.floor((sec / durationSec) * 100));
          if (pct > lastPct) {
            lastPct = pct;
            sendProgress(pct, `Exporting... ${pct}%`);
          }
        }
      });

      proc.on('close', (code) => {
        delete activeExports[exportId];
        cleanup();

        if (code === 0) {
          const sizeMB = (fs.statSync(outputPath).size / 1048576).toFixed(1);
          sendComplete(true, `Export complete! (${sizeMB} MB)`);
          resolve(true);
        } else {
          console.error('FFmpeg error:', stderr.slice(-500));
          sendComplete(false, `Export failed (code ${code})`);
          reject(new Error(`Export failed with code ${code}`));
        }
      });

      proc.on('error', (err) => {
        cleanup();
        sendComplete(false, `FFmpeg error: ${err.message}`);
        reject(err);
      });

      activeExports[exportId] = proc;
    });

  } catch (error) {
    console.error('Export error:', error);
    cleanup();
    throw error;
  }
}

app.whenReady().then(async () => {
  createWindow();
  
  // Update check is now triggered by renderer after checking user settings
  // This allows user to disable auto-update check in settings

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

// File-based settings storage for reliable persistence
const settingsPath = path.join(app.getPath('userData'), 'settings.json');

function loadSettings() {
  try {
    if (fs.existsSync(settingsPath)) {
      const data = fs.readFileSync(settingsPath, 'utf-8');
      return JSON.parse(data);
    }
  } catch (err) {
    console.error('Failed to load settings:', err);
  }
  return {};
}

function saveSettings(settings) {
  try {
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2), 'utf-8');
    return true;
  } catch (err) {
    console.error('Failed to save settings:', err);
    return false;
  }
}

ipcMain.handle('settings:get', async (event, key) => {
  const settings = loadSettings();
  return settings[key];
});

ipcMain.handle('settings:set', async (event, key, value) => {
  const settings = loadSettings();
  settings[key] = value;
  return saveSettings(settings);
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

// Read file contents (for event.json)
ipcMain.handle('fs:readFile', async (_event, filePath) => {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    console.error('Error reading file:', err);
    throw err;
  }
});

// ============================================================
// Auto-Update System
// ============================================================

function httpsGet(url) {
  return new Promise((resolve, reject) => {
    const options = {
      headers: { 'User-Agent': 'Sentry-Six-Updater' }
    };
    https.get(url, options, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        return httpsGet(res.headers.location).then(resolve).catch(reject);
      }
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve({ statusCode: res.statusCode, data }));
      res.on('error', reject);
    }).on('error', reject);
  });
}

function downloadFile(url, destPath, onProgress) {
  return new Promise((resolve, reject) => {
    const options = {
      headers: { 'User-Agent': 'Sentry-Six-Updater' }
    };
    
    const handleResponse = (res) => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        https.get(res.headers.location, options, handleResponse).on('error', reject);
        return;
      }
      
      const totalSize = parseInt(res.headers['content-length'], 10);
      let downloadedSize = 0;
      const file = createWriteStream(destPath);
      
      res.on('data', chunk => {
        downloadedSize += chunk.length;
        if (onProgress && totalSize) {
          onProgress(Math.round((downloadedSize / totalSize) * 100));
        }
      });
      
      res.pipe(file);
      file.on('finish', () => {
        file.close();
        resolve(destPath);
      });
      file.on('error', (err) => {
        fs.unlinkSync(destPath);
        reject(err);
      });
    };
    
    https.get(url, options, handleResponse).on('error', reject);
  });
}

function getCurrentVersion() {
  try {
    if (fs.existsSync(UPDATE_CONFIG.versionFile)) {
      const data = JSON.parse(fs.readFileSync(UPDATE_CONFIG.versionFile, 'utf8'));
      return data.commitSha || null;
    }
  } catch (err) {
    console.error('Error reading version file:', err);
  }
  return null;
}

function saveCurrentVersion(commitSha, commitDate, commitMessage) {
  try {
    const dir = path.dirname(UPDATE_CONFIG.versionFile);
    if (!fs.existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(UPDATE_CONFIG.versionFile, JSON.stringify({
      commitSha,
      commitDate,
      commitMessage,
      updatedAt: new Date().toISOString()
    }, null, 2));
  } catch (err) {
    console.error('Error saving version file:', err);
  }
}

async function getLatestCommit() {
  const url = `https://api.github.com/repos/${UPDATE_CONFIG.owner}/${UPDATE_CONFIG.repo}/commits/${UPDATE_CONFIG.branch}`;
  const response = await httpsGet(url);
  
  if (response.statusCode !== 200) {
    throw new Error(`GitHub API error: ${response.statusCode}`);
  }
  
  const commit = JSON.parse(response.data);
  return {
    sha: commit.sha,
    shortSha: commit.sha.substring(0, 7),
    message: commit.commit.message.split('\n')[0],
    date: commit.commit.author.date,
    author: commit.commit.author.name
  };
}

async function checkForUpdatesOnStartup() {
  try {
    console.log('🔄 Checking for updates...');
    const latestCommit = await getLatestCommit();
    const currentVersion = getCurrentVersion();
    
    console.log(`📌 Current: ${currentVersion || 'unknown'}`);
    console.log(`📦 Latest: ${latestCommit.sha}`);
    
    if (!currentVersion) {
      // First run - save current version without prompting
      saveCurrentVersion(latestCommit.sha, latestCommit.date, latestCommit.message);
      console.log('✅ Version initialized');
      return;
    }
    
    if (currentVersion !== latestCommit.sha) {
      // New version available - notify renderer
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('update:available', {
          currentVersion: currentVersion.substring(0, 7),
          latestVersion: latestCommit.shortSha,
          message: latestCommit.message,
          date: latestCommit.date,
          author: latestCommit.author
        });
      }
    } else {
      console.log('✅ App is up to date');
    }
  } catch (err) {
    console.error('❌ Update check failed:', err.message);
  }
}

async function performUpdate(event) {
  const sendProgress = (percentage, message) => {
    event.sender.send('update:progress', { percentage, message });
  };
  
  try {
    sendProgress(5, 'Fetching latest version info...');
    const latestCommit = await getLatestCommit();
    
    const zipUrl = `https://github.com/${UPDATE_CONFIG.owner}/${UPDATE_CONFIG.repo}/archive/refs/heads/${UPDATE_CONFIG.branch}.zip`;
    const tempDir = path.join(os.tmpdir(), 'sentry-six-update');
    const zipPath = path.join(tempDir, 'update.zip');
    
    // Clean and create temp directory
    if (fs.existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true, force: true });
    }
    mkdirSync(tempDir, { recursive: true });
    
    sendProgress(10, 'Downloading update...');
    await downloadFile(zipUrl, zipPath, (pct) => {
      sendProgress(10 + Math.round(pct * 0.5), `Downloading... ${pct}%`);
    });
    
    sendProgress(60, 'Extracting update...');
    
    // Extract zip file
    const extractDir = path.join(tempDir, 'extracted');
    mkdirSync(extractDir, { recursive: true });
    
    if (process.platform === 'win32') {
      // Windows: Use PowerShell
      execSync(`powershell -Command "Expand-Archive -Path '${zipPath}' -DestinationPath '${extractDir}' -Force"`, { windowsHide: true });
    } else {
      // macOS/Linux: Use unzip
      execSync(`unzip -o "${zipPath}" -d "${extractDir}"`, { stdio: 'ignore' });
    }
    
    sendProgress(75, 'Installing update...');
    
    // Find the extracted folder (GitHub adds repo-branch prefix)
    const extractedContents = fs.readdirSync(extractDir);
    const sourceDir = path.join(extractDir, extractedContents[0]);
    
    // Get app directory (where the app is installed)
    const appDir = app.isPackaged 
      ? path.dirname(app.getPath('exe'))
      : path.join(__dirname, '..');
    
    // Copy ALL files from the downloaded repo to app directory
    // This includes src/, README.md, package.json, and any other files
    const filesToCopy = fs.readdirSync(sourceDir, { withFileTypes: true });
    for (const entry of filesToCopy) {
      const srcPath = path.join(sourceDir, entry.name);
      const destPath = path.join(appDir, entry.name);
      
      // Skip node_modules and .git directories
      if (entry.name === 'node_modules' || entry.name === '.git') continue;
      
      if (entry.isDirectory()) {
        copyDirectory(srcPath, destPath);
      } else {
        copyFileSync(srcPath, destPath);
      }
    }
    
    sendProgress(90, 'Cleaning up...');
    
    // Cleanup temp files
    rmSync(tempDir, { recursive: true, force: true });
    
    // Save new version
    saveCurrentVersion(latestCommit.sha, latestCommit.date, latestCommit.message);
    
    sendProgress(100, 'Update complete!');
    
    return { success: true, needsRestart: true };
  } catch (err) {
    console.error('Update failed:', err);
    return { success: false, error: err.message };
  }
}

function copyDirectory(src, dest) {
  if (!fs.existsSync(src)) return;
  
  if (!fs.existsSync(dest)) {
    mkdirSync(dest, { recursive: true });
  }
  
  const entries = fs.readdirSync(src, { withFileTypes: true });
  
  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    
    if (entry.isDirectory()) {
      copyDirectory(srcPath, destPath);
    } else {
      copyFileSync(srcPath, destPath);
    }
  }
}

// Update IPC handlers
ipcMain.handle('update:check', async () => {
  // Call the existing checkForUpdatesOnStartup which handles everything
  // including sending the update:available event to the renderer
  await checkForUpdatesOnStartup();
  return { checked: true };
});

ipcMain.handle('update:install', async (event) => {
  const result = await performUpdate(event);
  // Don't auto-restart - let the UI show an Exit button
  return result;
});

ipcMain.handle('update:exit', async () => {
  // User clicked Exit button after update - quit the app
  app.quit();
});

ipcMain.handle('update:skip', async () => {
  // User chose to skip - just acknowledge
  return { skipped: true };
});

ipcMain.handle('update:bypass', async () => {
  // Hidden dev feature - mark current version as latest without downloading
  try {
    const latestCommit = await getLatestCommit();
    saveCurrentVersion(latestCommit.sha, latestCommit.date, latestCommit.message);
    console.log('🔧 [DEV] Update bypassed - version set to:', latestCommit.sha.substring(0, 7));
    return { success: true, version: latestCommit.shortSha };
  } catch (err) {
    console.error('Bypass update error:', err);
    return { success: false, error: err.message };
  }
});

// ============================================================
// Developer Settings IPC Handlers
// ============================================================

ipcMain.handle('dev:openDevTools', async () => {
  if (mainWindow) {
    mainWindow.webContents.openDevTools();
    return { success: true };
  }
  return { success: false, error: 'No main window' };
});

ipcMain.handle('dev:resetSettings', async () => {
  try {
    if (fs.existsSync(settingsPath)) {
      fs.unlinkSync(settingsPath);
      console.log('🔧 [DEV] Settings reset - deleted:', settingsPath);
    }
    return { success: true, path: settingsPath };
  } catch (err) {
    console.error('Reset settings error:', err);
    return { success: false, error: err.message };
  }
});

ipcMain.handle('dev:forceLatestVersion', async () => {
  try {
    const latestCommit = await getLatestCommit();
    saveCurrentVersion(latestCommit.sha, latestCommit.date, latestCommit.message);
    console.log('🔧 [DEV] Version forced to latest:', latestCommit.sha.substring(0, 7));
    return { success: true, version: latestCommit.sha.substring(0, 7) };
  } catch (err) {
    console.error('Force latest version error:', err);
    return { success: false, error: err.message };
  }
});

ipcMain.handle('dev:setTestingVersion', async () => {
  try {
    saveCurrentVersion('testing', new Date().toISOString(), 'Testing version');
    console.log('🔧 [DEV] Version set to Testing');
    return { success: true, version: 'Testing' };
  } catch (err) {
    console.error('Set testing version error:', err);
    return { success: false, error: err.message };
  }
});

ipcMain.handle('dev:getAppPaths', async () => {
  return {
    userData: app.getPath('userData'),
    settings: settingsPath,
    version: UPDATE_CONFIG.versionFile,
    app: app.getAppPath(),
    temp: app.getPath('temp')
  };
});

ipcMain.handle('dev:reloadApp', async () => {
  if (mainWindow) {
    mainWindow.reload();
    return { success: true };
  }
  return { success: false, error: 'No main window' };
});

