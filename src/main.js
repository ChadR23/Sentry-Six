const { app, BrowserWindow, dialog, ipcMain, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn, spawnSync, execSync } = require('child_process');
const { writeCompactDashboardAss, cleanupAssFile, writeSolidCoverAss } = require('./assGenerator');
const https = require('https');
const { createWriteStream, mkdirSync, rmSync, copyFileSync } = require('fs');

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

// Auto-Update Configuration
const UPDATE_CONFIG = {
  owner: 'ChadR23',
  repo: 'Sentry-Six',
  defaultBranch: 'main'
};

// electron-updater is optional - only needed for NSIS packaged installs
// Manual npm installs use the GitHub download method instead
let autoUpdater = null;
try {
  autoUpdater = require('electron-updater').autoUpdater;
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = true;
} catch (err) {
  console.log('[UPDATE] electron-updater not available - using manual update method');
}

// Get the configured update branch from settings (defaults to main)
function getUpdateBranch() {
  const settings = loadSettings();
  return settings.updateBranch || UPDATE_CONFIG.defaultBranch;
}

// Active exports tracking
const activeExports = {};
const cancelledExports = new Set(); // Track cancelled exports by ID
let mainWindow = null;
let gpuEncoder = null; // Cached GPU encoder detection (H.264)
let gpuEncoderHEVC = null; // Cached HEVC encoder detection (higher resolution support)

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

// FFmpeg Utilities
/**
 * Ensures macOS/Linux FFmpeg binaries are executable.
 * Called before attempting to run FFmpeg to handle fresh installs or builds.
 */
function ensureExecutable(filePath) {
  if (process.platform === 'win32') return; // Windows doesn't need chmod
  
  try {
    if (fs.existsSync(filePath)) {
      const stats = fs.statSync(filePath);
      // Check if executable bit is set (owner execute = 0o100)
      if ((stats.mode & 0o100) === 0) {
        console.log(`[CHMOD] Making executable: ${filePath}`);
        fs.chmodSync(filePath, 0o755);
      }
    }
  } catch (err) {
    console.warn(`[CHMOD] Could not set executable permission on ${filePath}: ${err.message}`);
  }
}

function findFFmpegPath() {
  const isMac = process.platform === 'darwin';
  const isWin = process.platform === 'win32';
  
  // Build list of paths to check
  const paths = [];
  
  if (isMac) {
    // macOS: Check bundled paths first (like Windows), then fall back to system paths
    console.log('🍎 macOS detected, checking FFmpeg paths:');
    
    // For packaged builds, extraResources places files in process.resourcesPath
    if (app.isPackaged) {
      paths.push(
        path.join(process.resourcesPath, 'ffmpeg_bin', 'ffmpeg')
      );
    }
    // Also check standard development paths (npm start)
    paths.push(
      path.join(__dirname, '..', 'ffmpeg_bin', 'ffmpeg'),
      path.join(__dirname, 'ffmpeg_bin', 'ffmpeg'),
      path.join(process.cwd(), 'ffmpeg_bin', 'ffmpeg'),
      path.join(app.getAppPath(), 'ffmpeg_bin', 'ffmpeg'),
      path.join(app.getAppPath(), '..', 'ffmpeg_bin', 'ffmpeg')
    );
    
    // Fall back to system install locations (Homebrew, MacPorts, etc.)
    const systemPaths = [
      '/opt/homebrew/bin/ffmpeg',  // Homebrew Apple Silicon
      '/usr/local/bin/ffmpeg',      // Homebrew Intel Mac
      '/opt/local/bin/ffmpeg',      // MacPorts
      '/usr/bin/ffmpeg',            // System
      path.join(os.homedir(), '.local', 'bin', 'ffmpeg'),
      path.join(os.homedir(), 'bin', 'ffmpeg')
    ];
    paths.push(...systemPaths);
    
    // Log what we're checking for debugging
    for (const p of paths) {
      const exists = fs.existsSync(p);
      console.log(`   ${exists ? '✓' : '✗'} ${p}`);
    }
  } else if (isWin) {
    // Windows: Check bundled paths first, then system
    // For packaged builds, extraResources places files in process.resourcesPath
    if (app.isPackaged) {
      paths.push(
        path.join(process.resourcesPath, 'ffmpeg_bin', 'ffmpeg.exe')
      );
    }
    // Also check standard development paths
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

  console.log('[SEARCH] Searching for FFmpeg in:', paths);

  for (const p of paths) {
    try {
      // First check if file exists (skip for bare 'ffmpeg' which relies on PATH)
      const exists = p === 'ffmpeg' || fs.existsSync(p);
      console.log(`  Checking ${p}: exists=${exists}`);
      
      if (!exists) continue;
      
      // Ensure bundled binaries are executable on macOS/Linux
      if (p !== 'ffmpeg' && !p.startsWith('/opt') && !p.startsWith('/usr')) {
        ensureExecutable(p);
      }
      
      // Don't use shell:true on Windows - it breaks paths with spaces
      // Only use shell on macOS for symlink handling
      const isMac = process.platform === 'darwin';
      const result = spawnSync(p, ['-version'], { 
        timeout: 5000, 
        windowsHide: true,
        encoding: 'utf8',
        shell: isMac  // Only use shell on macOS for symlinks
      });
      
      console.log(`  Spawn result: status=${result.status}, error=${result.error?.message || 'none'}`);
      
      if (result.status === 0) {
        console.log(`[OK] Found FFmpeg at: ${p}`);
        return p;
      }
    } catch (err) {
      console.log(`  Error checking ${p}: ${err.message}`);
    }
  }
  
  console.warn('[ERROR] FFmpeg not found in any of the checked paths');
  return null;
}

/**
 * Detects and tests available GPU hardware encoders.
 * Returns the first working encoder found, or null if none are available.
 * Caches result to avoid repeated detection.
 */
/**
 * Detect actual GPU hardware model name (e.g., "NVIDIA GeForce RTX 4070 Super")
 * This is separate from encoder detection - shows the actual hardware.
 */
let cachedGpuHardware = undefined; // undefined = not checked, null = checked but not found
function detectGpuHardware() {
  if (cachedGpuHardware !== undefined) return cachedGpuHardware;
  
  try {
    if (process.platform === 'win32') {
      // Windows: Use wmic to get GPU name
      const result = spawnSync('wmic', ['path', 'win32_VideoController', 'get', 'name'], {
        timeout: 5000,
        windowsHide: true,
        shell: true
      });
      const output = result.stdout?.toString() || '';
      const lines = output.split('\n').map(l => l.trim()).filter(l => l && l !== 'Name');
      if (lines.length > 0) {
        // Filter out basic display adapters, prefer dedicated GPUs
        const dedicated = lines.find(l => 
          l.includes('NVIDIA') || l.includes('AMD') || l.includes('Radeon') || l.includes('GeForce')
        );
        cachedGpuHardware = dedicated || lines[0];
        console.log(`[GPU] Hardware detected: ${cachedGpuHardware}`);
        return cachedGpuHardware;
      }
    } else if (process.platform === 'darwin') {
      // macOS: Use system_profiler
      const result = spawnSync('system_profiler', ['SPDisplaysDataType'], {
        timeout: 5000
      });
      const output = result.stdout?.toString() || '';
      const chipMatch = output.match(/Chipset Model:\s*(.+)/i) || output.match(/Chip:\s*(.+)/i);
      if (chipMatch) {
        cachedGpuHardware = chipMatch[1].trim();
        console.log(`[GPU] Hardware detected: ${cachedGpuHardware}`);
        return cachedGpuHardware;
      }
    } else {
      // Linux: Use lspci
      const result = spawnSync('lspci', ['-v'], { timeout: 5000 });
      const output = result.stdout?.toString() || '';
      const vgaMatch = output.match(/VGA compatible controller:\s*(.+)/i);
      if (vgaMatch) {
        cachedGpuHardware = vgaMatch[1].trim().split('(')[0].trim();
        console.log(`[GPU] Hardware detected: ${cachedGpuHardware}`);
        return cachedGpuHardware;
      }
    }
  } catch (err) {
    console.log('[GPU] Could not detect hardware:', err.message);
  }
  
  cachedGpuHardware = null;
  return null;
}

function detectGpuEncoder(ffmpegPath) {
  if (gpuEncoder !== null) return gpuEncoder;
  
  try {
    // Query FFmpeg for available encoders
    const encoderResult = spawnSync(ffmpegPath, ['-encoders'], { timeout: 5000, windowsHide: true });
    const encoderOutput = encoderResult.stdout?.toString() || '';
    
    /**
     * Tests if a GPU encoder can actually access hardware.
     * FFmpeg may list encoders that aren't usable (e.g., NVENC listed but no NVIDIA GPU).
     * Uses a strict test: only returns true if the encoder actually works (status === 0).
     */
    const testEncoder = (codec) => {
      try {
        // Verify encoder exists in FFmpeg build
        const helpResult = spawnSync(ffmpegPath, ['-hide_banner', '-h', `encoder=${codec}`], { 
          timeout: 2000, 
          windowsHide: true,
          stdio: 'pipe'
        });
        
        const helpOutput = (helpResult.stdout?.toString() || '') + (helpResult.stderr?.toString() || '');
        
        if (helpOutput.includes('Unknown encoder') || 
            helpOutput.includes('No such encoder') ||
            helpOutput.includes('not found')) {
          return false;
        }
        
        // Test encoder with realistic test input (like old code used testsrc2)
        // This is more reliable than minimal color test
        let testArgs = ['-hide_banner', '-f', 'lavfi', '-i', 'testsrc2=duration=1:size=320x240:rate=1'];
        
        // Add encoder-specific settings
        if (codec.includes('videotoolbox')) {
          testArgs.push('-b:v', '2M');
        }
        
        testArgs.push('-c:v', codec, '-frames:v', '1', '-f', 'null', '-');
        
        const testResult = spawnSync(ffmpegPath, testArgs, { 
          timeout: 5000,
          windowsHide: true,
          stdio: 'pipe'
        });
        
        const testOutput = (testResult.stdout?.toString() || '') + (testResult.stderr?.toString() || '');
        
        // Log test output for debugging
        if (testOutput.length > 0) {
          const shortOutput = testOutput.split('\n').slice(0, 3).join(' ').substring(0, 150);
          console.log(`  ${codec} test: status=${testResult.status}, output: ${shortOutput}...`);
        }
        
        // Check for definitive hardware errors
        const fatalErrors = [
          'No such device',
          'Could not open encoder',
          'Failed to create encoder',
          'Cannot load',
          'Device creation failed',
          'No capable devices found',
          'No device available',
          'No hardware device found',
          'Task finished with error',
          'Invalid argument'
        ];
        
        for (const error of fatalErrors) {
          if (testOutput.toLowerCase().includes(error.toLowerCase())) {
            return false;
          }
        }
        
        // STRICT: Only return true if the test actually succeeded (status === 0)
        // This matches the old working code behavior
        return testResult.status === 0;
      } catch (err) {
        return false;
      }
    };
    
    // Define encoder priority by platform
    // Test all encoders in order and use the first one that actually works
    // This matches the old working code behavior - no vendor detection, just test everything
    const encodersToCheck = [];
    
    if (process.platform === 'darwin') {
      encodersToCheck.push({ codec: 'h264_videotoolbox', name: 'Apple VideoToolbox', priority: 1 });
    } else if (process.platform === 'win32') {
      // Windows: Test all encoders in priority order (NVIDIA, AMD, Intel)
      // The testEncoder function will verify each one actually works
      encodersToCheck.push(
        { codec: 'h264_nvenc', name: 'NVIDIA NVENC', priority: 1 },
        { codec: 'h264_amf', name: 'AMD AMF', priority: 2 },
        { codec: 'h264_qsv', name: 'Intel QuickSync', priority: 3 }
      );
    } else {
      // Linux: Test NVIDIA and Intel
      encodersToCheck.push(
        { codec: 'h264_nvenc', name: 'NVIDIA NVENC', priority: 1 },
        { codec: 'h264_qsv', name: 'Intel QuickSync', priority: 2 }
      );
    }
    
    encodersToCheck.sort((a, b) => (a.priority || 999) - (b.priority || 999));
    
    // Test each encoder in priority order, return first working one
    for (const encoder of encodersToCheck) {
      if (encoderOutput.includes(encoder.codec)) {
        console.log(`[TEST] Testing ${encoder.name} (${encoder.codec})...`);
        if (testEncoder(encoder.codec)) {
          gpuEncoder = encoder;
          console.log(`[GPU] GPU encoder available: ${gpuEncoder.name}`);
          return gpuEncoder;
        } else {
          console.log(`[WARN] ${encoder.codec} is listed but not usable (no hardware available)`);
        }
      }
    }
    
    gpuEncoder = null;
    console.log('[INFO] No usable GPU encoder found, will use CPU encoding');
  } catch (err) {
    console.error('Error detecting GPU encoder:', err.message);
    gpuEncoder = null;
  }
  return gpuEncoder;
}

/**
 * Detects HEVC (H.265) GPU encoders for higher resolution support.
 * HEVC encoders support up to 8192px (vs H.264's 4096px limit).
 * Used when H.264 GPU encoding would exceed resolution limits.
 */
function detectHEVCEncoder(ffmpegPath) {
  if (gpuEncoderHEVC !== null) return gpuEncoderHEVC;
  
  try {
    // Query FFmpeg for available encoders
    const encoderResult = spawnSync(ffmpegPath, ['-encoders'], { timeout: 5000, windowsHide: true });
    const encoderOutput = encoderResult.stdout?.toString() || '';
    
    const testEncoder = (codec) => {
      try {
        const helpResult = spawnSync(ffmpegPath, ['-hide_banner', '-h', `encoder=${codec}`], { 
          timeout: 2000, windowsHide: true, stdio: 'pipe'
        });
        const helpOutput = (helpResult.stdout?.toString() || '') + (helpResult.stderr?.toString() || '');
        if (helpOutput.includes('Unknown encoder') || helpOutput.includes('not found')) {
          console.log(`  ${codec}: Not found in FFmpeg`);
          return false;
        }
        
        // Test encoder with realistic test input (like old code used testsrc2)
        // HEVC VideoToolbox needs larger resolution and specific settings
        const isHEVC = codec.includes('hevc');
        const testSize = isHEVC ? '640x480' : '320x240';
        let testArgs = ['-hide_banner', '-f', 'lavfi', '-i', `testsrc2=duration=1:size=${testSize}:rate=1`];
        
        // Add encoder-specific settings
        if (codec.includes('videotoolbox')) {
          // VideoToolbox HEVC needs higher bitrate and may need allow_sw for testing
          testArgs.push('-b:v', isHEVC ? '5M' : '2M');
          if (isHEVC) {
            testArgs.push('-allow_sw', '1'); // Allow software fallback for HEVC test
          }
        }
        
        testArgs.push('-c:v', codec, '-frames:v', '1', '-f', 'null', '-');
        
        const testResult = spawnSync(ffmpegPath, testArgs, { timeout: 5000, windowsHide: true, stdio: 'pipe' });
        const testOutput = (testResult.stdout?.toString() || '') + (testResult.stderr?.toString() || '');
        
        // Log test output for debugging
        if (testOutput.length > 0) {
          const shortOutput = testOutput.split('\n').slice(0, 3).join(' ').substring(0, 150);
          console.log(`  ${codec} test: status=${testResult.status}, output: ${shortOutput}...`);
        }
        
        // Check for fatal errors
        const fatalErrors = [
          'No such device',
          'Could not open encoder',
          'Failed to create encoder',
          'Cannot load',
          'Device creation failed',
          'No capable devices found',
          'No device available',
          'No hardware device found',
          'Task finished with error',
          'Invalid argument'
        ];
        for (const error of fatalErrors) {
          if (testOutput.toLowerCase().includes(error.toLowerCase())) {
            console.log(`  ${codec}: Fatal error - ${error}`);
            return false;
          }
        }
        
        // STRICT: Only return true if the test actually succeeded (status === 0)
        // This matches the old working code behavior
        return testResult.status === 0;
      } catch (err) { 
        console.log(`  ${codec}: Exception - ${err.message}`);
        return false; 
      }
    };
    
    // HEVC encoders by platform - test all encoders in order and use first one that works
    // This matches the old working code behavior - no vendor detection, just test everything
    const hevcEncoders = [];
    if (process.platform === 'darwin') {
      hevcEncoders.push({ codec: 'hevc_videotoolbox', name: 'Apple VideoToolbox HEVC', maxRes: 8192, priority: 1 });
    } else if (process.platform === 'win32') {
      // Windows: Test all encoders in priority order (NVIDIA, AMD, Intel)
      // The testEncoder function will verify each one actually works
      hevcEncoders.push(
        { codec: 'hevc_nvenc', name: 'NVIDIA NVENC HEVC', maxRes: 8192, priority: 1 },
        { codec: 'hevc_amf', name: 'AMD AMF HEVC', maxRes: 8192, priority: 2 },
        { codec: 'hevc_qsv', name: 'Intel QuickSync HEVC', maxRes: 8192, priority: 3 }
      );
      hevcEncoders.sort((a, b) => (a.priority || 999) - (b.priority || 999));
    } else {
      // Linux: Test NVIDIA and Intel
      hevcEncoders.push(
        { codec: 'hevc_nvenc', name: 'NVIDIA NVENC HEVC', maxRes: 8192, priority: 1 },
        { codec: 'hevc_qsv', name: 'Intel QuickSync HEVC', maxRes: 8192, priority: 2 }
      );
    }
    
    console.log('[HEVC] Checking for HEVC GPU encoders...');
    for (const encoder of hevcEncoders) {
      if (encoderOutput.includes(encoder.codec)) {
        console.log(`[TEST] Testing HEVC encoder ${encoder.name} (${encoder.codec})...`);
        if (testEncoder(encoder.codec)) {
          gpuEncoderHEVC = encoder;
          console.log(`[GPU] HEVC encoder available: ${gpuEncoderHEVC.name}`);
          return gpuEncoderHEVC;
        } else {
          console.log(`[WARN] ${encoder.codec} listed but not usable`);
        }
      } else {
        console.log(`[INFO] ${encoder.codec} not found in FFmpeg encoders list`);
      }
    }
    
    gpuEncoderHEVC = null;
    console.log('[INFO] No usable HEVC GPU encoder found');
  } catch (err) {
    console.error('Error detecting HEVC encoder:', err.message);
    gpuEncoderHEVC = null;
  }
  return gpuEncoderHEVC;
}

function makeEven(n) {
  return Math.floor(n / 2) * 2;
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

// Video Export Implementation
async function performVideoExport(event, exportId, exportData, ffmpegPath) {
  const { segments, startTimeMs, endTimeMs, outputPath, cameras, mobileExport, quality, includeDashboard, seiData, layoutData, useMetric, glassBlur = 7, dashboardStyle = 'standard', dashboardPosition = 'bottom-center', dashboardSize = 'medium', includeTimestamp = false, timestampPosition = 'bottom-center', timestampDateFormat = 'mdy', blurZones = [], blurType = 'solid', language = 'en' } = exportData;
  const tempFiles = [];
  const CAMERA_ORDER = ['left_pillar', 'front', 'right_pillar', 'left_repeater', 'back', 'right_repeater'];
  const FPS = 36; // Tesla cameras record at ~36fps

  const sendProgress = (percentage, message) => {
    event.sender.send('export:progress', exportId, { type: 'progress', percentage, message });
  };
  
  const sendDashboardProgress = (percentage, message) => {
    event.sender.send('export:progress', exportId, { type: 'dashboard-progress', percentage, message });
  };

  const sendComplete = (success, message) => {
    event.sender.send('export:progress', exportId, { type: 'complete', success, message, outputPath });
  };

  const cleanup = () => tempFiles.forEach(f => { try { fs.unlinkSync(f); } catch {} });

  // Dashboard temp file path (set during pre-render)
  let dashboardTempPath = null;

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
    
    // Camera position tracking for ASS-based solid cover overlay (scope shared across layout types)
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
        const isMirrored = ['back', 'left_repeater', 'right_repeater'].includes(camera);
        
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
      // Track camera positions for ASS-based solid cover overlay (single camera layout)
      singleCameraPositions = {};
      singleCameraDimensions = {};
      for (const stream of cameraStreams) {
        singleCameraPositions[stream.camera] = { x: stream.x, y: stream.y };
        singleCameraDimensions[stream.camera] = { width: w + (w % 2), height: h + (h % 2) };
      }
      
      // For 'solid' blur type, we skip FFmpeg-based blur and use ASS overlay later
      // For 'optimized' and 'trueBlur', we use mask-based FFmpeg filters
      if (blurType !== 'solid') {
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
            const { createCanvas, loadImage } = require('canvas');
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
            
            if (blurType === 'trueBlur') {
              // True Blur (Slow): uses alpha channel for smooth edge blending
              // Split the camera stream into two copies (FFmpeg streams can only be consumed once)
              filters.push(`${blurCameraStreamTag}split=2[blur_orig_${cam}][blur_base_${cam}]`);
              
              // Scale mask and convert to alpha format
              filters.push(`[${maskInputIdx}:v]scale=${cameraW}:${cameraH}:force_original_aspect_ratio=disable,format=gray,format=yuva420p[mask_alpha_${cam}]`);
              
              // Apply blur to one copy, then apply alpha mask
              filters.push(`[blur_orig_${cam}]boxblur=10:10[blurred_temp_${cam}]`);
              filters.push(`[blurred_temp_${cam}][mask_alpha_${cam}]alphamerge[blurred_with_alpha_${cam}]`);
              
              // Overlay the blurred+masked region onto the original base
              filters.push(`[blur_base_${cam}][blurred_with_alpha_${cam}]overlay=0:0:format=auto${blurredStreamTag}`);
            } else {
              // Blur (Optimized): direct mask overlay without alpha channel (faster)
              // Split the camera stream into two copies
              filters.push(`${blurCameraStreamTag}split=2[blur_orig_${cam}][blur_base_${cam}]`);
              
              // Scale mask to grayscale for masking, then convert to yuv420p to match video format
              filters.push(`[${maskInputIdx}:v]scale=${cameraW}:${cameraH}:force_original_aspect_ratio=disable,format=gray,format=yuv420p[mask_gray_${cam}]`);
              
              // Apply strong blur to one copy
              filters.push(`[blur_orig_${cam}]boxblur=15:15[blurred_temp_${cam}]`);
              
              // Use blend filter with mask: where mask is white, use blurred; where black, use original
              filters.push(`[blur_base_${cam}][blurred_temp_${cam}][mask_gray_${cam}]maskedmerge${blurredStreamTag}`);
            }
            
            blurStream.tag = blurredStreamTag;
          } catch (err) {
            console.error('[BLUR] Failed to apply blur zone:', err);
          }
        }
      } else if (blurZones.length > 0) {
        console.log(`[BLUR] Using ASS solid cover for ${blurZones.length} blur zone(s) (single camera layout)`);
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
        const isMirrored = ['back', 'left_repeater', 'right_repeater'].includes(camera);

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
      // Track camera positions for ASS-based solid cover overlay
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
      
      // For 'solid' blur type, we skip FFmpeg-based blur and use ASS overlay later
      // For 'optimized' and 'trueBlur', we use mask-based FFmpeg filters
      if (blurType !== 'solid') {
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
            
            const { createCanvas, loadImage } = require('canvas');
            const compositeCanvas = createCanvas(maskW, maskH);
            const compositeCtx = compositeCanvas.getContext('2d');
            compositeCtx.fillStyle = 'black';
            compositeCtx.fillRect(0, 0, maskW, maskH);
            
            for (const zone of zones) {
              const maskBuffer = Buffer.from(zone.maskImageBase64, 'base64');
              const maskImg = await loadImage(maskBuffer);
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
            
            if (blurType === 'trueBlur') {
              // True Blur (Slow): uses alpha channel for smooth edge blending
              filters.push(`${blurCameraStreamTag}split=2[blur_orig_${cam}][blur_base_${cam}]`);
              filters.push(`[${maskInputIdx}:v]scale=${cameraW}:${cameraH}:force_original_aspect_ratio=disable,format=gray,format=yuva420p[mask_alpha_${cam}]`);
              filters.push(`[blur_orig_${cam}]boxblur=10:10[blurred_temp_${cam}]`);
              filters.push(`[blurred_temp_${cam}][mask_alpha_${cam}]alphamerge[blurred_with_alpha_${cam}]`);
              filters.push(`[blur_base_${cam}][blurred_with_alpha_${cam}]overlay=0:0:format=auto${blurredStreamTag}`);
            } else {
              // Blur (Optimized): direct mask overlay without alpha channel (faster)
              filters.push(`${blurCameraStreamTag}split=2[blur_orig_${cam}][blur_base_${cam}]`);
              filters.push(`[${maskInputIdx}:v]scale=${cameraW}:${cameraH}:force_original_aspect_ratio=disable,format=gray[mask_gray_${cam}]`);
              filters.push(`[blur_orig_${cam}]boxblur=15:15[blurred_temp_${cam}]`);
              filters.push(`[blur_base_${cam}][blurred_temp_${cam}][mask_gray_${cam}]maskedmerge${blurredStreamTag}`);
            }
            
            blurStream.tag = blurredStreamTag;
            const streamIndex = streamTags.indexOf(blurCameraStreamTag);
            if (streamIndex !== -1) {
              streamTags[streamIndex] = blurredStreamTag;
            }
          } catch (err) {
            console.error('[BLUR] Failed to apply blur zone:', err);
          }
        }
      } else if (blurZones.length > 0) {
        console.log(`[BLUR] Using ASS solid cover for ${blurZones.length} blur zone(s)`);
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

    // Generate ASS solid cover overlay for 'solid' blur type
    let solidCoverAssPath = null;
    let currentStreamTag = '[grid]'; // Track the current stream tag for chaining filters
    
    if (blurType === 'solid' && blurZones.length > 0) {
      try {
        // Determine camera positions based on layout type
        // Use grid positions if available, otherwise fall back to single camera positions
        let cameraPositions = {};
        let cameraDimensions = {};
        
        if (gridCameraPositions && Object.keys(gridCameraPositions).length > 0) {
          // Grid layout - use grid positions
          cameraPositions = gridCameraPositions;
          cameraDimensions = gridCameraDimensions;
        } else if (singleCameraPositions && Object.keys(singleCameraPositions).length > 0) {
          // Single camera or custom layout
          cameraPositions = singleCameraPositions;
          cameraDimensions = singleCameraDimensions;
        } else {
          // Fallback - use full video dimensions for single camera
          const singleCam = activeCamerasForGrid[0] || blurZones[0]?.camera;
          if (singleCam) {
            cameraPositions[singleCam] = { x: 0, y: 0 };
            cameraDimensions[singleCam] = { width: totalW, height: totalH };
          }
        }
        
        // Filter blur zones to only those with selected cameras
        const selectedBlurZones = blurZones.filter(z => 
          z && z.coordinates && z.coordinates.length >= 3 && cameraPositions[z.camera]
        );
        
        if (selectedBlurZones.length > 0) {
          const durationMs = endTimeMs - startTimeMs;
          solidCoverAssPath = await writeSolidCoverAss(
            exportId,
            selectedBlurZones,
            durationMs,
            totalW,
            totalH,
            cameraDimensions,
            cameraPositions
          );
          tempFiles.push(solidCoverAssPath);
          
          // Apply solid cover ASS filter
          const escapedSolidCoverPath = solidCoverAssPath
            .replace(/\\/g, '/')
            .replace(/:/g, '\\:');
          
          filters.push(`[grid]ass='${escapedSolidCoverPath}'[grid_cover]`);
          currentStreamTag = '[grid_cover]';
          console.log(`[ASS] Using ASS solid cover for ${selectedBlurZones.length} blur zone(s): ${solidCoverAssPath}`);
        }
      } catch (err) {
        console.error('[BLUR] Failed to generate solid cover ASS:', err);
        // Fall through to continue without solid cover
      }
    }
    
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
    
    if (useAssDashboard && assTempPath) {
      // ASS SUBTITLE DASHBOARD (compact style) - High-speed GPU-accelerated rendering
      // The ASS filter burns subtitles directly into the video at GPU encoder speed
      // This is MUCH faster than BrowserWindow capture loop (30min -> 3-5min)
      // Escape Windows path for FFmpeg (colons and backslashes need escaping)
      const escapedAssPath = assTempPath
        .replace(/\\/g, '/')           // Convert backslashes to forward slashes
        .replace(/:/g, '\\:');         // Escape colons (Windows drive letters)
      
      filters.push(`${currentStreamTag}ass='${escapedAssPath}'[out]`);
      console.log(`[ASS] Using ASS subtitle filter for compact dashboard: ${assTempPath}`);
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
      const timestampText = `${dateFormat} %I\\:%M\\:%S %p`;
      
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
      const maxThreads = Math.min(4, Math.floor(require('os').cpus().length / 2));
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
  
  // Set up electron-updater event handlers (only if available)
  if (autoUpdater) {
    autoUpdater.on('checking-for-update', () => {
      console.log('[UPDATE] Checking for updates...');
    });
    
    autoUpdater.on('update-available', (info) => {
      console.log('[UPDATE] Update available:', info.version);
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('update:available', {
          currentVersion: app.getVersion(),
          latestVersion: info.version,
          releaseName: info.releaseName || 'New Update',
          releaseDate: info.releaseDate
        });
      }
    });
    
    autoUpdater.on('update-not-available', () => {
      console.log('[UPDATE] App is up to date');
    });
    
    autoUpdater.on('download-progress', (progress) => {
      console.log(`[UPDATE] Download progress: ${Math.round(progress.percent)}%`);
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('update:progress', {
          percentage: Math.round(progress.percent),
          message: `Downloading... ${Math.round(progress.percent)}%`
        });
      }
    });
    
    autoUpdater.on('update-downloaded', (info) => {
      console.log('[UPDATE] Update downloaded:', info.version);
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('update:downloaded', {
          version: info.version
        });
      }
    });
    
    autoUpdater.on('error', (err) => {
      console.error('[UPDATE] Error:', err.message);
    });
  }

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

// File-based settings storage for reliable persistence
const settingsPath = path.join(app.getPath('userData'), 'settings.json');

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

ipcMain.handle('ffmpeg:check', async () => {
  const ffmpegPath = findFFmpegPath();
  
  // Check for fake no GPU setting (developer mode)
  const settings = loadSettings();
  const fakeNoGpu = settings.devFakeNoGpu === true;
  
  let gpuInfo = null;
  let hevcInfo = null;
  
  if (ffmpegPath && !fakeNoGpu) {
    // Reset cached values to force re-detection
    gpuEncoder = null;
    gpuEncoderHEVC = null;
    
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

// Auto-Update System
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

/**
 * Fetch the latest version.json from GitHub (for manual/dev installs)
 */
async function getLatestVersionFromGitHub() {
  const cacheBuster = Date.now();
  const url = `https://raw.githubusercontent.com/${UPDATE_CONFIG.owner}/${UPDATE_CONFIG.repo}/${getUpdateBranch()}/version.json?cb=${cacheBuster}`;
  const response = await httpsGet(url);
  
  if (response.statusCode === 200) {
    return JSON.parse(response.data);
  }
  return null;
}

/**
 * Compare two semantic version strings
 */
function compareVersions(v1, v2) {
  const parts1 = v1.replace(/^v/i, '').split('.').map(Number);
  const parts2 = v2.replace(/^v/i, '').split('.').map(Number);
  
  for (let i = 0; i < Math.max(parts1.length, parts2.length); i++) {
    const p1 = parts1[i] || 0;
    const p2 = parts2[i] || 0;
    if (p1 < p2) return -1;
    if (p1 > p2) return 1;
  }
  return 0;
}

/**
 * Check for updates - handles both packaged (NSIS) and development (npm start) modes
 */
async function checkForUpdatesManual() {
  try {
    console.log('[UPDATE] Manual update check (dev mode)...');
    const latestVersion = await getLatestVersionFromGitHub();
    
    if (!latestVersion) {
      console.log('[UPDATE] No remote version available');
      return { updateAvailable: false, error: 'Could not fetch version info' };
    }
    
    const currentVer = app.getVersion();
    const latestVer = latestVersion.version;
    
    console.log(`[UPDATE] Current: v${currentVer}, Latest: v${latestVer}`);
    
    if (compareVersions(currentVer, latestVer) < 0) {
      console.log('[UPDATE] New version available!');
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('update:available', {
          currentVersion: currentVer,
          latestVersion: latestVer,
          releaseName: latestVersion.releaseName || 'New Update',
          releaseDate: latestVersion.releaseDate,
          isDevMode: true  // Flag to indicate this is dev mode
        });
      }
      return { updateAvailable: true, currentVersion: currentVer, latestVersion: latestVer };
    } else {
      console.log('[UPDATE] App is up to date');
      return { updateAvailable: false, currentVersion: currentVer, latestVersion: latestVer };
    }
  } catch (err) {
    console.error('[UPDATE] Manual check failed:', err.message);
    return { updateAvailable: false, error: err.message };
  }
}

// Update IPC handlers
ipcMain.handle('update:check', async () => {
  try {
    if (app.isPackaged && autoUpdater) {
      // NSIS install - use electron-updater
      const result = await autoUpdater.checkForUpdates();
      // electron-updater returns update info if available
      const updateAvailable = result?.updateInfo?.version && 
        compareVersions(app.getVersion(), result.updateInfo.version) < 0;
      return { 
        checked: true, 
        updateAvailable,
        currentVersion: app.getVersion(),
        latestVersion: result?.updateInfo?.version || app.getVersion()
      };
    } else {
      // Development/manual install - use GitHub version.json check
      const result = await checkForUpdatesManual();
      return { checked: true, ...result };
    }
  } catch (err) {
    console.error('[UPDATE] Check failed:', err.message);
    return { checked: false, updateAvailable: false, error: err.message };
  }
});

ipcMain.handle('update:install', async (event) => {
  try {
    if (app.isPackaged) {
      // Packaged app - use platform-specific installers
      if (process.platform === 'darwin') {
        // macOS: Always use DMG download - can't copy files into app.asar
        // and Squirrel.Mac requires code-signed apps which we don't have
        const result = await performMacOSUpdate();
        return result;
      } else if (autoUpdater) {
        // Windows NSIS install - use electron-updater to download
        await autoUpdater.downloadUpdate();
        return { success: true, downloading: true };
      } else {
        return { success: false, error: 'Auto-updater not available' };
      }
    } else {
      // Development/manual install - use the manual update process
      const result = await performManualUpdate(event);
      return result;
    }
  } catch (err) {
    console.error('[UPDATE] Download failed:', err.message);
    return { success: false, error: err.message };
  }
});

/**
 * Perform update for macOS packaged builds
 * Downloads DMG from GitHub releases and opens it for manual installation
 * This bypasses Squirrel.Mac which requires code-signed apps
 */
async function performMacOSUpdate() {
  const sendProgress = (percentage, message) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('update:progress', { percentage, message });
    }
  };
  
  try {
    sendProgress(5, 'Fetching latest release info...');
    
    // Get latest release from GitHub API
    const releaseUrl = `https://api.github.com/repos/${UPDATE_CONFIG.owner}/${UPDATE_CONFIG.repo}/releases/latest`;
    const releaseResponse = await httpsGet(releaseUrl);
    
    if (releaseResponse.statusCode !== 200) {
      throw new Error('Failed to fetch release info from GitHub');
    }
    
    const releaseData = JSON.parse(releaseResponse.data);
    const version = releaseData.tag_name?.replace(/^v/i, '') || releaseData.name;
    
    // Find the DMG asset
    const dmgAsset = releaseData.assets?.find(asset => 
      asset.name.endsWith('.dmg') && asset.name.includes('macOS')
    );
    
    if (!dmgAsset) {
      throw new Error('No macOS DMG found in the latest release');
    }
    
    sendProgress(10, 'Downloading update...');
    
    // Download DMG to temp directory
    const tempDir = path.join(os.tmpdir(), 'sentry-six-update');
    const dmgPath = path.join(tempDir, dmgAsset.name);
    
    // Clean and create temp directory
    if (fs.existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true, force: true });
    }
    mkdirSync(tempDir, { recursive: true });
    
    // Download the DMG file
    await downloadFile(dmgAsset.browser_download_url, dmgPath, (pct) => {
      sendProgress(10 + Math.round(pct * 0.8), `Downloading... ${pct}%`);
    });
    
    sendProgress(95, 'Opening installer...');
    
    // Open the DMG file for user to install
    const { shell } = require('electron');
    await shell.openPath(dmgPath);
    
    console.log(`[UPDATE] Downloaded macOS update v${version}, opened DMG for installation`);
    
    sendProgress(100, 'Update downloaded!');
    
    // Signal completion with macOS-specific info
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('update:downloaded', { 
        version, 
        isMacOS: true,
        dmgPath 
      });
    }
    
    return { success: true, isMacOS: true, dmgPath };
  } catch (err) {
    console.error('[UPDATE] macOS update failed:', err.message);
    sendProgress(0, `Update failed: ${err.message}`);
    return { success: false, error: err.message };
  }
}

/**
 * Perform update for manual/development installs
 * Downloads files from GitHub and copies them to the app directory
 */
async function performManualUpdate(event) {
  const sendProgress = (percentage, message) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('update:progress', { percentage, message });
    }
  };
  
  try {
    sendProgress(5, 'Fetching latest version info...');
    const latestVersion = await getLatestVersionFromGitHub();
    
    const zipUrl = `https://github.com/${UPDATE_CONFIG.owner}/${UPDATE_CONFIG.repo}/archive/refs/heads/${getUpdateBranch()}.zip`;
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
      execSync(`powershell -Command "Expand-Archive -Path '${zipPath}' -DestinationPath '${extractDir}' -Force"`, { windowsHide: true });
    } else {
      execSync(`unzip -o "${zipPath}" -d "${extractDir}"`, { stdio: 'ignore' });
    }
    
    sendProgress(75, 'Installing update...');
    
    // Find the extracted folder (GitHub adds repo-branch prefix)
    const extractedContents = fs.readdirSync(extractDir);
    const sourceDir = path.join(extractDir, extractedContents[0]);
    
    // Get app directory
    const appDir = path.join(__dirname, '..');
    
    // Copy files from the downloaded repo to app directory
    const filesToCopy = fs.readdirSync(sourceDir, { withFileTypes: true });
    for (const entry of filesToCopy) {
      const srcPath = path.join(sourceDir, entry.name);
      const destPath = path.join(appDir, entry.name);
      
      // Skip node_modules and .git directories
      if (entry.name === 'node_modules' || entry.name === '.git') continue;
      
      if (entry.isDirectory()) {
        copyDirectoryRecursive(srcPath, destPath);
      } else {
        copyFileSync(srcPath, destPath);
      }
    }
    
    sendProgress(90, 'Cleaning up...');
    
    // Cleanup temp files
    rmSync(tempDir, { recursive: true, force: true });
    
    console.log(`[UPDATE] Updated to v${latestVersion?.version || 'latest'}`);
    
    sendProgress(100, 'Update complete!');
    
    // Signal that update is complete (for dev mode)
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('update:downloaded', { version: latestVersion?.version, isDevMode: true });
    }
    
    return { success: true, needsRestart: true, isDevMode: true };
  } catch (err) {
    console.error('Manual update failed:', err);
    return { success: false, error: err.message };
  }
}

function copyDirectoryRecursive(src, dest) {
  if (!fs.existsSync(src)) return;
  
  if (!fs.existsSync(dest)) {
    mkdirSync(dest, { recursive: true });
  }
  
  const entries = fs.readdirSync(src, { withFileTypes: true });
  
  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    
    if (entry.isDirectory()) {
      copyDirectoryRecursive(srcPath, destPath);
    } else {
      copyFileSync(srcPath, destPath);
    }
  }
}

ipcMain.handle('update:installAndRestart', async () => {
  // Install the downloaded update and restart the app
  if (autoUpdater) {
    autoUpdater.quitAndInstall(false, true);
  } else {
    app.quit();
  }
});

ipcMain.handle('update:exit', async () => {
  // User clicked Exit button after update
  if (app.isPackaged && autoUpdater) {
    if (process.platform === 'darwin') {
      // macOS - just quit, user will drag DMG to Applications manually
      app.quit();
    } else {
      // Windows NSIS install - quit and install the update
      autoUpdater.quitAndInstall(false, true);
    }
  } else {
    // Dev mode - just quit, user will restart manually
    app.quit();
  }
});

ipcMain.handle('update:skip', async () => {
  // User chose to skip - just acknowledge
  return { skipped: true };
});

ipcMain.handle('update:getChangelog', async () => {
  // Load changelog from remote GitHub repo to get new version entries
  try {
    // Add cache-busting parameter to bypass GitHub's CDN cache
    const cacheBuster = Date.now();
    const url = `https://raw.githubusercontent.com/${UPDATE_CONFIG.owner}/${UPDATE_CONFIG.repo}/${getUpdateBranch()}/changelog.json?cb=${cacheBuster}`;
    const response = await httpsGet(url);
    
    if (response.statusCode === 200) {
      return JSON.parse(response.data);
    }
    
    // Fallback to local changelog if remote fetch fails
    console.log('[UPDATE] Remote changelog not available, falling back to local');
    const changelogPath = path.join(__dirname, '..', 'changelog.json');
    if (fs.existsSync(changelogPath)) {
      const data = fs.readFileSync(changelogPath, 'utf8');
      return JSON.parse(data);
    }
    return { versions: [] };
  } catch (err) {
    console.error('[UPDATE] Failed to load changelog:', err);
    return { versions: [] };
  }
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
    if (ffmpegDetected && gpuEncoder === null) {
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
        gpuDetected: gpuEncoder !== null || gpuHardware !== null,
        gpuHardware: gpuHardware,  // Actual GPU name (e.g., "NVIDIA GeForce RTX 4070 Super")
        gpuEncoder: gpuEncoder?.name || null,  // Encoder type (e.g., "NVIDIA NVENC")
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

// Diagnostics storage directory
const diagnosticsDir = path.join(app.getPath('userData'), 'diagnostics');

// Ensure diagnostics directory exists
function ensureDiagnosticsDir() {
  if (!fs.existsSync(diagnosticsDir)) {
    fs.mkdirSync(diagnosticsDir, { recursive: true });
  }
}

// Support server configuration
const SUPPORT_SERVER_URL = 'https://api.sentry-six.com';

// Upload diagnostics to support server (no auth required for upload)
ipcMain.handle('diagnostics:upload', async (_event, _unused, diagnostics) => {
  try {
    ensureDiagnosticsDir();
    
    // Upload to support server
    const supportId = await uploadToSupportServer(diagnostics);
    
    if (supportId) {
      // Save locally with support ID
      diagnostics.supportId = supportId;
      const localPath = path.join(diagnosticsDir, `${supportId}.json`);
      fs.writeFileSync(localPath, JSON.stringify(diagnostics, null, 2));
      
      // Update index
      updateDiagnosticsIndex(supportId, diagnostics);
      
      console.log(`[DIAGNOSTICS] Uploaded with Support ID: ${supportId}`);
      return { success: true, supportId };
    }
    
    throw new Error('Upload returned no support ID');
  } catch (err) {
    console.error('[DIAGNOSTICS] Upload failed:', err.message);
    return { success: false, error: err.message };
  }
});

// Upload to support server (no auth required)
function uploadToSupportServer(diagnostics) {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(SUPPORT_SERVER_URL);
    const payload = JSON.stringify({ data: diagnostics });
    
    const options = {
      hostname: urlObj.hostname,
      port: urlObj.port || (urlObj.protocol === 'https:' ? 443 : 80),
      path: '/upload',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload)
      }
    };

    const httpModule = urlObj.protocol === 'https:' ? https : require('http');
    const req = httpModule.request(options, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        try {
          const result = JSON.parse(body);
          if (res.statusCode === 200 && result.supportId) {
            resolve(result.supportId);
          } else {
            reject(new Error(result.error || `Server error: ${res.statusCode}`));
          }
        } catch (e) {
          reject(new Error('Invalid server response'));
        }
      });
    });

    req.on('error', reject);
    req.setTimeout(15000, () => {
      req.destroy();
      reject(new Error('Upload timeout'));
    });
    req.write(payload);
    req.end();
  });
}

// Update the diagnostics index file
function updateDiagnosticsIndex(supportId, diagnostics) {
  const indexPath = path.join(diagnosticsDir, 'index.json');
  let index = {};
  if (fs.existsSync(indexPath)) {
    try { index = JSON.parse(fs.readFileSync(indexPath, 'utf-8')); } catch {}
  }
  index[supportId] = {
    createdAt: new Date().toISOString(),
    appVersion: diagnostics.appVersion || diagnostics.app?.version,
    os: diagnostics.os || diagnostics.system?.platform
  };
  fs.writeFileSync(indexPath, JSON.stringify(index, null, 2));
}

// Retrieve diagnostics by Support ID (requires passcode to fetch from server)
ipcMain.handle('diagnostics:retrieve', async (_event, supportId, passcode) => {
  try {
    const cleanId = supportId.trim();
    
    if (!passcode || passcode.length !== 4) {
      return { success: false, error: 'Invalid passcode' };
    }
    
    // Check local storage first
    ensureDiagnosticsDir();
    const localPath = path.join(diagnosticsDir, `${cleanId}.json`);
    if (fs.existsSync(localPath)) {
      const data = JSON.parse(fs.readFileSync(localPath, 'utf-8'));
      console.log(`[DIAGNOSTICS] Retrieved from local: ${localPath}`);
      return { success: true, data };
    }
    
    // Fetch from server with passcode
    console.log(`[DIAGNOSTICS] Fetching from server: ${cleanId}`);
    const data = await retrieveFromSupportServer(cleanId, passcode);
    return { success: true, data };
  } catch (err) {
    console.error('[DIAGNOSTICS] Retrieval failed:', err);
    return { success: false, error: err.message };
  }
});

// Retrieve from support server (requires passcode)
function retrieveFromSupportServer(supportId, passcode) {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(SUPPORT_SERVER_URL);
    
    const options = {
      hostname: urlObj.hostname,
      port: urlObj.port || (urlObj.protocol === 'https:' ? 443 : 80),
      path: `/retrieve/${supportId}`,
      method: 'GET',
      headers: {
        'X-Passcode': passcode
      }
    };

    const httpModule = urlObj.protocol === 'https:' ? https : require('http');
    const req = httpModule.request(options, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        try {
          const result = JSON.parse(body);
          if (res.statusCode === 200) {
            resolve(result);
          } else if (res.statusCode === 401) {
            reject(new Error('Invalid passcode'));
          } else if (res.statusCode === 404) {
            reject(new Error('Support ID not found'));
          } else {
            reject(new Error(result.error || `Server error: ${res.statusCode}`));
          }
        } catch (e) {
          reject(new Error('Invalid server response'));
        }
      });
    });

    req.on('error', (e) => reject(new Error(`Connection failed: ${e.message}`)));
    req.setTimeout(15000, () => {
      req.destroy();
      reject(new Error('Request timeout'));
    });
    req.end();
  });
}

// Fetch content from URL (kept for backwards compatibility)
function fetchFromUrl(url) {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const httpModule = urlObj.protocol === 'https:' ? https : require('http');
    const options = {
      hostname: urlObj.hostname,
      port: urlObj.port || (urlObj.protocol === 'https:' ? 443 : 80),
      path: urlObj.pathname,
      method: 'GET'
    };

    const req = httpModule.request(options, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        if (res.statusCode === 200) {
          try {
            resolve(JSON.parse(body));
          } catch {
            reject(new Error('Invalid JSON in paste'));
          }
        } else {
          reject(new Error(`Fetch error: ${res.statusCode}`));
        }
      });
    });

    req.on('error', reject);
    req.setTimeout(10000, () => {
      req.destroy();
      reject(new Error('Fetch timeout'));
    });
    req.end();
  });
}

// Save diagnostics locally (fallback)
ipcMain.handle('diagnostics:saveLocal', async (_event, supportId, diagnostics) => {
  try {
    ensureDiagnosticsDir();
    const localPath = path.join(diagnosticsDir, `${supportId}.json`);
    fs.writeFileSync(localPath, JSON.stringify(diagnostics, null, 2));
    updateDiagnosticsIndex(supportId, diagnostics, null);
    console.log(`[DIAGNOSTICS] Saved locally: ${localPath}`);
    return { success: true, path: localPath };
  } catch (err) {
    console.error('[DIAGNOSTICS] Local save failed:', err);
    return { success: false, error: err.message };
  }
});

// =====================================================
// SUPPORT CHAT SYSTEM
// =====================================================

// Create a new support ticket
ipcMain.handle('support:createTicket', async (_event, data) => {
  try {
    const { message, diagnostics, hasAttachments } = data;
    const payload = JSON.stringify({ message, diagnostics, hasAttachments });
    const result = await makeSupportRequest('POST', '/chat/ticket', payload);
    console.log(`[SUPPORT] Created ticket: ${result.ticketId}`);
    return result;
  } catch (err) {
    console.error('[SUPPORT] Create ticket failed:', err.message);
    return { success: false, error: err.message };
  }
});

// Send a message to an existing ticket
ipcMain.handle('support:sendMessage', async (_event, data) => {
  try {
    const { ticketId, authToken, message, diagnostics } = data;
    const payload = JSON.stringify({ message, diagnostics });
    const result = await makeSupportRequest('POST', `/chat/ticket/${ticketId}/message`, payload, authToken);
    console.log(`[SUPPORT] Sent message to ticket: ${ticketId}`);
    return result;
  } catch (err) {
    console.error('[SUPPORT] Send message failed:', err.message);
    return { success: false, error: err.message };
  }
});

// Upload media attachment for a ticket
ipcMain.handle('support:uploadMedia', async (_event, data) => {
  try {
    const { ticketId, authToken, mediaData, fileName, fileType, fileSize, message, diagnostics } = data;
    const payload = JSON.stringify({ mediaData, fileName, fileType, fileSize, message, diagnostics });
    const result = await makeSupportRequest('POST', `/chat/ticket/${ticketId}/media`, payload, authToken, 180000);
    console.log(`[SUPPORT] Uploaded media to ticket: ${ticketId}`);
    return result;
  } catch (err) {
    console.error('[SUPPORT] Media upload failed:', err.message);
    return { success: false, error: err.message };
  }
});

// Fetch messages for a ticket
ipcMain.handle('support:fetchMessages', async (_event, data) => {
  try {
    const { ticketId, authToken, since } = data;
    const query = since ? `?since=${since}` : '';
    const result = await makeSupportRequest('GET', `/chat/ticket/${ticketId}/messages${query}`, null, authToken);
    return result;
  } catch (err) {
    console.error('[SUPPORT] Fetch messages failed:', err.message);
    return { success: false, error: err.message };
  }
});

// Close a support ticket
ipcMain.handle('support:closeTicket', async (_event, data) => {
  try {
    const { ticketId, authToken, reason } = data;
    const payload = JSON.stringify({ closedBy: 'User', reason });
    const result = await makeSupportRequest('POST', `/chat/ticket/${ticketId}/close`, payload, authToken);
    console.log(`[SUPPORT] Closed ticket: ${ticketId}`);
    return result;
  } catch (err) {
    console.error('[SUPPORT] Close ticket failed:', err.message);
    return { success: false, error: err.message };
  }
});

// Mark support messages as read (triggers Discord :eyes: reaction)
ipcMain.handle('support:markRead', async (_event, data) => {
  try {
    const { ticketId, authToken } = data;
    const result = await makeSupportRequest('POST', `/chat/ticket/${ticketId}/mark-read`, null, authToken);
    if (result.markedRead > 0) {
      console.log(`[SUPPORT] Marked ${result.markedRead} messages as read for ticket: ${ticketId}`);
    }
    return result;
  } catch (err) {
    console.error('[SUPPORT] Mark read failed:', err.message);
    return { success: false, error: err.message };
  }
});

// Helper function to make support server requests
function makeSupportRequest(method, path, payload = null, authToken = null, timeout = 30000) {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(SUPPORT_SERVER_URL);
    
    const headers = {
      'Content-Type': 'application/json'
    };
    
    if (payload) {
      headers['Content-Length'] = Buffer.byteLength(payload);
    }
    
    if (authToken) {
      headers['X-Auth-Token'] = authToken;
    }
    
    const options = {
      hostname: urlObj.hostname,
      port: urlObj.port || (urlObj.protocol === 'https:' ? 443 : 80),
      path: path,
      method: method,
      headers: headers
    };

    const httpModule = urlObj.protocol === 'https:' ? https : require('http');
    const req = httpModule.request(options, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        try {
          const result = JSON.parse(body);
          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve(result);
          } else {
            reject(new Error(result.error || `Server error: ${res.statusCode}`));
          }
        } catch (e) {
          reject(new Error('Invalid server response'));
        }
      });
    });

    req.on('error', reject);
    req.setTimeout(timeout, () => {
      req.destroy();
      reject(new Error('Request timeout'));
    });
    
    if (payload) {
      req.write(payload);
    }
    req.end();
  });
}

