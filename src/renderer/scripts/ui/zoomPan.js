/**
 * Zoom and Pan System
 * Handles zooming and panning in focused multi-camera view
 */

import { getEffectiveSlots } from '../features/cameraRearrange.js';

// Zoom/Pan state
export const zoomPanState = {
    zoom: 1,
    panX: 0,
    panY: 0,
    isPanning: false,
    wasPanning: false,
    startX: 0,
    startY: 0,
    minZoom: 1,
    maxZoom: 4,
    indicatorTimeout: null
};

// Dependencies set via init
let getMultiCamGrid = null;
let getState = null;

/**
 * Check if a camera should be mirrored (Back, Left/Right Repeater cameras)
 */
function shouldMirrorCamera(camera) {
    return camera === 'back' || camera === 'left_repeater' || camera === 'right_repeater';
}

/**
 * Get the camera assigned to a slot
 */
function getCameraForSlot(slot) {
    const effectiveSlots = getEffectiveSlots();
    const slotDef = effectiveSlots.find(s => s.slot === slot);
    return slotDef?.camera;
}

/**
 * Apply mirror transform to all video elements based on their camera assignments
 */
export function applyMirrorTransforms() {
    const multiCamGrid = getMultiCamGrid?.();
    if (!multiCamGrid) return;
    
    const effectiveSlots = getEffectiveSlots();
    
    // Map of slot to camera
    const slotToCamera = {};
    effectiveSlots.forEach(({ slot, camera }) => {
        slotToCamera[slot] = camera;
    });
    
    // Apply to regular tiles
    multiCamGrid.querySelectorAll('.multi-tile').forEach(tile => {
        const slot = tile.getAttribute('data-slot');
        const camera = slotToCamera[slot];
        const media = tile.querySelector('video, canvas');
        
        if (media && camera) {
            const needsMirror = shouldMirrorCamera(camera);
            if (needsMirror && !media.classList.contains('mirrored')) {
                media.classList.add('mirrored');
                // Apply base mirror transform if not zoomed
                if (!tile.classList.contains('zoomed')) {
                    media.style.transform = 'scaleX(-1)';
                }
            } else if (!needsMirror && media.classList.contains('mirrored')) {
                media.classList.remove('mirrored');
                if (!tile.classList.contains('zoomed')) {
                    media.style.transform = '';
                }
            }
        }
    });
    
    // Apply to immersive overlays (overlay slots map to base slots: overlay_tl -> tl, overlay_bl -> bl, etc.)
    const overlaySlotMap = {
        'overlay_tl': 'tl',
        'overlay_tr': 'tr',
        'overlay_bl': 'bl',
        'overlay_bc': 'bc',
        'overlay_br': 'br'
    };
    
    multiCamGrid.querySelectorAll('.immersive-overlay').forEach(overlay => {
        const overlaySlot = overlay.getAttribute('data-slot');
        const baseSlot = overlaySlotMap[overlaySlot];
        const camera = baseSlot ? slotToCamera[baseSlot] : null;
        const media = overlay.querySelector('video, canvas');
        
        if (media && camera) {
            const needsMirror = shouldMirrorCamera(camera);
            if (needsMirror && !media.classList.contains('mirrored')) {
                media.classList.add('mirrored');
                if (!overlay.classList.contains('zoomed')) {
                    media.style.transform = 'scaleX(-1)';
                }
            } else if (!needsMirror && media.classList.contains('mirrored')) {
                media.classList.remove('mirrored');
                if (!overlay.classList.contains('zoomed')) {
                    media.style.transform = '';
                }
            }
        }
    });
}

/**
 * Initialize zoom/pan module with dependencies
 * @param {Object} deps - Dependencies
 */
export function initZoomPan(deps) {
    getMultiCamGrid = deps.getMultiCamGrid;
    getState = deps.getState;
    initZoomPanListeners();
}

/**
 * Reset zoom and pan to default
 */
export function resetZoomPan() {
    const multiCamGrid = getMultiCamGrid?.();
    zoomPanState.zoom = 1;
    zoomPanState.panX = 0;
    zoomPanState.panY = 0;
    zoomPanState.isPanning = false;
    
    const allTiles = multiCamGrid?.querySelectorAll('.multi-tile, .immersive-main, .immersive-overlay');
    allTiles?.forEach(tile => {
        tile.classList.remove('zoomed');
        const media = tile.querySelector('video, canvas');
        if (media) {
            // Preserve mirror transform if this video should be mirrored
            if (media.classList.contains('mirrored')) {
                media.style.transform = 'scaleX(-1)';
            } else {
                media.style.transform = '';
            }
            media.classList.remove('panning');
        }
        const indicator = tile.querySelector('.zoom-indicator');
        if (indicator) indicator.remove();
    });
}

/**
 * Apply zoom and pan transform to the focused tile's media element
 */
export function applyZoomPan() {
    const multiCamGrid = getMultiCamGrid?.();
    const state = getState?.();
    if (!state?.ui?.multiFocusSlot || !multiCamGrid) return;
    
    const focusedTile = multiCamGrid.querySelector(
        `.multi-tile[data-slot="${state.ui.multiFocusSlot}"], ` +
        `.immersive-main[data-slot="${state.ui.multiFocusSlot}"], ` +
        `.immersive-overlay[data-slot="${state.ui.multiFocusSlot}"]`
    );
    if (!focusedTile) return;
    
    const media = focusedTile.querySelector('video, canvas');
    if (!media) return;
    
    // Check if this camera should be mirrored
    const slot = focusedTile.getAttribute('data-slot');
    // Handle immersive overlay slots (map to base slots)
    const overlaySlotMap = {
        'overlay_tl': 'tl',
        'overlay_tr': 'tr',
        'overlay_bl': 'bl',
        'overlay_bc': 'bc',
        'overlay_br': 'br'
    };
    const baseSlot = overlaySlotMap[slot] || slot;
    const camera = getCameraForSlot(baseSlot);
    const needsMirror = camera && shouldMirrorCamera(camera);
    
    // Build transform string
    // CSS transforms are applied right-to-left, so to get: mirror -> zoom -> pan
    // we need to write: translate -> scale -> scaleX(-1)
    let transform = '';
    if (zoomPanState.zoom > 1 || zoomPanState.panX !== 0 || zoomPanState.panY !== 0) {
        // Apply zoom and pan transforms
        transform = `translate(${zoomPanState.panX}px, ${zoomPanState.panY}px) scale(${zoomPanState.zoom})`;
        // Add mirror at the end (applied first visually) if needed
        if (needsMirror) {
            transform += ' scaleX(-1)';
        }
    } else {
        // No zoom/pan, just mirror if needed
        if (needsMirror) {
            transform = 'scaleX(-1)';
        }
    }
    
    media.style.transform = transform;
    
    // Track mirror state for reset
    if (needsMirror) {
        media.classList.add('mirrored');
    } else {
        media.classList.remove('mirrored');
    }
    
    if (zoomPanState.zoom > 1) {
        focusedTile.classList.add('zoomed');
    } else {
        focusedTile.classList.remove('zoomed');
    }
    
    updateZoomIndicator(focusedTile);
}

function updateZoomIndicator(tile) {
    let indicator = tile.querySelector('.zoom-indicator');
    
    if (zoomPanState.zoom <= 1) {
        if (indicator) indicator.remove();
        return;
    }
    
    if (!indicator) {
        indicator = document.createElement('div');
        indicator.className = 'zoom-indicator';
        tile.appendChild(indicator);
    }
    
    indicator.textContent = `${zoomPanState.zoom.toFixed(1)}x`;
    indicator.classList.add('visible');
    indicator.classList.remove('fading');
    
    if (zoomPanState.indicatorTimeout) {
        clearTimeout(zoomPanState.indicatorTimeout);
    }
    
    zoomPanState.indicatorTimeout = setTimeout(() => {
        indicator.classList.add('fading');
    }, 1500);
}

function handleZoomWheel(e) {
    const multiCamGrid = getMultiCamGrid?.();
    const state = getState?.();
    if (!state?.ui?.multiFocusSlot || !multiCamGrid?.classList.contains('focused')) return;
    
    const focusedTile = e.target.closest('.multi-tile, .immersive-main, .immersive-overlay');
    if (!focusedTile) return;
    
    e.preventDefault();
    
    const delta = e.deltaY > 0 ? -0.25 : 0.25;
    const newZoom = Math.max(zoomPanState.minZoom, Math.min(zoomPanState.maxZoom, zoomPanState.zoom + delta));
    
    if (newZoom <= 1) {
        zoomPanState.zoom = 1;
        zoomPanState.panX = 0;
        zoomPanState.panY = 0;
    } else {
        zoomPanState.zoom = newZoom;
        constrainPan();
    }
    
    applyZoomPan();
}

function constrainPan() {
    if (zoomPanState.zoom <= 1) {
        zoomPanState.panX = 0;
        zoomPanState.panY = 0;
        return;
    }
    
    const maxPan = (zoomPanState.zoom - 1) * 150;
    zoomPanState.panX = Math.max(-maxPan, Math.min(maxPan, zoomPanState.panX));
    zoomPanState.panY = Math.max(-maxPan, Math.min(maxPan, zoomPanState.panY));
}

function handlePanStart(e) {
    const multiCamGrid = getMultiCamGrid?.();
    const state = getState?.();
    if (!state?.ui?.multiFocusSlot || !multiCamGrid?.classList.contains('focused')) return;
    if (zoomPanState.zoom <= 1) return;
    
    const focusedTile = e.target.closest('.multi-tile, .immersive-main, .immersive-overlay');
    if (!focusedTile) return;
    
    if (e.target.closest('.multi-label, button, .zoom-indicator')) return;
    
    e.preventDefault();
    zoomPanState.isPanning = true;
    zoomPanState.startX = e.clientX - zoomPanState.panX * zoomPanState.zoom;
    zoomPanState.startY = e.clientY - zoomPanState.panY * zoomPanState.zoom;
    
    const media = focusedTile.querySelector('video, canvas');
    if (media) media.classList.add('panning');
}

function handlePanMove(e) {
    if (!zoomPanState.isPanning) return;
    
    e.preventDefault();
    zoomPanState.panX = (e.clientX - zoomPanState.startX) / zoomPanState.zoom;
    zoomPanState.panY = (e.clientY - zoomPanState.startY) / zoomPanState.zoom;
    
    constrainPan();
    applyZoomPan();
}

function handlePanEnd(e) {
    const multiCamGrid = getMultiCamGrid?.();
    if (!zoomPanState.isPanning) return;
    
    zoomPanState.isPanning = false;
    zoomPanState.wasPanning = true;
    
    const allMedia = multiCamGrid?.querySelectorAll('video.panning, canvas.panning');
    allMedia?.forEach(m => m.classList.remove('panning'));
    
    setTimeout(() => {
        zoomPanState.wasPanning = false;
    }, 50);
}

function handleZoomReset(e) {
    const multiCamGrid = getMultiCamGrid?.();
    const state = getState?.();
    if (!state?.ui?.multiFocusSlot || !multiCamGrid?.classList.contains('focused')) return;
    
    const focusedTile = e.target.closest('.multi-tile, .immersive-main, .immersive-overlay');
    if (!focusedTile) return;
    
    if (e.target.closest('.multi-label, button')) return;
    
    e.preventDefault();
    
    if (zoomPanState.zoom > 1) {
        zoomPanState.zoom = 1;
        zoomPanState.panX = 0;
        zoomPanState.panY = 0;
    } else {
        zoomPanState.zoom = 2;
    }
    
    applyZoomPan();
}

function initZoomPanListeners() {
    const multiCamGrid = getMultiCamGrid?.();
    if (!multiCamGrid) return;
    
    multiCamGrid.addEventListener('wheel', handleZoomWheel, { passive: false });
    multiCamGrid.addEventListener('mousedown', handlePanStart);
    document.addEventListener('mousemove', handlePanMove);
    document.addEventListener('mouseup', handlePanEnd);
    multiCamGrid.addEventListener('dblclick', handleZoomReset);
}
