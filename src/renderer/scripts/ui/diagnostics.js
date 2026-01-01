/**
 * Diagnostics & Support ID System
 * Collects logs, system info, and uploads to get short shareable Support IDs
 */

import { notify } from './notifications.js';

// Log buffer configuration - increased for comprehensive diagnostics
const MAX_LOG_ENTRIES = 2000;
const MAX_ERROR_ENTRIES = 500;

// In-memory log storage
const logBuffer = {
    console: [],
    errors: [],
    events: []
};

// Original console methods (preserved for passthrough)
const originalConsole = {
    log: console.log.bind(console),
    warn: console.warn.bind(console),
    error: console.error.bind(console),
    info: console.info.bind(console)
};

/**
 * Initialize console interceptor to capture logs
 */
export function initDiagnostics() {
    // Intercept console.log
    console.log = (...args) => {
        captureLog('log', args);
        originalConsole.log(...args);
    };

    // Intercept console.warn
    console.warn = (...args) => {
        captureLog('warn', args);
        originalConsole.warn(...args);
    };

    // Intercept console.error
    console.error = (...args) => {
        captureLog('error', args);
        captureError(args);
        originalConsole.error(...args);
    };

    // Intercept console.info
    console.info = (...args) => {
        captureLog('info', args);
        originalConsole.info(...args);
    };

    // Capture uncaught errors
    window.addEventListener('error', (event) => {
        captureError([`Uncaught: ${event.message}`, `at ${event.filename}:${event.lineno}:${event.colno}`]);
    });

    // Capture unhandled promise rejections
    window.addEventListener('unhandledrejection', (event) => {
        captureError([`Unhandled Promise Rejection: ${event.reason}`]);
    });

    originalConsole.log('[Diagnostics] Console capture initialized');
}

/**
 * Capture a log entry
 */
function captureLog(level, args) {
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

    logBuffer.console.push(entry);
    
    // Trim buffer if needed
    if (logBuffer.console.length > MAX_LOG_ENTRIES) {
        logBuffer.console.shift();
    }
}

/**
 * Capture an error entry
 */
function captureError(args) {
    const entry = {
        t: Date.now(),
        m: args.map(arg => {
            try {
                if (arg instanceof Error) {
                    return `${arg.name}: ${arg.message}\n${arg.stack || ''}`;
                }
                if (typeof arg === 'object') {
                    return JSON.stringify(arg, null, 0).substring(0, 1000);
                }
                return String(arg).substring(0, 1000);
            } catch {
                return '[Unserializable]';
            }
        }).join(' ')
    };

    logBuffer.errors.push(entry);
    
    // Trim buffer if needed
    if (logBuffer.errors.length > MAX_ERROR_ENTRIES) {
        logBuffer.errors.shift();
    }
}

/**
 * Log a diagnostic event (for specific tracking)
 */
export function logDiagnosticEvent(eventName, data = {}) {
    logBuffer.events.push({
        t: Date.now(),
        e: eventName,
        d: data
    });
    
    // Keep last 50 events
    if (logBuffer.events.length > 50) {
        logBuffer.events.shift();
    }
}

/**
 * Redact username from file paths for privacy
 * @param {string} filePath - Original file path
 * @returns {string} Path with username redacted
 */
function redactUsername(filePath) {
    if (!filePath) return null;
    // Windows: C:\Users\USERNAME\... -> C:\Users\[REDACTED]\...
    // macOS: /Users/USERNAME/... -> /Users/[REDACTED]/...
    // Linux: /home/USERNAME/... -> /home/[REDACTED]/...
    return filePath
        .replace(/^([A-Za-z]:\\Users\\)[^\\]+/, '$1[REDACTED]')
        .replace(/^(\/Users\/)[^\/]+/, '$1[REDACTED]')
        .replace(/^(\/home\/)[^\/]+/, '$1[REDACTED]');
}

/**
 * Collect all diagnostic data (minimal, privacy-focused)
 */
export async function collectDiagnostics() {
    const diagnostics = {
        v: 2, // Schema version - updated for minimal data
        ts: Date.now(),
        os: null,
        appVersion: null,
        pendingUpdate: false,
        settings: {},
        hardware: {},
        logs: {
            console: logBuffer.console.slice(-500), // DevTools console logs
            errors: logBuffer.errors.slice(-100)    // Errors only
        },
        terminalLogs: [] // Main process logs
    };

    // Get app info from main process
    try {
        if (window.electronAPI?.getDiagnostics) {
            const mainData = await window.electronAPI.getDiagnostics();
            diagnostics.os = mainData.os || null;
            diagnostics.appVersion = mainData.appVersion || null;
            diagnostics.pendingUpdate = mainData.pendingUpdate || false;
            diagnostics.hardware = mainData.hardware || {};
            diagnostics.terminalLogs = mainData.logs || [];
        }
    } catch (e) {
        diagnostics.error = e.message;
    }

    // Get saved settings (only the specified ones)
    try {
        if (window.electronAPI?.getSetting) {
            // Core settings
            diagnostics.settings.useMetric = await window.electronAPI.getSetting('useMetric') || false;
            diagnostics.settings.glassBlur = await window.electronAPI.getSetting('glassBlur') ?? 7;
            diagnostics.settings.disableAutoUpdate = await window.electronAPI.getSetting('disableAutoUpdate') || false;
            
            // UI toggles - get from state or settings
            diagnostics.settings.classicSidebar = await window.electronAPI.getSetting('layoutStyle') === 'classic';
            
            // Default folder (redacted for privacy)
            const defaultFolder = await window.electronAPI.getSetting('defaultFolder');
            diagnostics.settings.defaultFolder = redactUsername(defaultFolder);
            
            // Keybinds - only show which actions have shortcuts set (not the actual keys for privacy)
            const keybinds = await window.electronAPI.getSetting('keybinds');
            if (keybinds && typeof keybinds === 'object') {
                diagnostics.settings.shortcutsConfigured = Object.keys(keybinds);
            } else {
                diagnostics.settings.shortcutsConfigured = [];
            }
        }
    } catch (e) {
        diagnostics.settings.error = e.message;
    }
    
    // Get GPS/Dashboard toggle status from current UI state
    try {
        const dashboardToggle = document.getElementById('dashboardToggle');
        const mapToggle = document.getElementById('mapToggle');
        diagnostics.settings.dashboardEnabled = dashboardToggle?.checked ?? null;
        diagnostics.settings.gpsEnabled = mapToggle?.checked ?? null;
    } catch { /* ignore */ }

    return diagnostics;
}

/**
 * Upload diagnostics to support server
 */
export async function uploadDiagnostics(diagnostics) {
    diagnostics.uploadedAt = new Date().toISOString();
    
    try {
        if (window.electronAPI?.uploadDiagnostics) {
            const result = await window.electronAPI.uploadDiagnostics(null, diagnostics);
            if (result.success && result.supportId) {
                return result.supportId;
            }
            throw new Error(result.error || 'Upload failed');
        }
        throw new Error('Upload service not available');
    } catch (e) {
        originalConsole.error('[Diagnostics] Upload failed:', e.message);
        throw e;
    }
}

/**
 * Retrieve diagnostics by Support ID (requires passcode)
 */
export async function retrieveDiagnostics(supportId, passcode) {
    try {
        if (window.electronAPI?.retrieveDiagnostics) {
            const result = await window.electronAPI.retrieveDiagnostics(supportId, passcode);
            if (result.success) {
                return result.data;
            }
            throw new Error(result.error || 'Retrieval failed');
        }
        throw new Error('Retrieval service not available');
    } catch (e) {
        originalConsole.error('[Diagnostics] Retrieval failed:', e.message);
        throw e;
    }
}

/**
 * Show passcode input prompt
 */
function showPasscodePrompt() {
    return new Promise((resolve) => {
        let modal = document.getElementById('passcodeModal');
        if (!modal) {
            modal = document.createElement('div');
            modal.id = 'passcodeModal';
            modal.className = 'modal';
            modal.innerHTML = `
                <div class="modal-content" style="max-width: 350px;">
                    <div class="modal-header">
                        <svg class="modal-header-icon" viewBox="0 0 24 24" fill="currentColor" style="color: #9c27b0;">
                            <path d="M18 8h-1V6c0-2.76-2.24-5-5-5S7 3.24 7 6v2H6c-1.1 0-2 .9-2 2v10c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V10c0-1.1-.9-2-2-2zm-6 9c-1.1 0-2-.9-2-2s.9-2 2-2 2 .9 2 2-.9 2-2 2zm3.1-9H8.9V6c0-1.71 1.39-3.1 3.1-3.1 1.71 0 3.1 1.39 3.1 3.1v2z"/>
                        </svg>
                        <h2>Developer Access</h2>
                        <button id="closePasscodeModal" class="modal-close">&times;</button>
                    </div>
                    <div class="modal-body" style="text-align: center; padding: 20px;">
                        <p style="margin-bottom: 15px; color: var(--text-secondary);">Enter the 4-digit passcode to view support data.</p>
                        <input type="password" id="passcodeInput" maxlength="4" pattern="[0-9]{4}" 
                               style="font-size: 24px; text-align: center; width: 120px; padding: 10px; letter-spacing: 8px;"
                               placeholder="••••" autocomplete="off">
                        <div style="margin-top: 20px; display: flex; gap: 10px; justify-content: center;">
                            <button id="passcodeCancel" class="btn btn-secondary">Cancel</button>
                            <button id="passcodeSubmit" class="btn btn-primary">Submit</button>
                        </div>
                    </div>
                </div>
            `;
            document.body.appendChild(modal);
        }
        
        const input = modal.querySelector('#passcodeInput');
        const submitBtn = modal.querySelector('#passcodeSubmit');
        const cancelBtn = modal.querySelector('#passcodeCancel');
        const closeBtn = modal.querySelector('#closePasscodeModal');
        
        input.value = '';
        modal.style.display = 'flex';
        setTimeout(() => input.focus(), 100);
        
        const cleanup = () => {
            modal.style.display = 'none';
            input.removeEventListener('keydown', onKeydown);
            submitBtn.removeEventListener('click', onSubmit);
            cancelBtn.removeEventListener('click', onCancel);
            closeBtn.removeEventListener('click', onCancel);
        };
        
        const onSubmit = () => {
            const value = input.value.trim();
            if (value.length === 4 && /^\d{4}$/.test(value)) {
                cleanup();
                resolve(value);
            } else {
                input.style.borderColor = 'red';
                setTimeout(() => input.style.borderColor = '', 1000);
            }
        };
        
        const onCancel = () => {
            cleanup();
            resolve(null);
        };
        
        const onKeydown = (e) => {
            if (e.key === 'Enter') onSubmit();
            if (e.key === 'Escape') onCancel();
        };
        
        input.addEventListener('keydown', onKeydown);
        submitBtn.addEventListener('click', onSubmit);
        cancelBtn.addEventListener('click', onCancel);
        closeBtn.addEventListener('click', onCancel);
    });
}

/**
 * Generate a Support ID, upload, and copy to clipboard
 */
export async function generateSupportId() {
    try {
        notify('Collecting diagnostic data...', { type: 'info' });
        const diagnostics = await collectDiagnostics();
        
        notify('Uploading diagnostics...', { type: 'info' });
        const supportId = await uploadDiagnostics(diagnostics);
        
        await navigator.clipboard.writeText(supportId);
        notify(`Support ID: ${supportId} - Copied to clipboard!`, { type: 'success', timeoutMs: 5000 });
        
        return supportId;
    } catch (e) {
        notify('Failed to upload diagnostics: ' + e.message, { type: 'error' });
        throw e;
    }
}

/**
 * Show Support ID in a modal dialog
 */
export async function showSupportIdDialog() {
    let supportId = null;
    let diagnostics = null;
    let uploadError = null;
    
    try {
        notify('Collecting diagnostic data...', { type: 'info' });
        diagnostics = await collectDiagnostics();
        
        notify('Uploading diagnostics...', { type: 'info' });
        supportId = await uploadDiagnostics(diagnostics);
    } catch (e) {
        uploadError = e.message;
        notify('Upload failed: ' + e.message, { type: 'error' });
        return; // Can't show dialog without a valid Support ID
    }
    
    try {
        
        // Create modal
        let modal = document.getElementById('supportIdModal');
        if (!modal) {
            modal = document.createElement('div');
            modal.id = 'supportIdModal';
            modal.className = 'modal';
            modal.innerHTML = `
                <div class="modal-content support-id-modal">
                    <div class="modal-header">
                        <svg class="modal-header-icon" viewBox="0 0 24 24" fill="currentColor" style="color: #2196f3;">
                            <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 17h-2v-2h2v2zm2.07-7.75l-.9.92C13.45 12.9 13 13.5 13 15h-2v-.5c0-1.1.45-2.1 1.17-2.83l1.24-1.26c.37-.36.59-.86.59-1.41 0-1.1-.9-2-2-2s-2 .9-2 2H8c0-2.21 1.79-4 4-4s4 1.79 4 4c0 .88-.36 1.68-.93 2.25z"/>
                        </svg>
                        <h2>Support ID</h2>
                        <button id="closeSupportIdModal" class="modal-close">&times;</button>
                    </div>
                    <div class="modal-body modal-body-padded">
                        <p class="support-id-info">
                            Share this Support ID with developers to help troubleshoot issues.
                            The diagnostic data has been uploaded securely.
                        </p>
                        <div id="supportIdError" class="support-id-error hidden"></div>
                        <div class="support-id-container">
                            <div class="support-id-display">
                                <span id="supportIdValue" class="support-id-value"></span>
                            </div>
                            <div class="support-id-actions">
                                <button id="copySupportId" class="btn btn-primary">
                                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                        <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
                                        <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
                                    </svg>
                                    Copy ID
                                </button>
                            </div>
                        </div>
                        <div class="support-id-stats">
                            <span class="stat-item">
                                <strong>Logs:</strong> ${diagnostics.logs.console.length}
                            </span>
                            <span class="stat-item">
                                <strong>Errors:</strong> ${diagnostics.logs.errors.length}
                            </span>
                            <span class="stat-item">
                                <strong>Size:</strong> ${(supportId.length / 1024).toFixed(1)} KB
                            </span>
                        </div>
                    </div>
                    <div class="modal-footer">
                        <button id="closeSupportIdBtn" class="btn btn-secondary">Close</button>
                    </div>
                </div>
            `;
            document.body.appendChild(modal);
            
            // Event listeners
            modal.querySelector('#closeSupportIdModal').onclick = () => modal.classList.add('hidden');
            modal.querySelector('#closeSupportIdBtn').onclick = () => modal.classList.add('hidden');
            modal.onclick = (e) => { if (e.target === modal) modal.classList.add('hidden'); };
            
            modal.querySelector('#copySupportId').onclick = async () => {
                const idText = modal.querySelector('#supportIdValue').textContent;
                try {
                    await navigator.clipboard.writeText(idText);
                    notify('Support ID copied to clipboard!', { type: 'success' });
                } catch (e) {
                    notify('Failed to copy: ' + e.message, { type: 'error' });
                }
            };
        }
        
        // Set the support ID
        modal.querySelector('#supportIdValue').textContent = supportId;
        
        // Hide error element (not needed for successful uploads)
        const errorEl = modal.querySelector('#supportIdError');
        if (errorEl) errorEl.classList.add('hidden');
        
        // Update stats
        const statsContainer = modal.querySelector('.support-id-stats');
        if (statsContainer) {
            statsContainer.innerHTML = `
                <span class="stat-item"><strong>Logs:</strong> ${diagnostics.logs?.console?.length || 0}</span>
                <span class="stat-item"><strong>Errors:</strong> ${diagnostics.logs?.errors?.length || 0}</span>
                <span class="stat-item"><strong>Status:</strong> Uploaded</span>
            `;
        }
        
        // Show modal
        modal.classList.remove('hidden');
        
        return supportId;
    } catch (e) {
        console.error('Failed to show Support ID dialog:', e);
        notify('Failed to generate Support ID: ' + e.message, { type: 'error' });
        throw e;
    }
}

/**
 * Lookup and display diagnostics for a Support ID (for developers)
 */
export function showDecodeSupportIdDialog() {
    let modal = document.getElementById('decodeSupportIdModal');
    if (!modal) {
        modal = document.createElement('div');
        modal.id = 'decodeSupportIdModal';
        modal.className = 'modal';
        modal.innerHTML = `
            <div class="modal-content decode-support-id-modal">
                <div class="modal-header">
                    <svg class="modal-header-icon" viewBox="0 0 24 24" fill="currentColor" style="color: #9c27b0;">
                        <path d="M9.4 16.6L4.8 12l4.6-4.6L8 6l-6 6 6 6 1.4-1.4zm5.2 0l4.6-4.6-4.6-4.6L16 6l6 6-6 6-1.4-1.4z"/>
                    </svg>
                    <h2>Decode Support ID</h2>
                    <button id="closeDecodeSupportIdModal" class="modal-close">&times;</button>
                </div>
                <div class="modal-body modal-body-padded">
                    <div class="decode-input-section">
                        <label for="decodeSupportIdInput">Paste Support ID:</label>
                        <textarea id="decodeSupportIdInput" class="support-id-text" placeholder="S6-..."></textarea>
                        <button id="decodeBtn" class="btn btn-primary">Decode</button>
                    </div>
                    <div id="decodeOutput" class="decode-output hidden">
                        <div class="decode-tabs">
                            <button class="decode-tab active" data-tab="summary">Summary</button>
                            <button class="decode-tab" data-tab="logs">Console Logs</button>
                            <button class="decode-tab" data-tab="errors">Errors</button>
                            <button class="decode-tab" data-tab="raw">Raw JSON</button>
                        </div>
                        <div id="decodeContent" class="decode-content"></div>
                    </div>
                </div>
                <div class="modal-footer">
                    <button id="closeDecodeBtn" class="btn btn-secondary">Close</button>
                </div>
            </div>
        `;
        document.body.appendChild(modal);
        
        // Event listeners
        modal.querySelector('#closeDecodeSupportIdModal').onclick = () => modal.classList.add('hidden');
        modal.querySelector('#closeDecodeBtn').onclick = () => modal.classList.add('hidden');
        modal.onclick = (e) => { if (e.target === modal) modal.classList.add('hidden'); };
        
        // Decode/Lookup button
        modal.querySelector('#decodeBtn').onclick = async () => {
            const input = modal.querySelector('#decodeSupportIdInput').value.trim();
            const output = modal.querySelector('#decodeOutput');
            const content = modal.querySelector('#decodeContent');
            
            if (!input) {
                output.classList.remove('hidden');
                content.innerHTML = `<div class="decode-error">Please enter a Support ID</div>`;
                return;
            }
            
            // Prompt for passcode
            const passcode = await showPasscodePrompt();
            if (!passcode) {
                return; // User cancelled
            }
            
            content.innerHTML = `<div class="decode-loading">Looking up Support ID...</div>`;
            output.classList.remove('hidden');
            
            try {
                const diagnostics = await retrieveDiagnostics(input, passcode);
                output.dataset.diagnostics = JSON.stringify(diagnostics);
                
                // Show summary by default
                showDecodeTab('summary', diagnostics, content);
                
                // Tab handlers
                modal.querySelectorAll('.decode-tab').forEach(tab => {
                    tab.onclick = () => {
                        modal.querySelectorAll('.decode-tab').forEach(t => t.classList.remove('active'));
                        tab.classList.add('active');
                        showDecodeTab(tab.dataset.tab, diagnostics, content);
                    };
                });
                
            } catch (e) {
                content.innerHTML = `<div class="decode-error">Error: ${e.message}</div>`;
            }
        };
    }
    
    // Reset and show
    modal.querySelector('#decodeSupportIdInput').value = '';
    modal.querySelector('#decodeOutput').classList.add('hidden');
    modal.classList.remove('hidden');
}

/**
 * Format bytes to human readable
 */
function formatBytes(bytes) {
    if (!bytes) return 'N/A';
    const gb = bytes / (1024 ** 3);
    return gb >= 1 ? `${gb.toFixed(1)} GB` : `${Math.round(bytes / (1024 ** 2))} MB`;
}

/**
 * Show decode tab content (supports both v1 and v2 schemas)
 */
function showDecodeTab(tab, diagnostics, container) {
    // Detect schema version
    const isV2 = diagnostics.v >= 2;
    
    switch (tab) {
        case 'summary':
            if (isV2) {
                // New minimal schema v2
                container.innerHTML = `
                    <div class="decode-summary">
                        <h4>System Info</h4>
                        <table class="decode-table">
                            <tr><td>App Version</td><td>${diagnostics.appVersion || 'N/A'}</td></tr>
                            <tr><td>OS</td><td>${diagnostics.os || 'N/A'}</td></tr>
                            <tr><td>Pending Update</td><td>${diagnostics.pendingUpdate ? 'Yes' : 'No'}</td></tr>
                            <tr><td>Timestamp</td><td>${new Date(diagnostics.ts).toLocaleString()}</td></tr>
                        </table>
                        <h4>Hardware</h4>
                        <table class="decode-table">
                            <tr><td>CPU</td><td>${diagnostics.hardware?.cpuModel || 'N/A'}</td></tr>
                            <tr><td>RAM Total</td><td>${formatBytes(diagnostics.hardware?.ramTotal)}</td></tr>
                            <tr><td>RAM Free</td><td>${formatBytes(diagnostics.hardware?.ramFree)}</td></tr>
                            <tr><td>GPU Detected</td><td>${diagnostics.hardware?.gpuDetected ? 'Yes' : 'No'}</td></tr>
                            <tr><td>GPU Model</td><td>${diagnostics.hardware?.gpuModel || 'N/A'}</td></tr>
                            <tr><td>FFmpeg</td><td>${diagnostics.hardware?.ffmpegDetected ? 'Detected' : 'Not Found'}</td></tr>
                        </table>
                        <h4>Settings</h4>
                        <table class="decode-table">
                            <tr><td>Metric Units</td><td>${diagnostics.settings?.useMetric ? 'Yes' : 'No'}</td></tr>
                            <tr><td>Glass Blur</td><td>${diagnostics.settings?.glassBlur ?? 'N/A'}px</td></tr>
                            <tr><td>Dashboard</td><td>${diagnostics.settings?.dashboardEnabled === null ? 'N/A' : (diagnostics.settings?.dashboardEnabled ? 'On' : 'Off')}</td></tr>
                            <tr><td>GPS/Map</td><td>${diagnostics.settings?.gpsEnabled === null ? 'N/A' : (diagnostics.settings?.gpsEnabled ? 'On' : 'Off')}</td></tr>
                            <tr><td>Classic Sidebar</td><td>${diagnostics.settings?.classicSidebar ? 'Yes' : 'No'}</td></tr>
                            <tr><td>Auto Update</td><td>${diagnostics.settings?.disableAutoUpdate ? 'Disabled' : 'Enabled'}</td></tr>
                            <tr><td>Default Folder</td><td>${diagnostics.settings?.defaultFolder || '(not set)'}</td></tr>
                            <tr><td>Shortcuts</td><td>${diagnostics.settings?.shortcutsConfigured?.length || 0} configured</td></tr>
                        </table>
                        <h4>Logs</h4>
                        <table class="decode-table">
                            <tr><td>Console Logs</td><td>${diagnostics.logs?.console?.length || 0}</td></tr>
                            <tr><td>Errors</td><td>${diagnostics.logs?.errors?.length || 0}</td></tr>
                            <tr><td>Terminal Logs</td><td>${diagnostics.terminalLogs?.length || 0}</td></tr>
                        </table>
                    </div>
                `;
            } else {
                // Legacy schema v1
                container.innerHTML = `
                    <div class="decode-summary">
                        <h4>System Info</h4>
                        <table class="decode-table">
                            <tr><td>App Version</td><td>${diagnostics.app?.version || 'N/A'}</td></tr>
                            <tr><td>OS</td><td>${diagnostics.system?.platform || 'N/A'} ${diagnostics.system?.release || ''}</td></tr>
                            <tr><td>Arch</td><td>${diagnostics.system?.arch || 'N/A'}</td></tr>
                            <tr><td>Memory</td><td>${diagnostics.system?.totalMemory ? Math.round(diagnostics.system.totalMemory / 1024 / 1024 / 1024) + ' GB' : 'N/A'}</td></tr>
                            <tr><td>Timestamp</td><td>${new Date(diagnostics.ts).toLocaleString()}</td></tr>
                        </table>
                        <h4>Statistics</h4>
                        <table class="decode-table">
                            <tr><td>Console Logs</td><td>${diagnostics.logs?.console?.length || 0}</td></tr>
                            <tr><td>Errors</td><td>${diagnostics.logs?.errors?.length || 0}</td></tr>
                        </table>
                    </div>
                `;
            }
            break;
            
        case 'logs':
            const logs = diagnostics.logs?.console || [];
            container.innerHTML = `
                <div class="decode-logs">
                    ${logs.length === 0 ? '<p>No logs captured</p>' : ''}
                    ${logs.map(log => `
                        <div class="log-entry log-${log.l}">
                            <span class="log-time">${new Date(log.t).toLocaleTimeString()}</span>
                            <span class="log-level">[${log.l.toUpperCase()}]</span>
                            <span class="log-msg">${escapeHtml(log.m)}</span>
                        </div>
                    `).join('')}
                </div>
            `;
            break;
            
        case 'errors':
            const errors = diagnostics.logs?.errors || [];
            container.innerHTML = `
                <div class="decode-errors">
                    ${errors.length === 0 ? '<p>No errors captured</p>' : ''}
                    ${errors.map(err => `
                        <div class="error-entry">
                            <span class="error-time">${new Date(err.t).toLocaleTimeString()}</span>
                            <pre class="error-msg">${escapeHtml(err.m)}</pre>
                        </div>
                    `).join('')}
                </div>
            `;
            break;
            
        case 'raw':
            container.innerHTML = `
                <pre class="decode-raw">${escapeHtml(JSON.stringify(diagnostics, null, 2))}</pre>
            `;
            break;
    }
}

/**
 * Escape HTML for safe display
 */
function escapeHtml(str) {
    if (!str) return '';
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

/**
 * Clear log buffers (useful for testing)
 */
export function clearDiagnosticLogs() {
    logBuffer.console = [];
    logBuffer.errors = [];
    logBuffer.events = [];
    originalConsole.log('[Diagnostics] Log buffers cleared');
}
