const { app, BrowserWindow, dialog, ipcMain, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn, spawnSync, execSync } = require('child_process');
const https = require('https');
const { createWriteStream, mkdirSync, rmSync, copyFileSync } = require('fs');

// Auto-Update Configuration
const UPDATE_CONFIG = {
  owner: 'ChadR23',
  repo: 'Sentry-Six',
  defaultBranch: 'main',
  versionFile: path.join(app.getPath('userData'), 'current-version.json')
};

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

  console.log('[SEARCH] Searching for FFmpeg in:', paths);

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
function detectGpuEncoder(ffmpegPath) {
  if (gpuEncoder !== null) return gpuEncoder;
  
  try {
    // Query FFmpeg for available hardware accelerators and encoders
    const hwaccelResult = spawnSync(ffmpegPath, ['-hwaccels'], { timeout: 3000, windowsHide: true });
    const hwaccelsOutput = (hwaccelResult.stdout?.toString() || '') + (hwaccelResult.stderr?.toString() || '');
    
    const encoderResult = spawnSync(ffmpegPath, ['-encoders'], { timeout: 5000, windowsHide: true });
    const encoderOutput = encoderResult.stdout?.toString() || '';
    
    /**
     * Tests if a GPU encoder can actually access hardware.
     * FFmpeg may list encoders that aren't usable (e.g., NVENC listed but no NVIDIA GPU).
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
        
        // Test encoder with minimal encode to verify hardware access
        let testArgs = ['-hide_banner', '-f', 'lavfi', '-i', 'color=c=black:s=2x2:d=0.01:r=1'];
        
        // Add hardware acceleration hints for Windows (improves detection accuracy)
        if (process.platform === 'win32') {
          if (codec === 'h264_amf' && hwaccelsOutput.includes('d3d11va')) {
            testArgs.push('-hwaccel', 'd3d11va');
          } else if (codec === 'h264_nvenc' && hwaccelsOutput.includes('cuda')) {
            testArgs.push('-hwaccel', 'cuda');
          } else if (codec === 'h264_qsv' && hwaccelsOutput.includes('qsv')) {
            testArgs.push('-hwaccel', 'qsv');
          }
        }
        
        testArgs.push('-c:v', codec, '-frames:v', '1', '-f', 'null', '-');
        
        const testResult = spawnSync(ffmpegPath, testArgs, { 
          timeout: 3000,
          windowsHide: true,
          stdio: 'pipe'
        });
        
        const testOutput = (testResult.stdout?.toString() || '') + (testResult.stderr?.toString() || '');
        
        // Log first few lines of test output for debugging
        if (testOutput.length > 0) {
          const shortOutput = testOutput.split('\n').slice(0, 5).join(' ').substring(0, 200);
          console.log(`  Test output: ${shortOutput}...`);
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
          'No hardware device found'
        ];
        
        for (const error of fatalErrors) {
          if (testOutput.toLowerCase().includes(error.toLowerCase())) {
            return false;
          }
        }
        
        // Invalid argument errors related to encoder indicate hardware unavailable
        if (testOutput.includes('Invalid argument') && 
            (testOutput.includes('encoder') || testOutput.includes(codec))) {
          return false;
        }
        
        // Success: encoder initialized and encoded at least one frame
        if (testResult.status === 0) {
          return true;
        }
        
        // Partial success: saw encoding output but non-zero status (may be test-specific)
        if (testOutput.includes('frame=') || 
            testOutput.includes('Stream #') ||
            testOutput.includes('Video:') ||
            testOutput.includes('encoder')) {
          return true;
        }
        
        // Hardware-specific error in task failure
        if (testOutput.includes('Task finished with error') && 
            testOutput.includes(codec) &&
            (testOutput.includes('device') || testOutput.includes('hardware'))) {
          return false;
        }
        
        // Default: encoder exists and no hardware errors detected
        // Actual export will handle any remaining issues
        return true;
      } catch (err) {
        return false;
      }
    };
    
    // Define encoder priority by platform
    // Windows: Detect actual GPU vendor and prioritize matching encoder
    const encodersToCheck = [];
    
    if (process.platform === 'darwin') {
      encodersToCheck.push({ codec: 'h264_videotoolbox', name: 'Apple VideoToolbox' });
    } else if (process.platform === 'win32') {
      // Detect actual GPU vendor by checking vendor-specific hardware acceleration
      // CUDA is NVIDIA-specific, QSV is Intel-specific, AMF is AMD-specific
      const hasCUDA = hwaccelsOutput.includes('cuda');
      const hasQSV = hwaccelsOutput.includes('qsv');
      const hasD3D11 = hwaccelsOutput.includes('d3d11va');
      
      // Prioritize based on actual GPU vendor detection
      // NVIDIA: CUDA available -> prioritize NVENC
      // Intel: QSV available -> prioritize QuickSync
      // AMD: D3D11 available but no CUDA/QSV -> prioritize AMF
      // Otherwise: test all in order
      if (hasCUDA) {
        // NVIDIA GPU detected
        encodersToCheck.push(
          { codec: 'h264_nvenc', name: 'NVIDIA NVENC', priority: 1 },
          { codec: 'h264_qsv', name: 'Intel QuickSync', priority: 2 },
          { codec: 'h264_amf', name: 'AMD AMF', priority: 3 }
        );
      } else if (hasQSV) {
        // Intel GPU detected
        encodersToCheck.push(
          { codec: 'h264_qsv', name: 'Intel QuickSync', priority: 1 },
          { codec: 'h264_nvenc', name: 'NVIDIA NVENC', priority: 2 },
          { codec: 'h264_amf', name: 'AMD AMF', priority: 3 }
        );
      } else if (hasD3D11) {
        // D3D11 available but no vendor-specific detection - likely AMD or unknown
        // Test AMF first, then others
        encodersToCheck.push(
          { codec: 'h264_amf', name: 'AMD AMF', priority: 1 },
          { codec: 'h264_nvenc', name: 'NVIDIA NVENC', priority: 2 },
          { codec: 'h264_qsv', name: 'Intel QuickSync', priority: 3 }
        );
      } else {
        // No specific detection - test all in default order
        encodersToCheck.push(
          { codec: 'h264_nvenc', name: 'NVIDIA NVENC', priority: 1 },
          { codec: 'h264_amf', name: 'AMD AMF', priority: 2 },
          { codec: 'h264_qsv', name: 'Intel QuickSync', priority: 3 }
        );
      }
    } else {
      encodersToCheck.push(
        { codec: 'h264_nvenc', name: 'NVIDIA NVENC' },
        { codec: 'h264_amf', name: 'AMD AMF' },
        { codec: 'h264_qsv', name: 'Intel QuickSync' }
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
    // Query FFmpeg for available hardware accelerators and encoders
    const hwaccelResult = spawnSync(ffmpegPath, ['-hwaccels'], { timeout: 3000, windowsHide: true });
    const hwaccelsOutput = (hwaccelResult.stdout?.toString() || '') + (hwaccelResult.stderr?.toString() || '');
    
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
        
        // Build test args with hardware acceleration hints (like H.264 detection)
        let testArgs = ['-hide_banner', '-f', 'lavfi', '-i', 'color=c=black:s=2x2:d=0.01:r=1'];
        
        // Add hardware acceleration hints for Windows
        if (process.platform === 'win32') {
          if (codec === 'hevc_nvenc' && hwaccelsOutput.includes('cuda')) {
            testArgs.push('-hwaccel', 'cuda');
          } else if (codec === 'hevc_amf' && hwaccelsOutput.includes('d3d11va')) {
            testArgs.push('-hwaccel', 'd3d11va');
          } else if (codec === 'hevc_qsv' && hwaccelsOutput.includes('qsv')) {
            testArgs.push('-hwaccel', 'qsv');
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
        const fatalErrors = ['No such device', 'Could not open encoder', 'Failed to create', 'Cannot load', 
                            'Device creation failed', 'No capable devices', 'No device available', 'No hardware device'];
        for (const error of fatalErrors) {
          if (testOutput.toLowerCase().includes(error.toLowerCase())) {
            console.log(`  ${codec}: Fatal error - ${error}`);
            return false;
          }
        }
        
        // Success if status is 0 or we see encoding output
        if (testResult.status === 0) return true;
        if (testOutput.includes('frame=') || testOutput.includes('Stream #') || testOutput.includes('Video:')) return true;
        
        return false;
      } catch (err) { 
        console.log(`  ${codec}: Exception - ${err.message}`);
        return false; 
      }
    };
    
    // HEVC encoders by platform - prioritize based on detected hardware
    const hevcEncoders = [];
    if (process.platform === 'darwin') {
      hevcEncoders.push({ codec: 'hevc_videotoolbox', name: 'Apple VideoToolbox HEVC', maxRes: 8192 });
    } else if (process.platform === 'win32') {
      // Prioritize based on detected hardware acceleration
      const hasCUDA = hwaccelsOutput.includes('cuda');
      const hasQSV = hwaccelsOutput.includes('qsv');
      const hasD3D11 = hwaccelsOutput.includes('d3d11va');
      
      if (hasCUDA) {
        hevcEncoders.push({ codec: 'hevc_nvenc', name: 'NVIDIA NVENC HEVC', maxRes: 8192, priority: 1 });
        hevcEncoders.push({ codec: 'hevc_qsv', name: 'Intel QuickSync HEVC', maxRes: 8192, priority: 2 });
        hevcEncoders.push({ codec: 'hevc_amf', name: 'AMD AMF HEVC', maxRes: 8192, priority: 3 });
      } else if (hasQSV) {
        hevcEncoders.push({ codec: 'hevc_qsv', name: 'Intel QuickSync HEVC', maxRes: 8192, priority: 1 });
        hevcEncoders.push({ codec: 'hevc_nvenc', name: 'NVIDIA NVENC HEVC', maxRes: 8192, priority: 2 });
        hevcEncoders.push({ codec: 'hevc_amf', name: 'AMD AMF HEVC', maxRes: 8192, priority: 3 });
      } else if (hasD3D11) {
        hevcEncoders.push({ codec: 'hevc_amf', name: 'AMD AMF HEVC', maxRes: 8192, priority: 1 });
        hevcEncoders.push({ codec: 'hevc_nvenc', name: 'NVIDIA NVENC HEVC', maxRes: 8192, priority: 2 });
        hevcEncoders.push({ codec: 'hevc_qsv', name: 'Intel QuickSync HEVC', maxRes: 8192, priority: 3 });
      } else {
        hevcEncoders.push({ codec: 'hevc_nvenc', name: 'NVIDIA NVENC HEVC', maxRes: 8192, priority: 1 });
        hevcEncoders.push({ codec: 'hevc_amf', name: 'AMD AMF HEVC', maxRes: 8192, priority: 2 });
        hevcEncoders.push({ codec: 'hevc_qsv', name: 'Intel QuickSync HEVC', maxRes: 8192, priority: 3 });
      }
      hevcEncoders.sort((a, b) => (a.priority || 999) - (b.priority || 999));
    } else {
      hevcEncoders.push(
        { codec: 'hevc_nvenc', name: 'NVIDIA NVENC HEVC', maxRes: 8192 },
        { codec: 'hevc_amf', name: 'AMD AMF HEVC', maxRes: 8192 },
        { codec: 'hevc_qsv', name: 'Intel QuickSync HEVC', maxRes: 8192 }
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

// Create a hidden BrowserWindow for dashboard rendering
async function createDashboardRenderer(dashboardWidth, dashboardHeight) {
  return new Promise((resolve, reject) => {
    const dashboardWindow = new BrowserWindow({
      width: dashboardWidth,
      height: dashboardHeight,
      show: false,
      transparent: true,
      frame: false,
      webPreferences: {
        nodeIntegration: true,
        contextIsolation: false,
        webSecurity: false
      }
    });
    
    // Try multiple possible paths for the dashboard renderer
    const possiblePaths = [
      path.join(__dirname, 'renderer', 'dashboard-renderer.html'),
      path.join(app.getAppPath(), 'src', 'renderer', 'dashboard-renderer.html'),
      path.join(process.resourcesPath || __dirname, 'src', 'renderer', 'dashboard-renderer.html')
    ];
    
    let dashboardPath = null;
    for (const testPath of possiblePaths) {
      if (fs.existsSync(testPath)) {
        dashboardPath = testPath;
        break;
      }
    }
    
    if (!dashboardPath) {
      console.error('Dashboard renderer HTML not found. Tried:', possiblePaths);
      dashboardWindow.close();
      reject(new Error('Dashboard renderer HTML file not found'));
      return;
    }
    
    console.log('Loading dashboard renderer from:', dashboardPath);
    
    // Enable console logging for debugging
    dashboardWindow.webContents.on('console-message', (event, level, message) => {
      console.log(`[Dashboard Renderer] ${message}`);
    });
    
    // Set up error handlers
    dashboardWindow.webContents.once('did-fail-load', (event, errorCode, errorDescription, validatedURL, isMainFrame) => {
      if (isMainFrame) {
        console.error('Dashboard renderer failed to load:', errorCode, errorDescription, validatedURL);
        clearTimeout(timeout);
        dashboardWindow.close();
        reject(new Error(`Failed to load dashboard: ${errorDescription} (code: ${errorCode})`));
      }
    });
    
    // Wait for window to be ready with timeout
    const timeout = setTimeout(() => {
      console.error('Dashboard renderer timeout - taking too long to load');
      dashboardWindow.close();
      reject(new Error('Dashboard renderer initialization timeout (10s)'));
    }, 10000); // 10 second timeout
    
    dashboardWindow.webContents.once('did-finish-load', () => {
      clearTimeout(timeout);
      console.log('Dashboard renderer loaded successfully');
      
      // Wait a bit more for rendering and DOM to be ready, then resolve
      setTimeout(() => {
        console.log('Dashboard renderer ready for use');
        resolve(dashboardWindow);
      }, 800);
    });
    
    // Load the file
    console.log('Attempting to load dashboard file:', dashboardPath);
    dashboardWindow.loadFile(dashboardPath).catch(err => {
      clearTimeout(timeout);
      console.error('Error loading dashboard file:', err);
      dashboardWindow.close();
      reject(err);
    });
  });
}

// Store active dashboard renderers and their ready callbacks
const dashboardReadyCallbacks = new Map();

// IPC handler for dashboard ready signals
ipcMain.on('dashboard:ready', (event) => {
  const webContentsId = event.sender.id;
  const callback = dashboardReadyCallbacks.get(webContentsId);
  if (callback) {
    dashboardReadyCallbacks.delete(webContentsId);
    callback();
  }
});

// Base dashboard dimensions (reference for scaling)
const BASE_DASHBOARD_WIDTH = 600;
const BASE_DASHBOARD_HEIGHT = 250;
const DASHBOARD_ASPECT_RATIO = BASE_DASHBOARD_WIDTH / BASE_DASHBOARD_HEIGHT; // 2.4:1

// Calculate dashboard size based on output video dimensions and size preference
function calculateDashboardSize(outputWidth, outputHeight, sizeOption = 'medium') {
  // Size options: small (20%), medium (30%), large (40%)
  const sizeMultipliers = {
    'small': 0.20,
    'medium': 0.30,
    'large': 0.40
  };
  const multiplier = sizeMultipliers[sizeOption] || 0.30;
  
  const targetWidth = Math.round(outputWidth * multiplier);
  const targetHeight = Math.round(targetWidth / DASHBOARD_ASPECT_RATIO);
  // Ensure even dimensions (required for video encoding)
  return {
    width: targetWidth + (targetWidth % 2),
    height: targetHeight + (targetHeight % 2)
  };
}

async function renderDashboardFrame(dashboardWindow, sei, frameNumber, dashboardWidth, dashboardHeight, useMetric = false) {
  return new Promise((resolve) => {
    const webContents = dashboardWindow.webContents;
    const webContentsId = webContents.id;
    let resolved = false;
    
    // IPC callback: dashboard signals ready after DOM updates are painted
    const onReady = () => {
      if (resolved) return;
      resolved = true;
      // Reduced delay: 16ms (one frame) is sufficient for DOM paint to complete
      // Previous 100ms was excessive and caused major slowdown
      setTimeout(() => {
        webContents.capturePage({
          x: 0, y: 0,
          width: dashboardWidth,
          height: dashboardHeight
        }).then(image => {
          resolve(image);
        }).catch(() => {
          resolve(null);
        });
      }, 16);
    };
    
    dashboardReadyCallbacks.set(webContentsId, onReady);
    webContents.send('dashboard:update', sei, frameNumber, useMetric);
    
    // Fallback timeout if IPC doesn't work (reduced from 1000ms to 200ms)
    setTimeout(() => {
      if (!resolved) {
        resolved = true;
        dashboardReadyCallbacks.delete(webContentsId);
        webContents.capturePage({
          x: 0, y: 0,
          width: dashboardWidth,
          height: dashboardHeight
        }).then(image => {
          resolve(image);
        }).catch(() => resolve(null));
      }
    }, 200);
  });
}

/**
 * Convert NativeImage to RGBA buffer, reusing provided buffer to prevent memory leaks.
 * IMPORTANT: This function modifies the provided outputBuffer in-place.
 * @param {NativeImage} image - Electron NativeImage from capturePage
 * @param {number} width - Target width
 * @param {number} height - Target height  
 * @param {Buffer} outputBuffer - Pre-allocated buffer to write RGBA data into (must be width*height*4 bytes)
 * @returns {boolean} - true if successful, false if failed
 */
function imageToRGBA(image, width, height, outputBuffer) {
  try {
    const size = image.getSize();
    let bitmap;
    
    if (size.width !== width || size.height !== height) {
      // Resize creates a new NativeImage - get bitmap then let it be GC'd
      const resized = image.resize({ width, height });
      bitmap = resized.toBitmap();
      // resized will be GC'd when this scope exits
    } else {
      bitmap = image.toBitmap();
    }
    
    // NativeImage.toBitmap() returns BGRA on Windows, RGBA on macOS/Linux
    // FFmpeg requires RGBA, so we swap R and B channels on Windows
    const expectedSize = width * height * 4;
    
    if (bitmap.length < expectedSize || outputBuffer.length < expectedSize) {
      console.warn(`Buffer size mismatch: bitmap=${bitmap.length}, output=${outputBuffer.length}, expected=${expectedSize}`);
      return false;
    }
    
    if (process.platform === 'win32') {
      // Convert BGRA to RGBA on Windows - write directly to output buffer
      for (let i = 0; i < expectedSize; i += 4) {
        outputBuffer[i] = bitmap[i + 2];     // R
        outputBuffer[i + 1] = bitmap[i + 1]; // G
        outputBuffer[i + 2] = bitmap[i];     // B
        outputBuffer[i + 3] = bitmap[i + 3]; // A
      }
    } else {
      bitmap.copy(outputBuffer, 0, 0, expectedSize);
    }
    
    // bitmap buffer will be GC'd when this function returns
    return true;
  } catch (err) {
    console.error('imageToRGBA error:', err.message);
    return false;
  }
}

// Pre-render dashboard to temp video (prevents memory leak)
async function preRenderDashboard(event, exportId, ffmpegPath, seiData, startTimeMs, durationSec, dashboardWidth, dashboardHeight, useMetric, sendDashboardProgress) {
  const FPS = 36;
  const totalFrames = Math.ceil(durationSec * FPS);
  const frameTimeMs = 1000 / FPS;
  const frameSize = dashboardWidth * dashboardHeight * 4;
  
  // Create temp file for dashboard video
  // Use .mov container with qtrle codec for proper RGBA alpha support
  const tempDashPath = path.join(os.tmpdir(), `dashboard_${exportId}_${Date.now()}.mov`);
  
  console.log(`[DASHBOARD] Pre-rendering ${totalFrames} frames to ${tempDashPath}`);
  sendDashboardProgress(0, 'Pre-rendering dashboard overlay...');
  
  // Create dashboard renderer window
  const dashboardWindow = await createDashboardRenderer(dashboardWidth, dashboardHeight);
  
  try {
    // Spawn FFmpeg to encode dashboard frames to temp video
    // Use qtrle (QuickTime Animation) codec which properly supports RGBA with alpha
    // H.264/libx264 does NOT support alpha channels - transparent areas become black
    const dashArgs = [
      '-f', 'rawvideo',
      '-pixel_format', 'rgba',
      '-video_size', `${dashboardWidth}x${dashboardHeight}`,
      '-framerate', FPS.toString(),
      '-i', 'pipe:0',
      '-c:v', 'qtrle',        // QuickTime Animation - supports RGBA with alpha
      '-pix_fmt', 'argb',     // ARGB format for proper alpha
      '-y',
      tempDashPath
    ];
    console.log(`[DASHBOARD] FFmpeg command: ${ffmpegPath} ${dashArgs.join(' ')}`);
    console.log(`[DASHBOARD] Temp directory: ${os.tmpdir()}`);
    
    const dashProc = spawn(ffmpegPath, dashArgs, { stdio: ['pipe', 'pipe', 'pipe'] });
    
    // Consume stdout/stderr to prevent buffer deadlock
    let ffmpegStderr = '';
    dashProc.stdout.on('data', () => {}); // Drain stdout
    dashProc.stderr.on('data', (data) => {
      ffmpegStderr += data.toString();
      // Keep only last 2KB to avoid memory issues
      if (ffmpegStderr.length > 2048) {
        ffmpegStderr = ffmpegStderr.slice(-2048);
      }
    });
    
    const dashPipe = dashProc.stdin;
    
    // Pre-allocate reusable buffers
    const blackFrame = Buffer.alloc(frameSize, 0);
    const frameBuffer = Buffer.alloc(frameSize);
    
    // Track drain state for backpressure
    let drainResolve = null;
    dashPipe.on('drain', () => {
      if (drainResolve) {
        const resolve = drainResolve;
        drainResolve = null;
        resolve();
      }
    });
    
    dashPipe.on('error', (err) => {
      if (err.code !== 'EPIPE') console.error('Dashboard pipe error:', err.message);
    });
    
    // Render all frames
    for (let frame = 0; frame < totalFrames; frame++) {
      // Check for cancellation
      if (cancelledExports.has(exportId)) {
        console.log('Dashboard pre-render cancelled');
        dashPipe.end();
        dashProc.kill();
        dashboardWindow.close();
        try { fs.unlinkSync(tempDashPath); } catch {}
        throw new Error('Export cancelled');
      }
      
      const currentTimeMs = startTimeMs + (frame * frameTimeMs);
      const sei = findSeiAtTime(seiData, currentTimeMs);
      const image = await renderDashboardFrame(dashboardWindow, sei, frame, dashboardWidth, dashboardHeight, useMetric);
      
      let frameData = blackFrame;
      if (image) {
        const success = imageToRGBA(image, dashboardWidth, dashboardHeight, frameBuffer);
        if (success) frameData = frameBuffer;
      }
      
      // Write with backpressure
      const canContinue = dashPipe.write(frameData);
      if (!canContinue) {
        await new Promise(resolve => {
          drainResolve = resolve;
          setTimeout(resolve, 5000); // Safety timeout
        });
      }
      
      // Progress update
      if (frame % 50 === 0) {
        const pct = Math.floor((frame / totalFrames) * 100);
        sendDashboardProgress(pct, `Pre-rendering dashboard... ${pct}%`);
      }
    }
    
    // Close pipe and wait for FFmpeg to finish
    console.log(`[DASHBOARD] All ${totalFrames} frames written, closing pipe...`);
    dashPipe.end();
    
    console.log('[DASHBOARD] Waiting for FFmpeg to finish encoding...');
    await new Promise((resolve, reject) => {
      // Add timeout to detect hangs
      const ffmpegTimeout = setTimeout(() => {
        console.error('[DASHBOARD] FFmpeg timeout after 60s waiting for close');
        console.error('[DASHBOARD] FFmpeg stderr:', ffmpegStderr);
        dashProc.kill('SIGKILL');
        reject(new Error('Dashboard FFmpeg timed out after 60 seconds. Check temp directory permissions.'));
      }, 60000);
      
      dashProc.on('close', (code) => {
        clearTimeout(ffmpegTimeout);
        console.log(`[DASHBOARD] FFmpeg closed with code ${code}`);
        if (code !== 0) {
          console.error('[DASHBOARD] FFmpeg stderr:', ffmpegStderr);
        }
        if (code === 0) resolve();
        else reject(new Error(`Dashboard encoding failed with code ${code}: ${ffmpegStderr.slice(-500)}`));
      });
      dashProc.on('error', (err) => {
        clearTimeout(ffmpegTimeout);
        console.error('[DASHBOARD] FFmpeg error:', err);
        reject(err);
      });
    });
    
    sendDashboardProgress(100, 'Dashboard pre-render complete');
    console.log(`[DASHBOARD] Pre-render complete: ${tempDashPath}`);
    
    return tempDashPath;
  } finally {
    if (dashboardWindow && !dashboardWindow.isDestroyed()) {
      dashboardWindow.close();
    }
  }
}

// Video Export Implementation
async function performVideoExport(event, exportId, exportData, ffmpegPath) {
  const { segments, startTimeMs, endTimeMs, outputPath, cameras, mobileExport, quality, includeDashboard, seiData, layoutData, useMetric, dashboardPosition = 'bottom-center', dashboardSize = 'medium' } = exportData;
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

    sendProgress(5, 'Building export...');

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
        
        // Calculate dashboard size based on output resolution and user's size preference
        const dashboardSizeCalc = calculateDashboardSize(totalW, totalH, dashboardSize);
        const dashboardWidth = dashboardSizeCalc.width;
        const dashboardHeight = dashboardSizeCalc.height;
        
        // Flag to track if dashboard should be included in final export
        let useDashboard = false;

        if (includeDashboard && seiData && seiData.length > 0) {
          // Check for cancellation before starting dashboard pre-render
          if (cancelledExports.has(exportId)) {
            console.log('Export cancelled before dashboard pre-render');
            throw new Error('Export cancelled');
          }
          
          try {
            // PRE-RENDER DASHBOARD TO TEMP FILE
            // This prevents the massive memory leak caused by FFmpeg buffering
            // frames while waiting for pipe input to sync with video inputs
            dashboardTempPath = await preRenderDashboard(
              event, exportId, ffmpegPath, seiData, startTimeMs, durationSec,
              dashboardWidth, dashboardHeight, useMetric, sendDashboardProgress
            );
            tempFiles.push(dashboardTempPath);
            useDashboard = true;
            
            // Add pre-rendered dashboard video as input (regular file, not pipe)
            cmd.push('-i', dashboardTempPath);
            
            console.log(`[DASHBOARD] Using pre-rendered dashboard: ${dashboardTempPath}`);
          } catch (err) {
            // If cancelled, re-throw to stop the export
            if (err.message === 'Export cancelled' || cancelledExports.has(exportId)) {
              throw err;
            }
            sendDashboardProgress(0, `Dashboard pre-render failed: ${err.message}. Continuing without overlay...`);
            dashboardTempPath = null;
            useDashboard = false;
          }
        }
        
        // Check for cancellation after dashboard setup, before building filters
        if (cancelledExports.has(exportId)) {
          console.log('Export cancelled before building filters');
          throw new Error('Export cancelled');
        }

    const filters = [];
    const streamTags = [];

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
        cameraStreams.push({ tag: `[v${i}]`, x, y });
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
        streamTags.push(`[v${i}]`);
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

    // Add dashboard overlay if enabled, otherwise ensure proper pixel format
    if (useDashboard) {
      // Calculate overlay position based on user preference
      // W = main video width, H = main video height, w = overlay width, h = overlay height
      const padding = 20; // Padding from edges
      const positionExprs = {
        'bottom-center': `(W-w)/2:H-h-${padding}`,
        'bottom-left': `${padding}:H-h-${padding}`,
        'bottom-right': `W-w-${padding}:H-h-${padding}`,
        'top-center': `(W-w)/2:${padding}`,
        'top-left': `${padding}:${padding}`,
        'top-right': `W-w-${padding}:${padding}`
      };
      const overlayPos = positionExprs[dashboardPosition] || positionExprs['bottom-center'];
      
      // Dashboard is now a pre-rendered video file with alpha, no sync issues
      filters.push(`[grid][${dashboardInputIdx}:v]overlay=${overlayPos}:format=auto[out]`);
      console.log(`[DASHBOARD] Overlay position: ${dashboardPosition} -> ${overlayPos}`);
    } else {
      filters.push(`[grid]format=yuv420p[out]`);
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
        // Apple VideoToolbox: Quality scale inverted (higher = better)
        cmd.push('-q:v', Math.max(40, 100 - crf * 2).toString());
        cmd.push('-g', (FPS * 2).toString());
      } else if (activeEncoder.codec === 'h264_qsv' || activeEncoder.codec === 'hevc_qsv') {
        // Intel QuickSync: CQP mode
        const qsvQp = Math.max(18, Math.min(46, crf));
        cmd.push('-preset', 'balanced');
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
    cmd.push('-pix_fmt', 'yuv420p');
    
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
    
    sendProgress(8, useGpu ? `Exporting with ${activeEncoder.name}...` : 'Exporting with CPU...');

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
            sendProgress(pct, `Exporting... ${pct}%`);
          }
        }
      });

      proc.on('close', (code) => {
        delete activeExports[exportId];
        cancelledExports.delete(exportId); // Clean up cancellation flag
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
      message: 'Export cancelled'
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
 * Get the current installed version from local version.json
 * @returns {Object|null} Version info or null if not found
 */
function getCurrentVersion() {
  try {
    // First check the app's version.json (source of truth)
    const localVersionPath = path.join(__dirname, '..', 'version.json');
    if (fs.existsSync(localVersionPath)) {
      const data = JSON.parse(fs.readFileSync(localVersionPath, 'utf8'));
      return data;
    }
  } catch (err) {
    console.error('Error reading local version file:', err);
  }
  return null;
}

/**
 * Compare two semantic version strings
 * @param {string} v1 - First version
 * @param {string} v2 - Second version
 * @returns {number} -1 if v1 < v2, 0 if equal, 1 if v1 > v2
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
 * Fetch the latest version.json from GitHub
 * @returns {Object|null} Latest version info or null if not found
 */
async function getLatestVersion() {
  // Add cache-busting parameter to bypass GitHub's CDN cache (which can be 5+ minutes stale)
  const cacheBuster = Date.now();
  const url = `https://raw.githubusercontent.com/${UPDATE_CONFIG.owner}/${UPDATE_CONFIG.repo}/${getUpdateBranch()}/version.json?cb=${cacheBuster}`;
  const response = await httpsGet(url);
  
  if (response.statusCode === 404) {
    // version.json not yet pushed to repo - this is expected for initial setup
    console.log('[UPDATE] Remote version.json not found (not yet pushed to repo)');
    return null;
  }
  
  if (response.statusCode !== 200) {
    throw new Error(`Failed to fetch version.json: ${response.statusCode}`);
  }
  
  return JSON.parse(response.data);
}

/**
 * Check for updates on startup
 */
async function checkForUpdatesOnStartup() {
  try {
    console.log('[UPDATE] Checking for updates...');
    const latestVersion = await getLatestVersion();
    const currentVersion = getCurrentVersion();
    
    // If remote version.json doesn't exist yet, skip update check
    if (!latestVersion) {
      console.log('[UPDATE] No remote version available - skipping update check');
      return;
    }
    
    const currentVer = currentVersion?.version || '0.0.0';
    const latestVer = latestVersion?.version || '0.0.0';
    
    console.log(`[UPDATE] Current: v${currentVer}`);
    console.log(`[UPDATE] Latest: v${latestVer}`);
    
    if (compareVersions(currentVer, latestVer) < 0) {
      // New version available - notify renderer
      console.log('[UPDATE] New version available!');
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('update:available', {
          currentVersion: currentVer,
          latestVersion: latestVer,
          releaseName: latestVersion.releaseName || 'New Update',
          releaseDate: latestVersion.releaseDate
        });
      }
    } else {
      console.log('[UPDATE] App is up to date');
    }
  } catch (err) {
    console.error('[UPDATE] Check failed:', err.message);
  }
}

async function performUpdate(event) {
  const sendProgress = (percentage, message) => {
    event.sender.send('update:progress', { percentage, message });
  };
  
  try {
    sendProgress(5, 'Fetching latest version info...');
    const latestVersion = await getLatestVersion();
    
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
    
    // version.json is already copied from the downloaded repo
    console.log(`[UPDATE] Updated to v${latestVersion.version}`);
    
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

ipcMain.handle('update:bypass', async () => {
  // Hidden dev feature - update local version.json to match remote
  try {
    const latestVersion = await getLatestVersion();
    const localVersionPath = path.join(__dirname, '..', 'version.json');
    fs.writeFileSync(localVersionPath, JSON.stringify(latestVersion, null, 2));
    console.log('[DEV] Update bypassed - version set to:', latestVersion.version);
    return { success: true, version: latestVersion.version };
  } catch (err) {
    console.error('Bypass update error:', err);
    return { success: false, error: err.message };
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
  try {
    const latestVersion = await getLatestVersion();
    const localVersionPath = path.join(__dirname, '..', 'version.json');
    fs.writeFileSync(localVersionPath, JSON.stringify(latestVersion, null, 2));
    console.log('[DEV] Version forced to latest:', latestVersion.version);
    return { success: true, version: latestVersion.version };
  } catch (err) {
    console.error('Force latest version error:', err);
    return { success: false, error: err.message };
  }
});

ipcMain.handle('dev:setOldVersion', async () => {
  // Set version to 0.0.1 to trigger update prompt
  try {
    const localVersionPath = path.join(__dirname, '..', 'version.json');
    const oldVersion = {
      version: '0.0.1',
      releaseDate: '2020-01-01',
      releaseName: 'Test Old Version'
    };
    fs.writeFileSync(localVersionPath, JSON.stringify(oldVersion, null, 2));
    console.log('[DEV] Version set to 0.0.1 (will trigger update)');
    return { success: true, version: '0.0.1' };
  } catch (err) {
    console.error('Set old version error:', err);
    return { success: false, error: err.message };
  }
});

ipcMain.handle('dev:getCurrentVersion', async () => {
  const version = getCurrentVersion();
  return version || { version: 'unknown' };
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

// Diagnostics & Support ID IPC Handlers
// Main process log buffer
const mainLogBuffer = [];
const MAX_MAIN_LOG_ENTRIES = 200;

// Intercept console in main process to capture logs
const originalMainConsole = {
  log: console.log.bind(console),
  warn: console.warn.bind(console),
  error: console.error.bind(console)
};

function captureMainLog(level, args) {
  const entry = {
    t: Date.now(),
    l: level,
    m: args.map(arg => {
      try {
        if (typeof arg === 'object') {
          return JSON.stringify(arg, null, 0).substring(0, 500);
        }
        return String(arg).substring(0, 500);
      } catch {
        return '[Unserializable]';
      }
    }).join(' ')
  };
  mainLogBuffer.push(entry);
  if (mainLogBuffer.length > MAX_MAIN_LOG_ENTRIES) {
    mainLogBuffer.shift();
  }
}

// Override console methods in main process
console.log = (...args) => {
  captureMainLog('log', args);
  originalMainConsole.log(...args);
};
console.warn = (...args) => {
  captureMainLog('warn', args);
  originalMainConsole.warn(...args);
};
console.error = (...args) => {
  captureMainLog('error', args);
  originalMainConsole.error(...args);
};

ipcMain.handle('diagnostics:get', async () => {
  try {
    const currentVersion = getCurrentVersion();
    
    // Check for pending update
    let pendingUpdate = false;
    try {
      const latestVersion = await getLatestVersion();
      if (latestVersion && currentVersion) {
        pendingUpdate = latestVersion.version !== currentVersion.version;
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
    
    return {
      os: getOSName(),
      appVersion: currentVersion?.version || 'unknown',
      pendingUpdate,
      hardware: {
        cpuModel: os.cpus()[0]?.model || 'unknown',
        ramTotal: os.totalmem(),
        ramFree: os.freemem(),
        gpuDetected: gpuEncoder !== null,
        gpuModel: gpuEncoder?.name || null,
        ffmpegDetected
      },
      logs: mainLogBuffer.slice() // All main process logs (up to 200)
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
const SUPPORT_SERVER_URL = 'http://51.79.71.202:3847';

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

