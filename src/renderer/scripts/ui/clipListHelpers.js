/**
 * Clip List Helpers
 * Utility functions for clip list rendering
 */

import { escapeHtml } from '../lib/utils.js';

/**
 * Format event time from eventId
 * @param {string} eventId - Event ID in format "2025-12-11_17-58-00"
 * @returns {string} Formatted time "17:58:00"
 */
export function formatEventTime(eventId) {
    const parts = eventId.split('_');
    if (parts.length >= 2) {
        const timePart = parts[1];
        return timePart.replace(/-/g, ':');
    }
    return eventId;
}

/**
 * Get human-readable type label
 * @param {string} clipType - Clip type string
 * @returns {string} Human-readable label
 */
export function getTypeLabel(clipType) {
    switch (clipType) {
        case 'SentryClips': return 'Sentry';
        case 'RecentClips': return 'Recent';
        case 'SavedClips': return 'Saved';
        default: return clipType || 'Unknown';
    }
}

/**
 * Create a clip item element
 * @param {Object} coll - Collection object
 * @param {string} title - Display title
 * @param {string} typeClass - CSS class for badge
 * @param {Object} deps - Dependencies {formatEventReason, selectDayCollection}
 * @returns {HTMLElement} Clip item element
 */
export function createClipItem(coll, title, typeClass, deps) {
    const { formatEventReason, selectDayCollection } = deps;
    
    const groups = coll.groups || [];
    const firstGroup = groups[0];
    const cameras = firstGroup ? Array.from(firstGroup.filesByCamera.keys()) : [];
    
    let eventMeta = null;
    for (const g of groups) {
        if (g.eventMeta) {
            eventMeta = g.eventMeta;
            break;
        }
    }
    
    const item = document.createElement('div');
    item.className = `clip-item event-item ${typeClass}-item`;
    item.dataset.groupid = coll.id;
    item.dataset.type = 'collection';
    
    const subline = `${groups.length} segment${groups.length !== 1 ? 's' : ''} · ${Math.max(1, cameras.length)} cam`;
    const badgeClass = typeClass;
    const badgeLabel = typeClass.charAt(0).toUpperCase() + typeClass.slice(1);
    
    let reasonBadge = '';
    if (typeClass === 'saved' && eventMeta?.reason) {
        const reasonLabel = formatEventReason(eventMeta.reason);
        const alertClass = eventMeta.reason.includes('emergency') || eventMeta.reason.includes('collision') ? 'alert' : 'warning';
        reasonBadge = `<span class="badge reason-icon ${alertClass}" title="${escapeHtml(eventMeta.reason)}">${escapeHtml(reasonLabel)}</span>`;
    }
    
    item.innerHTML = `
        <div class="clip-meta clip-meta-full">
            <div class="clip-title">${escapeHtml(title)}</div>
            <div class="clip-badges">
                <span class="badge ${badgeClass}">${escapeHtml(badgeLabel)}</span>
                ${reasonBadge}
            </div>
            <div class="clip-sub">
                <div>${escapeHtml(subline)}</div>
            </div>
        </div>
    `;
    
    item.onclick = () => selectDayCollection(coll.key);
    return item;
}

/**
 * Populate event popout with metadata
 * @param {HTMLElement} rowEl - Row element
 * @param {Object} meta - Event metadata
 */
export function populateEventPopout(rowEl, meta) {
    const kv = rowEl.querySelector('.event-kv');
    if (!kv) return;
    kv.innerHTML = '';

    if (!meta) {
        const kEl = document.createElement('div');
        kEl.className = 'k';
        kEl.textContent = 'status';
        const vEl = document.createElement('div');
        vEl.className = 'v';
        vEl.textContent = 'Loading event.json…';
        kv.appendChild(kEl);
        kv.appendChild(vEl);
        return;
    }

    const preferred = ['timestamp', 'reason', 'camera', 'city', 'street', 'est_lat', 'est_lon'];
    const keys = [...preferred.filter(k => meta[k] != null), ...Object.keys(meta).filter(k => !preferred.includes(k))];
    for (const k of keys) {
        const v = meta[k];
        const kEl = document.createElement('div');
        kEl.className = 'k';
        kEl.textContent = k;
        const vEl = document.createElement('div');
        vEl.className = 'v';
        vEl.textContent = String(v);
        kv.appendChild(kEl);
        kv.appendChild(vEl);
    }
}
