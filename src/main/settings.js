const { app, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');

// File-based settings storage for reliable persistence
const settingsPath = path.join(app.getPath('userData'), 'settings.json');

// In-memory cache — loaded once from disk, then served from RAM
let _settingsCache = null;

function loadSettings() {
  if (_settingsCache !== null) return _settingsCache;
  try {
    if (fs.existsSync(settingsPath)) {
      const data = fs.readFileSync(settingsPath, 'utf-8');
      _settingsCache = JSON.parse(data);
      return _settingsCache;
    }
  } catch (err) {
    console.error('Failed to load settings:', err);
  }
  _settingsCache = {};
  return _settingsCache;
}

function saveSettings(settings) {
  _settingsCache = settings; // Update cache immediately
  try {
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2), 'utf-8');
    return true;
  } catch (err) {
    console.error('Failed to save settings:', err);
    return false;
  }
}

function registerSettingsIpc() {
  ipcMain.handle('settings:get', async (event, key) => {
    const settings = loadSettings();
    return settings[key];
  });

  ipcMain.handle('settings:set', async (event, key, value) => {
    const settings = loadSettings();
    settings[key] = value;
    return saveSettings(settings);
  });
}

module.exports = { settingsPath, loadSettings, saveSettings, registerSettingsIpc };
