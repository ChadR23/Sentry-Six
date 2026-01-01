/**
 * Event Timeline Markers & Camera Highlight
 * Shows Sentry/Saved event markers on timeline and highlights event camera
 */

import { getEffectiveSlots } from '../features/cameraRearrange.js';

// DOM helper
const $ = id => document.getElementById(id);

// Dependencies set via init
let getState = null;
let getNativeVideo = null;
let getEventMetaByKey = null;
let parseTimestampKeyToEpochMs = null;
let seekNativeDayCollectionBySec = null;

/**
 * Initialize event markers module with dependencies
 * @param {Object} deps - Dependencies
 */
export function initEventMarkers(deps) {
    getState = deps.getState;
    getNativeVideo = deps.getNativeVideo;
    getEventMetaByKey = deps.getEventMetaByKey;
    parseTimestampKeyToEpochMs = deps.parseTimestampKeyToEpochMs;
    seekNativeDayCollectionBySec = deps.seekNativeDayCollectionBySec;
}

/**
 * Update the event timeline marker position
 */
export function updateEventTimelineMarker() {
    const markersContainer = $('timelineMarkers');
    if (!markersContainer) return;
    
    // Remove existing event markers
    markersContainer.querySelectorAll('.event-timeline-marker').forEach(el => el.remove());
    
    const state = getState?.();
    const coll = state?.collection?.active;
    if (!coll) return;
    
    // Get event metadata from the collection
    const groups = coll.groups || [];
    let eventMeta = null;
    for (const g of groups) {
        if (g.eventMeta) {
            eventMeta = g.eventMeta;
            break;
        }
    }
    
    // Also check eventMetaByKey if not found in groups
    if (!eventMeta && coll.tag && coll.eventId) {
        const key = `${coll.tag}/${coll.eventId}`;
        eventMeta = getEventMetaByKey?.()?.get(key);
    }
    
    if (!eventMeta?.timestamp) return;
    
    // Determine event type (sentry or saved)
    const tagLower = (coll.tag || '').toLowerCase();
    if (tagLower !== 'sentryclips' && tagLower !== 'savedclips') return;
    
    const eventType = tagLower === 'sentryclips' ? 'sentry' : 'saved';
    
    // Calculate position on timeline
    const eventEpoch = Date.parse(eventMeta.timestamp);
    if (!Number.isFinite(eventEpoch)) return;
    
    // Get collection time range
    const startEpochMs = parseTimestampKeyToEpochMs?.(groups[0]?.timestampKey) ?? 0;
    const lastStart = parseTimestampKeyToEpochMs?.(groups[groups.length - 1]?.timestampKey) ?? startEpochMs;
    const endEpochMs = lastStart + 60_000;
    const durationMs = Math.max(1, endEpochMs - startEpochMs);
    
    // Calculate percentage position
    const eventOffsetMs = eventEpoch - startEpochMs;
    const pct = Math.max(0, Math.min(100, (eventOffsetMs / durationMs) * 100));
    
    // Create marker element
    const marker = document.createElement('div');
    marker.className = `event-timeline-marker ${eventType}`;
    marker.style.left = `${pct}%`;
    
    // Add icon based on event type
    if (eventType === 'sentry') {
        marker.innerHTML = `<svg viewBox="0 0 24 24"><path d="M12 2L1 21h22L12 2zm0 3.5L19.5 19h-15L12 5.5zM11 10v4h2v-4h-2zm0 6v2h2v-2h-2z"/></svg>`;
        marker.title = `Sentry Event: ${eventMeta.reason || 'Unknown'}\n${eventMeta.timestamp}`;
    } else {
        marker.innerHTML = `<svg viewBox="0 0 24 24"><path d="M17 3H7c-1.1 0-2 .9-2 2v16l7-3 7 3V5c0-1.1-.9-2-2-2z"/></svg>`;
        marker.title = `Saved Event: ${eventMeta.reason || 'User saved'}\n${eventMeta.timestamp}`;
    }
    
    // Click to seek to event time
    marker.addEventListener('click', (e) => {
        e.stopPropagation();
        const nativeVideo = getNativeVideo?.();
        if (state?.ui?.nativeVideoMode && state?.collection?.active) {
            const totalSec = nativeVideo?.cumulativeStarts?.[nativeVideo.cumulativeStarts.length - 1] || 60;
            const targetSec = (pct / 100) * totalSec;
            seekNativeDayCollectionBySec?.(targetSec);
        }
    });
    
    markersContainer.appendChild(marker);
}

/**
 * Update camera highlight for event camera
 */
export function updateEventCameraHighlight() {
    // Remove highlight from all tiles
    document.querySelectorAll('.multi-tile.event-camera-highlight-sentry, .multi-tile.event-camera-highlight-saved').forEach(el => {
        el.classList.remove('event-camera-highlight-sentry', 'event-camera-highlight-saved');
    });
    
    const state = getState?.();
    const coll = state?.collection?.active;
    if (!coll) return;
    
    // Determine event type
    const tagLower = (coll.tag || '').toLowerCase();
    if (tagLower !== 'savedclips' && tagLower !== 'sentryclips') return;
    
    // Check if the appropriate highlight setting is enabled
    const isSentry = tagLower === 'sentryclips';
    const isEnabled = isSentry 
        ? (window._sentryCameraHighlightEnabled !== false)
        : (window._savedCameraHighlightEnabled !== false);
    if (!isEnabled) return;
    
    // Get event metadata
    const groups = coll.groups || [];
    let eventMeta = null;
    for (const g of groups) {
        if (g.eventMeta) {
            eventMeta = g.eventMeta;
            break;
        }
    }
    
    // Also check eventMetaByKey
    if (!eventMeta && coll.tag && coll.eventId) {
        const key = `${coll.tag}/${coll.eventId}`;
        eventMeta = getEventMetaByKey?.()?.get(key);
    }
    
    if (!eventMeta?.camera && eventMeta?.camera !== 0) return;
    
    // Camera mapping based on Tesla camera indices
    const cameraIndexToName = {
        '0': 'front', '1': 'front', '2': 'front',
        '3': 'left_pillar', '4': 'right_pillar',
        '5': 'left_repeater', '6': 'right_repeater',
        '7': 'back'
    };
    
    const cameraValue = String(eventMeta.camera);
    const cameraName = cameraIndexToName[cameraValue];
    
    if (cameraName) {
        const effectiveSlots = getEffectiveSlots();
        const slotDef = effectiveSlots.find(s => s.camera === cameraName);
        const slot = slotDef?.slot;
        
        if (slot) {
            const tile = document.querySelector(`.multi-tile[data-slot="${slot}"]`);
            if (tile) {
                const highlightClass = isSentry 
                    ? 'event-camera-highlight-sentry' 
                    : 'event-camera-highlight-saved';
                tile.classList.add(highlightClass);
            }
        }
    }
}
