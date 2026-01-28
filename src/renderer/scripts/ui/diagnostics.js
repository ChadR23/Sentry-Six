/**
 * Diagnostics & Support ID System
 * Collects logs, system info, and uploads to get short shareable Support IDs
 */

import { notify } from './notifications.js';
import { t } from '../lib/i18n.js';

// In-memory log storage (no limits - VPS has sufficient bandwidth/storage)
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

    logBuffer.console.push(entry);
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
                    return JSON.stringify(arg, null, 0);
                }
                return String(arg);
            } catch {
                return '[Unserializable]';
            }
        }).join(' ')
    };

    logBuffer.errors.push(entry);
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
}

/**
 * Redact sensitive information from strings for privacy
 * - Usernames in file paths
 * - GPS coordinates and addresses from event.json location logs
 * @param {string} str - Original string (path or log message)
 * @returns {string} String with sensitive info redacted
 */
function redactSensitiveInfo(str) {
    if (!str) return null;
    
    let result = str;
    
    // Redact usernames in file paths (handles both regular and JSON-escaped paths)
    // Windows: C:\Users\USERNAME\... -> C:\Users\[REDACTED]\...
    // Windows JSON: C:\\Users\\USERNAME\\... -> C:\\Users\\[REDACTED]\\...
    // macOS: /Users/USERNAME/... -> /Users/[REDACTED]/...
    // Linux: /home/USERNAME/... -> /home/[REDACTED]/...
    result = result
        // Windows paths with escaped backslashes (JSON): C:\\Users\\USERNAME\\
        .replace(/([A-Za-z]:\\\\Users\\\\)([^\\"\s]+)/g, '$1[REDACTED]')
        // Windows paths with single backslashes: C:\Users\USERNAME\
        .replace(/([A-Za-z]:\\Users\\)([^\\\s"']+)/g, '$1[REDACTED]')
        // macOS paths
        .replace(/(\/Users\/)([^\/\s"']+)/g, '$1[REDACTED]')
        // Linux paths
        .replace(/(\/home\/)([^\/\s"']+)/g, '$1[REDACTED]');
    
    // Redact GPS coordinates and addresses from event.json location logs
    // Pattern: "Showing event.json location: LAT LONG ADDRESS" -> "Showing event.json location: [LOCATION REDACTED]"
    result = result.replace(
        /((?:showing|event\.json|location)[:\s]+)(-?\d+\.\d+\s+-?\d+\.\d+.*?)$/gi,
        '$1[LOCATION REDACTED]'
    );
    
    // Also catch standalone GPS coordinates (lat/long pairs)
    // Pattern: two decimal numbers that look like coordinates
    result = result.replace(
        /(location[:\s]+)(-?\d{1,3}\.\d{3,}\s+-?\d{1,3}\.\d{3,})/gi,
        '$1[COORDS REDACTED]'
    );
    
    return result;
}

/**
 * Redact usernames from all log entries
 * @param {Array} logs - Array of log entries
 * @returns {Array} Logs with usernames redacted
 */
/**
 * Redact sensitive info from all log entries
 * @param {Array} logs - Array of log entries
 * @returns {Array} Logs with sensitive info redacted
 */
function redactLogs(logs) {
    if (!Array.isArray(logs)) return logs;
    return logs.map(log => ({
        ...log,
        m: redactSensitiveInfo(log.m) || log.m
    }));
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
            console: redactLogs(logBuffer.console.slice()), // All DevTools console logs (redacted)
            errors: redactLogs(logBuffer.errors.slice())    // All errors (redacted)
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
            diagnostics.terminalLogs = redactLogs(mainData.logs || []);
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
 * Generate a Support ID, upload, and copy to clipboard
 */
export async function generateSupportId() {
    try {
        notify(t('ui.notifications.collectingDiagnostics'), { type: 'info' });
        const diagnostics = await collectDiagnostics();
        
        notify(t('ui.notifications.uploadingDiagnostics'), { type: 'info' });
        const supportId = await uploadDiagnostics(diagnostics);
        
        await navigator.clipboard.writeText(supportId);
        notify(t('ui.notifications.supportIdCopied', { supportId }), { type: 'success', timeoutMs: 5000 });
        
        return supportId;
    } catch (e) {
        notify(t('ui.notifications.failedToUploadDiagnostics', { error: e.message }), { type: 'error' });
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
        notify(t('ui.notifications.collectingDiagnostics'), { type: 'info' });
        diagnostics = await collectDiagnostics();
        
        notify(t('ui.notifications.uploadingDiagnostics'), { type: 'info' });
        supportId = await uploadDiagnostics(diagnostics);
    } catch (e) {
        uploadError = e.message;
        notify(t('ui.notifications.uploadFailed', { error: e.message }), { type: 'error' });
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
                        <a href="https://discord.com/invite/9QZEzVwdnt" target="_blank" class="btn btn-discord" id="joinDiscordBtn">
                            <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
                                <path d="M20.317 4.37a19.791 19.791 0 0 0-4.885-1.515.074.074 0 0 0-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 0 0-5.487 0 12.64 12.64 0 0 0-.617-1.25.077.077 0 0 0-.079-.037A19.736 19.736 0 0 0 3.677 4.37a.07.07 0 0 0-.032.027C.533 9.046-.32 13.58.099 18.057a.082.082 0 0 0 .031.057 19.9 19.9 0 0 0 5.993 3.03.078.078 0 0 0 .084-.028 14.09 14.09 0 0 0 1.226-1.994.076.076 0 0 0-.041-.106 13.107 13.107 0 0 1-1.872-.892.077.077 0 0 1-.008-.128 10.2 10.2 0 0 0 .372-.292.074.074 0 0 1 .077-.01c3.928 1.793 8.18 1.793 12.062 0a.074.074 0 0 1 .078.01c.12.098.246.198.373.292a.077.077 0 0 1-.006.127 12.299 12.299 0 0 1-1.873.892.077.077 0 0 0-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0 .084.028 19.839 19.839 0 0 0 6.002-3.03.077.077 0 0 0 .032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 0 0-.031-.03zM8.02 15.33c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.956-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.956 2.418-2.157 2.418zm7.975 0c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.955-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.946 2.418-2.157 2.418z"/>
                            </svg>
                            Join Discord for Support
                        </a>
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
                    notify(t('ui.notifications.supportIdCopiedSimple'), { type: 'success' });
                } catch (e) {
                    notify(t('ui.notifications.failedToCopy', { error: e.message }), { type: 'error' });
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
        notify(t('ui.notifications.failedToGenerateSupportId', { error: e.message }), { type: 'error' });
        throw e;
    }
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
