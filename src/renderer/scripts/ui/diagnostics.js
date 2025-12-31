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
 * Get browser/renderer info
 */
function getRendererInfo() {
    return {
        userAgent: navigator.userAgent,
        platform: navigator.platform,
        language: navigator.language,
        cookiesEnabled: navigator.cookieEnabled,
        screenWidth: window.screen.width,
        screenHeight: window.screen.height,
        windowWidth: window.innerWidth,
        windowHeight: window.innerHeight,
        devicePixelRatio: window.devicePixelRatio,
        colorDepth: window.screen.colorDepth
    };
}

/**
 * Get current UI state snapshot
 */
function getUIState() {
    try {
        const state = {
            modalsOpen: [],
            videoLoaded: false,
            clipsLoaded: 0
        };

        // Check which modals are open
        document.querySelectorAll('.modal').forEach(modal => {
            if (!modal.classList.contains('hidden')) {
                state.modalsOpen.push(modal.id);
            }
        });

        // Check video state
        const video = document.getElementById('videoMain');
        if (video) {
            state.videoLoaded = video.src !== '' && !video.error;
            state.videoError = video.error ? video.error.message : null;
        }

        // Count clips
        const clipList = document.getElementById('clipList');
        if (clipList) {
            state.clipsLoaded = clipList.children.length;
        }

        return state;
    } catch (e) {
        return { error: e.message };
    }
}

/**
 * Collect all diagnostic data
 */
export async function collectDiagnostics() {
    const diagnostics = {
        v: 1, // Schema version
        ts: Date.now(),
        app: {},
        system: {},
        renderer: getRendererInfo(),
        ui: getUIState(),
        settings: {},
        logs: {
            console: logBuffer.console.slice(-1000), // Last 1000 logs
            errors: logBuffer.errors.slice(-200),    // Last 200 errors  
            events: logBuffer.events.slice(-100)     // Last 100 events
        }
    };

    // Get app info from main process
    try {
        if (window.electronAPI?.getDiagnostics) {
            const mainDiagnostics = await window.electronAPI.getDiagnostics();
            diagnostics.app = mainDiagnostics.app || {};
            diagnostics.system = mainDiagnostics.system || {};
            diagnostics.mainLogs = mainDiagnostics.logs || [];
        }
    } catch (e) {
        diagnostics.app.error = e.message;
    }

    // Get saved settings
    try {
        if (window.electronAPI?.getSetting) {
            const settingKeys = ['defaultFolder', 'useMetric', 'disableAutoUpdate'];
            for (const key of settingKeys) {
                diagnostics.settings[key] = await window.electronAPI.getSetting(key);
            }
        }
    } catch (e) {
        diagnostics.settings.error = e.message;
    }

    return diagnostics;
}

/**
 * Upload diagnostics and get the Support ID from paste.rs
 */
export async function uploadDiagnostics(diagnostics) {
    diagnostics.uploadedAt = new Date().toISOString();
    
    try {
        if (window.electronAPI?.uploadDiagnostics) {
            const result = await window.electronAPI.uploadDiagnostics(null, diagnostics);
            if (result.success && result.supportId) {
                return result.supportId; // This is the paste.rs URL ID
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
 * Retrieve diagnostics by Support ID
 */
export async function retrieveDiagnostics(supportId) {
    try {
        if (window.electronAPI?.retrieveDiagnostics) {
            const result = await window.electronAPI.retrieveDiagnostics(supportId);
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
            
            content.innerHTML = `<div class="decode-loading">Looking up Support ID...</div>`;
            output.classList.remove('hidden');
            
            try {
                const diagnostics = await retrieveDiagnostics(input);
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
 * Show decode tab content
 */
function showDecodeTab(tab, diagnostics, container) {
    switch (tab) {
        case 'summary':
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
                    <h4>Renderer Info</h4>
                    <table class="decode-table">
                        <tr><td>User Agent</td><td>${diagnostics.renderer?.userAgent || 'N/A'}</td></tr>
                        <tr><td>Screen</td><td>${diagnostics.renderer?.screenWidth}x${diagnostics.renderer?.screenHeight}</td></tr>
                        <tr><td>Window</td><td>${diagnostics.renderer?.windowWidth}x${diagnostics.renderer?.windowHeight}</td></tr>
                    </table>
                    <h4>UI State</h4>
                    <table class="decode-table">
                        <tr><td>Modals Open</td><td>${diagnostics.ui?.modalsOpen?.join(', ') || 'None'}</td></tr>
                        <tr><td>Video Loaded</td><td>${diagnostics.ui?.videoLoaded ? 'Yes' : 'No'}</td></tr>
                        <tr><td>Clips Loaded</td><td>${diagnostics.ui?.clipsLoaded || 0}</td></tr>
                    </table>
                    <h4>Statistics</h4>
                    <table class="decode-table">
                        <tr><td>Console Logs</td><td>${diagnostics.logs?.console?.length || 0}</td></tr>
                        <tr><td>Errors</td><td>${diagnostics.logs?.errors?.length || 0}</td></tr>
                        <tr><td>Events</td><td>${diagnostics.logs?.events?.length || 0}</td></tr>
                    </table>
                </div>
            `;
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
