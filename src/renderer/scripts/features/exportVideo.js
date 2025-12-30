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
    ffmpegAvailable: false,
    gpuAvailable: false,
    gpuName: null,
    hevcAvailable: false,
    hevcName: null,
    cancelled: false
};

// DOM helper
const $ = id => document.getElementById(id);

// Dependencies set via init
let getState = null;
let getNativeVideo = null;
let getBaseFolderPath = null;
let getProgressBar = null;
let getFindSeiAtTime = null;
let getUseMetric = null;

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
    getUseMetric = deps.getUseMetric;
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
    
    // Show modal first so dimensions are accurate
    modal.classList.remove('hidden');
    
    updateExportRangeDisplay();
    checkFFmpegAvailability();
    
    // Initialize Layout Lab and collapsible sections after modal is visible
    import('../ui/layoutLab.js').then(({ initLayoutLab }) => {
        // Wait for next frame to ensure modal is fully rendered
        requestAnimationFrame(() => {
            requestAnimationFrame(() => {
                initLayoutLab();
                
                // Initialize collapsible sections
                modal.querySelectorAll('.collapsible-header').forEach(header => {
                    // Remove existing listener to avoid duplicates
                    const newHeader = header.cloneNode(true);
                    header.parentNode.replaceChild(newHeader, header);
                    newHeader.addEventListener('click', () => {
                        const section = newHeader.closest('.collapsible-section');
                        if (section) section.classList.toggle('open');
                    });
                });
            });
        });
    });
    
    const progressEl = $('exportProgress');
    const progressBar = $('exportProgressBar');
    const progressText = $('exportProgressText');
    const dashboardProgressEl = $('dashboardProgress');
    if (progressEl) progressEl.classList.add('hidden');
    if (progressBar) progressBar.style.width = '0%';
    if (progressText) progressText.textContent = 'Preparing...';
    if (dashboardProgressEl) dashboardProgressEl.classList.add('hidden');
    
    // Generate default filename (used when saving via dialog)
    const date = new Date().toISOString().slice(0, 10);
    const collName = state.collection.active?.label || 'export';
    const safeName = collName.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 30);
    exportState.defaultFilename = `tesla_${safeName}_${date}.mp4`;
    
    const highQuality = document.querySelector('input[name="exportQuality"][value="high"]');
    if (highQuality) highQuality.checked = true;
    
    const qualityInputs = document.querySelectorAll('input[name="exportQuality"]');
    qualityInputs.forEach(input => { input.onchange = updateExportSizeEstimate; });
    const cameraInputs = document.querySelectorAll('.option-card input[data-camera]');
    cameraInputs.forEach(input => { input.onchange = updateExportSizeEstimate; });
    updateExportSizeEstimate();
    
    const startBtn = $('startExportBtn');
    if (startBtn) startBtn.disabled = false;
    
    // Ensure close button is enabled when modal opens
    const closeBtn = $('closeExportModal');
    if (closeBtn) {
        closeBtn.disabled = false;
        closeBtn.style.cursor = 'pointer';
        closeBtn.style.opacity = '1';
    }
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
    
    const selectedCameras = document.querySelectorAll('.option-card input[data-camera]:checked');
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
    
    // Show warning for Maximum quality (exceeds GPU encoder limits)
    const maxQualityWarningEl = $('maxQualityWarning');
    if (maxQualityWarningEl) {
        const isMaxQuality = quality === 'max';
        maxQualityWarningEl.classList.toggle('hidden', !isMaxQuality);
    }
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
    const dashboardCheckbox = $('includeDashboard');
    const dashboardOptions = $('dashboardOptions');
    const dashboardWarning = document.querySelector('.export-option-warning-text');
    
    // Set up dashboard checkbox toggle for options visibility
    if (dashboardCheckbox && dashboardOptions) {
        dashboardCheckbox.addEventListener('change', () => {
            if (dashboardCheckbox.checked) {
                dashboardOptions.classList.remove('hidden');
            } else {
                dashboardOptions.classList.add('hidden');
            }
        });
    }
    
    if (!statusEl) return;
    
    statusEl.innerHTML = '<span class="status-icon">⏳</span><span class="status-text">Checking FFmpeg...</span>';
    
    try {
        if (window.electronAPI?.checkFFmpeg) {
            const result = await window.electronAPI.checkFFmpeg();
            exportState.ffmpegAvailable = result.available;
            exportState.gpuAvailable = !!result.gpu;
            exportState.gpuName = result.gpu?.name || null;
            exportState.hevcAvailable = !!result.hevc;
            exportState.hevcName = result.hevc?.name || null;
            
            if (result.available) {
                // Build status text with GPU info
                let statusText = 'FFmpeg ready';
                if (result.gpu) {
                    statusText += ` • GPU: ${result.gpu.name}`;
                    if (result.hevc) {
                        statusText += ` + HEVC`;
                    }
                } else {
                    statusText += ' • CPU only (no GPU encoder)';
                }
                if (result.fakeNoGpu) {
                    statusText += ' [DEV: Fake No GPU]';
                }
                
                statusEl.innerHTML = `<span class="status-icon" style="color: #4caf50;">✓</span><span class="status-text">${statusText}</span>`;
                if (startBtn) startBtn.disabled = false;
                
                // Dashboard overlay requires GPU - disable checkbox if no GPU
                if (dashboardCheckbox) {
                    if (!result.gpu) {
                        dashboardCheckbox.disabled = true;
                        dashboardCheckbox.checked = false;
                        dashboardCheckbox.parentElement?.classList.add('disabled');
                        if (dashboardWarning) {
                            dashboardWarning.innerHTML = '<span class="warning-icon">⚠️</span><span>Dashboard overlay requires GPU encoding. No GPU encoder detected on this system.</span>';
                        }
                    } else {
                        dashboardCheckbox.disabled = false;
                        dashboardCheckbox.parentElement?.classList.remove('disabled');
                        if (dashboardWarning) {
                            dashboardWarning.innerHTML = '<span class="warning-icon">ℹ️</span><span>This feature is in beta. Dashboard frames are rendered in real-time during export, which may increase export time.</span>';
                        }
                    }
                }
            } else {
                const isMac = navigator.platform.toLowerCase().includes('mac');
                if (isMac) {
                    statusEl.innerHTML = '<span class="status-icon" style="color: #f44336;">✗</span><span class="status-text">FFmpeg required. Run in Terminal: <code style="background:#333;padding:2px 6px;border-radius:3px;user-select:all;">brew install ffmpeg</code></span>';
                } else {
                    statusEl.innerHTML = '<span class="status-icon" style="color: #f44336;">✗</span><span class="status-text">FFmpeg not found. Place ffmpeg.exe in the ffmpeg_bin folder.</span>';
                }
                if (startBtn) startBtn.disabled = true;
                if (dashboardCheckbox) {
                    dashboardCheckbox.disabled = true;
                    dashboardCheckbox.checked = false;
                }
            }
        } else {
            statusEl.innerHTML = '<span class="status-icon" style="color: #ff9800;">⚠</span><span class="status-text">Export not available (running in browser)</span>';
            if (startBtn) startBtn.disabled = true;
            if (dashboardCheckbox) {
                dashboardCheckbox.disabled = true;
                dashboardCheckbox.checked = false;
            }
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
    
    const cameraCheckboxes = document.querySelectorAll('.option-card input[data-camera]:checked');
    const cameras = Array.from(cameraCheckboxes).map(cb => cb.dataset.camera);
    
    if (cameras.length === 0) {
        notify('Please select at least one camera', { type: 'warn' });
        return;
    }
    
    // Get layout data from Layout Lab
    let layoutData = null;
    try {
        const layoutLab = await import('../ui/layoutLab.js');
        layoutData = layoutLab.getLayoutData();
    } catch (err) {
        console.error('Failed to get layout data:', err);
    }
    
    // Use the default filename generated when modal opened
    let filename = exportState.defaultFilename || `tesla_export_${new Date().toISOString().slice(0, 10)}.mp4`;
    
    const qualityInput = document.querySelector('input[name="exportQuality"]:checked');
    const quality = qualityInput?.value || 'high';
    
    const includeDashboardCheckbox = $('includeDashboard');
    const includeDashboard = includeDashboardCheckbox?.checked ?? false;
    const dashboardPosition = $('dashboardPosition')?.value || 'bottom-center';
    const dashboardSize = $('dashboardSize')?.value || 'medium';
    
    const totalSec = nativeVideo?.cumulativeStarts?.[nativeVideo.cumulativeStarts.length - 1] || 60;
    const startPct = exportState.startMarkerPct ?? 0;
    const endPct = exportState.endMarkerPct ?? 100;
    
    const startTimeMs = (Math.min(startPct, endPct) / 100) * totalSec * 1000;
    const endTimeMs = (Math.max(startPct, endPct) / 100) * totalSec * 1000;
    
    // Open file dialog FIRST for instant response, before any heavy processing
    const outputPath = await window.electronAPI.saveFile({
        title: 'Save Tesla Export',
        defaultPath: filename
    });
    
    if (!outputPath) {
        notify('Export cancelled', { type: 'info' });
        return;
    }
    
    // Only extract SEI data if dashboard is enabled - skip entirely if disabled to save RAM
    // Extract SEI data one segment at a time to avoid loading all files into memory simultaneously
    // This happens AFTER file dialog so user gets instant feedback
    let seiData = null;
    if (includeDashboard) {
        try {
            notify('Extracting telemetry data...', { type: 'info' });
            
            const cumStarts = nativeVideo?.cumulativeStarts || [];
            const groups = state.collection.active.groups || [];
            const allSeiData = [];
            
            if (!window.DashcamMP4 || !window.DashcamHelpers) {
                throw new Error('Dashcam parser not available');
            }
            
            const DashcamMP4 = window.DashcamMP4;
            const { SeiMetadata } = await window.DashcamHelpers.initProtobuf();
            
            // Extract SEI data one segment at a time to minimize RAM usage
            for (let i = 0; i < groups.length; i++) {
                // Check for cancellation before processing each segment
                if (exportState.cancelled) {
                    console.log('SEI extraction cancelled by user');
                    seiData = null;
                    break;
                }
                
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
                            let buffer = null;
                            
                            // Load file into buffer (one at a time)
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
                            }
                            
                            if (buffer) {
                                // Extract SEI data from this segment
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
                                
                                // Explicitly clear buffer reference to help GC
                                buffer = null;
                            }
                        } catch (err) {
                            console.warn(`Failed to extract SEI from segment ${i}:`, err);
                            // Continue with other segments
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
                seiData = null; // Clear SEI data if extraction failed
            }
        } catch (err) {
            notify('Failed to extract telemetry data. Dashboard will be disabled.', { type: 'warn' });
            seiData = null; // Clear SEI data if extraction failed
        }
    }
    // If dashboard is disabled, seiData remains null and no files are loaded into memory
    
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
    
    // Disable close button during export to prevent accidental closing
    const closeBtn = $('closeExportModal');
    if (closeBtn) {
        closeBtn.disabled = true;
        closeBtn.style.cursor = 'not-allowed';
        closeBtn.style.opacity = '0.5';
    }
    
    const exportId = `export_${Date.now()}`;
    exportState.currentExportId = exportId;
    exportState.isExporting = true;
    exportState.cancelled = false; // Reset cancellation flag
    
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
                exportState.cancelled = false; // Reset cancellation flag
                
                // Re-enable close button after export completes
                const closeBtn = $('closeExportModal');
                if (closeBtn) {
                    closeBtn.disabled = false;
                    closeBtn.style.cursor = 'pointer';
                    closeBtn.style.opacity = '1';
                }
                
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
    
    // Check for cancellation after SEI extraction but before starting export
    if (exportState.cancelled) {
        console.log('Export cancelled before starting FFmpeg');
        exportState.isExporting = false;
        exportState.currentExportId = null;
        if (startBtn) startBtn.disabled = false;
        
        // Re-enable close button
        const closeBtn = $('closeExportModal');
        if (closeBtn) {
            closeBtn.disabled = false;
            closeBtn.style.cursor = 'pointer';
            closeBtn.style.opacity = '1';
        }
        return;
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
            // Only include dashboard if checkbox was checked AND we successfully extracted SEI data
            includeDashboard: includeDashboard && seiData !== null && seiData.length > 0,
            seiData: seiData || [], // Empty array if dashboard disabled - no RAM used
            layoutData: layoutData || null,
            useMetric: getUseMetric?.() ?? false, // Pass metric setting for dashboard overlay
            dashboardPosition, // Position: bottom-center, bottom-left, bottom-right, top-center, etc.
            dashboardSize // Size: small (20%), medium (30%), large (40%)
        };
        
        await window.electronAPI.startExport(exportId, exportData);
    } catch (err) {
        console.error('Export error:', err);
        notify(`Export failed: ${err.message}`, { type: 'error' });
        exportState.isExporting = false;
        exportState.currentExportId = null;
        exportState.cancelled = false; // Reset cancellation flag
        if (startBtn) startBtn.disabled = false;
        
        // Re-enable close button after export fails
        const closeBtn = $('closeExportModal');
        if (closeBtn) {
            closeBtn.disabled = false;
            closeBtn.style.cursor = 'pointer';
            closeBtn.style.opacity = '1';
        }
    }
}

/**
 * Cancel an ongoing export
 */
export async function cancelExport() {
    // Set cancellation flag immediately so SEI extraction loop can check it
    exportState.cancelled = true;
    
    if (exportState.currentExportId && window.electronAPI?.cancelExport) {
        await window.electronAPI.cancelExport(exportState.currentExportId);
        notify('Export cancelled', { type: 'info' });
    }
    
    exportState.isExporting = false;
    exportState.currentExportId = null;
    exportState.cancelled = false; // Reset cancellation flag
    
    const progressEl = $('exportProgress');
    const startBtn = $('startExportBtn');
    
    // Re-enable close button after export is cancelled
    const closeBtn = $('closeExportModal');
    if (closeBtn) {
        closeBtn.disabled = false;
        closeBtn.style.cursor = 'pointer';
        closeBtn.style.opacity = '1';
    }
    
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
