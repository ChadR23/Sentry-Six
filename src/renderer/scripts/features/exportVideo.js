/**
 * Export Video Functions
 * Handles video export with FFmpeg, markers, and progress tracking
 */

import { notify } from '../ui/notifications.js';
import { formatTimeHMS } from '../ui/timeDisplay.js';

// Export state
export const exportState = {
    startMarkerPct: null,
    endMarkerPct: null,
    isExporting: false,
    currentExportId: null,
    ffmpegAvailable: false
};

// DOM helper
const $ = id => document.getElementById(id);

// Dependencies set via init
let getState = null;
let getNativeVideo = null;
let getBaseFolderPath = null;
let getProgressBar = null;
let getFindSeiAtTime = null;

/**
 * Initialize export module with dependencies
 * @param {Object} deps - Dependencies
 */
export function initExportModule(deps) {
    getState = deps.getState;
    getNativeVideo = deps.getNativeVideo;
    getBaseFolderPath = deps.getBaseFolderPath;
    getProgressBar = deps.getProgressBar;
    getFindSeiAtTime = deps.getFindSeiAtTime;
}

/**
 * Set an export marker at current position
 * @param {string} type - 'start' or 'end'
 */
export function setExportMarker(type) {
    const state = getState?.();
    const progressBar = getProgressBar?.();
    
    if (!state?.collection?.active) {
        notify('Load a collection first to set export markers', { type: 'warn' });
        return;
    }
    
    const currentPct = parseFloat(progressBar?.value) || 0;
    
    if (type === 'start') {
        exportState.startMarkerPct = currentPct;
        if (exportState.endMarkerPct !== null && exportState.endMarkerPct <= currentPct) {
            exportState.endMarkerPct = null;
        }
        notify('Start marker set', { type: 'success' });
    } else {
        exportState.endMarkerPct = currentPct;
        if (exportState.startMarkerPct !== null && exportState.startMarkerPct >= currentPct) {
            exportState.startMarkerPct = null;
        }
        notify('End marker set', { type: 'success' });
    }
    
    updateExportMarkers();
    updateExportButtonState();
}

/**
 * Update visual export markers on timeline
 */
export function updateExportMarkers() {
    const markersContainer = $('timelineMarkers');
    if (!markersContainer) return;
    
    // Get or create start marker
    let startMarker = markersContainer.querySelector('.export-marker.start');
    if (exportState.startMarkerPct !== null) {
        if (!startMarker) {
            startMarker = document.createElement('div');
            startMarker.className = 'export-marker start';
            startMarker.title = 'Export start point (drag to adjust)';
            makeMarkerDraggable(startMarker, 'start');
            markersContainer.appendChild(startMarker);
        }
        startMarker.style.left = `${exportState.startMarkerPct}%`;
    } else if (startMarker) {
        startMarker.remove();
    }
    
    // Get or create end marker
    let endMarker = markersContainer.querySelector('.export-marker.end');
    if (exportState.endMarkerPct !== null) {
        if (!endMarker) {
            endMarker = document.createElement('div');
            endMarker.className = 'export-marker end';
            endMarker.title = 'Export end point (drag to adjust)';
            makeMarkerDraggable(endMarker, 'end');
            markersContainer.appendChild(endMarker);
        }
        endMarker.style.left = `${exportState.endMarkerPct}%`;
    } else if (endMarker) {
        endMarker.remove();
    }
    
    // Get or create highlight between markers
    let highlight = markersContainer.querySelector('.export-range-highlight');
    if (exportState.startMarkerPct !== null && exportState.endMarkerPct !== null) {
        if (!highlight) {
            highlight = document.createElement('div');
            highlight.className = 'export-range-highlight';
            markersContainer.appendChild(highlight);
        }
        const startPct = Math.min(exportState.startMarkerPct, exportState.endMarkerPct);
        const endPct = Math.max(exportState.startMarkerPct, exportState.endMarkerPct);
        highlight.style.left = `${startPct}%`;
        highlight.style.width = `${endPct - startPct}%`;
    } else if (highlight) {
        highlight.remove();
    }
}

function makeMarkerDraggable(marker, type) {
    let isDragging = false;
    
    marker.addEventListener('mousedown', (e) => {
        isDragging = true;
        marker.style.cursor = 'grabbing';
        e.preventDefault();
        e.stopPropagation();
        
        const onMouseMove = (moveEvent) => {
            if (!isDragging) return;
            const timelineContainer = marker.closest('.timeline-container');
            if (!timelineContainer) return;
            
            const rect = timelineContainer.getBoundingClientRect();
            const pct = Math.max(0, Math.min(100, ((moveEvent.clientX - rect.left) / rect.width) * 100));
            
            if (type === 'start') {
                exportState.startMarkerPct = pct;
            } else {
                exportState.endMarkerPct = pct;
            }
            
            updateExportMarkers();
        };
        
        const onMouseUp = () => {
            isDragging = false;
            marker.style.cursor = 'ew-resize';
            document.removeEventListener('mousemove', onMouseMove);
            document.removeEventListener('mouseup', onMouseUp);
            updateExportButtonState();
        };
        
        document.addEventListener('mousemove', onMouseMove);
        document.addEventListener('mouseup', onMouseUp);
    });
}

/**
 * Update export button enabled state
 */
export function updateExportButtonState() {
    const state = getState?.();
    const setStartMarkerBtn = $('setStartMarkerBtn');
    const setEndMarkerBtn = $('setEndMarkerBtn');
    const exportBtn = $('exportBtn');
    
    const hasCollection = !!state?.collection?.active;
    
    if (setStartMarkerBtn) setStartMarkerBtn.disabled = !hasCollection;
    if (setEndMarkerBtn) setEndMarkerBtn.disabled = !hasCollection;
    if (exportBtn) exportBtn.disabled = !hasCollection;
}

/**
 * Open the export modal
 */
export function openExportModal() {
    const state = getState?.();
    if (!state?.collection?.active) {
        notify('Load a collection first', { type: 'warn' });
        return;
    }
    
    const modal = $('exportModal');
    if (!modal) return;
    
    updateExportRangeDisplay();
    checkFFmpegAvailability();
    
    const progressEl = $('exportProgress');
    const progressBar = $('exportProgressBar');
    const progressText = $('exportProgressText');
    const dashboardProgressEl = $('dashboardProgress');
    if (progressEl) progressEl.classList.add('hidden');
    if (progressBar) progressBar.style.width = '0%';
    if (progressText) progressText.textContent = 'Preparing...';
    if (dashboardProgressEl) dashboardProgressEl.classList.add('hidden');
    
    const filenameInput = $('exportFilename');
    if (filenameInput) {
        const date = new Date().toISOString().slice(0, 10);
        const collName = state.collection.active?.label || 'export';
        const safeName = collName.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 30);
        filenameInput.value = `tesla_${safeName}_${date}`;
    }
    
    const highQuality = document.querySelector('input[name="exportQuality"][value="high"]');
    if (highQuality) highQuality.checked = true;
    
    const qualityInputs = document.querySelectorAll('input[name="exportQuality"]');
    qualityInputs.forEach(input => { input.onchange = updateExportSizeEstimate; });
    const cameraInputs = document.querySelectorAll('.camera-checkbox input');
    cameraInputs.forEach(input => { input.onchange = updateExportSizeEstimate; });
    updateExportSizeEstimate();
    
    const startBtn = $('startExportBtn');
    if (startBtn) startBtn.disabled = false;
    
    modal.classList.remove('hidden');
}

/**
 * Close the export modal
 */
export function closeExportModal() {
    const modal = $('exportModal');
    if (modal) modal.classList.add('hidden');
    
    if (exportState.isExporting && exportState.currentExportId) {
        cancelExport();
    }
}

/**
 * Update export range display in modal
 */
export function updateExportRangeDisplay() {
    const nativeVideo = getNativeVideo?.();
    const startTimeEl = $('exportStartTime');
    const endTimeEl = $('exportEndTime');
    const durationEl = $('exportDuration');
    
    const state = getState?.();
    if (!state?.collection?.active) return;
    
    const totalSec = nativeVideo?.cumulativeStarts?.[nativeVideo.cumulativeStarts.length - 1] || 60;
    
    const startPct = exportState.startMarkerPct ?? 0;
    const endPct = exportState.endMarkerPct ?? 100;
    
    const startSec = (startPct / 100) * totalSec;
    const endSec = (endPct / 100) * totalSec;
    const durationSec = Math.abs(endSec - startSec);
    
    if (startTimeEl) startTimeEl.textContent = formatTimeHMS(Math.min(startSec, endSec));
    if (endTimeEl) endTimeEl.textContent = formatTimeHMS(Math.max(startSec, endSec));
    if (durationEl) durationEl.textContent = formatTimeHMS(durationSec);
}

/**
 * Update estimated file size display
 */
export function updateExportSizeEstimate() {
    const nativeVideo = getNativeVideo?.();
    const state = getState?.();
    const estimateEl = $('exportSizeEstimate');
    const warningEl = $('frontCamWarning');
    if (!estimateEl || !state?.collection?.active) return;
    
    const totalSec = nativeVideo?.cumulativeStarts?.[nativeVideo.cumulativeStarts.length - 1] || 60;
    const startPct = exportState.startMarkerPct ?? 0;
    const endPct = exportState.endMarkerPct ?? 100;
    const durationMin = Math.abs((endPct - startPct) / 100 * totalSec) / 60;
    
    const selectedCameras = document.querySelectorAll('.camera-checkbox input:checked');
    const cameraCount = selectedCameras.length || 6;
    const isFrontOnly = cameraCount === 1 && selectedCameras[0]?.dataset?.camera === 'front';
    const hasFrontAndOthers = cameraCount > 1 && Array.from(selectedCameras).some(cb => cb.dataset?.camera === 'front');
    
    if (warningEl) warningEl.classList.toggle('hidden', !hasFrontAndOthers);
    
    let cols, rows;
    if (cameraCount <= 1) { cols = 1; rows = 1; }
    else if (cameraCount === 2) { cols = 2; rows = 1; }
    else if (cameraCount === 3) { cols = 3; rows = 1; }
    else if (cameraCount === 4) { cols = 2; rows = 2; }
    else { cols = 3; rows = 2; }
    
    const quality = document.querySelector('input[name="exportQuality"]:checked')?.value || 'high';
    let perCam;
    if (isFrontOnly) {
        perCam = { mobile: [724, 469], medium: [1448, 938], high: [2172, 1407], max: [2896, 1876] }[quality] || [1448, 938];
    } else {
        perCam = { mobile: [484, 314], medium: [724, 469], high: [1086, 704], max: [1448, 938] }[quality] || [1086, 704];
    }
    
    const gridW = perCam[0] * cols;
    const gridH = perCam[1] * rows;
    const pixels = gridW * gridH;
    const mbPerMin = pixels * 0.000018;
    const estimatedMB = Math.round(durationMin * mbPerMin);
    const estimatedGB = (estimatedMB / 1024).toFixed(1);
    
    let sizeText = estimatedMB > 1024 ? `~${estimatedGB} GB` : `~${estimatedMB} MB`;
    estimateEl.textContent = `Output: ${gridW}×${gridH} • ${sizeText}`;
}

/**
 * Check if FFmpeg is available
 */
export async function checkFFmpegAvailability() {
    const statusEl = $('ffmpegStatus');
    const startBtn = $('startExportBtn');
    
    if (!statusEl) return;
    
    statusEl.innerHTML = '<span class="status-icon">⏳</span><span class="status-text">Checking FFmpeg...</span>';
    
    try {
        if (window.electronAPI?.checkFFmpeg) {
            const result = await window.electronAPI.checkFFmpeg();
            exportState.ffmpegAvailable = result.available;
            
            if (result.available) {
                statusEl.innerHTML = '<span class="status-icon" style="color: #4caf50;">✓</span><span class="status-text">FFmpeg ready</span>';
                if (startBtn) startBtn.disabled = false;
            } else {
                const isMac = navigator.platform.toLowerCase().includes('mac');
                if (isMac) {
                    statusEl.innerHTML = '<span class="status-icon" style="color: #f44336;">✗</span><span class="status-text">FFmpeg required. Run in Terminal: <code style="background:#333;padding:2px 6px;border-radius:3px;user-select:all;">brew install ffmpeg</code></span>';
                } else {
                    statusEl.innerHTML = '<span class="status-icon" style="color: #f44336;">✗</span><span class="status-text">FFmpeg not found. Place ffmpeg.exe in the ffmpeg_bin folder.</span>';
                }
                if (startBtn) startBtn.disabled = true;
            }
        } else {
            statusEl.innerHTML = '<span class="status-icon" style="color: #ff9800;">⚠</span><span class="status-text">Export not available (running in browser)</span>';
            if (startBtn) startBtn.disabled = true;
        }
    } catch (err) {
        statusEl.innerHTML = '<span class="status-icon" style="color: #f44336;">✗</span><span class="status-text">Error checking FFmpeg</span>';
        if (startBtn) startBtn.disabled = true;
    }
}

/**
 * Start the export process
 */
export async function startExport() {
    const state = getState?.();
    const nativeVideo = getNativeVideo?.();
    const baseFolderPath = getBaseFolderPath?.();
    
    if (!state?.collection?.active || !window.electronAPI?.startExport) {
        notify('Export not available', { type: 'error' });
        return;
    }
    
    if (!baseFolderPath) {
        notify('Export requires selecting a folder via the folder picker. Please re-select your TeslaCam folder.', { type: 'warn' });
        return;
    }
    
    const cameraCheckboxes = document.querySelectorAll('.camera-checkbox input[type="checkbox"]:checked');
    const cameras = Array.from(cameraCheckboxes).map(cb => cb.dataset.camera);
    
    if (cameras.length === 0) {
        notify('Please select at least one camera', { type: 'warn' });
        return;
    }
    
    const filenameInput = $('exportFilename');
    let filename = filenameInput?.value?.trim() || `tesla_export_${new Date().toISOString().slice(0, 10)}`;
    if (!filename.toLowerCase().endsWith('.mp4')) filename += '.mp4';
    
    const qualityInput = document.querySelector('input[name="exportQuality"]:checked');
    const quality = qualityInput?.value || 'high';
    
    const includeDashboardCheckbox = $('includeDashboard');
    let includeDashboard = includeDashboardCheckbox?.checked ?? true;
    
    const totalSec = nativeVideo?.cumulativeStarts?.[nativeVideo.cumulativeStarts.length - 1] || 60;
    const startPct = exportState.startMarkerPct ?? 0;
    const endPct = exportState.endMarkerPct ?? 100;
    
    const startTimeMs = (Math.min(startPct, endPct) / 100) * totalSec * 1000;
    const endTimeMs = (Math.max(startPct, endPct) / 100) * totalSec * 1000;
    
    let seiData = null;
    if (includeDashboard) {
        try {
            const cumStarts = nativeVideo?.cumulativeStarts || [];
            const groups = state.collection.active.groups || [];
            const allSeiData = [];
            
            // Collect SEI data from all segments that overlap with export range
            // Timestamps are adjusted from segment-relative to absolute time
            for (let i = 0; i < groups.length; i++) {
                const group = groups[i];
                const segStartMs = (cumStarts[i] || 0) * 1000;
                const segDurationMs = (nativeVideo?.segmentDurations?.[i] || 60) * 1000;
                const segEndMs = segStartMs + segDurationMs;
                
                if (segEndMs > startTimeMs && segStartMs < endTimeMs) {
                    // Prefer front camera for SEI extraction, fallback to any available camera
                    let entry = group.filesByCamera?.get('front');
                    if (!entry) {
                        const firstCamera = group.filesByCamera?.keys().next().value;
                        entry = firstCamera ? group.filesByCamera?.get(firstCamera) : null;
                    }
                    
                    if (entry?.file) {
                        try {
                            if (!window.DashcamMP4 || !window.DashcamHelpers) {
                                continue;
                            }
                            
                            const DashcamMP4 = window.DashcamMP4;
                            const { SeiMetadata } = await window.DashcamHelpers.initProtobuf();
                            
                            // Handle both Electron file paths and regular File objects
                            let buffer;
                            if (entry.file?.isElectronFile && entry.file?.path) {
                                const filePath = entry.file.path;
                                const fileUrl = filePath.startsWith('/') 
                                    ? `file://${filePath}` 
                                    : `file:///${filePath.replace(/\\/g, '/')}`;
                                const response = await fetch(fileUrl);
                                buffer = await response.arrayBuffer();
                            } else if (entry.file instanceof File) {
                                buffer = await entry.file.arrayBuffer();
                            } else if (entry.file.path) {
                                const filePath = entry.file.path;
                                const fileUrl = filePath.startsWith('/') 
                                    ? `file://${filePath}` 
                                    : `file:///${filePath.replace(/\\/g, '/')}`;
                                const response = await fetch(fileUrl);
                                buffer = await response.arrayBuffer();
                            } else {
                                continue;
                            }
                            
                            const mp4 = new DashcamMP4(buffer);
                            const frames = mp4.parseFrames(SeiMetadata);
                            
                            // Convert segment-relative timestamps to absolute time
                            for (const frame of frames) {
                                if (frame.sei) {
                                    allSeiData.push({
                                        timestampMs: segStartMs + frame.timestamp,
                                        sei: frame.sei
                                    });
                                }
                            }
                        } catch (err) {
                            // Skip segment on error
                        }
                    }
                }
            }
            
            // Sort by timestamp for efficient lookup during rendering
            allSeiData.sort((a, b) => a.timestampMs - b.timestampMs);
            
            if (allSeiData.length > 0) {
                seiData = allSeiData;
            } else {
                notify('No telemetry data available for dashboard overlay. Dashboard will be disabled.', { type: 'warn' });
                includeDashboard = false;
            }
        } catch (err) {
            notify('Failed to extract telemetry data. Dashboard will be disabled.', { type: 'warn' });
            includeDashboard = false;
        }
    }
    
    const outputPath = await window.electronAPI.saveFile({
        title: 'Save Tesla Export',
        defaultPath: filename
    });
    
    if (!outputPath) {
        notify('Export cancelled', { type: 'info' });
        return;
    }
    
    const segments = [];
    const groups = state.collection.active.groups || [];
    const cumStarts = nativeVideo?.cumulativeStarts || [];
    
    for (let i = 0; i < groups.length; i++) {
        const group = groups[i];
        const durationSec = nativeVideo?.segmentDurations?.[i] || 60;
        
        const files = {};
        for (const camera of cameras) {
            const entry = group.filesByCamera?.get(camera);
            if (entry?.file) {
                if (entry.file.path) {
                    files[camera] = entry.file.path;
                } else if (entry.file.webkitRelativePath && baseFolderPath) {
                    const relativePath = entry.file.webkitRelativePath;
                    const pathParts = relativePath.split('/');
                    const subPath = pathParts.slice(1).join('/');
                    files[camera] = baseFolderPath + '/' + subPath;
                }
            }
        }
        
        segments.push({
            index: i,
            durationSec,
            startSec: cumStarts[i] || 0,
            files,
            groupId: group.id
        });
    }
    
    const hasFiles = segments.some(seg => Object.keys(seg.files).length > 0);
    if (!hasFiles) {
        notify('No video files found for export. Please ensure the folder was selected correctly.', { type: 'error' });
        return;
    }
    
    const progressEl = $('exportProgress');
    const exportProgressBar = $('exportProgressBar');
    const progressText = $('exportProgressText');
    const dashboardProgressEl = $('dashboardProgress');
    const dashboardProgressBar = $('dashboardProgressBar');
    const dashboardProgressText = $('dashboardProgressText');
    const startBtn = $('startExportBtn');
    
    if (progressEl) progressEl.classList.remove('hidden');
    if (exportProgressBar) exportProgressBar.style.width = '0%';
    if (progressText) progressText.textContent = 'Starting export...';
    
    if (includeDashboard && dashboardProgressEl) {
        dashboardProgressEl.classList.remove('hidden');
        if (dashboardProgressBar) dashboardProgressBar.style.width = '0%';
        if (dashboardProgressText) dashboardProgressText.textContent = 'Waiting...';
    } else {
        if (dashboardProgressEl) dashboardProgressEl.classList.add('hidden');
    }
    
    if (startBtn) startBtn.disabled = true;
    
    const exportId = `export_${Date.now()}`;
    exportState.currentExportId = exportId;
    exportState.isExporting = true;
    
    if (window.electronAPI?.on) {
        window.electronAPI.on('export:progress', (receivedExportId, progress) => {
            if (receivedExportId !== exportId) return;
            
            if (progress.type === 'progress') {
                if (exportProgressBar) exportProgressBar.style.width = `${progress.percentage}%`;
                if (progressText) progressText.textContent = progress.message;
            } else if (progress.type === 'dashboard-progress') {
                if (dashboardProgressBar) dashboardProgressBar.style.width = `${progress.percentage}%`;
                if (dashboardProgressText) dashboardProgressText.textContent = progress.message;
            } else if (progress.type === 'complete') {
                exportState.isExporting = false;
                exportState.currentExportId = null;
                
                if (progress.success) {
                    if (exportProgressBar) exportProgressBar.style.width = '100%';
                    if (progressText) progressText.textContent = progress.message;
                    if (dashboardProgressBar) dashboardProgressBar.style.width = '100%';
                    if (dashboardProgressText) dashboardProgressText.textContent = 'Complete';
                    notify(progress.message, { type: 'success' });
                    
                    setTimeout(() => {
                        if (confirm(`${progress.message}\n\nWould you like to open the file location?`)) {
                            window.electronAPI.showItemInFolder(outputPath);
                        }
                        closeExportModal();
                    }, 500);
                } else {
                    if (progressText) progressText.textContent = progress.message;
                    notify(progress.message, { type: 'error' });
                    if (startBtn) startBtn.disabled = false;
                }
            }
        });
    }
    
    try {
        const exportData = {
            segments,
            startTimeMs,
            endTimeMs,
            outputPath,
            cameras,
            baseFolderPath,
            quality,
            includeDashboard: includeDashboard && seiData !== null,
            seiData: seiData || []
        };
        
        await window.electronAPI.startExport(exportId, exportData);
    } catch (err) {
        console.error('Export error:', err);
        notify(`Export failed: ${err.message}`, { type: 'error' });
        exportState.isExporting = false;
        exportState.currentExportId = null;
        if (startBtn) startBtn.disabled = false;
    }
}

/**
 * Cancel an ongoing export
 */
export async function cancelExport() {
    if (exportState.currentExportId && window.electronAPI?.cancelExport) {
        await window.electronAPI.cancelExport(exportState.currentExportId);
        notify('Export cancelled', { type: 'info' });
    }
    
    exportState.isExporting = false;
    exportState.currentExportId = null;
    
    const progressEl = $('exportProgress');
    const startBtn = $('startExportBtn');
    
    if (progressEl) progressEl.classList.add('hidden');
    if (startBtn) startBtn.disabled = false;
    
    closeExportModal();
}

/**
 * Clear export markers
 */
export function clearExportMarkers() {
    exportState.startMarkerPct = null;
    exportState.endMarkerPct = null;
    updateExportMarkers();
    updateExportButtonState();
}
