const { app, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const https = require('https');
const { execSync } = require('child_process');

// Auto-Update Configuration
const UPDATE_CONFIG = {
  owner: 'Sentry-Six',
  repo: 'Sentry-Six',
  defaultBranch: 'main'
};

// Update channels. `stable` follows published GitHub releases; `prerelease`
// also picks up releases flagged prerelease (RCs / betas). `branch` is used by
// the paths that read raw files from GitHub rather than going through
// electron-updater — the dev-install zip download, the version.json check, and
// the changelog fetch.
const UPDATE_CHANNELS = Object.freeze({
  stable: Object.freeze({
    id: 'stable',
    branch: 'main',
    releaseType: 'release',
    allowPrerelease: false
  }),
  prerelease: Object.freeze({
    id: 'prerelease',
    branch: 'Dev-SEI',
    releaseType: 'prerelease',
    allowPrerelease: true
  })
});
const DEFAULT_CHANNEL_ID = 'stable';

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

function httpsGet(url) {
  return new Promise((resolve, reject) => {
    const options = {
      headers: { 'User-Agent': 'Sentry-Studio-Updater' }
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
      headers: { 'User-Agent': 'Sentry-Studio-Updater' }
    };
    
    const handleResponse = (res) => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        const redirectReq = https.get(res.headers.location, options, handleResponse);
        redirectReq.on('error', reject);
        redirectReq.setTimeout(30000, () => { redirectReq.destroy(); reject(new Error('Redirect timeout')); });
        return;
      }
      
      const totalSize = parseInt(res.headers['content-length'], 10);
      let downloadedSize = 0;
      const file = fs.createWriteStream(destPath);
      
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
 * Resolve the configured update channel from a settings object.
 *
 * Falls back to the legacy `updateBranch` setting — the dropdown that shipped
 * until the 2026.6.11 UI overhaul removed it — so anyone who had opted into
 * Dev-SEI back then lands on the pre-release channel instead of being silently
 * moved to stable.
 *
 * @param {object} settings - Parsed settings.json contents
 * @returns {{id: string, branch: string, releaseType: string, allowPrerelease: boolean}}
 */
function resolveUpdateChannel(settings) {
  const channelId = settings && settings.updateChannel;
  if (channelId && UPDATE_CHANNELS[channelId]) return UPDATE_CHANNELS[channelId];

  const legacyBranch = settings && settings.updateBranch;
  if (legacyBranch && legacyBranch !== UPDATE_CONFIG.defaultBranch) {
    return UPDATE_CHANNELS.prerelease;
  }
  return UPDATE_CHANNELS[DEFAULT_CHANNEL_ID];
}

/**
 * Point electron-updater at a channel's release feed.
 *
 * allowDowngrade is the subtle part. A pre-release sorts BELOW the stable
 * release it precedes (2026.32.35-rc1 < 2026.32.35), so the pre-release channel
 * can only ever install anything if downgrades are permitted. Coming back the
 * other way needs it too: someone running an RC who switches to stable has to
 * move *down* to the latest stable build. So downgrades are allowed on the
 * pre-release channel, and on stable only while the running build is itself a
 * pre-release (a '-' in its version) — ordinary stable users can never be
 * rolled backwards by a bad publish.
 *
 * No-ops without electron-updater (manual npm installs), which update by
 * downloading the branch zip instead.
 *
 * @param {object} channel - A UPDATE_CHANNELS entry
 * @param {string} currentVersion - The running app version
 * @returns {object} The channel that was applied
 */
function applyUpdateChannel(channel, currentVersion) {
  if (!autoUpdater) return channel;

  const runningPrerelease = String(currentVersion || '').includes('-');
  autoUpdater.allowPrerelease = channel.allowPrerelease;
  autoUpdater.allowDowngrade = channel.allowPrerelease || runningPrerelease;
  autoUpdater.setFeedURL({
    provider: 'github',
    owner: UPDATE_CONFIG.owner,
    repo: UPDATE_CONFIG.repo,
    releaseType: channel.releaseType
  });
  return channel;
}

/**
 * Fetch the latest version.json from GitHub (for manual/dev installs)
 */
async function getLatestVersionFromGitHub(getUpdateBranch) {
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

function copyDirectoryRecursive(src, dest) {
  if (!fs.existsSync(src)) return;
  
  if (!fs.existsSync(dest)) {
    fs.mkdirSync(dest, { recursive: true });
  }
  
  const entries = fs.readdirSync(src, { withFileTypes: true });
  
  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    
    if (entry.isDirectory()) {
      copyDirectoryRecursive(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

/**
 * Register all auto-update IPC handlers
 * @param {object} deps - Dependencies
 * @param {function} deps.getMainWindow - Returns the main BrowserWindow
 * @param {function} deps.getUpdateBranch - Returns the configured update branch
 * @param {function} deps.loadSettings - Returns settings object
 * @param {function} deps.saveSettings - Persists a settings object
 * @param {function} deps.checkUpdateWithTelemetry - Telemetry check function
 * @param {function} deps.processApiResponse - Process telemetry API response
 */
function registerAutoUpdateIpc(deps) {
  // Mac App Store builds update exclusively via the App Store — skip all GitHub update logic
  if (process.mas) {
    console.log('[UPDATE] Mac App Store build detected — auto-update disabled');
    return;
  }

  const { getMainWindow, getUpdateBranch, loadSettings, saveSettings, checkUpdateWithTelemetry, processApiResponse } = deps;

  const getActiveChannel = () => resolveUpdateChannel(loadSettings());

  // Apply the persisted channel up front so the session's first update check
  // already targets the right feed rather than electron-builder's default.
  const startupChannel = getActiveChannel();
  applyUpdateChannel(startupChannel, app.getVersion());
  console.log(`[UPDATE] Update channel: ${startupChannel.id} (branch ${startupChannel.branch})`);

  /**
   * Check for updates - handles both packaged (NSIS) and development (npm start) modes
   */
  async function checkForUpdatesManual() {
    try {
      console.log('[UPDATE] Manual update check (dev mode)...');
      const latestVersion = await getLatestVersionFromGitHub(getUpdateBranch);
      
      if (!latestVersion) {
        console.log('[UPDATE] No remote version available');
        return { updateAvailable: false, error: 'Could not fetch version info' };
      }
      
      const currentVer = app.getVersion();
      const latestVer = latestVersion.version;
      
      console.log(`[UPDATE] Current: v${currentVer}, Latest: v${latestVer}`);
      
      if (compareVersions(currentVer, latestVer) < 0) {
        console.log('[UPDATE] New version available!');
        const mainWindow = getMainWindow();
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('update:available', {
            currentVersion: currentVer,
            latestVersion: latestVer,
            releaseName: latestVersion.releaseName || 'New Update',
            releaseDate: latestVersion.releaseDate,
            isDevMode: true
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

  /**
   * Perform update for manual/development installs
   */
  async function performManualUpdate(event) {
    const sendProgress = (percentage, message) => {
      const mainWindow = getMainWindow();
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('update:progress', { percentage, message });
      }
    };
    
    try {
      sendProgress(5, 'Fetching latest version info...');
      const latestVersion = await getLatestVersionFromGitHub(getUpdateBranch);
      
      const zipUrl = `https://github.com/${UPDATE_CONFIG.owner}/${UPDATE_CONFIG.repo}/archive/refs/heads/${getUpdateBranch()}.zip`;
      const tempDir = path.join(os.tmpdir(), 'sentry-six-update');
      const zipPath = path.join(tempDir, 'update.zip');
      
      if (fs.existsSync(tempDir)) {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
      fs.mkdirSync(tempDir, { recursive: true });
      
      sendProgress(10, 'Downloading update...');
      await downloadFile(zipUrl, zipPath, (pct) => {
        sendProgress(10 + Math.round(pct * 0.5), `Downloading... ${pct}%`);
      });
      
      sendProgress(60, 'Extracting update...');
      
      const extractDir = path.join(tempDir, 'extracted');
      fs.mkdirSync(extractDir, { recursive: true });
      
      if (process.platform === 'win32') {
        execSync(`powershell -Command "Expand-Archive -Path '${zipPath}' -DestinationPath '${extractDir}' -Force"`, { windowsHide: true });
      } else {
        execSync(`unzip -o "${zipPath}" -d "${extractDir}"`, { stdio: 'ignore' });
      }
      
      sendProgress(75, 'Installing update...');
      
      const extractedContents = fs.readdirSync(extractDir);
      const sourceDir = path.join(extractDir, extractedContents[0]);
      
      const appDir = path.join(__dirname, '..', '..');
      
      const filesToCopy = fs.readdirSync(sourceDir, { withFileTypes: true });
      for (const entry of filesToCopy) {
        const srcPath = path.join(sourceDir, entry.name);
        const destPath = path.join(appDir, entry.name);
        
        if (entry.name === 'node_modules' || entry.name === '.git') continue;
        
        if (entry.isDirectory()) {
          copyDirectoryRecursive(srcPath, destPath);
        } else {
          fs.copyFileSync(srcPath, destPath);
        }
      }
      
      sendProgress(90, 'Cleaning up...');
      
      fs.rmSync(tempDir, { recursive: true, force: true });
      
      console.log(`[UPDATE] Updated to v${latestVersion?.version || 'latest'}`);
      
      sendProgress(100, 'Update complete!');
      
      const mainWindow = getMainWindow();
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('update:downloaded', { version: latestVersion?.version, isDevMode: true });
      }
      
      return { success: true, needsRestart: true, isDevMode: true };
    } catch (err) {
      console.error('Manual update failed:', err);
      return { success: false, error: err.message };
    }
  }

  // Update IPC handlers
  ipcMain.handle('update:check', async () => {
    try {
      // Step 1: Check with telemetry API (for killswitch and update status)
      console.log('[UPDATE] Checking with telemetry API...');
      const apiResponse = await checkUpdateWithTelemetry();
      const processedResult = processApiResponse(apiResponse);
      
      // Handle force_manual (killswitch)
      if (processedResult.action === 'force_manual') {
        console.log('[UPDATE] Force manual update required (killswitch activated)');
        const mainWindow = getMainWindow();
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('update:forceManual', {
            message: processedResult.message,
            download_url: processedResult.download_url,
            new_version: processedResult.new_version,
            currentVersion: app.getVersion()
          });
        }
        return {
          checked: true,
          updateAvailable: true,
          forceManual: true,
          message: processedResult.message,
          download_url: processedResult.download_url,
          currentVersion: app.getVersion(),
          latestVersion: processedResult.new_version
        };
      }
      
      // Handle update available from API
      if (processedResult.action === 'update_available') {
        console.log('[UPDATE] Update available from API:', processedResult.new_version);
        const mainWindow = getMainWindow();
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('update:available', {
            currentVersion: app.getVersion(),
            latestVersion: processedResult.new_version,
            releaseName: 'New Update',
            serverMessage: processedResult.message
          });
        }
        return {
          checked: true,
          updateAvailable: true,
          currentVersion: app.getVersion(),
          latestVersion: processedResult.new_version,
          serverMessage: processedResult.message
        };
      }
      
      // Handle up_to_date from API
      if (processedResult.action === 'up_to_date') {
        console.log('[UPDATE] App is up to date (from API)');
        return {
          checked: true,
          updateAvailable: false,
          currentVersion: app.getVersion(),
          latestVersion: app.getVersion(),
          serverMessage: processedResult.message
        };
      }
      
      // Fallback to direct GitHub/electron-updater check
      console.log('[UPDATE] API unavailable, falling back to direct check...');
      if (app.isPackaged && autoUpdater) {
        const result = await autoUpdater.checkForUpdates();
        const updateAvailable = result?.updateInfo?.version && 
          compareVersions(app.getVersion(), result.updateInfo.version) < 0;
        return { 
          checked: true, 
          updateAvailable,
          currentVersion: app.getVersion(),
          latestVersion: result?.updateInfo?.version || app.getVersion()
        };
      } else {
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
        if (autoUpdater) {
          // Both Windows (NSIS) and macOS (Squirrel.Mac) flow through electron-updater.
          // electron-updater downloads the delta using the .blockmap file published
          // alongside the installer/zip, so users re-download only changed chunks
          // instead of the full ~275 MB DMG / 150 MB EXE.
          await autoUpdater.checkForUpdates();
          await autoUpdater.downloadUpdate();
          return { success: true, downloading: true };
        } else {
          return { success: false, error: 'Auto-updater not available' };
        }
      } else {
        const result = await performManualUpdate(event);
        return result;
      }
    } catch (err) {
      console.error('[UPDATE] Download failed:', err.message);
      return { success: false, error: err.message };
    }
  });

  // quitAndInstall throws if no update was actually downloaded, which would
  // leave the app running with no way to exit — fall back to a plain quit.
  function quitAndInstallOrExit() {
    try {
      autoUpdater.quitAndInstall(false, true);
    } catch (err) {
      console.error('[UPDATE] quitAndInstall failed, quitting normally:', err.message);
      app.quit();
    }
  }

  ipcMain.handle('update:installAndRestart', async () => {
    if (autoUpdater) {
      quitAndInstallOrExit();
    } else {
      app.quit();
    }
  });

  ipcMain.handle('update:exit', async () => {
    if (app.isPackaged && autoUpdater) {
      // Both platforms apply the downloaded update via Squirrel on quit.
      quitAndInstallOrExit();
    } else {
      app.quit();
    }
  });

  ipcMain.handle('update:skip', async () => {
    return { skipped: true };
  });

  ipcMain.handle('update:getChannel', async () => {
    const channel = getActiveChannel();
    return { channel: channel.id, branch: channel.branch };
  });

  ipcMain.handle('update:setChannel', async (_event, channelId) => {
    const channel = UPDATE_CHANNELS[channelId];
    if (!channel) {
      return { success: false, error: `Unknown update channel: ${channelId}` };
    }

    const settings = loadSettings();
    settings.updateChannel = channel.id;
    // Keep the legacy branch key in step. It is what older builds sharing this
    // settings file read directly, and resolveUpdateChannel still honours it.
    settings.updateBranch = channel.branch;
    const saved = saveSettings(settings);

    applyUpdateChannel(channel, app.getVersion());
    console.log(`[UPDATE] Channel set to ${channel.id} (branch ${channel.branch})`);
    return { success: saved, channel: channel.id, branch: channel.branch };
  });

  // Pre-release testing handlers. Fetches the latest GitHub release with
  // `prerelease: true` and, on install, flips the autoUpdater into a
  // prerelease+downgrade-allowed mode so the pre-release installs even
  // when its semver sorts below the currently-installed stable version
  // (e.g. 2026.12.15-rc1 < 2026.12.15). The feed and flags are reset to the
  // user's configured channel after the download completes so ordinary update
  // cycles are not permanently flipped.
  //
  // This is the one-shot dev-tools path; users who want to stay on pre-releases
  // should switch the update channel in Settings instead.
  ipcMain.handle('dev:checkPrerelease', async () => {
    try {
      const url = `https://api.github.com/repos/${UPDATE_CONFIG.owner}/${UPDATE_CONFIG.repo}/releases?per_page=10`;
      const response = await httpsGet(url);
      if (response.statusCode !== 200) {
        return { found: false, error: `GitHub API returned ${response.statusCode}` };
      }
      const releases = JSON.parse(response.data);
      const pre = releases.find(r => r.prerelease && !r.draft);
      if (!pre) {
        return { found: false, error: 'No pre-release found on GitHub' };
      }
      console.log(`[UPDATE] Dev check found pre-release: ${pre.tag_name}`);
      return {
        found: true,
        tag: pre.tag_name,
        name: pre.name,
        body: pre.body,
        publishedAt: pre.published_at
      };
    } catch (err) {
      console.error('[UPDATE] Dev pre-release check failed:', err.message);
      return { found: false, error: err.message };
    }
  });

  ipcMain.handle('dev:installPrerelease', async (event, tag) => {
    if (!app.isPackaged || !autoUpdater) {
      return {
        success: false,
        error: 'Pre-release install only works on packaged builds (NSIS / DMG). In dev mode (npm start), check out the tag in git instead.'
      };
    }
    try {
      console.log(`[UPDATE] Dev-triggered pre-release install: ${tag}`);

      autoUpdater.allowPrerelease = true;
      autoUpdater.allowDowngrade = true;
      autoUpdater.setFeedURL({
        provider: 'github',
        owner: UPDATE_CONFIG.owner,
        repo: UPDATE_CONFIG.repo,
        releaseType: 'prerelease'
      });

      // cleanup() must undo everything the prerelease attempt changed —
      // flags, feed, and BOTH event listeners. Removing the sibling listener
      // matters: a stale update-downloaded listener left behind by a failed
      // attempt would force quitAndInstall in the middle of a later normal
      // update in the same session.
      const onError = () => cleanup();
      const onDownloaded = () => {
        cleanup();
        // Both platforms apply the downloaded update via Squirrel on quit.
        // Same quitAndInstall signature used by the normal update flow.
        autoUpdater.quitAndInstall(false, true);
      };
      const cleanup = () => {
        // Restore the user's configured channel, NOT a hardcoded stable feed —
        // a dev-tools install must not silently drag someone off the
        // pre-release channel they opted into.
        applyUpdateChannel(getActiveChannel(), app.getVersion());
        autoUpdater.removeListener('error', onError);
        autoUpdater.removeListener('update-downloaded', onDownloaded);
      };
      autoUpdater.once('error', onError);
      autoUpdater.once('update-downloaded', onDownloaded);

      try {
        await autoUpdater.checkForUpdates();
        await autoUpdater.downloadUpdate();
        return { success: true, downloading: true };
      } catch (err) {
        cleanup();
        throw err;
      }
    } catch (err) {
      console.error('[UPDATE] Pre-release install failed:', err.message);
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('update:getChangelog', async () => {
    try {
      const cacheBuster = Date.now();
      const url = `https://raw.githubusercontent.com/${UPDATE_CONFIG.owner}/${UPDATE_CONFIG.repo}/${getUpdateBranch()}/changelog.json?cb=${cacheBuster}`;
      const response = await httpsGet(url);
      
      if (response.statusCode === 200) {
        return JSON.parse(response.data);
      }
      
      console.log('[UPDATE] Remote changelog not available, falling back to local');
      const changelogPath = path.join(__dirname, '..', '..', 'changelog.json');
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
}

/**
 * Set up electron-updater event handlers on the main window
 * @param {BrowserWindow} mainWindow
 */
function setupAutoUpdaterEvents(mainWindow) {
  if (!autoUpdater) return;
  
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

module.exports = {
  UPDATE_CONFIG,
  UPDATE_CHANNELS,
  DEFAULT_CHANNEL_ID,
  autoUpdater,
  applyUpdateChannel,
  getLatestVersionFromGitHub,
  registerAutoUpdateIpc,
  resolveUpdateChannel,
  setupAutoUpdaterEvents
};
