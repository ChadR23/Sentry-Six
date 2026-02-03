/**
 * Export Video Functions
 * Handles video export with FFmpeg, markers, and progress tracking
 */

import { notify } from '../ui/notifications.js';
import { formatTimeHMS } from '../ui/timeDisplay.js';
import { initBlurZoneEditor, getNormalizedCoordinates, resetBlurZoneEditor, generateMaskImage, getCanvasDimensions } from '../ui/blurZoneEditor.js';
import { filePathToUrl } from '../lib/utils.js';
import { parseTimestampKeyToEpochMs } from '../core/clipBrowser.js';
import { t, getCurrentLanguage } from '../lib/i18n.js';

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
    cancelled: false,
    modalMinimized: false,
    currentStep: '',
    currentProgress: 0,
    blurZones: [], // Array of { coordinates: [{x, y}, ...], camera: string, maskImageBase64, maskWidth, maskHeight }
    blurZoneCamera: null, // Camera being edited
    blurZoneEditIndex: null, // Index of zone being edited (null = new zone)
    blurType: 'solid' // 'solid' (faster) or 'transparent' (blends edges)
};

// Track if modal listeners have been initialized
let blurZoneModalInitialized = false;

// DOM helper
const $ = id => document.getElementById(id);

/**
 * Check if dashboard should be disabled based on blur zones and blur type
 * Dashboard is only disabled when blur zones exist AND blur type is NOT 'solid'
 * (Solid uses ASS overlay which can be layered with dashboard ASS)
 * @returns {boolean} True if dashboard should be disabled
 */
function shouldDisableDashboard() {
    const hasBlurZones = exportState.blurZones.length > 0;
    const blurType = $('blurTypeSelect')?.value || 'solid';
    // Only disable dashboard for 'trueBlur' - not for 'solid'
    return hasBlurZones && blurType !== 'solid';
}

/**
 * Update dashboard checkbox state based on blur zones and blur type
 */
function updateDashboardAvailability() {
    const dashboardCheckbox = $('includeDashboard');
    const dashboardOptions = $('dashboardOptions');
    const dashboardToggleRow = dashboardCheckbox?.closest('.toggle-row');
    const timestampCheckbox = $('includeTimestamp');
    const timestampToggleRow = timestampCheckbox?.closest('.toggle-row');
    const timestampOptions = $('timestampOptions');
    
    if (!dashboardCheckbox) return;
    
    const shouldDisable = shouldDisableDashboard();
    const hasGpu = exportState.gpuAvailable;
    
    if (shouldDisable || !hasGpu) {
        // Disable dashboard
        dashboardCheckbox.checked = false;
        dashboardCheckbox.disabled = true;
        if (dashboardToggleRow) dashboardToggleRow.classList.add('disabled');
        if (dashboardOptions) dashboardOptions.classList.add('hidden');
        
        // Re-enable timestamp toggle since dashboard is disabled
        if (timestampCheckbox) {
            timestampCheckbox.disabled = false;
            if (timestampToggleRow) timestampToggleRow.classList.remove('disabled');
        }
    } else {
        // Enable dashboard (if GPU available and no conflicting blur)
        dashboardCheckbox.disabled = false;
        if (dashboardToggleRow) dashboardToggleRow.classList.remove('disabled');
        
        // If dashboard was enabled before, keep its state
        // Otherwise, the user can now enable it
    }
}

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
 * Detect available cameras from the current collection
 * HW3 vehicles only have 4 cameras (no pillars), HW3+/HW4 have 6 cameras
 * @param {Object} state - App state
 * @returns {Set<string>} Set of available camera names
 */
function detectAvailableCameras(state) {
    const availableCameras = new Set();
    const collection = state?.collection?.active;
    
    if (!collection?.groups) return availableCameras;
    
    // Scan all groups in the collection for available cameras
    for (const group of collection.groups) {
        if (group.filesByCamera) {
            for (const camera of group.filesByCamera.keys()) {
                availableCameras.add(camera);
            }
        }
    }
    
    return availableCameras;
}

/**
 * Update camera checkbox visibility based on available cameras
 * Hides pillar camera options for HW3 vehicles (4-cam systems)
 * @param {Set<string>} availableCameras - Set of available camera names
 */
function updateCameraCheckboxVisibility(availableCameras) {
    const allCameraCheckboxes = document.querySelectorAll('.option-card input[data-camera]');
    const hasPillarCameras = availableCameras.has('left_pillar') || availableCameras.has('right_pillar');
    
    allCameraCheckboxes.forEach(checkbox => {
        const camera = checkbox.dataset.camera;
        const card = checkbox.closest('.option-card');
        
        if (!card) return;
        
        // Check if this camera is a pillar camera
        const isPillarCamera = camera === 'left_pillar' || camera === 'right_pillar';
        
        if (isPillarCamera && !hasPillarCameras) {
            // Hide pillar cameras for HW3 vehicles
            card.style.display = 'none';
            checkbox.checked = false;
        } else {
            // Show and check available cameras
            card.style.display = '';
            checkbox.checked = availableCameras.has(camera);
        }
    });
    
    // Update the grid layout - switch to 2x2 for 4 cameras (option-grid defaults to 2 cols)
    const layoutSection = document.querySelector('.collapsible-section[data-section="layout"]');
    const optionGrid = layoutSection?.querySelector('.option-grid');
    if (optionGrid) {
        if (hasPillarCameras) {
            optionGrid.classList.add('option-grid-3');
        } else {
            optionGrid.classList.remove('option-grid-3');
        }
    }
}

/**
 * Set an export marker at current position
 * @param {string} type - 'start' or 'end'
 */
export function setExportMarker(type) {
    const state = getState?.();
    const progressBar = getProgressBar?.();
    
    if (!state?.collection?.active) {
        notify(t('ui.notifications.loadCollectionFirst'), { type: 'warn' });
        return;
    }
    
    const currentPct = parseFloat(progressBar?.value) || 0;
    
    if (type === 'start') {
        exportState.startMarkerPct = currentPct;
        if (exportState.endMarkerPct !== null && exportState.endMarkerPct <= currentPct) {
            exportState.endMarkerPct = null;
        }
        notify(t('ui.notifications.startMarkerSet'), { type: 'success' });
    } else {
        exportState.endMarkerPct = currentPct;
        if (exportState.startMarkerPct !== null && exportState.startMarkerPct >= currentPct) {
            exportState.startMarkerPct = null;
        }
        notify(t('ui.notifications.endMarkerSet'), { type: 'success' });
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
            startMarker = createMarkerElement('start');
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
            endMarker = createMarkerElement('end');
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

/**
 * Create a marker element with remove button
 * @param {string} type - 'start' or 'end'
 * @returns {HTMLElement}
 */
function createMarkerElement(type) {
    const marker = document.createElement('div');
    marker.className = `export-marker ${type}`;
    const markerType = type === 'start' ? t('ui.export.start') : t('ui.export.end');
    marker.title = `${t('ui.export.exportBtn')} ${markerType} point (drag to adjust)`;
    
    // Add remove button (X)
    const removeBtn = document.createElement('div');
    removeBtn.className = 'marker-remove';
    removeBtn.title = `Remove ${markerType} marker`;
    removeBtn.innerHTML = `<svg viewBox="0 0 24 24"><path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>`;
    removeBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        e.preventDefault();
        removeMarker(type);
    });
    marker.appendChild(removeBtn);
    
    makeMarkerDraggable(marker, type);
    return marker;
}

/**
 * Remove a specific marker
 * @param {string} type - 'start' or 'end'
 */
function removeMarker(type) {
    if (type === 'start') {
        exportState.startMarkerPct = null;
    } else {
        exportState.endMarkerPct = null;
    }
    updateExportMarkers();
    updateExportButtonState();
}

function makeMarkerDraggable(marker, type) {
    let isDragging = false;
    
    marker.addEventListener('mousedown', (e) => {
        // Ignore clicks on the remove button
        if (e.target.closest('.marker-remove')) return;
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
        notify(t('ui.notifications.loadCollectionFirst'), { type: 'warn' });
        return;
    }
    
    const modal = $('exportModal');
    if (!modal) return;
    
    // Detect available cameras from the collection
    const availableCameras = detectAvailableCameras(state);
    updateCameraCheckboxVisibility(availableCameras);
    
    // Show modal first so dimensions are accurate
    modal.classList.remove('hidden');
    
    updateExportRangeDisplay();
    checkFFmpegAvailability();
    
    // Initialize Layout Lab and collapsible sections after modal is visible
    import('../ui/layoutLab.js').then(({ initLayoutLab, setAvailableCameras }) => {
        // Pass available cameras to Layout Lab
        if (setAvailableCameras) setAvailableCameras(availableCameras);
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
    if (progressEl) progressEl.classList.add('hidden');
    if (progressBar) progressBar.style.width = '0%';
    if (progressText) progressText.textContent = t('ui.export.preparing');
    
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
    
    // Initialize blur zone editor modal
    initBlurZoneEditorModal();
    
    // Update blur zone status display
    updateBlurZoneStatusDisplay();
    
    // Initialize minimap toggle and options
    const minimapCheckbox = $('includeMinimap');
    const minimapOptions = $('minimapOptions');
    const minimapNoGpsWarning = $('minimapNoGpsWarning');
    const minimapRenderMode = $('minimapRenderMode');
    const minimapModeDesc = $('minimapModeDesc');
    const minimapModeInfo = $('minimapModeInfo');
    
    if (minimapCheckbox) {
        // Enable minimap checkbox - GPS availability is checked during export
        minimapCheckbox.checked = false;
        minimapCheckbox.disabled = false;
        
        // Hide warning by default
        if (minimapNoGpsWarning) minimapNoGpsWarning.classList.add('hidden');
        
        // Toggle minimap options visibility
        minimapCheckbox.onchange = () => {
            if (minimapOptions) {
                if (minimapCheckbox.checked) {
                    minimapOptions.classList.remove('hidden');
                } else {
                    minimapOptions.classList.add('hidden');
                }
            }
        };
        
        // Initialize options visibility
        if (minimapOptions) {
            minimapOptions.classList.add('hidden');
        }
    }
    
    // Handle minimap render mode change
    if (minimapRenderMode && minimapModeDesc && minimapModeInfo) {
        const updateMinimapModeInfo = () => {
            const mode = minimapRenderMode.value;
            if (mode === 'ass') {
                minimapModeDesc.textContent = t('ui.export.minimapStaticDesc');
                minimapModeInfo.classList.remove('info-yellow');
                minimapModeInfo.classList.add('info-blue');
                minimapModeInfo.querySelector('.info-box-icon').textContent = '⚡';
            } else {
                minimapModeDesc.textContent = t('ui.export.minimapLiveDesc');
                minimapModeInfo.classList.remove('info-blue');
                minimapModeInfo.classList.add('info-yellow');
                minimapModeInfo.querySelector('.info-box-icon').textContent = '🗺️';
            }
        };
        
        minimapRenderMode.onchange = updateMinimapModeInfo;
        updateMinimapModeInfo(); // Set initial state
    }
}

/**
 * Close the export modal (minimizes during active export instead of canceling)
 */
export function closeExportModal() {
    const modal = $('exportModal');
    if (modal) modal.classList.add('hidden');
    
    // If exporting, show floating progress instead of canceling
    if (exportState.isExporting && exportState.currentExportId) {
        exportState.modalMinimized = true;
        showFloatingProgress();
    }
}

/**
 * Reopen the export modal from the floating progress notification
 */
export function reopenExportModal() {
    const modal = $('exportModal');
    if (modal) {
        modal.classList.remove('hidden');
        exportState.modalMinimized = false;
        hideFloatingProgress();
    }
}

/**
 * Show the floating export progress notification
 */
function showFloatingProgress() {
    const floatingEl = $('exportFloatingProgress');
    if (floatingEl) {
        floatingEl.classList.remove('hidden');
        // Trigger animation after removing hidden
        requestAnimationFrame(() => {
            floatingEl.classList.add('show');
        });
        updateFloatingProgress(exportState.currentStep, exportState.currentProgress);
    }
}

/**
 * Hide the floating export progress notification
 */
function hideFloatingProgress() {
    const floatingEl = $('exportFloatingProgress');
    if (floatingEl) {
        floatingEl.classList.remove('show');
        setTimeout(() => {
            floatingEl.classList.add('hidden');
        }, 200);
    }
}

/**
 * Translate a message that may be a string or an object with translation key
 * @param {string|Object} message - Either a plain string or { key: string, params?: Object }
 * @returns {string} The translated message
 */
function translateMessage(message) {
    if (!message) return '';
    if (typeof message === 'string') return message;
    if (typeof message === 'object' && message.key) {
        return t(message.key, message.params || {});
    }
    return String(message);
}

/**
 * Update the floating progress notification
 * @param {string|Object} step - Current step text or translation key object
 * @param {number} percentage - Progress percentage (0-100)
 */
function updateFloatingProgress(step, percentage) {
    const stepEl = $('exportFloatingStep');
    const barFill = $('exportFloatingBarFill');
    
    if (stepEl) stepEl.textContent = translateMessage(step) || t('ui.export.exporting');
    if (barFill) barFill.style.width = `${percentage || 0}%`;
}

/**
 * Capture a snapshot from video at a specific time
 * @param {number} timeSec - Time in seconds to capture
 * @param {HTMLVideoElement} videoElement - Video element to capture from
 * @returns {Promise<string>} - Data URL of the captured image
 */
async function captureVideoSnapshot(timeSec, videoElement) {
    return new Promise((resolve, reject) => {
        if (!videoElement) {
            reject(new Error('No video element provided'));
            return;
        }
        
        const wasPlaying = !videoElement.paused;
        const originalTime = videoElement.currentTime;
        
        // Seek to target time
        videoElement.currentTime = timeSec;
        
        const onSeeked = () => {
            videoElement.removeEventListener('seeked', onSeeked);
            
            // Create canvas and draw video frame
            const canvas = document.createElement('canvas');
            canvas.width = videoElement.videoWidth || videoElement.clientWidth;
            canvas.height = videoElement.videoHeight || videoElement.clientHeight;
            
            const ctx = canvas.getContext('2d');
            ctx.drawImage(videoElement, 0, 0, canvas.width, canvas.height);
            
            // Restore original state
            videoElement.currentTime = originalTime;
            if (wasPlaying) {
                videoElement.play().catch(() => {});
            }
            
            resolve(canvas.toDataURL('image/png'));
        };
        
        videoElement.addEventListener('seeked', onSeeked, { once: true });
        
        // Timeout fallback
        setTimeout(() => {
            videoElement.removeEventListener('seeked', onSeeked);
            reject(new Error('Snapshot capture timeout'));
        }, 5000);
    });
}

/**
 * Open the blur zone editor for a specific camera
 * @param {string} snapshotCamera - Camera to capture snapshot from
 * @param {HTMLElement} editorModal - The editor modal element
 * @param {number|null} editIndex - Index of existing zone to edit, or null for new zone
 */
async function openBlurZoneEditorForCamera(snapshotCamera, editorModal, editIndex = null) {
    const state = getState?.();
    const nativeVideo = getNativeVideo?.();
    
    if (!state?.collection?.active) {
        notify(t('ui.notifications.loadCollectionFirst'), { type: 'warn' });
        return;
    }
    
    // Use current viewer playback time (cumulative position across all segments)
    const totalSec = nativeVideo?.cumulativeStarts?.[nativeVideo.cumulativeStarts.length - 1] || 60;
    const segIdx = nativeVideo?.currentSegmentIdx || 0;
    const cumStart = nativeVideo?.cumulativeStarts?.[segIdx] || 0;
    const masterTime = nativeVideo?.master?.currentTime || 0;
    const currentPlaybackSec = cumStart + masterTime;
    
    // Use current playback time directly (don't clamp to export range - user wants to see what's playing)
    const snapshotSec = Math.max(0, Math.min(totalSec, currentPlaybackSec));
    
    try {
        notify(t('ui.notifications.capturingSnapshot'));
        
        // Find the video file for the snapshot camera at the current playback position
        const groups = state.collection.active.groups || [];
        const cumStarts = nativeVideo?.cumulativeStarts || [];
        let targetSegment = 0;
        
        for (let i = 0; i < cumStarts.length - 1; i++) {
            if (snapshotSec >= cumStarts[i] && snapshotSec < cumStarts[i + 1]) {
                targetSegment = i;
                break;
            }
        }
        if (snapshotSec >= cumStarts[cumStarts.length - 1]) {
            targetSegment = groups.length - 1;
        }
        
        const group = groups[targetSegment];
        const entry = group?.filesByCamera?.get(snapshotCamera);
        
        if (!entry?.file) {
            notify(t('ui.notifications.couldNotFindVideoFile', { camera: snapshotCamera }), { type: 'error' });
            return;
        }
        
        // Create temporary video element
        const tempVideo = document.createElement('video');
        tempVideo.muted = true;
        tempVideo.playsInline = true;
        tempVideo.style.display = 'none';
        document.body.appendChild(tempVideo);
        
        // Load video file
        let videoUrl;
        if (entry.file.path) {
            // Use filePathToUrl which handles both Electron and web mode
            videoUrl = filePathToUrl(entry.file.path);
        } else if (entry.file instanceof File) {
            videoUrl = URL.createObjectURL(entry.file);
        } else {
            notify(t('ui.notifications.unsupportedFileType'), { type: 'error' });
            return;
        }
        
        tempVideo.src = videoUrl;
        
        await new Promise((resolve, reject) => {
            tempVideo.onloadedmetadata = resolve;
            tempVideo.onerror = reject;
            setTimeout(reject, 10000);
        });
        
        // Calculate local time within segment
        const segmentStartSec = cumStarts[targetSegment] || 0;
        const localTimeSec = Math.min(snapshotSec - segmentStartSec, tempVideo.duration);
        
        // Capture snapshot
        const snapshotDataUrl = await captureVideoSnapshot(localTimeSec, tempVideo);
        
        // Clean up
        tempVideo.src = '';
        document.body.removeChild(tempVideo);
        if (videoUrl.startsWith('blob:')) {
            URL.revokeObjectURL(videoUrl);
        }
        
        // Get video dimensions
        const videoWidth = tempVideo.videoWidth || 1448;
        const videoHeight = tempVideo.videoHeight || 938;
        
        // Store which camera this zone is for
        exportState.blurZoneCamera = snapshotCamera;
        exportState.blurZoneEditIndex = editIndex;
        
        // Load existing coordinates if editing
        const savedCoords = editIndex !== null ? exportState.blurZones[editIndex]?.coordinates : null;
        
        // Mirror the snapshot for cameras that are mirrored in viewer/export (back and repeaters only)
        // Respect the global mirrorCameras setting
        const shouldMirror = window._mirrorCameras !== false && ['back', 'left_repeater', 'right_repeater'].includes(snapshotCamera);
        
        // Initialize editor with snapshot
        editorModal.classList.remove('hidden');
        initBlurZoneEditor(snapshotDataUrl, videoWidth, videoHeight, savedCoords, shouldMirror);
        
    } catch (err) {
        console.error('Failed to capture snapshot:', err);
        notify(t('ui.notifications.failedToCaptureSnapshot', { error: err.message }), { type: 'error' });
    }
}

/**
 * Render the list of configured blur zones with edit/remove buttons
 */
function renderBlurZoneList() {
    const listEl = $('blurZoneList');
    if (!listEl) return;
    
    const cameraNames = {
        front: t('ui.cameras.front'),
        back: t('ui.cameras.back'),
        left_repeater: t('ui.cameras.leftRepeater'),
        right_repeater: t('ui.cameras.rightRepeater'),
        left_pillar: t('ui.cameras.leftPillar'),
        right_pillar: t('ui.cameras.rightPillar')
    };
    
    if (exportState.blurZones.length === 0) {
        listEl.innerHTML = '';
        return;
    }
    
    listEl.innerHTML = exportState.blurZones.map((zone, index) => `
        <div class="blur-zone-item" style="display: flex; align-items: center; justify-content: space-between; padding: 8px 12px; background: rgba(255,255,255,0.05); border-radius: 6px; margin-bottom: 6px;">
            <span style="color: var(--text-secondary);">
                <strong>${cameraNames[zone.camera] || zone.camera}</strong> - ${zone.coordinates.length} points
            </span>
            <div style="display: flex; gap: 6px;">
                <button class="btn btn-secondary btn-small blur-zone-edit-btn" data-index="${index}" style="padding: 4px 10px; font-size: 12px;">Edit</button>
                <button class="btn btn-secondary btn-small blur-zone-remove-btn" data-index="${index}" style="padding: 4px 10px; font-size: 12px; color: #ff6b6b;">Remove</button>
            </div>
        </div>
    `).join('');
    
    // Add event listeners for edit/remove buttons
    listEl.querySelectorAll('.blur-zone-edit-btn').forEach(btn => {
        btn.addEventListener('click', async () => {
            const index = parseInt(btn.dataset.index, 10);
            const zone = exportState.blurZones[index];
            if (zone) {
                const editorModal = $('blurZoneEditorModal');
                await openBlurZoneEditorForCamera(zone.camera, editorModal, index);
            }
        });
    });
    
    listEl.querySelectorAll('.blur-zone-remove-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const index = parseInt(btn.dataset.index, 10);
            exportState.blurZones.splice(index, 1);
            renderBlurZoneList();
            updateBlurZoneStatusDisplay(); // This handles dashboard availability
        });
    });
}

/**
 * Initialize blur zone editor modal event handlers
 */
function initBlurZoneEditorModal() {
    // Prevent duplicate initialization
    if (blurZoneModalInitialized) return;
    
    const addBtn = $('addBlurZoneBtn');
    const editorModal = $('blurZoneEditorModal');
    const closeBtn = $('closeBlurZoneEditorModal');
    const cancelBtn = $('cancelBlurZoneBtn');
    const saveBtn = $('saveBlurZoneBtn');
    
    if (!addBtn || !editorModal) return;
    
    blurZoneModalInitialized = true;
    
    addBtn.addEventListener('click', async () => {
        // Get camera from dropdown
        const cameraSelect = $('blurZoneCameraSelect');
        const snapshotCamera = cameraSelect?.value || 'back';
        
        await openBlurZoneEditorForCamera(snapshotCamera, editorModal);
    });
    
    const closeEditor = () => {
        editorModal.classList.add('hidden');
        resetBlurZoneEditor();
        exportState.blurZoneEditIndex = null;
    };
    
    if (closeBtn) closeBtn.addEventListener('click', closeEditor);
    if (cancelBtn) cancelBtn.addEventListener('click', closeEditor);
    
    if (saveBtn) {
        saveBtn.addEventListener('click', async () => {
            try {
                const coords = getNormalizedCoordinates();
                
                if (!coords || coords.length < 3) {
                    notify(t('ui.notifications.blurZoneMinPoints'), { type: 'warn' });
                    return;
                }
                
                // Generate mask image
                const maskImageDataUrl = await generateMaskImage();
                if (!maskImageDataUrl) {
                    notify(t('ui.notifications.failedToGenerateMask'), { type: 'error' });
                    return;
                }
                
                // Extract base64 data
                const base64Data = maskImageDataUrl.split(',')[1];
                if (!base64Data) {
                    notify(t('ui.notifications.failedToExtractMaskData'), { type: 'error' });
                    return;
                }
                
                // Get canvas dimensions
                const canvasDims = getCanvasDimensions();
                if (!canvasDims) {
                    notify(t('ui.notifications.failedToGetCanvasDimensions'), { type: 'error' });
                    return;
                }
                
                const newZone = {
                    coordinates: coords,
                    camera: exportState.blurZoneCamera || 'back',
                    maskImageBase64: base64Data,
                    maskWidth: canvasDims.width,
                    maskHeight: canvasDims.height
                };
                
                // Update existing zone if editing, or add new zone
                if (exportState.blurZoneEditIndex !== null) {
                    exportState.blurZones[exportState.blurZoneEditIndex] = newZone;
                } else {
                    // Always add as new zone (allow multiple zones per camera)
                    exportState.blurZones.push(newZone);
                }
                
                // Update dashboard availability based on blur zones and blur type
                updateDashboardAvailability();
                
                updateBlurZoneStatusDisplay();
                notify(t('ui.notifications.blurZoneSaved'), { type: 'success' });
                closeEditor();
            } catch (err) {
                console.error('[BLUR ZONE] Save error:', err);
                notify(t('ui.notifications.failedToSaveBlurZone', { error: err.message }), { type: 'error' });
            }
        });
    }
}

/**
 * Update the blur zone status display in export modal
 */
function updateBlurZoneStatusDisplay() {
    const statusEl = $('blurZoneStatus');
    const statusTextEl = $('blurZoneStatusText');
    const addBtn = $('addBlurZoneBtn');
    
    // Render the blur zone list
    renderBlurZoneList();
    
    if (exportState.blurZones.length > 0) {
        if (statusEl) statusEl.classList.remove('hidden');
        const cameras = [...new Set(exportState.blurZones.map(z => z.camera))];
        const cameraNames = cameras.map(c => {
            const names = { front: t('ui.cameras.front'), back: t('ui.cameras.back'), left_repeater: t('ui.cameras.leftRepeater'), right_repeater: t('ui.cameras.rightRepeater'), left_pillar: t('ui.cameras.leftPillar'), right_pillar: t('ui.cameras.rightPillar') };
            return names[c] || c;
        });
        // Show blur zone count - dashboard status depends on blur type, handled separately
        if (statusTextEl) {
            statusTextEl.textContent = t('ui.export.blurZoneCount', { count: exportState.blurZones.length });
        }
        if (addBtn) addBtn.textContent = 'Add Zone';
    } else {
        if (statusEl) statusEl.classList.add('hidden');
        if (addBtn) addBtn.textContent = 'Add Zone';
    }
    
    // Update dashboard availability based on blur zones and blur type
    updateDashboardAvailability();
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
    estimateEl.textContent = `${t('ui.export.output')}: ${gridW}×${gridH} • ${sizeText}`;
}

/**
 * Check if FFmpeg is available
 */
export async function checkFFmpegAvailability() {
    const statusEl = $('ffmpegStatus');
    const startBtn = $('startExportBtn');
    const dashboardCheckbox = $('includeDashboard');
    const dashboardOptions = $('dashboardOptions');
    const dashboardGpuWarning = $('dashboardGpuWarning');
    const dashboardToggleRow = dashboardCheckbox?.closest('.toggle-row');
    const timestampCheckbox = $('includeTimestamp');
    const timestampOptions = $('timestampOptions');
    const timestampToggleRow = timestampCheckbox?.closest('.toggle-row');
    
    // Set up dashboard checkbox toggle for options visibility
    if (dashboardCheckbox && dashboardOptions) {
        dashboardCheckbox.addEventListener('change', () => {
            if (dashboardCheckbox.checked) {
                dashboardOptions.classList.remove('hidden');
                // Dashboard includes timestamp, so disable timestamp-only option
                if (timestampCheckbox) {
                    timestampCheckbox.checked = false;
                    timestampCheckbox.disabled = true;
                    if (timestampToggleRow) timestampToggleRow.classList.add('disabled');
                    if (timestampOptions) timestampOptions.classList.add('hidden');
                }
            } else {
                dashboardOptions.classList.add('hidden');
                // Re-enable timestamp option when dashboard is disabled
                if (timestampCheckbox) {
                    timestampCheckbox.disabled = false;
                    if (timestampToggleRow) timestampToggleRow.classList.remove('disabled');
                }
            }
        });
    }
    
    // Set up timestamp checkbox toggle for options visibility
    if (timestampCheckbox && timestampOptions) {
        timestampCheckbox.addEventListener('change', () => {
            if (timestampCheckbox.checked) {
                timestampOptions.classList.remove('hidden');
            } else {
                timestampOptions.classList.add('hidden');
            }
        });
    }
    
    // Set up blur type dropdown listener to update dashboard availability
    // When user changes blur type, dashboard availability may change
    const blurTypeSelect = $('blurTypeSelect');
    if (blurTypeSelect) {
        blurTypeSelect.addEventListener('change', () => {
            updateDashboardAvailability();
        });
    }
    
    if (!statusEl) return;
    
    statusEl.innerHTML = `<span class="status-icon">⏳</span><span class="status-text">${t('ui.export.checkingFfmpeg')}</span>`;
    
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
                let statusText = t('ui.export.ffmpegReady');
                if (result.gpu) {
                    statusText += ` • GPU: ${result.gpu.name}`;
                    if (result.hevc) {
                        statusText += ` + HEVC`;
                    }
                } else {
                    statusText += ` • ${t('ui.export.cpuOnly')}`;
                }
                if (result.fakeNoGpu) {
                    statusText += ' [DEV: Fake No GPU]';
                }
                
                statusEl.innerHTML = `<span class="status-icon" style="color: #4caf50;">✓</span><span class="status-text">${statusText}</span>`;
                if (startBtn) startBtn.disabled = false;
                
                // Dashboard overlay requires GPU - show warning if no GPU
                if (!result.gpu && dashboardGpuWarning) {
                    dashboardGpuWarning.classList.remove('hidden');
                } else if (dashboardGpuWarning) {
                    dashboardGpuWarning.classList.add('hidden');
                }
                
                // Update dashboard availability based on GPU and blur zones/type
                updateDashboardAvailability();
            } else {
                const isMac = navigator.platform.toLowerCase().includes('mac');
                if (isMac) {
                    statusEl.innerHTML = `<span class="status-icon" style="color: #f44336;">✗</span><span class="status-text">${t('ui.export.ffmpegRequiredMac')}</span>`;
                } else {
                    statusEl.innerHTML = `<span class="status-icon" style="color: #f44336;">✗</span><span class="status-text">${t('ui.export.ffmpegRequiredWin')}</span>`;
                }
                if (startBtn) startBtn.disabled = true;
                if (dashboardCheckbox) {
                    dashboardCheckbox.disabled = true;
                    dashboardCheckbox.checked = false;
                }
            }
        } else {
            statusEl.innerHTML = `<span class="status-icon" style="color: #ff9800;">⚠</span><span class="status-text">${t('ui.export.notAvailable')}</span>`;
            if (startBtn) startBtn.disabled = true;
            if (dashboardCheckbox) {
                dashboardCheckbox.disabled = true;
                dashboardCheckbox.checked = false;
            }
        }
    } catch (err) {
        statusEl.innerHTML = `<span class="status-icon" style="color: #f44336;">✗</span><span class="status-text">${t('ui.export.ffmpegError')}</span>`;
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
        notify(t('ui.notifications.exportNotAvailable'), { type: 'error' });
        return;
    }
    
    if (!baseFolderPath) {
        notify(t('ui.notifications.exportRequiresFolder'), { type: 'warn' });
        return;
    }
    
    const cameraCheckboxes = document.querySelectorAll('.option-card input[data-camera]:checked');
    const cameras = Array.from(cameraCheckboxes).map(cb => cb.dataset.camera);
    
    if (cameras.length === 0) {
        notify(t('ui.notifications.selectAtLeastOneCamera'), { type: 'warn' });
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
    
    // Blur zone disables dashboard ONLY for 'trueBlur' type
    // 'solid' blur type uses ASS overlay which can be layered with dashboard
    const hasBlurZones = exportState.blurZones.length > 0;
    const blurType = $('blurTypeSelect')?.value || 'solid';
    const includeDashboardCheckbox = $('includeDashboard');
    let includeDashboard = includeDashboardCheckbox?.checked ?? false;
    
    // Disable dashboard if blur zones are active AND blur type is not 'solid'
    if (hasBlurZones && blurType !== 'solid') {
        includeDashboard = false;
    }
    
    // Check for blur zones on unselected cameras and warn user
    if (hasBlurZones) {
        const blurCameras = [...new Set(exportState.blurZones.map(z => z.camera))];
        const unselectedBlurCameras = blurCameras.filter(c => !cameras.includes(c));
        if (unselectedBlurCameras.length > 0) {
            const cameraNames = { front: t('ui.cameras.front'), back: t('ui.cameras.back'), left_repeater: t('ui.cameras.leftRepeater'), right_repeater: t('ui.cameras.rightRepeater'), left_pillar: t('ui.cameras.leftPillar'), right_pillar: t('ui.cameras.rightPillar') };
            const names = unselectedBlurCameras.map(c => cameraNames[c] || c).join(', ');
            notify(t('ui.export.blurZonesWarning', { cameras: names }), { type: 'warn' });
        }
    }
    
    const dashboardStyle = $('dashboardStyle')?.value || 'standard';
    const dashboardPosition = $('dashboardPosition')?.value || 'bottom-center';
    const dashboardSize = $('dashboardSize')?.value || 'medium';
    
    // Minimap settings
    const includeMinimapCheckbox = $('includeMinimap');
    const includeMinimap = includeMinimapCheckbox?.checked ?? false;
    const minimapPosition = $('minimapPosition')?.value || 'top-right';
    const minimapSize = $('minimapSize')?.value || 'small';
    const minimapRenderMode = $('minimapRenderMode')?.value || 'ass'; // 'ass' or 'leaflet'
    
    console.log(`[MINIMAP] UI state: checkbox=${includeMinimapCheckbox?.checked}, includeMinimap=${includeMinimap}`);
    console.log(`[MINIMAP] Position=${minimapPosition}, Size=${minimapSize}, RenderMode=${minimapRenderMode}`);
    
    const includeTimestampCheckbox = $('includeTimestamp');
    const includeTimestamp = includeTimestampCheckbox?.checked ?? false;
    const timestampPosition = $('timestampPosition')?.value || 'bottom-center';
    const timestampDateFormat = window._dateFormat || 'ymd'; // Use global date format setting
    const timestampTimeFormat = window._timeFormat || '12h'; // Use global time format setting (12h/24h)
    
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
        notify(t('ui.notifications.exportCancelled'), { type: 'info' });
        return;
    }
    
    // Only extract SEI data if dashboard or minimap is enabled - skip entirely if both disabled to save RAM
    // Extract SEI data one segment at a time to avoid loading all files into memory simultaneously
    // This happens AFTER file dialog so user gets instant feedback
    let seiData = null;
    let mapPath = []; // GPS path for minimap
    
    if (includeDashboard || includeMinimap) {
        try {
            notify(t('ui.notifications.extractingTelemetry'), { type: 'info' });
            
            const cumStarts = nativeVideo?.cumulativeStarts || [];
            const groups = state.collection.active.groups || [];
            const allSeiData = [];
            const allMapPath = []; // Collect GPS coordinates
            
            if (!window.DashcamMP4 || !window.DashcamHelpers) {
                throw new Error('Dashcam parser not available');
            }
            
            const DashcamMP4 = window.DashcamMP4;
            const { SeiMetadata } = await window.DashcamHelpers.initProtobuf();
            
            // Helper to check for valid GPS coordinates
            // SEI uses latitude_deg/longitude_deg field names
            const hasValidGps = (sei) => {
                const lat = sei?.latitude_deg;
                const lon = sei?.longitude_deg;
                return lat !== undefined && lon !== undefined && 
                       Number.isFinite(lat) && Number.isFinite(lon) &&
                       !(Math.abs(lat) < 0.001 && Math.abs(lon) < 0.001);
            };
            
            // Extract SEI data one segment at a time to minimize RAM usage
            for (let i = 0; i < groups.length; i++) {
                // Check for cancellation before processing each segment
                if (exportState.cancelled) {
                    console.log('SEI extraction cancelled by user');
                    seiData = null;
                    mapPath = [];
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
                                const fileUrl = filePathToUrl(entry.file.path);
                                const response = await fetch(fileUrl);
                                buffer = await response.arrayBuffer();
                            } else if (entry.file instanceof File) {
                                buffer = await entry.file.arrayBuffer();
                            } else if (entry.file.path) {
                                const fileUrl = filePathToUrl(entry.file.path);
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
                                        
                                        // Extract GPS coordinates for minimap path
                                        if (includeMinimap && hasValidGps(frame.sei)) {
                                            allMapPath.push([frame.sei.latitude_deg, frame.sei.longitude_deg]);
                                        }
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
            
            console.log(`[MINIMAP] SEI extraction complete: ${allSeiData.length} SEI frames, ${allMapPath.length} GPS points`);
            
            if (allSeiData.length > 0) {
                seiData = allSeiData;
                mapPath = allMapPath;
                console.log(`[MINIMAP] GPS data available: ${mapPath.length} points`);
            } else {
                if (includeDashboard) {
                    notify(t('ui.notifications.noTelemetryData'), { type: 'warn' });
                }
                if (includeMinimap && allMapPath.length === 0) {
                    notify(t('ui.export.minimapNoGpsDisabled'), { type: 'warn' });
                }
                seiData = null;
                mapPath = [];
            }
        } catch (err) {
            if (includeDashboard) {
                notify(t('ui.notifications.failedToExtractTelemetry'), { type: 'warn' });
            }
            if (includeMinimap) {
                notify(t('ui.export.minimapGpsExtractFailed'), { type: 'warn' });
            }
            seiData = null;
            mapPath = [];
        }
    }
    // If dashboard and minimap are both disabled, seiData remains null and no files are loaded into memory
    
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
        
        // Parse timestamp from group's timestampKey for ASS dashboard overlay
        const timestamp = parseTimestampKeyToEpochMs(group.timestampKey) || null;
        
        segments.push({
            index: i,
            durationSec,
            startSec: cumStarts[i] || 0,
            files,
            groupId: group.id,
            timestamp // Epoch ms for this segment's start time (UTC)
        });
    }
    
    const hasFiles = segments.some(seg => Object.keys(seg.files).length > 0);
    if (!hasFiles) {
        notify(t('ui.notifications.noVideoFilesForExport'), { type: 'error' });
        return;
    }
    
    const progressEl = $('exportProgress');
    const exportProgressBar = $('exportProgressBar');
    const progressText = $('exportProgressText');
    const startBtn = $('startExportBtn');
    
    if (progressEl) progressEl.classList.remove('hidden');
    if (exportProgressBar) exportProgressBar.style.width = '0%';
    if (progressText) progressText.textContent = t('ui.export.preparing');
    
    if (startBtn) startBtn.disabled = true;
    
    // Show hint during export
    const minimizeHint = $('exportMinimizeHint');
    if (minimizeHint) minimizeHint.classList.remove('hidden');
    
    const exportId = `export_${Date.now()}`;
    exportState.currentExportId = exportId;
    exportState.isExporting = true;
    exportState.cancelled = false; // Reset cancellation flag
    
    // Get dashboard and minimap progress elements
    const dashboardProgressEl = $('dashboardProgress');
    const dashboardProgressBar = $('dashboardProgressBar');
    const dashboardProgressText = $('dashboardProgressText');
    const minimapProgressEl = $('minimapProgress');
    const minimapProgressBar = $('minimapProgressBar');
    const minimapProgressText = $('minimapProgressText');
    
    // Hide dashboard and minimap progress bars initially
    if (dashboardProgressEl) dashboardProgressEl.classList.add('hidden');
    if (minimapProgressEl) minimapProgressEl.classList.add('hidden');
    
    if (window.electronAPI?.on) {
        window.electronAPI.on('export:progress', (receivedExportId, progress) => {
            if (receivedExportId !== exportId) return;
            
            if (progress.type === 'progress') {
                const translatedMessage = translateMessage(progress.message);
                if (exportProgressBar) exportProgressBar.style.width = `${progress.percentage}%`;
                if (progressText) progressText.textContent = translatedMessage;
                
                // Track progress for floating notification
                exportState.currentStep = translatedMessage;
                exportState.currentProgress = progress.percentage;
                
                // Update floating notification if modal is minimized
                if (exportState.modalMinimized) {
                    updateFloatingProgress(translatedMessage, progress.percentage);
                }
            } else if (progress.type === 'dashboard-progress') {
                // Show dashboard progress bar
                if (dashboardProgressEl) dashboardProgressEl.classList.remove('hidden');
                if (dashboardProgressBar) dashboardProgressBar.style.width = `${progress.percentage}%`;
                if (dashboardProgressText) dashboardProgressText.textContent = progress.message;
                
                if (exportState.modalMinimized) {
                    updateFloatingProgress(progress.message, progress.percentage);
                }
            } else if (progress.type === 'minimap-progress') {
                // Show minimap progress bar
                if (minimapProgressEl) minimapProgressEl.classList.remove('hidden');
                if (minimapProgressBar) minimapProgressBar.style.width = `${progress.percentage}%`;
                if (minimapProgressText) minimapProgressText.textContent = progress.message;
                
                if (exportState.modalMinimized) {
                    updateFloatingProgress(progress.message, progress.percentage);
                }
            } else if (progress.type === 'complete') {
                exportState.isExporting = false;
                exportState.currentExportId = null;
                exportState.cancelled = false;
                exportState.modalMinimized = false;
                exportState.currentStep = '';
                exportState.currentProgress = 0;
                
                // Hide floating notification on complete
                hideFloatingProgress();
                
                // Hide hint and overlay progress bars
                const minHint = $('exportMinimizeHint');
                if (minHint) minHint.classList.add('hidden');
                if (dashboardProgressEl) dashboardProgressEl.classList.add('hidden');
                if (minimapProgressEl) minimapProgressEl.classList.add('hidden');
                
                const translatedMessage = translateMessage(progress.message);
                
                if (progress.success) {
                    if (exportProgressBar) exportProgressBar.style.width = '100%';
                    if (progressText) progressText.textContent = translatedMessage;
                    notify(translatedMessage, { type: 'success' });
                    
                    // Show modal if it was minimized so user sees completion
                    const modal = $('exportModal');
                    if (modal?.classList.contains('hidden')) {
                        modal.classList.remove('hidden');
                    }
                    
                    setTimeout(() => {
                        if (confirm(`${translatedMessage}\n\n${t('ui.export.openFileLocation')}`)) {
                            window.electronAPI.showItemInFolder(outputPath);
                        }
                        closeExportModal();
                    }, 500);
                } else {
                    if (progressText) progressText.textContent = translatedMessage;
                    notify(translatedMessage, { type: 'error' });
                    if (startBtn) startBtn.disabled = false;
                    
                    // Show modal on error so user sees what happened
                    const modal = $('exportModal');
                    if (modal?.classList.contains('hidden')) {
                        modal.classList.remove('hidden');
                    }
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
            // Dashboard is allowed with blur zones if blur type is 'solid' (both use ASS, can be layered)
            includeDashboard: includeDashboard && seiData !== null && seiData.length > 0 && (blurType === 'solid' || !hasBlurZones),
            seiData: seiData || [], // Empty array if dashboard disabled - no RAM used
            layoutData: layoutData || null,
            useMetric: getUseMetric?.() ?? false, // Pass metric setting for dashboard overlay
            glassBlur: parseInt(document.documentElement.style.getPropertyValue('--glass-blur') || '7', 10), // Glass blur setting
            dashboardStyle, // Style: standard (full layout) or compact (streamlined)
            dashboardPosition, // Position: bottom-center, bottom-left, bottom-right, top-center, etc.
            dashboardSize, // Size: small (20%), medium (30%), large (40%)
            // Timestamp-only option (independent of dashboard, uses simple drawtext filter)
            includeTimestamp: includeTimestamp && !includeDashboard, // Only if dashboard is not enabled
            timestampPosition, // Position: bottom-center, bottom-left, etc.
            timestampDateFormat, // Date format: mdy (US), dmy (International), ymd (ISO)
            timestampTimeFormat, // Time format: 12h (AM/PM), 24h
            // Blur zone data - filter to only selected cameras, send all zones
            blurZones: exportState.blurZones.filter(z => cameras.includes(z.camera)),
            blurType: $('blurTypeSelect')?.value || 'solid', // 'solid' (ASS cover), 'trueBlur' (mask-based blur)
            // Language for dashboard text translations (Gear, Autopilot states, etc.)
            language: getCurrentLanguage(),
            // Mirror cameras setting (back and repeaters)
            mirrorCameras: window._mirrorCameras !== false,
            // Minimap settings
            includeMinimap: includeMinimap && mapPath.length > 0,
            minimapPosition,
            minimapSize,
            minimapRenderMode, // 'ass' (fast, vector) or 'leaflet' (slow, map tiles)
            mapPath
        };
        
        console.log(`[MINIMAP] Export data: includeMinimap=${exportData.includeMinimap}, mapPath.length=${mapPath.length}, position=${minimapPosition}, size=${minimapSize}, renderMode=${minimapRenderMode}`);
        
        await window.electronAPI.startExport(exportId, exportData);
    } catch (err) {
        console.error('Export error:', err);
        notify(t('ui.notifications.exportFailedWithError', { error: err.message }), { type: 'error' });
        exportState.isExporting = false;
        exportState.currentExportId = null;
        exportState.cancelled = false; // Reset cancellation flag
        if (startBtn) startBtn.disabled = false;
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
        notify(t('ui.notifications.exportCancelled'), { type: 'info' });
    }
    
    exportState.isExporting = false;
    exportState.currentExportId = null;
    exportState.cancelled = false;
    exportState.modalMinimized = false;
    exportState.currentStep = '';
    exportState.currentProgress = 0;
    
    // Hide floating progress if visible
    hideFloatingProgress();
    
    // Hide hint
    const minimizeHint = $('exportMinimizeHint');
    if (minimizeHint) minimizeHint.classList.add('hidden');
    
    const progressEl = $('exportProgress');
    const startBtn = $('startExportBtn');
    
    if (progressEl) progressEl.classList.add('hidden');
    if (startBtn) startBtn.disabled = false;
    
    // Close modal completely when cancelled
    const modal = $('exportModal');
    if (modal) modal.classList.add('hidden');
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
