/**
 * Multi-Camera Focus
 * Handles focusing/zooming on individual camera tiles
 */

import { resetZoomPan } from './zoomPan.js';

// Dependencies set via init
let getMultiCamGrid = null;
let getState = null;
let getNativeVideo = null;
let getVideoBySlot = null;

/**
 * Initialize multi-cam focus module with dependencies
 * @param {Object} deps - Dependencies
 */
export function initMultiCamFocus(deps) {
    getMultiCamGrid = deps.getMultiCamGrid;
    getState = deps.getState;
    getNativeVideo = deps.getNativeVideo;
    getVideoBySlot = deps.getVideoBySlot;
}

/**
 * Clear focus from multi-camera grid
 */
export function clearMultiFocus() {
    const state = getState?.();
    const multiCamGrid = getMultiCamGrid?.();
    
    if (state) state.ui.multiFocusSlot = null;
    if (!multiCamGrid) return;
    multiCamGrid.classList.remove('focused');
    multiCamGrid.removeAttribute('data-focus-slot');
    resetZoomPan();
}

/**
 * Toggle focus on a specific camera slot
 * @param {string} slot - Slot identifier
 */
export function toggleMultiFocus(slot) {
    const state = getState?.();
    const multiCamGrid = getMultiCamGrid?.();
    
    if (!multiCamGrid) return;
    if (state?.ui?.multiFocusSlot === slot) {
        clearMultiFocus();
        return;
    }
    resetZoomPan();
    if (state) state.ui.multiFocusSlot = slot;
    multiCamGrid.classList.add('focused');
    multiCamGrid.setAttribute('data-focus-slot', slot);
}

// Timer for debounced video resync
let resyncTimer = null;

/**
 * Schedule a debounced resync of all videos
 */
export function scheduleResync() {
    if (resyncTimer) {
        clearTimeout(resyncTimer);
        resyncTimer = null;
    }
    resyncTimer = setTimeout(() => {
        resyncTimer = null;
        forceResyncAllVideos();
    }, 300);
}

/**
 * Force resync all videos to master
 */
export function forceResyncAllVideos() {
    const nativeVideo = getNativeVideo?.();
    const videoBySlot = getVideoBySlot?.();
    
    if (!nativeVideo?.master) return;
    if (nativeVideo.master.readyState < 1) return;
    
    const masterTime = nativeVideo.master.currentTime;
    const masterPlaying = !nativeVideo.master.paused;
    
    console.log('Force resyncing all videos to', masterTime.toFixed(2), 'masterPlaying:', masterPlaying);
    
    const secondaryVideos = Object.values(videoBySlot || {}).filter(vid => 
        vid && vid !== nativeVideo.master && vid.src
    );
    
    secondaryVideos.forEach(vid => {
        try { vid.pause(); } catch(e) {}
    });
    
    secondaryVideos.forEach(vid => {
        if (vid.readyState >= 1) {
            vid.currentTime = masterTime;
        }
    });
    
    if (masterPlaying) {
        setTimeout(() => {
            secondaryVideos.forEach(vid => {
                if (vid.readyState >= 1 && vid.paused) {
                    vid.play().catch(err => {
                        console.warn('Resync play failed:', err.message);
                    });
                }
            });
        }, 50);
    }
}

/**
 * Regular sync for timeupdate events (less aggressive)
 * @param {number} targetTime - Target time to sync to
 */
export function syncMultiVideos(targetTime) {
    const nativeVideo = getNativeVideo?.();
    const videoBySlot = getVideoBySlot?.();
    const state = getState?.();
    
    if (!state?.multi?.enabled) return;
    
    Object.entries(videoBySlot || {}).forEach(([slot, vid]) => {
        if (!vid || vid === nativeVideo?.master) return;
        if (!vid.src || vid.readyState < 1) return;
        
        const drift = Math.abs(vid.currentTime - targetTime);
        if (drift > 0.15) {
            vid.currentTime = targetTime;
        }
    });
}
