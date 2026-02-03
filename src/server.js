/**
 * Sentry-Six Web Server
 * Express-based server for Docker web mode
 * Replaces Electron IPC with REST API endpoints
 */

const express = require('express');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const os = require('os');
const crypto = require('crypto');

// Import shared modules
const { isDockerEnvironment, getConfigPath, getDataPath, getSettingsPath, getMachineIdPath } = require('./dockerPaths');

const app = express();
const PORT = process.env.PORT || 5800;

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Serve static files from renderer directory
app.use(express.static(path.join(__dirname, 'renderer')));

// Serve assets
app.use('/assets', express.static(path.join(__dirname, '..', 'assets')));

// Store active exports
const activeExports = new Map();

// ============================================
// Settings Management
// ============================================

const settingsPath = getSettingsPath();

function loadSettings() {
  try {
    if (fs.existsSync(settingsPath)) {
      const data = fs.readFileSync(settingsPath, 'utf-8');
      return JSON.parse(data);
    }
  } catch (err) {
    console.error('[SERVER] Failed to load settings:', err);
  }
  return {};
}

function saveSettings(settings) {
  try {
    const dir = path.dirname(settingsPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2), 'utf-8');
    return true;
  } catch (err) {
    console.error('[SERVER] Failed to save settings:', err);
    return false;
  }
}

// ============================================
// API Routes
// ============================================

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', mode: 'web', docker: isDockerEnvironment() });
});

// Get app info
app.get('/api/info', (req, res) => {
  let version = 'unknown';
  try {
    const versionPath = path.join(__dirname, '..', 'version.json');
    if (fs.existsSync(versionPath)) {
      const versionData = JSON.parse(fs.readFileSync(versionPath, 'utf-8'));
      version = versionData.version || 'unknown';
    }
  } catch (err) {
    console.error('[SERVER] Failed to read version:', err);
  }
  
  res.json({
    version,
    platform: os.platform(),
    arch: os.arch(),
    nodeVersion: process.version,
    isDocker: isDockerEnvironment(),
    configPath: getConfigPath(),
    dataPath: getDataPath()
  });
});

// ============================================
// File System Operations
// ============================================

// Read directory
app.post('/api/fs/readDir', (req, res) => {
  const { dirPath } = req.body;
  
  if (!dirPath) {
    return res.status(400).json({ error: 'dirPath is required' });
  }
  
  try {
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    const result = entries.map(entry => ({
      name: entry.name,
      isDirectory: entry.isDirectory(),
      isFile: entry.isFile(),
      path: path.join(dirPath, entry.name)
    }));
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Read file (for small files like JSON)
app.post('/api/fs/readFile', (req, res) => {
  const { filePath, encoding } = req.body;
  
  if (!filePath) {
    return res.status(400).json({ error: 'filePath is required' });
  }
  
  try {
    const data = fs.readFileSync(filePath, encoding || 'utf-8');
    res.json({ data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Check if file/directory exists
app.post('/api/fs/exists', (req, res) => {
  const { filePath } = req.body;
  
  if (!filePath) {
    return res.status(400).json({ error: 'filePath is required' });
  }
  
  res.json({ exists: fs.existsSync(filePath) });
});

// Get file stats
app.post('/api/fs/stat', (req, res) => {
  const { filePath } = req.body;
  
  if (!filePath) {
    return res.status(400).json({ error: 'filePath is required' });
  }
  
  try {
    const stats = fs.statSync(filePath);
    res.json({
      size: stats.size,
      isDirectory: stats.isDirectory(),
      isFile: stats.isFile(),
      mtime: stats.mtime,
      ctime: stats.ctime,
      birthtime: stats.birthtime
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================
// Video Streaming
// ============================================

// Stream video file
app.get('/api/video/*', (req, res) => {
  const filePath = '/' + req.params[0];
  
  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: 'File not found' });
  }
  
  const stat = fs.statSync(filePath);
  const fileSize = stat.size;
  const range = req.headers.range;
  
  if (range) {
    const parts = range.replace(/bytes=/, '').split('-');
    const start = parseInt(parts[0], 10);
    const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
    const chunkSize = end - start + 1;
    
    const file = fs.createReadStream(filePath, { start, end });
    const head = {
      'Content-Range': `bytes ${start}-${end}/${fileSize}`,
      'Accept-Ranges': 'bytes',
      'Content-Length': chunkSize,
      'Content-Type': 'video/mp4'
    };
    
    res.writeHead(206, head);
    file.pipe(res);
  } else {
    const head = {
      'Content-Length': fileSize,
      'Content-Type': 'video/mp4'
    };
    
    res.writeHead(200, head);
    fs.createReadStream(filePath).pipe(res);
  }
});

// ============================================
// Settings Operations
// ============================================

// Get setting
app.post('/api/settings/get', (req, res) => {
  const { key } = req.body;
  const settings = loadSettings();
  
  if (key) {
    res.json({ value: settings[key] });
  } else {
    res.json({ value: settings });
  }
});

// Set setting
app.post('/api/settings/set', (req, res) => {
  const { key, value } = req.body;
  
  if (!key) {
    return res.status(400).json({ error: 'key is required' });
  }
  
  const settings = loadSettings();
  settings[key] = value;
  const success = saveSettings(settings);
  
  res.json({ success });
});

// ============================================
// FFmpeg Operations
// ============================================

// Check FFmpeg availability
app.get('/api/ffmpeg/check', (req, res) => {
  const ffmpegPath = findFFmpeg();
  res.json({ 
    available: !!ffmpegPath,
    path: ffmpegPath
  });
});

function findFFmpeg() {
  // Check common locations
  const locations = [
    '/usr/bin/ffmpeg',
    '/usr/local/bin/ffmpeg',
    'ffmpeg'
  ];
  
  for (const loc of locations) {
    try {
      if (fs.existsSync(loc)) {
        return loc;
      }
    } catch (e) {
      // Try spawning it
      try {
        const result = require('child_process').spawnSync(loc, ['-version']);
        if (result.status === 0) {
          return loc;
        }
      } catch (e2) {
        continue;
      }
    }
  }
  
  return '/usr/bin/ffmpeg'; // Default for Docker
}

// Start export
app.post('/api/export/start', (req, res) => {
  const { exportId, exportData } = req.body;
  
  if (!exportId || !exportData) {
    return res.status(400).json({ error: 'exportId and exportData are required' });
  }
  
  // TODO: Implement FFmpeg export logic
  // For now, return a placeholder
  res.json({ started: true, exportId });
});

// Cancel export
app.post('/api/export/cancel', (req, res) => {
  const { exportId } = req.body;
  
  const exportProcess = activeExports.get(exportId);
  if (exportProcess) {
    exportProcess.kill('SIGTERM');
    activeExports.delete(exportId);
    res.json({ cancelled: true });
  } else {
    res.json({ cancelled: false, error: 'Export not found' });
  }
});

// ============================================
// Diagnostics
// ============================================

app.get('/api/diagnostics', (req, res) => {
  res.json({
    platform: os.platform(),
    arch: os.arch(),
    nodeVersion: process.version,
    uptime: process.uptime(),
    memory: process.memoryUsage(),
    cpus: os.cpus().length,
    totalMemory: os.totalmem(),
    freeMemory: os.freemem(),
    isDocker: isDockerEnvironment(),
    configPath: getConfigPath(),
    dataPath: getDataPath()
  });
});

// ============================================
// Version/Update (stub for web mode)
// ============================================

app.get('/api/version', (req, res) => {
  let version = 'unknown';
  try {
    const versionPath = path.join(__dirname, '..', 'version.json');
    if (fs.existsSync(versionPath)) {
      const versionData = JSON.parse(fs.readFileSync(versionPath, 'utf-8'));
      version = versionData.version || 'unknown';
    }
  } catch (err) {
    console.error('[SERVER] Failed to read version:', err);
  }
  
  res.json({ version, updateAvailable: false });
});

// ============================================
// Folder Browser (replacement for dialog:openFolder)
// ============================================

// List root directories for browsing
app.get('/api/browse/roots', (req, res) => {
  const roots = [];
  
  // Add data path as primary browse location
  const dataPath = getDataPath();
  if (fs.existsSync(dataPath)) {
    roots.push({ name: 'Tesla Footage', path: dataPath, type: 'data' });
  }
  
  // Add config path
  const configPath = getConfigPath();
  if (fs.existsSync(configPath)) {
    roots.push({ name: 'Config', path: configPath, type: 'config' });
  }
  
  // Add common mount points
  if (fs.existsSync('/mnt')) {
    roots.push({ name: 'Mounts', path: '/mnt', type: 'system' });
  }
  
  res.json(roots);
});

// Browse directory
app.get('/api/browse', (req, res) => {
  const dirPath = req.query.path || getDataPath();
  
  if (!fs.existsSync(dirPath)) {
    return res.status(404).json({ error: 'Directory not found' });
  }
  
  try {
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    const items = entries
      .filter(entry => !entry.name.startsWith('.'))
      .map(entry => ({
        name: entry.name,
        path: path.join(dirPath, entry.name),
        isDirectory: entry.isDirectory(),
        isFile: entry.isFile()
      }))
      .sort((a, b) => {
        // Directories first, then files
        if (a.isDirectory && !b.isDirectory) return -1;
        if (!a.isDirectory && b.isDirectory) return 1;
        return a.name.localeCompare(b.name);
      });
    
    res.json({
      path: dirPath,
      parent: path.dirname(dirPath),
      items
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================
// Serve main app
// ============================================

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'renderer', 'index.html'));
});

// Catch-all for SPA routing
app.get('*', (req, res) => {
  // If it's an API route that wasn't matched, return 404
  if (req.path.startsWith('/api/')) {
    return res.status(404).json({ error: 'API endpoint not found' });
  }
  
  // Otherwise serve the main app
  res.sendFile(path.join(__dirname, 'renderer', 'index.html'));
});

// ============================================
// Start Server
// ============================================

app.listen(PORT, '0.0.0.0', () => {
  console.log('[SERVER] ========================================');
  console.log('[SERVER] Sentry-Six Web Server');
  console.log('[SERVER] ========================================');
  console.log(`[SERVER] Running on http://0.0.0.0:${PORT}`);
  console.log(`[SERVER] Docker Mode: ${isDockerEnvironment()}`);
  console.log(`[SERVER] Config Path: ${getConfigPath()}`);
  console.log(`[SERVER] Data Path: ${getDataPath()}`);
  console.log('[SERVER] ========================================');
});

module.exports = app;
