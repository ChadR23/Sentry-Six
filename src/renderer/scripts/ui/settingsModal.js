/**
 * Settings Modal
 * Handles the settings panel UI and preferences
 */

import { initKeybindSettings } from '../lib/keybinds.js';

// DOM helper
const $ = id => document.getElementById(id);

// Dependencies set via init
let getState = null;
let getUseMetric = null;
let updateEventCameraHighlight = null;
let resetCameraOrder = null;
let openDevSettingsModal = null;

/**
 * Initialize settings modal with dependencies
 * @param {Object} deps - Dependencies
 */
export function initSettingsModalDeps(deps) {
    getState = deps.getState;
    getUseMetric = deps.getUseMetric;
    updateEventCameraHighlight = deps.updateEventCameraHighlight;
    resetCameraOrder = deps.resetCameraOrder;
    openDevSettingsModal = deps.openDevSettingsModal;
}

/**
 * Initialize the settings modal
 */
export function initSettingsModal() {
    const state = getState?.();
    const useMetric = getUseMetric?.();
    
    const settingsBtn = $('settingsBtn');
    const settingsModal = $('settingsModal');
    const closeSettingsModal = $('closeSettingsModal');
    const closeSettingsBtn = $('closeSettingsBtn');
    
    const settingsDashboardToggle = $('settingsDashboardToggle');
    const settingsMapToggle = $('settingsMapToggle');
    const settingsMetricToggle = $('settingsMetricToggle');
    
    const dashboardToggle = $('dashboardToggle');
    const mapToggle = $('mapToggle');
    const metricToggle = $('metricToggle');
    
    const defaultFolderPath = $('defaultFolderPath');
    const browseDefaultFolderBtn = $('browseDefaultFolderBtn');
    const clearDefaultFolderBtn = $('clearDefaultFolderBtn');
    const defaultFolderStatus = $('defaultFolderStatus');
    
    // Initialize settings values
    if (settingsDashboardToggle && state) settingsDashboardToggle.checked = state.ui.dashboardEnabled;
    if (settingsMapToggle && state) settingsMapToggle.checked = state.ui.mapEnabled;
    if (settingsMetricToggle) settingsMetricToggle.checked = useMetric;
    
    // Load saved default folder
    if (window.electronAPI?.getSetting && defaultFolderPath) {
        window.electronAPI.getSetting('defaultFolder').then(savedFolder => {
            if (savedFolder) defaultFolderPath.value = savedFolder;
        });
    }
    
    // Open settings modal
    if (settingsBtn) {
        settingsBtn.onclick = (e) => {
            e.preventDefault();
            if (settingsModal) {
                const currentState = getState?.();
                const currentUseMetric = getUseMetric?.();
                if (settingsDashboardToggle && currentState) settingsDashboardToggle.checked = currentState.ui.dashboardEnabled;
                if (settingsMapToggle && currentState) settingsMapToggle.checked = currentState.ui.mapEnabled;
                if (settingsMetricToggle) settingsMetricToggle.checked = currentUseMetric;
                
                const disableAutoUpdate = $('settingsDisableAutoUpdate');
                if (disableAutoUpdate && window.electronAPI?.getSetting) {
                    window.electronAPI.getSetting('disableAutoUpdate').then(savedValue => {
                        disableAutoUpdate.checked = savedValue === true;
                    });
                }
                settingsModal.classList.remove('hidden');
            }
        };
    }
    
    function closeSettings() {
        if (settingsModal) settingsModal.classList.add('hidden');
    }
    
    if (closeSettingsModal) closeSettingsModal.onclick = closeSettings;
    if (closeSettingsBtn) closeSettingsBtn.onclick = closeSettings;
    
    if (settingsModal) {
        settingsModal.onclick = (e) => {
            if (e.target === settingsModal) closeSettings();
        };
    }
    
    // Dashboard toggle
    if (settingsDashboardToggle) {
        settingsDashboardToggle.onchange = () => {
            if (dashboardToggle) {
                dashboardToggle.checked = settingsDashboardToggle.checked;
                dashboardToggle.dispatchEvent(new Event('change'));
            }
        };
    }
    
    // Map toggle
    if (settingsMapToggle) {
        settingsMapToggle.onchange = () => {
            if (mapToggle) {
                mapToggle.checked = settingsMapToggle.checked;
                mapToggle.dispatchEvent(new Event('change'));
            }
        };
    }
    
    // Metric toggle
    if (settingsMetricToggle) {
        settingsMetricToggle.onchange = () => {
            if (metricToggle) {
                metricToggle.checked = settingsMetricToggle.checked;
                metricToggle.dispatchEvent(new Event('change'));
            }
        };
    }
    
    // Browse for default folder
    if (browseDefaultFolderBtn) {
        browseDefaultFolderBtn.onclick = async (e) => {
            e.preventDefault();
            if (window.electronAPI?.openFolder) {
                try {
                    const folderPath = await window.electronAPI.openFolder();
                    if (folderPath) {
                        if (window.electronAPI?.setSetting) {
                            await window.electronAPI.setSetting('defaultFolder', folderPath);
                        }
                        if (defaultFolderPath) defaultFolderPath.value = folderPath;
                        if (defaultFolderStatus) {
                            defaultFolderStatus.textContent = 'Default folder saved';
                            defaultFolderStatus.className = 'folder-status success';
                            setTimeout(() => {
                                defaultFolderStatus.textContent = '';
                                defaultFolderStatus.className = 'folder-status';
                            }, 3000);
                        }
                    }
                } catch (err) {
                    console.error('Failed to select folder:', err);
                    if (defaultFolderStatus) {
                        defaultFolderStatus.textContent = 'Failed to select folder';
                        defaultFolderStatus.className = 'folder-status error';
                    }
                }
            } else {
                if (defaultFolderStatus) {
                    defaultFolderStatus.textContent = 'Folder selection requires Electron';
                    defaultFolderStatus.className = 'folder-status error';
                }
            }
        };
    }
    
    // Clear default folder
    if (clearDefaultFolderBtn) {
        clearDefaultFolderBtn.onclick = async (e) => {
            e.preventDefault();
            if (window.electronAPI?.setSetting) {
                await window.electronAPI.setSetting('defaultFolder', null);
            }
            if (defaultFolderPath) defaultFolderPath.value = '';
            if (defaultFolderStatus) {
                defaultFolderStatus.textContent = 'Default folder cleared';
                defaultFolderStatus.className = 'folder-status';
                setTimeout(() => { defaultFolderStatus.textContent = ''; }, 2000);
            }
        };
    }
    
    // Initialize keybind settings
    initKeybindSettings();
    
    // Advanced settings toggle
    const advancedSettingsToggle = $('advancedSettingsToggle');
    const advancedSettingsSection = $('advancedSettingsSection');
    
    if (advancedSettingsToggle && advancedSettingsSection) {
        advancedSettingsToggle.onclick = (e) => {
            e.preventDefault();
            advancedSettingsSection.classList.toggle('hidden');
            advancedSettingsToggle.classList.toggle('expanded', !advancedSettingsSection.classList.contains('hidden'));
        };
    }
    
    // Disable auto-update toggle
    const settingsDisableAutoUpdate = $('settingsDisableAutoUpdate');
    if (settingsDisableAutoUpdate) {
        if (window.electronAPI?.getSetting) {
            window.electronAPI.getSetting('disableAutoUpdate').then(savedValue => {
                settingsDisableAutoUpdate.checked = savedValue === true;
            });
        }
        
        settingsDisableAutoUpdate.addEventListener('change', async function() {
            if (window.electronAPI?.setSetting) {
                await window.electronAPI.setSetting('disableAutoUpdate', this.checked);
            }
        });
    }
    
    // Sentry camera highlight toggle
    const settingsSentryCameraHighlight = $('settingsSentryCameraHighlight');
    if (settingsSentryCameraHighlight) {
        if (window.electronAPI?.getSetting) {
            window.electronAPI.getSetting('sentryCameraHighlight').then(savedValue => {
                const enabled = savedValue !== false;
                settingsSentryCameraHighlight.checked = enabled;
                window._sentryCameraHighlightEnabled = enabled;
                updateEventCameraHighlight?.();
            });
        } else {
            window._sentryCameraHighlightEnabled = true;
        }
        
        settingsSentryCameraHighlight.addEventListener('change', async function() {
            window._sentryCameraHighlightEnabled = this.checked;
            if (window.electronAPI?.setSetting) {
                await window.electronAPI.setSetting('sentryCameraHighlight', this.checked);
            }
            updateEventCameraHighlight?.();
        });
    }
    
    // Saved camera highlight toggle
    const settingsSavedCameraHighlight = $('settingsSavedCameraHighlight');
    if (settingsSavedCameraHighlight) {
        if (window.electronAPI?.getSetting) {
            window.electronAPI.getSetting('savedCameraHighlight').then(savedValue => {
                const enabled = savedValue !== false;
                settingsSavedCameraHighlight.checked = enabled;
                window._savedCameraHighlightEnabled = enabled;
                updateEventCameraHighlight?.();
            });
        } else {
            window._savedCameraHighlightEnabled = true;
        }
        
        settingsSavedCameraHighlight.addEventListener('change', async function() {
            window._savedCameraHighlightEnabled = this.checked;
            if (window.electronAPI?.setSetting) {
                await window.electronAPI.setSetting('savedCameraHighlight', this.checked);
            }
            updateEventCameraHighlight?.();
        });
    }
    
    // Reset camera order button (use onclick to prevent duplicate listeners)
    const resetCameraOrderBtn = $('resetCameraOrderBtn');
    if (resetCameraOrderBtn) {
        resetCameraOrderBtn.onclick = (e) => {
            e.preventDefault();
            resetCameraOrder?.();
        };
    }
    
    // Glass blur slider
    const settingsGlassBlur = $('settingsGlassBlur');
    const glassBlurValue = $('glassBlurValue');
    
    function applyGlassBlur(value) {
        document.documentElement.style.setProperty('--glass-blur', `${value}px`);
        if (glassBlurValue) glassBlurValue.textContent = `${value}px`;
        if (settingsGlassBlur) settingsGlassBlur.value = value;
    }
    
    if (window.electronAPI?.getSetting) {
        window.electronAPI.getSetting('glassBlur').then(savedValue => {
            applyGlassBlur(savedValue !== undefined ? savedValue : 7);
        });
    }
    
    if (settingsGlassBlur) {
        settingsGlassBlur.addEventListener('input', function() {
            applyGlassBlur(parseInt(this.value, 10));
        });
        
        settingsGlassBlur.addEventListener('change', async function() {
            if (window.electronAPI?.setSetting) {
                await window.electronAPI.setSetting('glassBlur', parseInt(this.value, 10));
            }
        });
    }
    
    // Hidden Developer Settings trigger - click Settings title 5 times
    const settingsModalHeader = settingsModal?.querySelector('.modal-header h2');
    let settingsTitleClickCount = 0;
    let settingsTitleClickTimer = null;
    
    if (settingsModalHeader) {
        settingsModalHeader.style.cursor = 'default';
        settingsModalHeader.addEventListener('click', (e) => {
            e.stopPropagation();
            settingsTitleClickCount++;
            
            clearTimeout(settingsTitleClickTimer);
            settingsTitleClickTimer = setTimeout(() => { settingsTitleClickCount = 0; }, 10000);
            
            if (settingsTitleClickCount >= 5) {
                settingsTitleClickCount = 0;
                closeSettings();
                openDevSettingsModal?.();
            }
        });
    }
}

/**
 * Initialize Developer Settings Modal
 */
export function initDevSettingsModal() {
    const devSettingsModal = $('devSettingsModal');
    const closeDevSettingsModal_btn = $('closeDevSettingsModal');
    const closeDevSettingsBtn = $('closeDevSettingsBtn');
    
    function closeDevSettings() {
        if (devSettingsModal) devSettingsModal.classList.add('hidden');
        const devOutput = $('devOutput');
        if (devOutput) devOutput.classList.add('hidden');
    }
    
    function showDevOutput(text) {
        const devOutput = $('devOutput');
        const devOutputText = $('devOutputText');
        if (devOutput && devOutputText) {
            devOutputText.textContent = text;
            devOutput.classList.remove('hidden');
        }
    }
    
    if (closeDevSettingsModal_btn) closeDevSettingsModal_btn.onclick = closeDevSettings;
    if (closeDevSettingsBtn) closeDevSettingsBtn.onclick = closeDevSettings;
    
    if (devSettingsModal) {
        devSettingsModal.onclick = (e) => {
            if (e.target === devSettingsModal) closeDevSettings();
        };
    }
    
    // Open DevTools
    const devOpenConsole = $('devOpenConsole');
    if (devOpenConsole) {
        devOpenConsole.onclick = async () => {
            if (window.electronAPI?.devOpenDevTools) {
                const result = await window.electronAPI.devOpenDevTools();
                showDevOutput(result.success ? 'DevTools opened successfully' : 'Error: ' + result.error);
            }
        };
    }
    
    // Reset Settings
    const devResetSettings = $('devResetSettings');
    if (devResetSettings) {
        devResetSettings.onclick = async () => {
            if (window.electronAPI?.devResetSettings) {
                if (confirm('Are you sure you want to reset all settings? This will reload the app.')) {
                    const result = await window.electronAPI.devResetSettings();
                    if (result.success) {
                        showDevOutput('Settings reset successfully.\nDeleted: ' + result.path + '\n\nReloading app...');
                        setTimeout(() => { window.electronAPI?.devReloadApp?.(); }, 1500);
                    } else {
                        showDevOutput('Error: ' + result.error);
                    }
                }
            }
        };
    }
    
    // Force Latest Version
    const devForceLatest = $('devForceLatest');
    if (devForceLatest) {
        devForceLatest.onclick = async () => {
            if (window.electronAPI?.devForceLatestVersion) {
                const result = await window.electronAPI.devForceLatestVersion();
                showDevOutput(result.success 
                    ? 'Version forced to latest: ' + result.version + '\n\nUpdate check will now pass.'
                    : 'Error: ' + result.error);
            }
        };
    }
    
    // Set Testing Version
    const devSetTesting = $('devSetTesting');
    if (devSetTesting) {
        devSetTesting.onclick = async () => {
            if (window.electronAPI?.devSetTestingVersion) {
                const result = await window.electronAPI.devSetTestingVersion();
                showDevOutput(result.success
                    ? 'Version set to: ' + result.version + '\n\nThis will trigger an update prompt on next check.'
                    : 'Error: ' + result.error);
            }
        };
    }
    
    // Show App Paths
    const devShowPaths = $('devShowPaths');
    if (devShowPaths) {
        devShowPaths.onclick = async () => {
            if (window.electronAPI?.devGetAppPaths) {
                const paths = await window.electronAPI.devGetAppPaths();
                showDevOutput(
                    'Application Paths:\n─────────────────────────────────\n' +
                    'User Data:  ' + paths.userData + '\n' +
                    'Settings:   ' + paths.settings + '\n' +
                    'Version:    ' + paths.version + '\n' +
                    'App:        ' + paths.app + '\n' +
                    'Temp:       ' + paths.temp
                );
            }
        };
    }
    
    // Reload App
    const devReloadApp = $('devReloadApp');
    if (devReloadApp) {
        devReloadApp.onclick = async () => {
            if (window.electronAPI?.devReloadApp) {
                showDevOutput('Reloading application...');
                setTimeout(() => { window.electronAPI.devReloadApp(); }, 500);
            }
        };
    }
    
    // Fake No GPU Toggle
    const devFakeNoGpu = $('devFakeNoGpu');
    if (devFakeNoGpu) {
        // Load current setting
        window.electronAPI?.getSetting?.('devFakeNoGpu').then(value => {
            devFakeNoGpu.checked = value === true;
        });
        
        devFakeNoGpu.onchange = async () => {
            const value = devFakeNoGpu.checked;
            await window.electronAPI?.setSetting?.('devFakeNoGpu', value);
            showDevOutput(value 
                ? 'Fake No GPU: ENABLED\n\nFFmpeg will report no GPU encoder.\nRe-open Export panel to see the effect.'
                : 'Fake No GPU: DISABLED\n\nGPU encoder detection restored.\nRe-open Export panel to see the effect.');
        };
    }
}

/**
 * Open the developer settings modal
 */
export function openDevSettings() {
    const devSettingsModal = $('devSettingsModal');
    if (devSettingsModal) devSettingsModal.classList.remove('hidden');
}
