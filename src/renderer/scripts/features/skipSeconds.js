/**
 * Skip Seconds
 * Handles forward/backward seeking by a time delta
 */

// Dependencies set via init
let getState = null;
let getNativeVideo = null;
let getProgressBar = null;
let getPlayer = null;
let seekNativeDayCollectionBySec = null;
let showCollectionAtMs = null;
let showFrame = null;

/**
 * Initialize skip seconds module with dependencies
 * @param {Object} deps - Dependencies
 */
export function initSkipSeconds(deps) {
    getState = deps.getState;
    getNativeVideo = deps.getNativeVideo;
    getProgressBar = deps.getProgressBar;
    getPlayer = deps.getPlayer;
    seekNativeDayCollectionBySec = deps.seekNativeDayCollectionBySec;
    showCollectionAtMs = deps.showCollectionAtMs;
    showFrame = deps.showFrame;
}

/**
 * Skip forward or backward by delta seconds
 * @param {number} delta - Seconds to skip (positive = forward, negative = backward)
 */
export function skipSeconds(delta) {
    const state = getState?.();
    const nativeVideo = getNativeVideo?.();
    const progressBar = getProgressBar?.();
    const player = getPlayer?.();
    
    // Native video day collection mode - use actual durations
    if (state?.ui?.nativeVideoMode && state?.collection?.active) {
        const vid = nativeVideo?.master;
        if (!vid) return;
        
        const segIdx = nativeVideo.currentSegmentIdx || 0;
        const cumStart = nativeVideo.cumulativeStarts[segIdx] || 0;
        const currentSec = cumStart + vid.currentTime;
        const totalSec = nativeVideo.cumulativeStarts[nativeVideo.cumulativeStarts.length - 1] || 1;
        const newSec = Math.max(0, Math.min(totalSec, currentSec + delta));
        
        seekNativeDayCollectionBySec?.(newSec);
        return;
    }
    
    // WebCodecs collection mode
    if (state?.collection?.active) {
        const currentMs = +progressBar?.value || 0;
        const newMs = Math.max(0, Math.min(state.collection.active.durationMs, currentMs + delta * 1000));
        if (progressBar) progressBar.value = Math.floor(newMs);
        showCollectionAtMs?.(newMs);
    } else if (player?.frames?.length) {
        // Clip mode: find frame ~delta seconds away
        const currentIdx = +progressBar?.value || 0;
        const currentTs = player.frames[currentIdx]?.timestamp || 0;
        const targetTs = currentTs + delta * 1000;
        let lo = 0, hi = player.frames.length - 1;
        while (lo < hi) {
            const mid = Math.floor((lo + hi + 1) / 2);
            if (player.frames[mid].timestamp <= targetTs) lo = mid;
            else hi = mid - 1;
        }
        const newIdx = Math.max(0, Math.min(player.frames.length - 1, lo));
        if (progressBar) progressBar.value = newIdx;
        showFrame?.(newIdx);
    }
}
