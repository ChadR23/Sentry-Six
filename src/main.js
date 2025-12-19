const { app, BrowserWindow, dialog, ipcMain, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn, spawnSync } = require('child_process');

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

// Read file contents (for event.json)
ipcMain.handle('fs:readFile', async (_event, filePath) => {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    console.error('Error reading file:', err);
    throw err;
  }
});

