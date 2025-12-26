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
 * Uses SEI frame_seq_no for accurate sync when available, falls back to time-based sync
 */
export function forceResyncAllVideos() {
    const nativeVideo = getNativeVideo?.();
    const videoBySlot = getVideoBySlot?.();
    
    if (!nativeVideo?.master) return;
    if (nativeVideo.master.readyState < 1) return;
    
    const masterTime = nativeVideo.master.currentTime;
    const masterPlaying = !nativeVideo.master.paused;
    
    // Try to get current frame_seq_no from master's SEI data for accurate sync
    const masterTimeMs = masterTime * 1000;
    let masterFrameSeqNo = null;
    
    const seiData = nativeVideo?.seiData;
    if (seiData && seiData.length > 0) {
        let closest = seiData[0];
        let minDiff = Math.abs(seiData[0].timestampMs - masterTimeMs);
        
        for (let i = 1; i < seiData.length; i++) {
            const diff = Math.abs(seiData[i].timestampMs - masterTimeMs);
            if (diff < minDiff) {
                minDiff = diff;
                closest = seiData[i];
            }
            if (seiData[i].timestampMs > masterTimeMs && diff > minDiff) break;
        }
        
        if (closest?.sei) {
            masterFrameSeqNo = closest.sei.frame_seq_no ?? closest.sei.frameSeqNo ?? null;
        }
    }
    
    const usingSeiSync = masterFrameSeqNo !== null && nativeVideo?.seiSyncData?.size > 0;
    console.log('Force resyncing all videos to', masterTime.toFixed(2), 
        'masterPlaying:', masterPlaying, 
        'usingSeiSync:', usingSeiSync,
        'frame_seq_no:', masterFrameSeqNo);
    
    const secondarySlots = Object.entries(videoBySlot || {}).filter(([slot, vid]) => 
        vid && vid !== nativeVideo.master && vid.src
    );
    
    secondarySlots.forEach(([slot, vid]) => {
        try { vid.pause(); } catch(e) {}
    });
    
    secondarySlots.forEach(([slot, vid]) => {
        if (vid.readyState >= 1) {
            let syncTargetTime = masterTime;
            
            // Try SEI-based sync if available
            if (masterFrameSeqNo !== null && nativeVideo?.seiSyncData) {
                const slotSyncMap = nativeVideo.seiSyncData.get(slot);
                if (slotSyncMap) {
                    const slotTimeMs = slotSyncMap.get(Number(masterFrameSeqNo));
                    if (slotTimeMs !== undefined && slotTimeMs !== null) {
                        syncTargetTime = slotTimeMs / 1000;
                    }
                }
            }
            
            vid.currentTime = syncTargetTime;
        }
    });
    
    if (masterPlaying) {
        setTimeout(() => {
            secondarySlots.forEach(([slot, vid]) => {
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
 * Uses SEI frame_seq_no for accurate sync when available, falls back to time-based sync
 * @param {number} targetTime - Target time to sync to (in seconds)
 */
export function syncMultiVideos(targetTime) {
    const nativeVideo = getNativeVideo?.();
    const videoBySlot = getVideoBySlot?.();
    const state = getState?.();
    
    if (!state?.multi?.enabled) return;
    
    // Try to get current frame_seq_no from master's SEI data for accurate sync
    const masterTimeMs = targetTime * 1000;
    let masterFrameSeqNo = null;
    
    // Find master's frame_seq_no from seiData
    const seiData = nativeVideo?.seiData;
    if (seiData && seiData.length > 0) {
        let closest = seiData[0];
        let minDiff = Math.abs(seiData[0].timestampMs - masterTimeMs);
        
        for (let i = 1; i < seiData.length; i++) {
            const diff = Math.abs(seiData[i].timestampMs - masterTimeMs);
            if (diff < minDiff) {
                minDiff = diff;
                closest = seiData[i];
            }
            if (seiData[i].timestampMs > masterTimeMs && diff > minDiff) break;
        }
        
        if (closest?.sei) {
            masterFrameSeqNo = closest.sei.frame_seq_no ?? closest.sei.frameSeqNo ?? null;
        }
    }
    
    Object.entries(videoBySlot || {}).forEach(([slot, vid]) => {
        if (!vid || vid === nativeVideo?.master) return;
        if (!vid.src || vid.readyState < 1) return;
        
        let syncTargetTime = targetTime;
        let usedSeiSync = false;
        
        // Try SEI-based sync if we have frame_seq_no data for this slot
        if (masterFrameSeqNo !== null && nativeVideo?.seiSyncData) {
            const slotSyncMap = nativeVideo.seiSyncData.get(slot);
            if (slotSyncMap) {
                const slotTimeMs = slotSyncMap.get(Number(masterFrameSeqNo));
                if (slotTimeMs !== undefined && slotTimeMs !== null) {
                    syncTargetTime = slotTimeMs / 1000;
                    usedSeiSync = true;
                }
            }
        }
        
        const drift = Math.abs(vid.currentTime - syncTargetTime);
        if (drift > 0.15) {
            vid.currentTime = syncTargetTime;
        }
    });
}
