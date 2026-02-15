/**
 * TeslaCam Index Builder
 * Parses Tesla dashcam folder structures and builds clip group indexes
 */

import { yieldToUI } from '../ui/loadingOverlay.js';
import { t } from '../lib/i18n.js';
import { parseTimestampKeyToEpochMs } from './clipBrowser.js';

export function getRootFolderNameFromWebkitRelativePath(relPath) {
    if (!relPath || typeof relPath !== 'string') return null;
    const parts = relPath.split('/').filter(Boolean);
    return parts.length ? parts[0] : null;
}

export function getBestEffortRelPath(file, directoryName = null) {
    // 1) webkitdirectory input provides webkitRelativePath
    if (file?.webkitRelativePath) return file.webkitRelativePath;

    // 2) directory drop traversal: our helper stores entry.fullPath on the File as _teslaPath
    //    Example: "/TeslaCam/RecentClips/2025-...-front.mp4"
    const p = file?._teslaPath;
    if (typeof p === 'string' && p.length) {
        return p.startsWith('/') ? p.slice(1) : p;
    }

    // 3) fall back to whatever we know
    return directoryName ? `${directoryName}/${file.name}` : file.name;
}

export function parseTeslaCamPath(relPath) {
    const norm = (relPath || '').replace(/\\/g, '/');
    const parts = norm.split('/').filter(Boolean);

    // Known clip folder names (case-insensitive)
    const clipFolders = ['recentclips', 'sentryclips', 'savedclips'];
    
    // Find any known parent folder (TeslaCam, teslausb, or any folder containing clip subfolders)
    // First, look for a clip folder directly in the path
    const clipFolderIdx = parts.findIndex(p => clipFolders.includes(p.toLowerCase()));
    if (clipFolderIdx >= 0) {
        // Found a clip folder - use it as the tag
        const tag = parts[clipFolderIdx];
        const rest = parts.slice(clipFolderIdx + 1);
        return { tag, rest };
    }

    // Legacy: Find "TeslaCam" or "teslausb" segment if present
    const knownRoots = ['teslacam', 'teslausb'];
    const rootIdx = parts.findIndex(p => knownRoots.includes(p.toLowerCase()));
    if (rootIdx >= 0 && parts.length > rootIdx + 1) {
        const tag = parts[rootIdx + 1];
        const rest = parts.slice(rootIdx + 2);
        return { tag, rest };
    }

    // No known root: best effort tag from first folder if any
    if (parts.length >= 2) return { tag: parts[0], rest: parts.slice(1) };
    return { tag: 'Unknown', rest: parts.slice(1) };
}

export function parseClipFilename(name) {
    // Tesla naming: YYYY-MM-DD_HH-MM-SS-front.mp4
    // Also seen in Sentry: same naming inside event folder; also "event.mp4" which we ignore.
    const lower = name.toLowerCase();
    if (!lower.endsWith('.mp4')) return null;
    if (lower === 'event.mp4') return null;

    const m = name.match(/^(\d{4}-\d{2}-\d{2})_(\d{2}-\d{2}-\d{2})-(.+)\.mp4$/i);
    if (!m) return null;
    const timestampKey = `${m[1]}_${m[2]}`;
    const cameraRaw = m[3];
    return { timestampKey, camera: normalizeCamera(cameraRaw) };
}

export function normalizeCamera(cameraRaw) {
    const c = (cameraRaw || '').toLowerCase();
    if (c === 'front') return 'front';
    if (c === 'back') return 'back';
    if (c === 'left_repeater' || c === 'left') return 'left_repeater';
    if (c === 'right_repeater' || c === 'right') return 'right_repeater';
    if (c === 'left_pillar') return 'left_pillar';
    if (c === 'right_pillar') return 'right_pillar';
    return c || 'unknown';
}

export function cameraLabel(camera) {
    if (camera === 'front') return t('ui.cameras.front');
    if (camera === 'back') return t('ui.cameras.back');
    if (camera === 'left_repeater') return t('ui.cameras.leftRepeater');
    if (camera === 'right_repeater') return t('ui.cameras.rightRepeater');
    if (camera === 'left_pillar') return t('ui.cameras.leftPillar');
    if (camera === 'right_pillar') return t('ui.cameras.rightPillar');
    return camera;
}

export async function buildTeslaCamIndex(files, directoryName = null, onProgress = null) {
    const groups = new Map(); // id -> group
    let inferredRoot = directoryName || null;
    const eventAssetsByKey = new Map(); // `${tag}/${eventId}` -> { jsonFile, pngFile, mp4File }

    const totalFiles = files.length;
    const BATCH_SIZE = 500; // Process files in batches to prevent UI blocking
    let processed = 0;

    for (let i = 0; i < totalFiles; i++) {
        const file = files[i];
        const relPath = getBestEffortRelPath(file, directoryName);
        const { tag, rest } = parseTeslaCamPath(relPath);
        const filename = rest[rest.length - 1] || file.name;
        const lowerName = String(filename || '').toLowerCase();

        // Event assets (event.json / event.png / event.mp4) for SentryClips and SavedClips
        const tagLowerAsset = tag.toLowerCase();
        if ((tagLowerAsset === 'sentryclips' || tagLowerAsset === 'savedclips') && rest.length >= 2 && (lowerName === 'event.json' || lowerName === 'event.png' || lowerName === 'event.mp4')) {
            const eventId = rest[0];
            const key = `${tag}/${eventId}`;
            if (!eventAssetsByKey.has(key)) eventAssetsByKey.set(key, {});
            const entry = eventAssetsByKey.get(key);
            if (lowerName === 'event.json') entry.jsonFile = file;
            if (lowerName === 'event.png') entry.pngFile = file;
            if (lowerName === 'event.mp4') entry.mp4File = file;
            processed++;
            continue;
        }

        // Regular per-camera MP4
        const parsed = parseClipFilename(filename);
        if (!parsed) {
            processed++;
            continue;
        }

        // SentryClips/<eventId>/YYYY-...-front.mp4
        // SavedClips/<eventId>/YYYY-...-front.mp4
        // RecentClips/YYYY-...-front.mp4
        let eventId = null;
        const tagLower = tag.toLowerCase();
        if ((tagLower === 'sentryclips' || tagLower === 'savedclips') && rest.length >= 2) {
            eventId = rest[0];
        }

        const groupId = `${tag}/${eventId ? eventId + '/' : ''}${parsed.timestampKey}`;
        if (!groups.has(groupId)) {
            groups.set(groupId, {
                id: groupId,
                tag,
                eventId,
                timestampKey: parsed.timestampKey,
                filesByCamera: new Map(),
                bestRelPathHint: relPath,
                eventMeta: null,
                eventJsonFile: null,
                eventPngFile: null,
                eventMp4File: null
            });
        }
        const g = groups.get(groupId);
        g.filesByCamera.set(parsed.camera, { file, relPath, tag, eventId, timestampKey: parsed.timestampKey, camera: parsed.camera });

        // try to infer folder label from relPath root if possible
        if (!inferredRoot && relPath) inferredRoot = relPath.split('/')[0] || null;

        processed++;

        // Yield to UI every BATCH_SIZE files to prevent blocking
        if (processed % BATCH_SIZE === 0) {
            if (onProgress) onProgress(processed, totalFiles, groups.size);
            await yieldToUI();
        }
    }

    // Final progress update
    if (onProgress) onProgress(totalFiles, totalFiles, groups.size);

    // Attach any event assets to groups in the same Sentry event folder
    for (const g of groups.values()) {
        if (!g.eventId) continue;
        const key = `${g.tag}/${g.eventId}`;
        const assets = eventAssetsByKey.get(key);
        if (!assets) continue;
        g.eventJsonFile = assets.jsonFile || null;
        g.eventPngFile = assets.pngFile || null;
        g.eventMp4File = assets.mp4File || null;
    }

    const arr = Array.from(groups.values());
    arr.sort((a, b) => (b.timestampKey || '').localeCompare(a.timestampKey || ''));
    return { groups: arr, inferredRoot, eventAssetsByKey };
}

/**
 * Build day collections from clip groups.
 * Returns { collections, allDates, dayData } — caller assigns to library.
 */
export function buildDayCollections(groups) {
    const byDay = new Map();
    const allDates = new Set();

    for (const g of groups) {
        const key = String(g.timestampKey || '');
        const day = key.split('_')[0] || 'Unknown';
        const type = (g.tag || '').toLowerCase();
        
        allDates.add(day);
        
        if (!byDay.has(day)) {
            byDay.set(day, {
                recent: [],
                sentry: new Map(),
                saved: new Map(),
                custom: []
            });
        }
        const dayData = byDay.get(day);
        
        if (type === 'recentclips') {
            dayData.recent.push(g);
        } else if (type === 'sentryclips' && g.eventId) {
            if (!dayData.sentry.has(g.eventId)) dayData.sentry.set(g.eventId, []);
            dayData.sentry.get(g.eventId).push(g);
        } else if (type === 'savedclips' && g.eventId) {
            if (!dayData.saved.has(g.eventId)) dayData.saved.set(g.eventId, []);
            dayData.saved.get(g.eventId).push(g);
        } else {
            // Custom folder structure (not RecentClips/SentryClips/SavedClips)
            dayData.custom.push(g);
        }
    }

    // Build collections for each selectable item
    const collections = new Map();

    for (const [day, dayData] of byDay.entries()) {
        // Recent clips collection (all clips for this day combined)
        if (dayData.recent.length > 0) {
            const recentGroups = dayData.recent.sort((a, b) => (a.timestampKey || '').localeCompare(b.timestampKey || ''));
            const id = `recent:${day}`;
            collections.set(id, buildCollectionFromGroups(id, day, 'RecentClips', recentGroups));
        }

        // Individual Sentry events
        for (const [eventId, eventGroups] of dayData.sentry.entries()) {
            const sortedGroups = eventGroups.sort((a, b) => (a.timestampKey || '').localeCompare(b.timestampKey || ''));
            const id = `sentry:${day}:${eventId}`;
            const coll = buildCollectionFromGroups(id, day, 'SentryClips', sortedGroups);
            coll.eventId = eventId;
            coll.eventTime = eventId.split('_')[1]?.replace(/-/g, ':') || '';
            collections.set(id, coll);
        }

        // Individual Saved events
        for (const [eventId, eventGroups] of dayData.saved.entries()) {
            const sortedGroups = eventGroups.sort((a, b) => (a.timestampKey || '').localeCompare(b.timestampKey || ''));
            const id = `saved:${day}:${eventId}`;
            const coll = buildCollectionFromGroups(id, day, 'SavedClips', sortedGroups);
            coll.eventId = eventId;
            coll.eventTime = eventId.split('_')[1]?.replace(/-/g, ':') || '';
            collections.set(id, coll);
        }

        // Custom folder clips (non-standard folder names)
        if (dayData.custom && dayData.custom.length > 0) {
            const customGroups = dayData.custom.sort((a, b) => (a.timestampKey || '').localeCompare(b.timestampKey || ''));
            const id = `custom:${day}`;
            const coll = buildCollectionFromGroups(id, day, 'Custom', customGroups);
            coll.isCustomStructure = true;
            collections.set(id, coll);
        }
    }

    return {
        collections,
        allDates: Array.from(allDates).sort().reverse(),
        dayData: byDay
    };
}

function buildCollectionFromGroups(id, day, clipType, groups) {
    const startEpochMs = parseTimestampKeyToEpochMs(groups[0]?.timestampKey) ?? 0;
    const lastStart = parseTimestampKeyToEpochMs(groups[groups.length - 1]?.timestampKey) ?? startEpochMs;
    const endEpochMs = lastStart + 60_000;
    const durationMs = Math.max(1, endEpochMs - startEpochMs);

    const segmentStartsMs = groups.map(g => {
        const t = parseTimestampKeyToEpochMs(g.timestampKey) ?? startEpochMs;
        return Math.max(0, t - startEpochMs);
    });

    return {
        id,
        key: id,
        day,
        clipType,
        tag: clipType,
        groups,
        meta: null,
        durationMs,
        segmentStartsMs,
        anchorMs: 0,
        anchorGroupId: groups[0]?.id || null,
        sortEpoch: endEpochMs
    };
}
