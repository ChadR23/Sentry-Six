const { app } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawnSync } = require('child_process');

// Cached GPU encoder detection
let gpuEncoder = null;
let gpuEncoderHEVC = null;
let cachedGpuHardware = undefined; // undefined = not checked, null = checked but not found

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
      const isMacLocal = process.platform === 'darwin';
      const result = spawnSync(p, ['-version'], { 
        timeout: 5000, 
        windowsHide: true,
        encoding: 'utf8',
        shell: isMacLocal  // Only use shell on macOS for symlinks
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
 * Format milliseconds into a human-readable time string (Xh Xm Xs format)
 * @param {number} ms - Milliseconds
 * @returns {string} Formatted time string
 */
function formatExportDuration(ms) {
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  
  if (hours > 0) {
    return `${hours}h ${minutes}m ${seconds}s`;
  } else if (minutes > 0) {
    return `${minutes}m ${seconds}s`;
  } else {
    return `${seconds}s`;
  }
}

/**
 * Detect actual GPU hardware model name (e.g., "NVIDIA GeForce RTX 4070 Super")
 * This is separate from encoder detection - shows the actual hardware.
 */
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

/**
 * Tests if a GPU encoder can actually access hardware.
 * FFmpeg may list encoders that aren't usable (e.g., NVENC listed but no NVIDIA GPU).
 * Uses a strict test: only returns true if the encoder actually works (status === 0).
 */
function testEncoderCapability(ffmpegPath, codec) {
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
    
    // Test encoder with realistic test input
    // HEVC VideoToolbox needs larger resolution and specific settings
    const isHEVC = codec.includes('hevc');
    const testSize = isHEVC ? '640x480' : '320x240';
    let testArgs = ['-hide_banner', '-f', 'lavfi', '-i', `testsrc2=duration=1:size=${testSize}:rate=1`];
    
    // Add encoder-specific settings
    if (codec.includes('videotoolbox')) {
      testArgs.push('-b:v', isHEVC ? '5M' : '2M');
      if (isHEVC) {
        testArgs.push('-allow_sw', '1'); // Allow software fallback for HEVC test
      }
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
        console.log(`  ${codec}: Fatal error - ${error}`);
        return false;
      }
    }
    
    // STRICT: Only return true if the test actually succeeded (status === 0)
    return testResult.status === 0;
  } catch (err) {
    console.log(`  ${codec}: Exception - ${err.message}`);
    return false;
  }
}

function detectGpuEncoder(ffmpegPath) {
  if (gpuEncoder !== null) return gpuEncoder;
  
  try {
    // Query FFmpeg for available encoders
    const encoderResult = spawnSync(ffmpegPath, ['-encoders'], { timeout: 5000, windowsHide: true });
    const encoderOutput = encoderResult.stdout?.toString() || '';
    
    // Define encoder priority by platform
    // Test all encoders in order and use the first one that actually works
    const encodersToCheck = [];
    
    if (process.platform === 'darwin') {
      encodersToCheck.push({ codec: 'h264_videotoolbox', name: 'Apple VideoToolbox', priority: 1 });
    } else if (process.platform === 'win32') {
      encodersToCheck.push(
        { codec: 'h264_nvenc', name: 'NVIDIA NVENC', priority: 1 },
        { codec: 'h264_amf', name: 'AMD AMF', priority: 2 },
        { codec: 'h264_qsv', name: 'Intel QuickSync', priority: 3 }
      );
    } else {
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
        if (testEncoderCapability(ffmpegPath, encoder.codec)) {
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
    
    // HEVC encoders by platform
    const hevcEncoders = [];
    if (process.platform === 'darwin') {
      hevcEncoders.push({ codec: 'hevc_videotoolbox', name: 'Apple VideoToolbox HEVC', maxRes: 8192, priority: 1 });
    } else if (process.platform === 'win32') {
      hevcEncoders.push(
        { codec: 'hevc_nvenc', name: 'NVIDIA NVENC HEVC', maxRes: 8192, priority: 1 },
        { codec: 'hevc_amf', name: 'AMD AMF HEVC', maxRes: 8192, priority: 2 },
        { codec: 'hevc_qsv', name: 'Intel QuickSync HEVC', maxRes: 8192, priority: 3 }
      );
      hevcEncoders.sort((a, b) => (a.priority || 999) - (b.priority || 999));
    } else {
      hevcEncoders.push(
        { codec: 'hevc_nvenc', name: 'NVIDIA NVENC HEVC', maxRes: 8192, priority: 1 },
        { codec: 'hevc_qsv', name: 'Intel QuickSync HEVC', maxRes: 8192, priority: 2 }
      );
    }
    
    console.log('[HEVC] Checking for HEVC GPU encoders...');
    for (const encoder of hevcEncoders) {
      if (encoderOutput.includes(encoder.codec)) {
        console.log(`[TEST] Testing HEVC encoder ${encoder.name} (${encoder.codec})...`);
        if (testEncoderCapability(ffmpegPath, encoder.codec)) {
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

// Getters/setters for mutable encoder state (used by video export and diagnostics)
function getGpuEncoder() { return gpuEncoder; }
function setGpuEncoder(val) { gpuEncoder = val; }
function getGpuEncoderHEVC() { return gpuEncoderHEVC; }
function setGpuEncoderHEVC(val) { gpuEncoderHEVC = val; }

module.exports = {
  ensureExecutable,
  findFFmpegPath,
  formatExportDuration,
  detectGpuHardware,
  testEncoderCapability,
  detectGpuEncoder,
  detectHEVCEncoder,
  makeEven,
  getGpuEncoder,
  setGpuEncoder,
  getGpuEncoderHEVC,
  setGpuEncoderHEVC
};
