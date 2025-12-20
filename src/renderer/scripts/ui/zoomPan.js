/**
 * Zoom and Pan System
 * Handles zooming and panning in focused multi-camera view
 */

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
            media.style.transform = '';
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
    
    media.style.transform = `scale(${zoomPanState.zoom}) translate(${zoomPanState.panX}px, ${zoomPanState.panY}px)`;
    
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
