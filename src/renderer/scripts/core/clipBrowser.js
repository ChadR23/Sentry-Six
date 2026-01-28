/**
 * Clip Browser Module
 * Handles clip list rendering, selection, and display item building.
 */

import { escapeHtml, cssEscape } from '../lib/utils.js';
import { formatEventTime, populateEventPopout } from '../ui/clipListHelpers.js';
import { t } from '../lib/i18n.js';

// Dependencies injected at init
let getState = null;
let getLibrary = null;
let getSelection = null;
let clipList = null;
let dayFilter = null;
let selectDayCollection = null;
let formatEventReason = null;

/**
 * Initialize the clip browser module with dependencies.
 */
export function initClipBrowser(deps) {
    getState = deps.getState;
    getLibrary = deps.getLibrary;
    getSelection = deps.getSelection;
    clipList = deps.clipList;
    dayFilter = deps.dayFilter;
    selectDayCollection = deps.selectDayCollection;
    formatEventReason = deps.formatEventReason;
}

/**
 * Render the clip list based on current day selection.
 */
export function renderClipList() {
    const library = getLibrary?.();
    if (!clipList) return;
    
    // Make available globally for language change updates
    window._renderClipList = renderClipList;
    
    clipList.innerHTML = '';
    
    const selectedDay = dayFilter?.value || '';
    if (!selectedDay || !library?.dayData) {
        const placeholder = document.createElement('div');
        placeholder.className = 'clip-list-placeholder';
        placeholder.textContent = t('ui.clipBrowser.subtitle');
        placeholder.style.cssText = 'padding: 16px; text-align: center; color: rgba(255,255,255,0.5); font-size: 12px;';
        clipList.appendChild(placeholder);
        return;
    }
    
    const dayData = library.dayData.get(selectedDay);
    if (!dayData) return;
    
    // 1. Recent Clips (at top)
    if (dayData.recent.length > 0) {
        const recentId = `recent:${selectedDay}`;
        const recentColl = library.dayCollections?.get(recentId);
        if (recentColl) {
            const item = createClipItem(recentColl, t('ui.clipBrowser.recent') + ' ' + t('ui.clipBrowser.title'), 'recent');
            clipList.appendChild(item);
        }
    }
    
    // 2. Sentry Events (individual folders)
    const sentryEvents = Array.from(dayData.sentry.entries())
        .map(([eventId, groups]) => ({ eventId, groups, type: 'sentry' }))
        .sort((a, b) => b.eventId.localeCompare(a.eventId));
    
    for (const event of sentryEvents) {
        const eventId = event.eventId;
        const collId = `sentry:${selectedDay}:${eventId}`;
        const coll = library.dayCollections?.get(collId);
        if (coll) {
            const timeStr = formatEventTime(eventId);
            const item = createClipItem(coll, `${t('ui.clipBrowser.sentry')} · ${timeStr}`, 'sentry');
            clipList.appendChild(item);
        }
    }
    
    // 3. Saved Events (individual folders)
    const savedEvents = Array.from(dayData.saved.entries())
        .map(([eventId, groups]) => ({ eventId, groups, type: 'saved' }))
        .sort((a, b) => b.eventId.localeCompare(a.eventId));
    
    for (const event of savedEvents) {
        const eventId = event.eventId;
        const collId = `saved:${selectedDay}:${eventId}`;
        const coll = library.dayCollections?.get(collId);
        if (coll) {
            const timeStr = formatEventTime(eventId);
            const item = createClipItem(coll, `${t('ui.clipBrowser.saved')} · ${timeStr}`, 'saved');
            clipList.appendChild(item);
        }
    }
    
    highlightSelectedClip();
}

/**
 * Create a clip item element for the list.
 */
export function createClipItem(coll, title, typeClass) {
    const groups = coll.groups || [];
    const firstGroup = groups[0];
    const cameras = firstGroup ? Array.from(firstGroup.filesByCamera.keys()) : [];
    
    // Get eventMeta for reason icon
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
    
    const segmentText = groups.length === 1 ? t('ui.clipBrowser.segment') : t('ui.clipBrowser.segments');
    const subline = `${groups.length} ${segmentText} · ${Math.max(1, cameras.length)} cam`;
    const badgeClass = typeClass;
    const badgeLabel = typeClass.charAt(0).toUpperCase() + typeClass.slice(1);
    
    // Build reason badge for SavedClips only (as text, not icon)
    let reasonBadge = '';
    if (typeClass === 'saved' && eventMeta?.reason && formatEventReason) {
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
    
    item.onclick = () => selectDayCollection?.(coll.key);
    return item;
}

/**
 * Highlight the currently selected clip in the list.
 */
export function highlightSelectedClip() {
    const selection = getSelection?.();
    const state = getState?.();
    if (!clipList) return;
    
    for (const el of clipList.querySelectorAll('.clip-item')) {
        el.classList.toggle('selected', 
            el.dataset.groupid === selection?.selectedGroupId || 
            el.dataset.groupid === state?.collection?.active?.id
        );
    }
}

/**
 * Close any open event popout.
 */
export function closeEventPopout() {
    const state = getState?.();
    if (!state?.ui?.openEventRowId) return;
    const el = clipList?.querySelector?.(`.clip-item[data-groupid="${cssEscape(state.ui.openEventRowId)}"]`);
    if (el) el.classList.remove('event-open');
    state.ui.openEventRowId = null;
}

/**
 * Toggle event popout for a row.
 */
export function toggleEventPopout(rowId, metaOverride = null) {
    const state = getState?.();
    const library = getLibrary?.();
    
    if (state?.ui?.openEventRowId && state.ui.openEventRowId !== rowId) closeEventPopout();
    const el = clipList?.querySelector?.(`.clip-item[data-groupid="${cssEscape(rowId)}"]`);
    if (!el) return;
    const opening = !el.classList.contains('event-open');
    if (!opening) { closeEventPopout(); return; }

    const meta = metaOverride ?? (library?.clipGroupById?.get(rowId)?.eventMeta || null);
    populateEventPopout(el, meta);
    el.classList.add('event-open');
    if (state?.ui) state.ui.openEventRowId = rowId;
}

/**
 * Build display items for legacy Sentry collection mode.
 */
export function buildDisplayItems(eventMetaByKey = new Map()) {
    const library = getLibrary?.();
    if (!library?.clipGroups) return [];
    
    const items = [];
    const sentryBuckets = new Map();

    for (const g of library.clipGroups) {
        if (g.tag?.toLowerCase() === 'sentryclips' && g.eventId) {
            const key = `${g.tag}/${g.eventId}`;
            if (!sentryBuckets.has(key)) sentryBuckets.set(key, []);
            sentryBuckets.get(key).push(g);
        } else {
            items.push({ type: 'group', id: g.id, group: g });
        }
    }

    for (const [key, groups] of sentryBuckets.entries()) {
        groups.sort((a, b) => (a.timestampKey || '').localeCompare(b.timestampKey || ''));
        const [tag, eventId] = key.split('/');
        const id = `sentry:${key}`;

        const startEpochMs = parseTimestampKeyToEpochMs(groups[0]?.timestampKey) ?? 0;
        const lastStart = parseTimestampKeyToEpochMs(groups[groups.length - 1]?.timestampKey) ?? startEpochMs;
        const endEpochMs = lastStart + 60_000;
        const durationMs = Math.max(1, endEpochMs - startEpochMs);

        const segmentStartsMs = groups.map(g => {
            const t = parseTimestampKeyToEpochMs(g.timestampKey) ?? startEpochMs;
            return Math.max(0, t - startEpochMs);
        });

        const meta = groups[0]?.eventMeta || (eventMetaByKey.get(key) ?? null);
        let anchorMs = null;
        let anchorGroupId = groups[0].id;
        if (meta?.timestamp) {
            const eventEpoch = Date.parse(meta.timestamp);
            if (Number.isFinite(eventEpoch)) {
                anchorMs = Math.max(0, Math.min(durationMs, eventEpoch - startEpochMs));
                let anchorIdx = 0;
                for (let i = 0; i < segmentStartsMs.length; i++) {
                    if (segmentStartsMs[i] <= anchorMs) anchorIdx = i;
                }
                anchorGroupId = groups[anchorIdx]?.id || anchorGroupId;
            }
        }

        const sortEpoch = meta?.timestamp ? Date.parse(meta.timestamp) : lastStart;
        items.push({
            type: 'collection',
            id,
            sortEpoch: Number.isFinite(sortEpoch) ? sortEpoch : lastStart,
            collection: {
                id,
                key,
                tag,
                eventId,
                groups,
                meta,
                durationMs,
                segmentStartsMs,
                anchorMs,
                anchorGroupId
            }
        });
    }

    items.sort((a, b) => {
        const ta = a.type === 'collection'
            ? (a.sortEpoch ?? 0)
            : (parseTimestampKeyToEpochMs(a.group.timestampKey) ?? 0);
        const tb = b.type === 'collection'
            ? (b.sortEpoch ?? 0)
            : (parseTimestampKeyToEpochMs(b.group.timestampKey) ?? 0);
        return tb - ta;
    });

    return items;
}

/**
 * Parse timestamp key to epoch milliseconds (Tesla filenames are in vehicle local time).
 */
export function parseTimestampKeyToEpochMs(timestampKey) {
    const m = String(timestampKey || '').match(/^(\d{4})-(\d{2})-(\d{2})_(\d{2})-(\d{2})-(\d{2})$/);
    if (!m) return null;
    const [ , Y, Mo, D, h, mi, s ] = m;
    return new Date(+Y, +Mo - 1, +D, +h, +mi, +s, 0).getTime();
}

/**
 * Format camera name for display.
 */
export function formatCameraName(camera) {
    if (camera === 'front') return t('ui.cameras.front');
    if (camera === 'back') return t('ui.cameras.back');
    if (camera === 'left_repeater') return t('ui.cameras.leftRepeater');
    if (camera === 'right_repeater') return t('ui.cameras.rightRepeater');
    if (camera === 'left_pillar') return t('ui.cameras.leftPillar');
    if (camera === 'right_pillar') return t('ui.cameras.rightPillar');
    return camera;
}

/**
 * Format timestamp key for display.
 */
export function timestampLabel(timestampKey) {
    return (timestampKey || '').replace('_', ' ').replace(/-/g, (m, off, s) => {
        return m;
    }).replace(/(\d{4}-\d{2}-\d{2}) (\d{2})-(\d{2})-(\d{2})/, '$1 $2:$3:$4');
}

// Setup document click handler for closing popouts
export function setupPopoutCloseHandler() {
    document.addEventListener('click', (e) => {
        const state = getState?.();
        if (!state?.ui?.openEventRowId) return;
        const openEl = clipList?.querySelector?.(`.clip-item[data-groupid="${cssEscape(state.ui.openEventRowId)}"]`);
        if (!openEl) { state.ui.openEventRowId = null; return; }
        if (openEl.contains(e.target)) return;
        closeEventPopout();
    });
}
