/**
 * Tests for src/preload.js
 * Covers: channel allowlist, API surface, listener management
 */

const electron = require('electron');
const { contextBridge, ipcRenderer } = electron;

// Require preload once - it calls contextBridge.exposeInMainWorld
require('../src/preload.js');

// Capture the API object passed to exposeInMainWorld
const api = contextBridge.exposeInMainWorld.mock.calls[0][1];

describe('preload', () => {
  beforeEach(() => {
    // Clear only ipcRenderer mocks, not contextBridge (already captured)
    ipcRenderer.invoke.mockClear();
    ipcRenderer.on.mockClear();
    ipcRenderer.removeListener.mockClear();
    ipcRenderer.removeAllListeners.mockClear();
  });

  test('exposes electronAPI via contextBridge', () => {
    expect(contextBridge.exposeInMainWorld).toHaveBeenCalledWith(
      'electronAPI',
      expect.any(Object)
    );
  });

  test('electronAPI has all required methods', () => {
    // File operations
    expect(api.openFolder).toBeDefined();
    expect(api.openFile).toBeDefined();
    expect(api.readDir).toBeDefined();
    expect(api.readFile).toBeDefined();
    expect(api.exists).toBeDefined();
    expect(api.stat).toBeDefined();
    expect(api.showItemInFolder).toBeDefined();
    expect(api.deleteFolder).toBeDefined();

    // Export
    expect(api.startExport).toBeDefined();
    expect(api.cancelExport).toBeDefined();
    expect(api.checkFFmpeg).toBeDefined();
    expect(api.saveFile).toBeDefined();

    // Sharing
    expect(api.getShareConfig).toBeDefined();
    expect(api.reserveShareCode).toBeDefined();
    expect(api.uploadShareClip).toBeDefined();
    expect(api.getSharedClips).toBeDefined();
    expect(api.deleteSharedClip).toBeDefined();

    // Updates
    expect(api.checkForUpdates).toBeDefined();
    expect(api.installUpdate).toBeDefined();
    expect(api.installAndRestart).toBeDefined();
    expect(api.skipUpdate).toBeDefined();
    expect(api.exitApp).toBeDefined();
    expect(api.getChangelog).toBeDefined();

    // Settings
    expect(api.getSetting).toBeDefined();
    expect(api.setSetting).toBeDefined();

    // System
    expect(api.getSystemInfo).toBeDefined();
    expect(api.getDiagnostics).toBeDefined();
    expect(api.openExternal).toBeDefined();

    // Support
    expect(api.createSupportTicket).toBeDefined();
    expect(api.sendSupportMessage).toBeDefined();
    expect(api.fetchSupportMessages).toBeDefined();
    expect(api.closeSupportTicket).toBeDefined();

    // Event listener management
    expect(api.on).toBeDefined();
    expect(api.off).toBeDefined();
    expect(api.removeAllListeners).toBeDefined();
  });

  describe('channel allowlist', () => {
    const ALLOWED_CHANNELS = [
      'export:progress',
      'share:progress',
      'update:available',
      'update:progress',
      'update:downloaded',
      'update:forceManual'
    ];

    test('allows registering listeners on allowed channels', () => {
      for (const channel of ALLOWED_CHANNELS) {
        ipcRenderer.on.mockClear();
        const callback = jest.fn();
        api.on(channel, callback);
        expect(ipcRenderer.on).toHaveBeenCalledWith(channel, expect.any(Function));
      }
    });

    test('blocks listeners on disallowed channels', () => {
      const blockedChannels = [
        'fs:readDir',
        'shell:openExternal',
        'dialog:openFolder',
        'malicious:channel',
        'settings:get'
      ];

      for (const channel of blockedChannels) {
        ipcRenderer.on.mockClear();
        const callback = jest.fn();
        api.on(channel, callback);
        expect(ipcRenderer.on).not.toHaveBeenCalled();
      }
    });
  });

  describe('listener management', () => {
    test('off removes previously registered listener', () => {
      const callback = jest.fn();
      api.on('export:progress', callback);

      api.off('export:progress', callback);
      expect(ipcRenderer.removeListener).toHaveBeenCalledWith(
        'export:progress',
        expect.any(Function)
      );
    });

    test('off does nothing for unregistered callback', () => {
      const callback = jest.fn();
      api.off('export:progress', callback);
      expect(ipcRenderer.removeListener).not.toHaveBeenCalled();
    });

    test('removeAllListeners delegates to ipcRenderer', () => {
      api.removeAllListeners('export:progress');
      expect(ipcRenderer.removeAllListeners).toHaveBeenCalledWith('export:progress');
    });
  });

  describe('IPC invoke calls', () => {
    test('openFolder invokes correct channel', () => {
      api.openFolder('/test/path');
      expect(ipcRenderer.invoke).toHaveBeenCalledWith('dialog:openFolder', '/test/path');
    });

    test('getSetting invokes with key', () => {
      api.getSetting('TeslaCamPath');
      expect(ipcRenderer.invoke).toHaveBeenCalledWith('settings:get', 'TeslaCamPath');
    });

    test('setSetting invokes with key and value', () => {
      api.setSetting('theme', 'dark');
      expect(ipcRenderer.invoke).toHaveBeenCalledWith('settings:set', 'theme', 'dark');
    });

    test('startExport invokes with exportId and data', () => {
      api.startExport('export-1', { quality: 'high' });
      expect(ipcRenderer.invoke).toHaveBeenCalledWith('export:start', 'export-1', { quality: 'high' });
    });
  });
});
