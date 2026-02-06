const { app, BrowserWindow, dialog, ipcMain, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn, spawnSync, execSync } = require('child_process');
const { writeCompactDashboardAss, cleanupAssFile, writeMinimapAss } = require('./assGenerator');
const https = require('https');
const http = require('http');
let _canvas = null;
function getCanvas() { if (!_canvas) _canvas = require('canvas'); return _canvas; }
const { checkUpdateWithTelemetry, processApiResponse } = require('./updateTelemetry');
const { settingsPath, loadSettings, saveSettings, registerSettingsIpc } = require('./main/settings');
const { SUPPORT_SERVER_URL, makeSupportRequest, registerSupportChatIpc } = require('./main/supportChat');
const { fetchFromUrl, registerDiagnosticsStorageIpc } = require('./main/diagnostics');
const { UPDATE_CONFIG, autoUpdater, getLatestVersionFromGitHub, compareVersions, registerAutoUpdateIpc, setupAutoUpdaterEvents } = require('./main/autoUpdate');
const { findFFmpegPath, formatExportDuration, detectGpuHardware, detectGpuEncoder, detectHEVCEncoder, makeEven, getGpuEncoder, setGpuEncoder, getGpuEncoderHEVC, setGpuEncoderHEVC } = require('./main/ffmpeg');
const { calculateMinimapSize, downloadStaticMapBackground, preRenderMinimap } = require('./main/minimap');

// ============================================
// DIAGNOSTICS: Console capture (must be early to catch all logs)
// ============================================
const mainLogBuffer = [];
const originalMainConsole = {
  log: console.log.bind(console),
  warn: console.warn.bind(console),
  error: console.error.bind(console),
  info: console.info.bind(console)
};

function captureMainLog(level, args) {
  const entry = {
    t: Date.now(),
    l: level,
    m: args.map(arg => {
      try {
        if (arg instanceof Error) {
          return `${arg.name}: ${arg.message}\n${arg.stack || ''}`;
        }
        if (typeof arg === 'object') {
          return JSON.stringify(arg, null, 0);
        }
        return String(arg);
      } catch {
        return '[Unserializable]';
      }
    }).join(' ')
  };
  mainLogBuffer.push(entry);
}

// Override console methods to capture all logs from startup
console.log = (...args) => { captureMainLog('log', args); originalMainConsole.log(...args); };
console.warn = (...args) => { captureMainLog('warn', args); originalMainConsole.warn(...args); };
console.error = (...args) => { captureMainLog('error', args); originalMainConsole.error(...args); };
console.info = (...args) => { captureMainLog('info', args); originalMainConsole.info(...args); };

// Get the configured update branch from settings (defaults to main)
function getUpdateBranch() {
  const settings = loadSettings();
  return settings.updateBranch || UPDATE_CONFIG.defaultBranch;
}

// Active exports tracking
const activeExports = {};
const cancelledExports = new Set(); // Track cancelled exports by ID
let mainWindow = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1384,
    minHeight: 861,
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

// Dashboard Rendering Utilities
// Find SEI data for a given timestamp
function findSeiAtTime(seiData, timestampMs) {
  if (!seiData || !seiData.length) return null;
  
  let closest = seiData[0];
  let minDiff = Math.abs(seiData[0].timestampMs - timestampMs);
  
  for (let i = 1; i < seiData.length; i++) {
    const diff = Math.abs(seiData[i].timestampMs - timestampMs);
    if (diff < minDiff) {
      minDiff = diff;
      closest = seiData[i];
    }
    // Since data is sorted, if diff starts increasing, we passed the closest
    if (seiData[i].timestampMs > timestampMs && diff > minDiff) break;
  }
  
  return closest?.sei || null;
}

// Parse timestamp key from filename (format: YYYY-MM-DD_HH-MM-SS-camera.mp4)
function parseTimestampKeyFromFilename(filename) {
  if (!filename) return null;
  const match = filename.match(/(\d{4})-(\d{2})-(\d{2})_(\d{2})-(\d{2})-(\d{2})/);
  if (!match) return null;
  return `${match[1]}-${match[2]}-${match[3]}_${match[4]}-${match[5]}-${match[6]}`;
}

// Convert timestamp key to epoch milliseconds (Tesla filenames are in vehicle local time)
function parseTimestampKeyToEpochMs(timestampKey) {
  if (!timestampKey) return null;
  const match = String(timestampKey).match(/^(\d{4})-(\d{2})-(\d{2})_(\d{2})-(\d{2})-(\d{2})$/);
  if (!match) return null;
  const [, Y, Mo, D, h, mi, s] = match;
  return new Date(+Y, +Mo - 1, +D, +h, +mi, +s, 0).getTime();
}

// Convert video time offset (ms from collection start) to actual timestamp (epoch ms)
// This accounts for start/end markers by finding the correct segment
function convertVideoTimeToTimestamp(videoTimeMs, segments, cumStarts) {
  if (!segments || !segments.length || !cumStarts || !cumStarts.length) return null;
  
  // Find which segment contains this video time
  for (let i = 0; i < segments.length; i++) {
    const segStartMs = (cumStarts[i] || 0) * 1000;
    const segDurMs = (segments[i]?.durationSec || 60) * 1000;
    const segEndMs = segStartMs + segDurMs;
    
    if (videoTimeMs >= segStartMs && videoTimeMs < segEndMs) {
      // Found the segment - extract timestamp from filename
      const seg = segments[i];
      const files = seg.files || {};
      
      // Try to get filename from any camera file (prefer front, then any)
      let filename = null;
      if (files.front) {
        filename = path.basename(files.front);
      } else {
        // Get first available file
        const firstCamera = Object.keys(files)[0];
        if (firstCamera) filename = path.basename(files[firstCamera]);
      }
      
      if (!filename) continue;
      
      // Parse timestamp key from filename
      const timestampKey = parseTimestampKeyFromFilename(filename);
      if (!timestampKey) continue;
      
      // Convert to epoch milliseconds
      const segmentStartEpochMs = parseTimestampKeyToEpochMs(timestampKey);
      if (!segmentStartEpochMs) continue;
      
      // Calculate offset within this segment
      const offsetWithinSegmentMs = videoTimeMs - segStartMs;
      
      // Return actual timestamp
      return segmentStartEpochMs + offsetWithinSegmentMs;
    }
  }
  
  return null;
}

// Dashboard dimensions for compact style (ASS subtitle overlay)
const DASHBOARD_DIMENSIONS = {
  compact: { width: 500, height: 76 }
};

// Calculate dashboard size based on output video dimensions, size preference, and style
function calculateDashboardSize(outputWidth, outputHeight, sizeOption = 'medium', style = 'compact') {
  const sizeMultipliers = {
    'small': 0.20,
    'medium': 0.30,
    'large': 0.40
  };
  const multiplier = sizeMultipliers[sizeOption] || 0.30;
  
  const baseDims = DASHBOARD_DIMENSIONS[style] || DASHBOARD_DIMENSIONS.compact;
  const aspectRatio = baseDims.width / baseDims.height;
  
  const targetWidth = Math.round(outputWidth * multiplier);
  const targetHeight = Math.round(targetWidth / aspectRatio);
  // Ensure even dimensions (required for video encoding)
  return {
    width: targetWidth + (targetWidth % 2),
    height: targetHeight + (targetHeight % 2)
  };
}

// ============================================
// VIDEO EXPORT IMPLEMENTATION
// ============================================

// Video Export Implementation
async function performVideoExport(event, exportId, exportData, ffmpegPath) {
  const { segments, startTimeMs, endTimeMs, outputPath, cameras, mobileExport, quality, includeDashboard, seiData, layoutData, useMetric, glassBlur = 7, dashboardStyle = 'standard', dashboardPosition = 'bottom-center', dashboardSize = 'medium', includeTimestamp = false, timestampPosition = 'bottom-center', timestampDateFormat = 'mdy', timestampTimeFormat = '12h', blurZones = [], blurType = 'solid', language = 'en', includeMinimap = false, minimapPosition = 'top-right', minimapSize = 'small', minimapRenderMode = 'ass', mapPath = [], mirrorCameras = true } = exportData;
  
  console.log(`[EXPORT] Received exportData - includeMinimap: ${includeMinimap}, mapPath.length: ${mapPath?.length || 0}, minimapPosition: ${minimapPosition}, minimapSize: ${minimapSize}, renderMode: ${minimapRenderMode}`);
  
  const tempFiles = [];
  const CAMERA_ORDER = ['left_pillar', 'front', 'right_pillar', 'left_repeater', 'back', 'right_repeater'];
  const FPS = 36; // Tesla cameras record at ~36fps

  const sendProgress = (percentage, message) => {
    event.sender.send('export:progress', exportId, { type: 'progress', percentage, message });
  };
  
  const sendDashboardProgress = (percentage, message) => {
    event.sender.send('export:progress', exportId, { type: 'dashboard-progress', percentage, message });
  };
  
  const sendMinimapProgress = (percentage, message) => {
    event.sender.send('export:progress', exportId, { type: 'minimap-progress', percentage, message });
  };

  const sendComplete = (success, message) => {
    event.sender.send('export:progress', exportId, { type: 'complete', success, message, outputPath });
  };

  const cleanup = () => tempFiles.forEach(f => { try { fs.unlinkSync(f); } catch {} });

  // Dashboard temp file path (set during pre-render)
  let dashboardTempPath = null;
  
  // Minimap temp file path (set during pre-render)
  let minimapTempPath = null;

  // Check if export was cancelled before starting
  if (cancelledExports.has(exportId)) {
    console.log('Export cancelled before starting:', exportId);
    cancelledExports.delete(exportId);
    return Promise.reject(new Error('Export cancelled'));
  }

  try {
    console.log('[EXPORT] Starting video export...');
    sendProgress(2, { key: 'ui.export.analyzingSegments' });

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
    console.log(`[SEGMENTS] Found ${relevantSegments.length} segments for export`);

    // Start export timer - rendering begins now (dashboards, minimaps, blur zones, etc.)
    const exportStartTime = Date.now();
    console.log('[EXPORT] Export rendering started');

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

    sendProgress(5, { key: 'ui.export.buildingExport' });

    // Quality settings based on quality option (per-camera resolution)
    // Tesla cameras: Front=2896×1876, Others=1448×938 (both ~1.54:1 aspect ratio)
    // Multi-cam: scale to side camera res (1448×938) to avoid upscaling artifacts
    // Front-only: use full front camera resolution for max quality
    const isFrontOnly = selectedCameras.size === 1 && selectedCameras.has('front');
    let w, h, crf;
    const q = quality || (mobileExport ? 'mobile' : 'high');
    
    // Base resolution for per-camera scaling (used when layoutData is provided)
    let basePerCamW, basePerCamH;
    
    if (isFrontOnly) {
      // Front camera only - use full front camera resolution
      switch (q) {
        case 'mobile':   w = 724;  h = 469;  crf = 28; basePerCamW = 724;  basePerCamH = 469; break;
        case 'medium':   w = 1448; h = 938;  crf = 26; basePerCamW = 1448; basePerCamH = 938; break;
        case 'high':     w = 2172; h = 1407; crf = 23; basePerCamW = 2172; basePerCamH = 1407; break;
        case 'max':      w = 2896; h = 1876; crf = 20; basePerCamW = 2896; basePerCamH = 1876; break;  // Full front native
        default:         w = 1448; h = 938;  crf = 23; basePerCamW = 1448; basePerCamH = 938;
      }
      console.log('[RESOLUTION] Front camera only - using full front camera resolution');
    } else {
      // Multi-camera - scale to side camera resolution
      switch (q) {
        case 'mobile':   w = 484;  h = 314;  crf = 28; basePerCamW = 484;  basePerCamH = 314; break;  // 0.33x side native
        case 'medium':   w = 724;  h = 470;  crf = 26; basePerCamW = 724;  basePerCamH = 470; break;  // 0.5x side native (h must be even)
        case 'high':     w = 1086; h = 704;  crf = 23; basePerCamW = 1086; basePerCamH = 704; break;  // 0.75x side native
        case 'max':      w = 1448; h = 938;  crf = 20; basePerCamW = 1448; basePerCamH = 938; break;  // Side native (front scaled down)
        default:         w = 1086; h = 704;  crf = 23; basePerCamW = 1086; basePerCamH = 704;
      }
    }

    // Detect GPU encoder
    const gpu = detectGpuEncoder(ffmpegPath);

    // Build FFmpeg command with memory optimization flags
    const cmd = [ffmpegPath, '-y'];
    
    // Memory optimization: limit input buffer sizes and reduce buffering
    // Note: thread_queue_size applies to all inputs, keeping it low reduces RAM
    cmd.push('-thread_queue_size', '512'); // Limit input queue size (default is often 8MB+ per input)
    cmd.push('-probesize', '32M'); // Limit probe size for format detection
    cmd.push('-analyzeduration', '10M'); // Limit analysis duration
    
    // Additional memory optimizations
    cmd.push('-fflags', '+genpts+discardcorrupt'); // Generate PTS and discard corrupt frames (reduces buffering)
    cmd.push('-flags', '+low_delay'); // Low delay mode (reduces buffering)

    // Add video inputs with memory-limiting flags
    for (const input of inputs) {
      cmd.push('-thread_queue_size', '16'); // Limit input buffer to 16 frames
      if (input.isConcat) cmd.push('-f', 'concat', '-safe', '0');
      // Use -ss before -i for better memory efficiency (FFmpeg can skip decoding)
      if (input.offset > 0) cmd.push('-ss', input.offset.toString());
      cmd.push('-i', input.path);
    }

    // Always add black source for missing cameras (lavfi doesn't need thread_queue_size)
    const blackInputIdx = inputs.length;
    cmd.push('-f', 'lavfi', '-i', `color=c=black:s=${w}x${h}:r=${FPS}:d=${durationSec}`);

    // Build filter complex - determine which cameras are active for grid
    const activeCamerasForGrid = CAMERA_ORDER.filter(c => selectedCameras.has(c));

    // Calculate output dimensions
    let totalW, totalH, cols, rows;
    let baseInputIdx = null;
    
    if (layoutData && layoutData.cameras && Object.keys(layoutData.cameras).length > 0) {
      // Use custom layout - map canvas positions to video coordinates
      const cameraLayouts = layoutData.cameras;
      
      // Get card dimensions from layout (all cards have the same size)
      // This is the size of each card on the canvas
      const firstLayout = cameraLayouts[Object.keys(cameraLayouts)[0]];
      const cardWidth = firstLayout?.width || 200;
      const cardHeight = firstLayout?.height || 112;
      
      // Scale factors: map canvas card size to native camera size
      // Each card on the canvas represents one camera at native size (w x h)
      const scaleX = w / cardWidth; // Map card width to camera width
      const scaleY = h / cardHeight; // Map card height to camera height
      
      // Calculate bounding box: find min position and max position + camera size
      let minX = Infinity, minY = Infinity;
      let maxRight = -Infinity, maxBottom = -Infinity;
      
      for (const camera of activeCamerasForGrid) {
        const layout = cameraLayouts[camera];
        if (!layout) continue;
        
        // Position in video coordinates (scale from canvas)
        const videoX = layout.x * scaleX;
        const videoY = layout.y * scaleY;
        
        // Camera ends at position + native size
        const cameraRight = videoX + w;
        const cameraBottom = videoY + h;
        
        if (videoX < minX) minX = videoX;
        if (videoY < minY) minY = videoY;
        if (cameraRight > maxRight) maxRight = cameraRight;
        if (cameraBottom > maxBottom) maxBottom = cameraBottom;
      }
      
      // Total output size is from 0 to max (we'll offset positions to start at 0)
      totalW = Math.ceil(maxRight - minX);
      totalH = Math.ceil(maxBottom - minY);
      
      // Ensure even dimensions for video encoding
      totalW = totalW + (totalW % 2);
      totalH = totalH + (totalH % 2);
      
      cols = 0; rows = 0; // Not used for custom layout
      console.log(`📐 Custom layout: ${totalW}x${totalH} (cameras at native ${w}x${h}, card ${cardWidth}x${cardHeight}, scale ${scaleX.toFixed(3)}x/${scaleY.toFixed(3)}y)`);
      
      // Add base canvas input for custom layout (after black source)
      baseInputIdx = inputs.length + 1;
      cmd.push('-f', 'lavfi', '-i', `color=c=black:s=${totalW}x${totalH}:r=${FPS}:d=${durationSec}`);
    } else {
      // Grid layout - calculate grid dimensions and total output resolution
      const numStreams = activeCamerasForGrid.length;
      if (numStreams <= 1) { cols = 1; rows = 1; }
      else if (numStreams === 2) { cols = 2; rows = 1; }
      else if (numStreams === 3) { cols = 3; rows = 1; }
      else if (numStreams === 4) { cols = 2; rows = 2; }
      else { cols = 3; rows = 2; }
      
      totalW = w * cols;
      totalH = h * rows;
    }

        // Dashboard input index: after black source (and base canvas if custom layout)
        const dashboardInputIdx = baseInputIdx !== null ? baseInputIdx + 1 : inputs.length + 1;
        
        // Calculate dashboard size based on output resolution, user's size preference, and style
        const dashboardSizeCalc = calculateDashboardSize(totalW, totalH, dashboardSize, dashboardStyle);
        const dashboardWidth = dashboardSizeCalc.width;
        const dashboardHeight = dashboardSizeCalc.height;
        
        let useAssDashboard = false;
        let assTempPath = null;

        if (includeDashboard && seiData && seiData.length > 0) {
          if (cancelledExports.has(exportId)) {
            console.log('Export cancelled before dashboard generation');
            throw new Error('Export cancelled');
          }
          
          try {
            sendDashboardProgress(5, 'Generating dashboard overlay...');
            const cumStarts = segments.map(seg => seg.startSec || 0);
            
            assTempPath = await writeCompactDashboardAss(exportId, seiData, startTimeMs, endTimeMs, {
              playResX: totalW,
              playResY: totalH,
              position: dashboardPosition,
              size: dashboardSize,
              useMetric,
              segments,
              cumStarts,
              dateFormat: timestampDateFormat,
              timeFormat: timestampTimeFormat,
              language
            });
            tempFiles.push(assTempPath);
            useAssDashboard = true;
            
            sendDashboardProgress(100, 'Dashboard overlay ready');
            console.log(`[ASS] Generated dashboard: ${assTempPath}`);
          } catch (err) {
            if (err.message === 'Export cancelled' || cancelledExports.has(exportId)) {
              throw err;
            }
            console.error('[ASS] Failed to generate dashboard:', err);
            sendDashboardProgress(0, `Dashboard generation failed: ${err.message}. Continuing without overlay...`);
            useAssDashboard = false;
          }
        }
        
        // Minimap rendering (if enabled and we have GPS data)
        // Two modes: 'ass' (fast, vector-based) or 'leaflet' (slow, map tiles)
        let useAssMinimap = false;
        let useLeafletMinimap = false;
        let minimapAssTempPath = null;
        console.log(`[MINIMAP] Checking conditions: includeMinimap=${includeMinimap}, mapPath.length=${mapPath?.length || 0}, seiData.length=${seiData?.length || 0}, renderMode=${minimapRenderMode}`);
        
        if (includeMinimap && mapPath && mapPath.length > 0 && seiData && seiData.length > 0) {
          if (cancelledExports.has(exportId)) {
            console.log('Export cancelled before minimap render');
            throw new Error('Export cancelled');
          }
          
          if (minimapRenderMode === 'ass') {
            // ASS Mode: Download map tiles + overlay ASS route/markers
            try {
              const minimapDims = calculateMinimapSize(totalW, totalH, minimapSize);
              const minimapTargetSize = minimapDims.width; // Square minimap
              
              sendMinimapProgress(0, 'Downloading map tiles...');
              
              // Step 1: Download static map background image
              let mapBgPath = null;
              let mapBounds = null;
              
              try {
                const mapResult = await downloadStaticMapBackground(
                  exportId,
                  mapPath,
                  minimapTargetSize,
                  ffmpegPath
                );
                mapBgPath = mapResult.imagePath;
                mapBounds = mapResult.bounds;
                tempFiles.push(mapBgPath);
                console.log(`[MINIMAP] Downloaded map background: ${mapBgPath}`);
              } catch (mapErr) {
                console.warn(`[MINIMAP] Failed to download map tiles: ${mapErr.message}. Using dark background.`);
                // Continue without map background - will use dark bg from ASS
              }
              
              sendMinimapProgress(30, 'Generating route overlay...');
              
              // Step 2: Generate ASS with route path and markers
              // If we have a map background, use standalone mode with map bounds
              // Otherwise, use normal mode with dark background
              if (mapBgPath && mapBounds) {
                // Standalone mode: ASS coordinates are 0,0 to minimapTargetSize
                minimapAssTempPath = await writeMinimapAss(
                  exportId,
                  seiData,
                  mapPath,
                  startTimeMs,
                  endTimeMs,
                  {
                    standaloneMode: true,
                    standaloneSize: minimapTargetSize,
                    customBounds: mapBounds,
                    includeBackground: false // Map image is the background
                  }
                );
              } else {
                // Normal mode: ASS includes dark background
                minimapAssTempPath = await writeMinimapAss(
                  exportId,
                  seiData,
                  mapPath,
                  startTimeMs,
                  endTimeMs,
                  {
                    standaloneMode: true,
                    standaloneSize: minimapTargetSize,
                    includeBackground: true // Use ASS dark background
                  }
                );
              }
              tempFiles.push(minimapAssTempPath);
              
              sendMinimapProgress(50, 'Creating minimap video...');
              
              // Step 3: Create composite minimap video (map bg + ASS overlay)
              // This pre-renders the minimap so FFmpeg can just overlay it on the main video
              const minimapVideoPath = path.join(os.tmpdir(), `minimap_video_${exportId}_${Date.now()}.mov`);
              const durationSec = (endTimeMs - startTimeMs) / 1000;
              
              const escapedAssPath = minimapAssTempPath
                .replace(/\\/g, '/')
                .replace(/:/g, '\\:');
              
              let minimapFfmpegArgs;
              if (mapBgPath) {
                // Use map image as background, loop it for video duration
                const escapedMapPath = mapBgPath.replace(/\\/g, '/');
                minimapFfmpegArgs = [
                  '-y',
                  '-loop', '1',
                  '-i', mapBgPath,
                  '-t', durationSec.toString(),
                  '-vf', `scale=${minimapTargetSize}:${minimapTargetSize},ass='${escapedAssPath}'`,
                  '-c:v', 'qtrle',
                  '-pix_fmt', 'argb',
                  '-r', '36',
                  minimapVideoPath
                ];
              } else {
                // Use black background with ASS (includes dark panel)
                minimapFfmpegArgs = [
                  '-y',
                  '-f', 'lavfi',
                  '-i', `color=c=black@0:s=${minimapTargetSize}x${minimapTargetSize}:d=${durationSec}:r=36,format=rgba`,
                  '-vf', `ass='${escapedAssPath}'`,
                  '-c:v', 'qtrle',
                  '-pix_fmt', 'argb',
                  '-r', '36',
                  minimapVideoPath
                ];
              }
              
              console.log(`[MINIMAP] Creating composite video: ${ffmpegPath} ${minimapFfmpegArgs.join(' ')}`);
              
              await new Promise((resolve, reject) => {
                const proc = spawn(ffmpegPath, minimapFfmpegArgs, { stdio: ['pipe', 'pipe', 'pipe'] });
                let stderr = '';
                proc.stderr.on('data', d => stderr += d.toString());
                proc.on('close', code => {
                  if (code === 0) resolve();
                  else reject(new Error(`FFmpeg minimap composite failed: ${stderr.slice(-500)}`));
                });
                proc.on('error', reject);
              });
              
              // Use the composite video as the minimap (same as Leaflet mode)
              minimapTempPath = minimapVideoPath;
              tempFiles.push(minimapVideoPath);
              useLeafletMinimap = true; // Use video overlay mode
              useAssMinimap = false; // Not using direct ASS mode
              
              sendMinimapProgress(100, 'Minimap ready');
              console.log(`[MINIMAP] Created ASS minimap with map background: ${minimapVideoPath}`);
            } catch (err) {
              if (err.message === 'Export cancelled' || cancelledExports.has(exportId)) {
                throw err;
              }
              console.error('[MINIMAP] Failed to generate ASS minimap:', err);
              sendMinimapProgress(0, `Minimap generation failed: ${err.message}. Continuing without minimap...`);
              useAssMinimap = false;
              useLeafletMinimap = false;
            }
          } else {
            // Leaflet Mode: Slow BrowserWindow pre-rendering with map tiles
            try {
              const minimapDims = calculateMinimapSize(totalW, totalH, minimapSize);
              const minimapWidth = minimapDims.width;
              const minimapHeight = minimapDims.height;
              console.log(`[MINIMAP] Leaflet mode - Dimensions: ${minimapWidth}x${minimapHeight}, position: ${minimapPosition}`);
              
              sendMinimapProgress(0, 'Pre-rendering minimap overlay (Leaflet)...');
              
              minimapTempPath = await preRenderMinimap(
                exportId,
                seiData,
                mapPath,
                startTimeMs,
                endTimeMs,
                minimapWidth,
                minimapHeight,
                ffmpegPath,
                sendMinimapProgress,
                cancelledExports
              );
              
              tempFiles.push(minimapTempPath);
              useLeafletMinimap = true;
              sendMinimapProgress(100, 'Minimap overlay ready (Leaflet)');
              console.log(`[MINIMAP] Pre-rendered Leaflet minimap: ${minimapTempPath}`);
            } catch (err) {
              if (err.message === 'Export cancelled' || cancelledExports.has(exportId)) {
                throw err;
              }
              console.error('[MINIMAP] Failed to pre-render Leaflet minimap:', err);
              sendMinimapProgress(0, `Minimap rendering failed: ${err.message}. Continuing without minimap...`);
              useLeafletMinimap = false;
            }
          }
        } else {
          console.log('[MINIMAP] Skipping - conditions not met');
        }
        
        let useTimestamp = includeTimestamp && !useAssDashboard;
        
        // Calculate timestamp basetime from first relevant segment
        let timestampBasetimeUs = null;
        if (useTimestamp) {
          // Find the first segment's timestamp from filename
          const firstSeg = relevantSegments[0];
          if (firstSeg) {
            const files = firstSeg.files || {};
            let filename = files.front ? path.basename(files.front) : null;
            if (!filename) {
              const firstCamera = Object.keys(files)[0];
              if (firstCamera) filename = path.basename(files[firstCamera]);
            }
            
            if (filename) {
              const timestampKey = parseTimestampKeyFromFilename(filename);
              if (timestampKey) {
                const segmentStartEpochMs = parseTimestampKeyToEpochMs(timestampKey);
                if (segmentStartEpochMs) {
                  // Add the offset within the first segment (if export starts mid-segment)
                  const firstSegStartMs = firstSeg.segStartMs || 0;
                  const offsetWithinFirstSegMs = Math.max(0, startTimeMs - firstSegStartMs);
                  const exportStartEpochMs = segmentStartEpochMs + offsetWithinFirstSegMs;
                  timestampBasetimeUs = Math.floor(exportStartEpochMs * 1000); // Convert ms to microseconds
                  console.log(`[TIMESTAMP] Basetime calculated: ${new Date(exportStartEpochMs).toISOString()}`);
                }
              }
            }
          }
          
          if (!timestampBasetimeUs) {
            console.warn('[TIMESTAMP] Could not calculate timestamp basetime, disabling timestamp overlay');
            useTimestamp = false;
          }
        }
        
        // Check for cancellation after dashboard/timestamp setup, before building filters
        if (cancelledExports.has(exportId)) {
          console.log('Export cancelled before building filters');
          throw new Error('Export cancelled');
        }

    const filters = [];
    const streamTags = [];
    
    // Camera position tracking (scope shared across layout types)
    let gridCameraPositions = null;
    let gridCameraDimensions = null;
    let singleCameraPositions = null;
    let singleCameraDimensions = null;

    if (layoutData && layoutData.cameras && Object.keys(layoutData.cameras).length > 0) {
      // Custom layout using overlay filters (base canvas already added as input)
      // Cameras use native size (w x h), only positioning comes from layout
      
      const cameraLayouts = layoutData.cameras;
      
      // Get card dimensions from layout (all cards have the same size)
      const firstLayout = cameraLayouts[Object.keys(cameraLayouts)[0]];
      const cardWidth = firstLayout?.width || 200;
      const cardHeight = firstLayout?.height || 112;
      
      // Calculate scale factors: map canvas card size to native camera size
      const scaleX = w / cardWidth;
      const scaleY = h / cardHeight;
      
      // Find minimum positions to offset all cameras (so output starts at 0,0)
      let minX = Infinity, minY = Infinity;
      for (const camera of activeCamerasForGrid) {
        const layout = cameraLayouts[camera];
        if (!layout) continue;
        const videoX = layout.x * scaleX;
        const videoY = layout.y * scaleY;
        if (videoX < minX) minX = videoX;
        if (videoY < minY) minY = videoY;
      }
      
      const cameraStreams = [];
      
      for (let i = 0; i < activeCamerasForGrid.length; i++) {
        const camera = activeCamerasForGrid[i];
        const layout = cameraLayouts[camera];
        if (!layout) continue;
        
        const inputIdx = cameraInputMap.get(camera);
        const hasVideo = inputIdx !== undefined;
        const srcIdx = hasVideo ? inputIdx : blackInputIdx;
        const isMirrored = mirrorCameras && ['back', 'left_repeater', 'right_repeater'].includes(camera);
        
        // Scale camera to native size (w x h) - exactly like old grid code
        // Ensure even dimensions
        const finalW = w + (w % 2);
        const finalH = h + (h % 2);
        
        // Calculate position from canvas layout (scale and offset)
        const x = Math.round((layout.x * scaleX) - minX);
        const y = Math.round((layout.y * scaleY) - minY);
        
        // Use smoother frame rate conversion
        // Normalize timestamps, convert frame rate, mirror if needed, scale to target size
        let chain = `[${srcIdx}:v]setpts=PTS-STARTPTS`;
        chain += `,fps=${FPS}:round=near`; // Smooth frame rate conversion
        if (hasVideo && isMirrored) chain += ',hflip';
        chain += `,scale=${finalW}:${finalH}:force_original_aspect_ratio=disable:flags=lanczos,setsar=1[v${i}]`;
        
        filters.push(chain);
        const streamTag = `[v${i}]`;
        cameraStreams.push({ camera, tag: streamTag, x, y });
      }
      
      // Apply blur zones to individual camera streams BEFORE grid composition
      singleCameraPositions = {};
      singleCameraDimensions = {};
      for (const stream of cameraStreams) {
        singleCameraPositions[stream.camera] = { x: stream.x, y: stream.y };
        singleCameraDimensions[stream.camera] = { width: w + (w % 2), height: h + (h % 2) };
      }
      
      if (blurZones.length > 0) {
        // OPTIMIZATION: Group blur zones by camera and combine masks to reduce FFmpeg operations
        const zonesByCamera = {};
        for (const zone of blurZones) {
          if (!zone || !zone.maskImageBase64 || !zone.camera) continue;
          if (!zonesByCamera[zone.camera]) zonesByCamera[zone.camera] = [];
          zonesByCamera[zone.camera].push(zone);
        }
        
        let maskInputOffset = 0;
        for (const [cam, zones] of Object.entries(zonesByCamera)) {
          const blurStream = cameraStreams.find(s => s.camera === cam);
          if (!blurStream) continue;
          
          const blurCameraStreamTag = blurStream.tag;
          console.log(`[BLUR] Applying ${zones.length} blur zone(s) to camera: ${cam} (method: ${blurType})`);
          
          try {
            // Combine multiple masks for same camera into one composite mask using canvas
            const firstZone = zones[0];
            const maskW = firstZone.maskWidth || 1448;
            const maskH = firstZone.maskHeight || 938;
            
            // Create composite mask by combining all zone masks
            const { createCanvas, loadImage } = getCanvas();
            const compositeCanvas = createCanvas(maskW, maskH);
            const compositeCtx = compositeCanvas.getContext('2d');
            compositeCtx.fillStyle = 'black';
            compositeCtx.fillRect(0, 0, maskW, maskH);
            
            // Draw each mask (white areas are blur regions)
            for (const zone of zones) {
              const maskBuffer = Buffer.from(zone.maskImageBase64, 'base64');
              const maskImg = await loadImage(maskBuffer);
              compositeCtx.drawImage(maskImg, 0, 0, maskW, maskH);
            }
            
            // Save composite mask
            const compositeMaskBuffer = compositeCanvas.toBuffer('image/png');
            const maskPath = path.join(os.tmpdir(), `blur_mask_${exportId}_${cam}_${Date.now()}.png`);
            fs.writeFileSync(maskPath, compositeMaskBuffer);
            tempFiles.push(maskPath);
            
            let maskInputIdx = inputs.length + 1;
            if (baseInputIdx !== null) maskInputIdx++;
            maskInputIdx += maskInputOffset;
            maskInputOffset++;
            
            cmd.push('-loop', '1', '-framerate', FPS.toString(), '-i', maskPath);
            
            const cameraW = w + (w % 2);
            const cameraH = h + (h % 2);
            
            const blurredStreamTag = `[blurred_${cam}]`;
            
            // True Blur: uses alpha channel for smooth edge blending
            // Split the camera stream into two copies (FFmpeg streams can only be consumed once)
            filters.push(`${blurCameraStreamTag}split=2[blur_orig_${cam}][blur_base_${cam}]`);
            
            // Scale mask and convert to alpha format
            filters.push(`[${maskInputIdx}:v]scale=${cameraW}:${cameraH}:force_original_aspect_ratio=disable,format=gray,format=yuva420p[mask_alpha_${cam}]`);
            
            // Apply blur to one copy, then apply alpha mask
            filters.push(`[blur_orig_${cam}]boxblur=10:10[blurred_temp_${cam}]`);
            filters.push(`[blurred_temp_${cam}][mask_alpha_${cam}]alphamerge[blurred_with_alpha_${cam}]`);
            
            // Overlay the blurred+masked region onto the original base
            filters.push(`[blur_base_${cam}][blurred_with_alpha_${cam}]overlay=0:0:format=auto${blurredStreamTag}`);
            
            blurStream.tag = blurredStreamTag;
          } catch (err) {
            console.error('[BLUR] Failed to apply blur zone:', err);
          }
        }
      }
      
      // Chain overlays: start with base, overlay each camera in order
      let currentTag = `[${baseInputIdx}:v]`;
      for (let i = 0; i < cameraStreams.length; i++) {
        const stream = cameraStreams[i];
        const nextTag = i === cameraStreams.length - 1 ? '[grid]' : `[overlay${i}]`;
        filters.push(`${currentTag}${stream.tag}overlay=${stream.x}:${stream.y}:format=auto${nextTag}`);
        currentTag = nextTag;
      }
      
      // If no cameras, just copy base to grid
      if (cameraStreams.length === 0) {
        filters.push(`[${baseInputIdx}:v]copy[grid]`);
      }
      
    } else {
      // Grid layout (original code)
      const gridStreams = [];
      for (let i = 0; i < activeCamerasForGrid.length; i++) {
        const camera = activeCamerasForGrid[i];
        const inputIdx = cameraInputMap.get(camera);
        const hasVideo = inputIdx !== undefined;
        const srcIdx = hasVideo ? inputIdx : blackInputIdx;
        const isMirrored = mirrorCameras && ['back', 'left_repeater', 'right_repeater'].includes(camera);

        // Use minterpolate for smoother frame rate conversion to avoid pulsing
        // fps filter can cause frame drops/duplicates, minterpolate is smoother
        // Normalize timestamps, convert frame rate, mirror if needed, scale to target size
        let chain = `[${srcIdx}:v]setpts=PTS-STARTPTS`;
        chain += `,fps=${FPS}:round=near`; // Smooth frame rate conversion
        if (hasVideo && isMirrored) chain += ',hflip';
        chain += `,scale=${w}:${h}:force_original_aspect_ratio=disable:flags=lanczos,setsar=1[v${i}]`;
        
        filters.push(chain);
        gridStreams.push({ camera, tag: `[v${i}]` });
        streamTags.push(`[v${i}]`);
      }
      
      // Apply blur zones to individual camera streams BEFORE grid composition (grid layout)
      gridCameraPositions = {};
      gridCameraDimensions = {};
      for (let i = 0; i < activeCamerasForGrid.length; i++) {
        const cam = activeCamerasForGrid[i];
        gridCameraPositions[cam] = {
          x: (i % cols) * w,
          y: Math.floor(i / cols) * h
        };
        gridCameraDimensions[cam] = { width: w, height: h };
      }
      
      if (blurZones.length > 0) {
        // OPTIMIZATION: Group blur zones by camera and combine masks to reduce FFmpeg operations
        const gridZonesByCamera = {};
        for (const zone of blurZones) {
          if (!zone || !zone.maskImageBase64 || !zone.camera) continue;
          if (!gridZonesByCamera[zone.camera]) gridZonesByCamera[zone.camera] = [];
          gridZonesByCamera[zone.camera].push(zone);
        }
        
        let gridMaskInputOffset = 0;
        for (const [cam, zones] of Object.entries(gridZonesByCamera)) {
          const blurStream = gridStreams.find(s => s.camera === cam);
          if (!blurStream) continue;
          
          const blurCameraStreamTag = blurStream.tag;
          console.log(`[BLUR] Applying ${zones.length} blur zone(s) to camera: ${cam} (method: ${blurType})`);
          
          try {
            // Combine multiple masks for same camera into one composite mask
            const firstZone = zones[0];
            const maskW = firstZone.maskWidth || 1448;
            const maskH = firstZone.maskHeight || 938;
            
            const { createCanvas: createCanvas2, loadImage: loadImage2 } = getCanvas();
            const compositeCanvas = createCanvas2(maskW, maskH);
            const compositeCtx = compositeCanvas.getContext('2d');
            compositeCtx.fillStyle = 'black';
            compositeCtx.fillRect(0, 0, maskW, maskH);
            
            for (const zone of zones) {
              const maskBuffer = Buffer.from(zone.maskImageBase64, 'base64');
              const maskImg = await loadImage2(maskBuffer);
              compositeCtx.drawImage(maskImg, 0, 0, maskW, maskH);
            }
            
            const compositeMaskBuffer = compositeCanvas.toBuffer('image/png');
            const maskPath = path.join(os.tmpdir(), `blur_mask_${exportId}_${cam}_${Date.now()}.png`);
            fs.writeFileSync(maskPath, compositeMaskBuffer);
            tempFiles.push(maskPath);
            
            let maskInputIdx = inputs.length + 1;
            maskInputIdx += gridMaskInputOffset;
            gridMaskInputOffset++;
            
            cmd.push('-loop', '1', '-framerate', FPS.toString(), '-i', maskPath);
            
            const cameraW = w + (w % 2);
            const cameraH = h + (h % 2);
            
            const blurredStreamTag = `[blurred_${cam}]`;
            
            // True Blur: uses alpha channel for smooth edge blending
            filters.push(`${blurCameraStreamTag}split=2[blur_orig_${cam}][blur_base_${cam}]`);
            filters.push(`[${maskInputIdx}:v]scale=${cameraW}:${cameraH}:force_original_aspect_ratio=disable,format=gray,format=yuva420p[mask_alpha_${cam}]`);
            filters.push(`[blur_orig_${cam}]boxblur=10:10[blurred_temp_${cam}]`);
            filters.push(`[blurred_temp_${cam}][mask_alpha_${cam}]alphamerge[blurred_with_alpha_${cam}]`);
            filters.push(`[blur_base_${cam}][blurred_with_alpha_${cam}]overlay=0:0:format=auto${blurredStreamTag}`);
            
            blurStream.tag = blurredStreamTag;
            const streamIndex = streamTags.indexOf(blurCameraStreamTag);
            if (streamIndex !== -1) {
              streamTags[streamIndex] = blurredStreamTag;
            }
          } catch (err) {
            console.error('[BLUR] Failed to apply blur zone:', err);
          }
        }
      }
      
      const numStreams = activeCamerasForGrid.length;
      if (numStreams > 1) {
        const layout = [];
        for (let i = 0; i < numStreams; i++) {
          layout.push(`${(i % cols) * w}_${Math.floor(i / cols) * h}`);
        }
        filters.push(`${streamTags.join('')}xstack=inputs=${numStreams}:layout=${layout.join('|')}:fill=black[grid]`);
      } else {
        filters.push(`${streamTags[0]}copy[grid]`);
      }
    }
    
    // Determine if GPU encoding can be used
    // H.264 GPU encoders: 4096px limit, HEVC GPU encoders: 8192px limit
    const h264MaxRes = 4096;
    const hevcMaxRes = 8192;
    
    // Check HEVC encoder for high resolutions (Maximum quality often exceeds H.264 limits)
    const hevcGpu = detectHEVCEncoder(ffmpegPath);
    
    // Determine best encoder: prefer H.264 GPU, fall back to HEVC GPU for high res, then CPU
    let useGpu = false;
    let useHEVC = false;
    let activeEncoder = null;
    
    if (!mobileExport && gpu) {
      if (totalW <= h264MaxRes && totalH <= h264MaxRes) {
        // Resolution within H.264 GPU limits - use H.264 GPU
        useGpu = true;
        activeEncoder = gpu;
      } else if (hevcGpu && totalW <= hevcMaxRes && totalH <= hevcMaxRes) {
        // Resolution exceeds H.264 but within HEVC limits - use HEVC GPU
        useGpu = true;
        useHEVC = true;
        activeEncoder = hevcGpu;
        console.log(`[GPU] Resolution ${totalW}×${totalH} exceeds H.264 limit, using HEVC encoder`);
      }
    }

    let currentStreamTag = '[grid]'; // Track the current stream tag for chaining filters
    
    // Add dashboard or timestamp overlay if enabled, otherwise ensure proper pixel format
    const padding = 20; // Padding from edges
    const positionExprs = {
      'bottom-center': `(W-w)/2:H-h-${padding}`,
      'bottom-left': `${padding}:H-h-${padding}`,
      'bottom-right': `W-w-${padding}:H-h-${padding}`,
      'top-center': `(W-w)/2:${padding}`,
      'top-left': `${padding}:${padding}`,
      'top-right': `W-w-${padding}:${padding}`
    };
    
    // Minimap position expressions (corner positions only)
    const minimapPosExprs = {
      'top-left': `${padding}:${padding}`,
      'top-right': `W-w-${padding}:${padding}`,
      'bottom-left': `${padding}:H-h-${padding}`,
      'bottom-right': `W-w-${padding}:H-h-${padding}`
    };
    
    // Add Leaflet minimap video as input if enabled (Leaflet mode only)
    let minimapInputIdx = -1;
    if (useLeafletMinimap && minimapTempPath) {
      minimapInputIdx = cmd.filter(arg => arg === '-i').length;
      cmd.push('-stream_loop', '-1', '-i', minimapTempPath);
      console.log(`[MINIMAP] Added Leaflet minimap input at index ${minimapInputIdx}: ${minimapTempPath}`);
    }
    
    // Build overlay pipeline based on enabled features
    // Order: Base video -> Dashboard ASS -> Minimap ASS -> Leaflet Minimap overlay
    
    if (useAssDashboard && assTempPath) {
      // ASS SUBTITLE DASHBOARD (compact style) - High-speed GPU-accelerated rendering
      // The ASS filter burns subtitles directly into the video at GPU encoder speed
      // This is MUCH faster than BrowserWindow capture loop (30min -> 3-5min)
      // Escape Windows path for FFmpeg (colons and backslashes need escaping)
      const escapedAssPath = assTempPath
        .replace(/\\/g, '/')           // Convert backslashes to forward slashes
        .replace(/:/g, '\\:');         // Escape colons (Windows drive letters)
      
      if (useAssMinimap && minimapAssTempPath) {
        // Dashboard ASS + Minimap ASS: Chain both ASS filters
        const escapedMinimapAssPath = minimapAssTempPath
          .replace(/\\/g, '/')
          .replace(/:/g, '\\:');
        filters.push(`${currentStreamTag}ass='${escapedAssPath}',ass='${escapedMinimapAssPath}'[out]`);
        console.log(`[ASS] Dashboard + ASS Minimap overlay`);
      } else if (useLeafletMinimap && minimapInputIdx >= 0) {
        // Dashboard ASS + Leaflet Minimap video overlay
        const mapPos = minimapPosExprs[minimapPosition] || minimapPosExprs['top-right'];
        filters.push(`${currentStreamTag}ass='${escapedAssPath}'[with_dash]`);
        filters.push(`[with_dash][${minimapInputIdx}:v]overlay=${mapPos}:format=auto[out]`);
        console.log(`[ASS+MINIMAP] Dashboard + Leaflet Minimap overlay at ${minimapPosition}`);
      } else {
        // Dashboard only
        filters.push(`${currentStreamTag}ass='${escapedAssPath}'[out]`);
        console.log(`[ASS] Using ASS subtitle filter for compact dashboard: ${assTempPath}`);
      }
    } else if (useAssMinimap && minimapAssTempPath) {
      // ASS Minimap only (no dashboard)
      const escapedMinimapAssPath = minimapAssTempPath
        .replace(/\\/g, '/')
        .replace(/:/g, '\\:');
      filters.push(`${currentStreamTag}ass='${escapedMinimapAssPath}'[out]`);
      console.log(`[ASS] Using ASS minimap filter: ${minimapAssTempPath}`);
    } else if (useLeafletMinimap && minimapInputIdx >= 0) {
      // Leaflet Minimap only (no dashboard)
      const mapPos = minimapPosExprs[minimapPosition] || minimapPosExprs['top-right'];
      filters.push(`${currentStreamTag}[${minimapInputIdx}:v]overlay=${mapPos}:format=auto[out]`);
      console.log(`[MINIMAP] Leaflet Minimap overlay at ${minimapPosition}`);
    } else if (useTimestamp && timestampBasetimeUs) {
      // Timestamp-only overlay using FFmpeg drawtext filter (simpler, smaller like old version)
      // Position expressions for drawtext (x/y coordinates)
      const drawtextPositions = {
        'bottom-center': `x=(w-text_w)/2:y=h-th-${padding}`,
        'bottom-left': `x=${padding}:y=h-th-${padding}`,
        'bottom-right': `x=w-text_w-${padding}:y=h-th-${padding}`,
        'top-center': `x=(w-text_w)/2:y=${padding}`,
        'top-left': `x=${padding}:y=${padding}`,
        'top-right': `x=w-text_w-${padding}:y=${padding}`
      };
      const drawtextPos = drawtextPositions[timestampPosition] || drawtextPositions['bottom-center'];
      
      // Date format strings for strftime
      const dateFormats = {
        'mdy': '%m/%d/%Y',  // US: MM/DD/YYYY
        'dmy': '%d/%m/%Y',  // International: DD/MM/YYYY
        'ymd': '%Y-%m-%d'   // ISO: YYYY-MM-DD
      };
      const dateFormat = dateFormats[timestampDateFormat] || dateFormats['mdy'];
      // Time format: 12h uses %I (12-hour) with %p (AM/PM), 24h uses %H (24-hour)
      const timeFormat = timestampTimeFormat === '24h' ? '%H\\:%M\\:%S' : '%I\\:%M\\:%S %p';
      const timestampText = `${dateFormat} ${timeFormat}`;
      
      // Build drawtext filter with timestamp (similar to old version)
      const drawtextFilter = [
        "drawtext=font='Arial'",
        'expansion=strftime',
        `basetime=${timestampBasetimeUs}`,
        `text='${timestampText}'`,
        'fontcolor=white',
        'fontsize=36',
        'box=1',
        'boxcolor=black@0.4',
        'boxborderw=5',
        drawtextPos
      ].join(':');
      
      filters.push(`${currentStreamTag}${drawtextFilter}[out]`);
      console.log(`[TIMESTAMP] Using drawtext filter at position: ${timestampPosition}, format: ${timestampDateFormat}`);
    } else {
      filters.push(`${currentStreamTag}format=yuv420p[out]`);
    }

    cmd.push('-filter_complex', filters.join(';'));
    cmd.push('-map', '[out]');

    // Configure video encoder based on GPU availability
    if (useGpu && activeEncoder) {
      cmd.push('-c:v', activeEncoder.codec);
      
      if (activeEncoder.codec === 'h264_nvenc' || activeEncoder.codec === 'hevc_nvenc') {
        // NVIDIA NVENC: CQP mode prevents quality pulsing/glitches
        const cq = Math.max(0, Math.min(51, crf));
        cmd.push('-preset', 'p4', '-rc', 'constqp', '-qp', cq.toString());
        cmd.push('-g', (FPS * 2).toString()); // Keyframe every 2 seconds
        cmd.push('-forced-idr', '1');
      } else if (activeEncoder.codec === 'h264_amf' || activeEncoder.codec === 'hevc_amf') {
        // AMD AMF: CQP mode with quality preset based on CRF
        let quality = 'quality';
        if (crf >= 28) quality = 'speed';
        else if (crf >= 24) quality = 'balanced';
        
        cmd.push('-quality', quality);
        cmd.push('-rc', 'cqp');
        cmd.push('-qp_i', Math.max(18, Math.min(46, crf)).toString());
        cmd.push('-qp_p', Math.max(18, Math.min(46, crf + 2)).toString());
        cmd.push('-qp_b', Math.max(18, Math.min(46, crf + 4)).toString());
        cmd.push('-g', (FPS * 2).toString());
      } else if (activeEncoder.codec === 'h264_videotoolbox' || activeEncoder.codec === 'hevc_videotoolbox') {
        // Apple VideoToolbox: Use bitrate mode for better compatibility
        // Quality-based encoding can fail on some hardware configurations
        // Target ~8Mbps for high quality, scaled by CRF
        const baseBitrate = 8000; // 8Mbps base
        const bitrateMultiplier = Math.max(0.3, 1 - (crf - 18) * 0.03); // Scale down with higher CRF
        const targetBitrate = Math.round(baseBitrate * bitrateMultiplier);
        cmd.push('-b:v', `${targetBitrate}k`);
        cmd.push('-maxrate', `${Math.round(targetBitrate * 1.5)}k`);
        cmd.push('-bufsize', `${targetBitrate * 2}k`);
        cmd.push('-allow_sw', '1'); // Allow software fallback for compatibility
        cmd.push('-realtime', '0'); // Disable realtime for better quality
        cmd.push('-g', (FPS * 2).toString());
      } else if (activeEncoder.codec === 'h264_qsv' || activeEncoder.codec === 'hevc_qsv') {
        // Intel QuickSync: CQP mode
        // QSV uses x264-style presets: veryfast, faster, fast, medium, slow, slower, veryslow
        // (NOT "balanced" which is AMD AMF only)
        const qsvQp = Math.max(18, Math.min(46, crf));
        cmd.push('-preset', 'medium');
        cmd.push('-global_quality', qsvQp.toString());
        cmd.push('-g', (FPS * 2).toString());
      } else {
        // Fallback for unknown GPU encoders
        console.log(`[WARN] Using generic settings for unknown GPU encoder: ${activeEncoder.codec}`);
        cmd.push('-preset', 'fast', '-crf', crf.toString());
        cmd.push('-g', (FPS * 2).toString());
      }
      console.log(`[GPU] Using GPU encoder: ${activeEncoder.name}`);
    } else {
      // CPU encoding: libx264/libx265 with memory-optimized threading
      if (gpu && (totalW > h264MaxRes || totalH > h264MaxRes)) {
        console.log(`[WARN] Resolution ${totalW}×${totalH} exceeds GPU limits, using CPU encoder`);
      }
      const maxThreads = Math.min(4, Math.floor(os.cpus().length / 2));
      cmd.push('-c:v', 'libx264', '-preset', mobileExport ? 'faster' : 'fast', '-crf', crf.toString());
      cmd.push('-threads', maxThreads.toString());
      cmd.push('-x264-params', `threads=${maxThreads}:thread-input=1:thread-lookahead=2`);
    }
    
    cmd.push('-t', durationSec.toString());
    cmd.push('-movflags', '+faststart');
    
    // Set pixel format - VideoToolbox handles this internally, others need explicit setting
    // The filter chain already converts to yuv420p, but CPU encoders need the output hint
    const isVideoToolbox = activeEncoder?.codec?.includes('videotoolbox');
    if (!isVideoToolbox) {
      cmd.push('-pix_fmt', 'yuv420p');
    }
    
    // GPU encoders: use constant frame rate to prevent frame drops
    if (useGpu) {
      cmd.push('-vsync', 'cfr');
      cmd.push('-r', FPS.toString());
    } else {
      cmd.push('-r', FPS.toString());
    }
    // Memory optimization: limit output buffer
    cmd.push('-max_muxing_queue_size', '1024'); // Limit muxer queue size
    cmd.push(outputPath);

    console.log('[FFMPEG] FFmpeg:', cmd.slice(0, 20).join(' ') + '...');
    
    // Final cancellation check before spawning FFmpeg
    if (cancelledExports.has(exportId)) {
      console.log('Export cancelled before spawning FFmpeg process');
      throw new Error('Export cancelled');
    }
    
    sendProgress(8, useGpu ? { key: 'ui.export.exportingWithEncoder', params: { encoder: activeEncoder.name } } : { key: 'ui.export.exportingWithCpu' });

    // Execute FFmpeg - no pipe needed since dashboard is pre-rendered to file
    return new Promise(async (resolve, reject) => {
      const proc = spawn(cmd[0], cmd.slice(1), {
        stdio: ['pipe', 'pipe', 'pipe']
      });
      
      // Limit stderr buffer to prevent excessive RAM usage (keep only last 100KB)
      let stderr = '', lastPct = 0;
      const MAX_STDERR_SIZE = 100 * 1024; // 100KB max

      proc.stderr.on('data', (data) => {
        const dataStr = data.toString();
        stderr += dataStr;
        // Limit stderr buffer size to prevent excessive RAM usage
        if (stderr.length > MAX_STDERR_SIZE) {
          stderr = stderr.slice(-MAX_STDERR_SIZE);
        }
        const match = dataStr.match(/time=(\d+):(\d+):(\d+)/);
        if (match && durationSec > 0) {
          const sec = +match[1] * 3600 + +match[2] * 60 + +match[3];
          const pct = Math.min(95, Math.floor((sec / durationSec) * 100));
          if (pct > lastPct) {
            lastPct = pct;
            sendProgress(pct, { key: 'ui.export.exportingPercent', params: { percent: pct } });
          }
        }
      });

      proc.on('close', (code) => {
        delete activeExports[exportId];
        cancelledExports.delete(exportId); // Clean up cancellation flag
        cleanup();

        if (code === 0) {
          const exportDurationMs = Date.now() - exportStartTime;
          const formattedDuration = formatExportDuration(exportDurationMs);
          
          console.log(`[EXPORT] ✅ Export completed in ${formattedDuration}`);
          
          const sizeMB = (fs.statSync(outputPath).size / 1048576).toFixed(1);
          sendComplete(true, { key: 'ui.export.exportCompleteMB', params: { size: sizeMB } });
          resolve(true);
        } else {
          console.error('FFmpeg error:', stderr.slice(-500));
          sendComplete(false, { key: 'ui.export.exportFailedCode', params: { code: code } });
          reject(new Error(`Export failed with code ${code}`));
        }
      });

      proc.on('error', (err) => {
        cleanup();
        cancelledExports.delete(exportId); // Clean up cancellation flag
        sendComplete(false, `FFmpeg error: ${err.message}`);
        reject(err);
      });

      // Register export early so cancellation can find it
      activeExports[exportId] = proc;
      
      // Check for cancellation immediately after spawning (race condition protection)
      if (cancelledExports.has(exportId)) {
        console.log('Export cancelled immediately after spawning FFmpeg, killing process');
        proc.kill('SIGTERM');
        delete activeExports[exportId];
        cancelledExports.delete(exportId);
        reject(new Error('Export cancelled'));
        return;
      }
    });

  } catch (error) {
    console.error('Export error:', error);
    cancelledExports.delete(exportId); // Clean up cancellation flag
    cleanup();
    throw error;
  }
}

app.whenReady().then(async () => {
  // Check for new packages after update (dev mode only)
  // This runs before window creation to ensure packages are installed
  const packageResult = await checkAndInstallPackages();
  
  if (packageResult.installed && packageResult.count > 0) {
    // New packages were installed - show dialog and ask to restart
    const response = await dialog.showMessageBox({
      type: 'info',
      title: 'New Packages Installed',
      message: `The update installed ${packageResult.count} new package(s).`,
      detail: 'Please restart the application with "npm start" for the changes to take effect.',
      buttons: ['Exit Now', 'Continue Anyway'],
      defaultId: 0,
      cancelId: 1
    });
    
    if (response.response === 0) {
      // User chose to exit
      app.quit();
      return;
    }
  }
  
  createWindow();
  
  // Set up electron-updater event handlers (extracted to src/main/autoUpdate.js)
  setupAutoUpdaterEvents(mainWindow);

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// Clean up all active FFmpeg processes before quitting
// This prevents orphaned processes that can block the Windows installer
app.on('before-quit', () => {
  console.log('[APP] before-quit: cleaning up active exports...');
  const exportIds = Object.keys(activeExports);
  if (exportIds.length > 0) {
    console.log(`[APP] Killing ${exportIds.length} active FFmpeg process(es)`);
    for (const exportId of exportIds) {
      const proc = activeExports[exportId];
      if (proc && !proc.killed) {
        try {
          // Use SIGKILL on Windows for immediate termination
          proc.kill('SIGKILL');
          console.log(`[APP] Killed export process: ${exportId}`);
        } catch (err) {
          console.error(`[APP] Failed to kill export ${exportId}:`, err.message);
        }
      }
      delete activeExports[exportId];
    }
  }
  cancelledExports.clear();
});

ipcMain.handle('dialog:openFolder', async () => {
  const result = await dialog.showOpenDialog({
    properties: ['openDirectory'],
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  return result.filePaths[0];
});

// Settings module (extracted to src/main/settings.js)
registerSettingsIpc();

/**
 * Check if npm packages need to be installed after an update (dev mode only)
 * @returns {Promise<{needed: boolean, installed: boolean, error?: string}>}
 */
async function checkAndInstallPackages() {
  // Only run for dev mode (npm start users)
  if (app.isPackaged) {
    return { needed: false, installed: false };
  }
  
  try {
    const settings = loadSettings();
    const versionPath = path.join(__dirname, '..', 'version.json');
    
    // Read current version
    let currentVersion = '0.0.0';
    if (fs.existsSync(versionPath)) {
      try {
        const versionData = JSON.parse(fs.readFileSync(versionPath, 'utf-8'));
        currentVersion = versionData.version || '0.0.0';
      } catch (e) {
        console.log('[STARTUP] Could not read version.json');
      }
    }
    
    const lastRunVersion = settings.lastRunVersion || '0.0.0';
    
    // If version hasn't changed, no need to check
    if (currentVersion === lastRunVersion) {
      return { needed: false, installed: false };
    }
    
    console.log(`[STARTUP] Version changed from ${lastRunVersion} to ${currentVersion}, checking for new packages...`);
    
    // Run npm install and capture output
    const projectRoot = path.join(__dirname, '..');
    const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';
    
    const result = spawnSync(npmCmd, ['install'], {
      cwd: projectRoot,
      encoding: 'utf-8',
      timeout: 120000, // 2 minute timeout
      shell: true
    });
    
    if (result.error) {
      console.error('[STARTUP] npm install error:', result.error);
      // Still update version so we don't keep trying
      settings.lastRunVersion = currentVersion;
      saveSettings(settings);
      return { needed: true, installed: false, error: result.error.message };
    }
    
    const output = (result.stdout || '') + (result.stderr || '');
    
    // Check if new packages were actually installed
    // npm install outputs "added X packages" when new packages are installed
    const addedMatch = output.match(/added (\d+) package/i);
    const packagesAdded = addedMatch ? parseInt(addedMatch[1], 10) : 0;
    
    // Update last run version
    settings.lastRunVersion = currentVersion;
    saveSettings(settings);
    
    if (packagesAdded > 0) {
      console.log(`[STARTUP] Installed ${packagesAdded} new package(s)`);
      return { needed: true, installed: true, count: packagesAdded };
    }
    
    console.log('[STARTUP] No new packages needed');
    return { needed: true, installed: false };
    
  } catch (err) {
    console.error('[STARTUP] Package check error:', err);
    return { needed: false, installed: false, error: err.message };
  }
}

ipcMain.handle('shell:openExternal', async (_event, url) => {
  await shell.openExternal(url);
});

// Export IPC Handlers
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
  console.log('[EXPORT] Starting export:', exportId);
  
  // Check if already cancelled before starting
  if (cancelledExports.has(exportId)) {
    console.log('Export cancelled before starting:', exportId);
    cancelledExports.delete(exportId);
    event.sender.send('export:progress', exportId, {
      type: 'complete',
      success: false,
      message: { key: 'ui.notifications.exportCancelled' }
    });
    return false;
  }
  
  try {
    const ffmpegPath = findFFmpegPath();
    if (!ffmpegPath) {
      throw new Error('FFmpeg not found. Please install FFmpeg or place it in the ffmpeg_bin directory.');
    }

    const result = await performVideoExport(event, exportId, exportData, ffmpegPath);
    return result;
  } catch (error) {
    console.error('Export failed:', error);
    cancelledExports.delete(exportId); // Clean up cancellation flag
    event.sender.send('export:progress', exportId, {
      type: 'complete',
      success: false,
      message: `Export failed: ${error.message}`
    });
    return false;
  }
});

ipcMain.handle('export:cancel', async (_event, exportId) => {
  // Mark as cancelled immediately so dashboard rendering loop can check it
  cancelledExports.add(exportId);
  
  const proc = activeExports[exportId];
  if (proc) {
    proc.kill('SIGTERM');
    delete activeExports[exportId];
    cancelledExports.delete(exportId); // Clean up immediately after killing
    return true;
  }
  // Even if process not found, mark as cancelled so it won't start
  return true;
});

ipcMain.handle('fs:showItemInFolder', async (_event, filePath) => {
  shell.showItemInFolder(filePath);
});

// Store pending deletion for after reload
let pendingDeleteFolder = null;

ipcMain.handle('fs:deleteFolder', async (_event, folderPath) => {
  try {
    // Validate the path exists and is a directory
    if (!fs.existsSync(folderPath)) {
      return { success: false, error: 'Folder does not exist' };
    }
    
    const stats = fs.statSync(folderPath);
    if (!stats.isDirectory()) {
      return { success: false, error: 'Path is not a directory' };
    }
    
    // Try using shell.trashItem first (moves to recycle bin, works better with locked files on Windows)
    try {
      await shell.trashItem(folderPath);
      console.log('[DELETE] Successfully moved folder to trash:', folderPath);
      return { success: true };
    } catch (trashErr) {
      console.log('[DELETE] Trash failed, trying direct delete:', trashErr.message);
      // Fall back to direct delete
      fs.rmSync(folderPath, { recursive: true, force: true });
      console.log('[DELETE] Successfully deleted folder:', folderPath);
      return { success: true };
    }
  } catch (err) {
    console.error('[DELETE] Failed to delete folder:', folderPath, err);
    return { success: false, error: err.message };
  }
});

// Schedule folder deletion and reload window to release file handles
ipcMain.handle('fs:deleteFolderWithReload', async (_event, folderPath, baseFolderPath) => {
  try {
    // Validate the path exists
    if (!fs.existsSync(folderPath)) {
      return { success: false, error: 'Folder does not exist' };
    }
    
    const stats = fs.statSync(folderPath);
    if (!stats.isDirectory()) {
      return { success: false, error: 'Path is not a directory' };
    }
    
    // Store the pending deletion info
    pendingDeleteFolder = { folderPath, baseFolderPath };
    
    // Reload the main window to release all file handles
    if (mainWindow && !mainWindow.isDestroyed()) {
      console.log('[DELETE] Reloading window to release file handles...');
      mainWindow.webContents.reload();
      return { success: true, reloading: true };
    }
    
    return { success: false, error: 'Window not available' };
  } catch (err) {
    console.error('[DELETE] Failed to schedule deletion:', err);
    return { success: false, error: err.message };
  }
});

// Check for pending deletion after window reload
ipcMain.handle('fs:checkPendingDelete', async () => {
  if (!pendingDeleteFolder) {
    return { hasPending: false };
  }
  
  const { folderPath, baseFolderPath } = pendingDeleteFolder;
  pendingDeleteFolder = null; // Clear it
  
  console.log('[DELETE] Processing pending deletion after reload:', folderPath);
  
  try {
    // Try trash first
    try {
      await shell.trashItem(folderPath);
      console.log('[DELETE] Successfully moved folder to trash:', folderPath);
      return { hasPending: true, success: true, folderPath, baseFolderPath };
    } catch (trashErr) {
      console.log('[DELETE] Trash failed, trying direct delete:', trashErr.message);
      fs.rmSync(folderPath, { recursive: true, force: true });
      console.log('[DELETE] Successfully deleted folder:', folderPath);
      return { hasPending: true, success: true, folderPath, baseFolderPath };
    }
  } catch (err) {
    console.error('[DELETE] Failed to delete folder after reload:', folderPath, err);
    return { hasPending: true, success: false, error: err.message, folderPath };
  }
});

ipcMain.handle('ffmpeg:check', async () => {
  const ffmpegPath = findFFmpegPath();
  
  // Check for fake no GPU setting (developer mode)
  const settings = loadSettings();
  const fakeNoGpu = settings.devFakeNoGpu === true;
  
  let gpuInfo = null;
  let hevcInfo = null;
  
  if (ffmpegPath && !fakeNoGpu) {
    // Reset cached values to force re-detection
    setGpuEncoder(null);
    setGpuEncoderHEVC(null);
    
    const gpu = detectGpuEncoder(ffmpegPath);
    const hevc = detectHEVCEncoder(ffmpegPath);
    
    if (gpu) {
      gpuInfo = { name: gpu.name, codec: gpu.codec };
    }
    if (hevc) {
      hevcInfo = { name: hevc.name, codec: hevc.codec };
    }
  }
  
  return { 
    available: !!ffmpegPath, 
    path: ffmpegPath,
    gpu: gpuInfo,
    hevc: hevcInfo,
    fakeNoGpu: fakeNoGpu
  };
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

// Auto-update module (extracted to src/main/autoUpdate.js)
registerAutoUpdateIpc({
  getMainWindow: () => mainWindow,
  getUpdateBranch,
  loadSettings,
  checkUpdateWithTelemetry,
  processApiResponse
});

// Developer Settings IPC Handlers
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
      console.log('[DEV] Settings reset - deleted:', settingsPath);
    }
    return { success: true, path: settingsPath };
  } catch (err) {
    console.error('Reset settings error:', err);
    return { success: false, error: err.message };
  }
});

ipcMain.handle('dev:forceLatestVersion', async () => {
  // Note: With electron-updater, version is managed by package.json
  // This just returns the current version for display purposes
  return { success: true, version: app.getVersion(), note: 'Version is managed by electron-updater' };
});

ipcMain.handle('dev:setOldVersion', async () => {
  // Note: With electron-updater, version is managed by package.json
  // This can't actually change the version - just triggers a manual update check
  console.log('[DEV] Triggering manual update check...');
  try {
    await autoUpdater.checkForUpdates();
    return { success: true, note: 'Manual update check triggered' };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('dev:getCurrentVersion', async () => {
  return { version: app.getVersion() };
});

ipcMain.handle('dev:getAppPaths', async () => {
  return {
    userData: app.getPath('userData'),
    settings: settingsPath,
    app: app.getAppPath(),
    temp: app.getPath('temp'),
    isPackaged: app.isPackaged
  };
});

ipcMain.handle('dev:reloadApp', async () => {
  if (mainWindow) {
    mainWindow.reload();
    return { success: true };
  }
  return { success: false, error: 'No main window' };
});

ipcMain.handle('app:isPackaged', async () => {
  return app.isPackaged;
});

// Diagnostics & Support ID IPC Handlers
ipcMain.handle('diagnostics:get', async () => {
  try {
    const currentVersion = app.getVersion();
    
    // Check for pending update
    let pendingUpdate = null; // null = up to date, string = pending version
    try {
      const latestVersion = await getLatestVersionFromGitHub();
      if (latestVersion && currentVersion && latestVersion.version !== currentVersion) {
        pendingUpdate = latestVersion.version; // Store the pending version
      }
    } catch { /* ignore update check errors */ }
    
    // Get OS name (friendly format)
    const getOSName = () => {
      const platform = os.platform();
      if (platform === 'win32') return 'Windows';
      if (platform === 'darwin') return 'macOS';
      if (platform === 'linux') {
        // Try to get distro name from /etc/os-release
        try {
          const osRelease = fs.readFileSync('/etc/os-release', 'utf-8');
          const nameMatch = osRelease.match(/^PRETTY_NAME="?([^"\n]+)"?/m);
          if (nameMatch) return nameMatch[1];
        } catch { /* ignore */ }
        return 'Linux';
      }
      return platform;
    };
    
    // Check FFmpeg and GPU
    const ffmpegPath = findFFmpegPath();
    const ffmpegDetected = ffmpegPath !== null;
    
    // Detect GPU if not already done
    if (ffmpegDetected && getGpuEncoder() === null) {
      detectGpuEncoder(ffmpegPath);
    }
    
    // Detect actual GPU hardware
    const gpuHardware = detectGpuHardware();
    
    return {
      os: getOSName(),
      appVersion: currentVersion || 'unknown',
      pendingUpdate,
      hardware: {
        cpuModel: os.cpus()[0]?.model || 'unknown',
        ramTotal: os.totalmem(),
        ramFree: os.freemem(),
        gpuDetected: getGpuEncoder() !== null || gpuHardware !== null,
        gpuHardware: gpuHardware,  // Actual GPU name (e.g., "NVIDIA GeForce RTX 4070 Super")
        gpuEncoder: getGpuEncoder()?.name || null,  // Encoder type (e.g., "NVIDIA NVENC")
        ffmpegDetected
      },
      logs: mainLogBuffer.slice() // All main process logs
    };
  } catch (err) {
    console.error('Failed to collect diagnostics:', err);
    return { error: err.message };
  }
});

ipcMain.handle('diagnostics:writeFile', async (_event, filePath, content) => {
  try {
    fs.writeFileSync(filePath, content, 'utf-8');
    return { success: true };
  } catch (err) {
    console.error('Failed to write diagnostic file:', err);
    return { success: false, error: err.message };
  }
});

// Diagnostics storage module (extracted to src/main/diagnostics.js)
registerDiagnosticsStorageIpc(SUPPORT_SERVER_URL);

// Support chat module (extracted to src/main/supportChat.js)
registerSupportChatIpc();

