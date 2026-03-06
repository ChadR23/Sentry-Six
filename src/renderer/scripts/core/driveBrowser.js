/**
 * Drive Browser Module
 * Renders the SentryUSB drives list panel and handles drive selection.
 */

import { escapeHtml } from '../lib/utils.js';
import { formatDriveDuration, formatDriveDistance } from './driveGrouper.js';

// Route map colors — match the main map polyline colors in script.js
const FSD_COLOR = '#1e5af1';
const MANUAL_COLOR = '#4d4c4c';

// Injected dependencies
let getState = null;
let getDriveState = null;
let driveList = null;
let onDriveSelected = null;
let getUseMetric = null;

// Shared hover tooltip for route map preview
let routeTooltip = null;
let routeCanvas = null;

/**
 * Initialize the drive browser with dependencies.
 */
export function initDriveBrowser(deps) {
    getState = deps.getState;
    getDriveState = deps.getDriveState;
    driveList = deps.driveList;
    onDriveSelected = deps.onDriveSelected;
    getUseMetric = deps.getUseMetric;

    // Create shared route map tooltip (appended to body so it escapes any overflow:hidden containers)
    routeTooltip = document.createElement('div');
    routeTooltip.className = 'drive-route-tooltip';
    routeCanvas = document.createElement('canvas');
    routeCanvas.width = 220;
    routeCanvas.height = 160;
    routeTooltip.appendChild(routeCanvas);
    document.body.appendChild(routeTooltip);
}

// Active filter state
let activeTagFilter = '';
let selectedDriveId = null;

/**
 * Render the full drives list.
 * Efficient: only re-renders when called (not reactive).
 */
export function renderDriveList() {
    if (!driveList) return;

    const driveState = getDriveState?.();
    if (!driveState?.loaded || !driveState.drives?.length) {
        driveList.innerHTML = `
            <div class="drive-list-placeholder">
                No drive data loaded. Select a drive-data.json file in Settings &gt; Storage.
            </div>`;
        return;
    }

    const { drives, hasFootage } = driveState;
    const useMetric = getUseMetric?.() ?? false;

    // Apply tag filter
    const filtered = activeTagFilter
        ? drives.filter(d => d.tags.some(t => t.toLowerCase().includes(activeTagFilter.toLowerCase())))
        : drives;

    // Group by date (YYYY-MM-DD)
    const byDate = new Map();
    for (const drive of filtered) {
        if (!byDate.has(drive.date)) byDate.set(drive.date, []);
        byDate.get(drive.date).push(drive);
    }

    // Sort dates descending (newest first)
    const sortedDates = Array.from(byDate.keys()).sort((a, b) => b.localeCompare(a));

    driveList.innerHTML = '';

    if (sortedDates.length === 0) {
        driveList.innerHTML = `<div class="drive-list-placeholder">No drives match the current filter.</div>`;
        return;
    }

    for (const date of sortedDates) {
        // Date group header
        const dateHeader = document.createElement('div');
        dateHeader.className = 'drive-date-header';
        dateHeader.textContent = formatDateDisplay(date);
        driveList.appendChild(dateHeader);

        const dayDrives = byDate.get(date);
        for (const drive of dayDrives) {
            const item = createDriveItem(drive, hasFootage?.has(drive.id) ?? false, useMetric);
            driveList.appendChild(item);
        }
    }

    highlightSelectedDrive();
}

/**
 * Draw the drive route on a canvas element, coloring segments by autopilot state.
 * Points are 5-tuples: [lat, lng, timeMs, speedMps, autopilotState]
 */
function renderRouteOnCanvas(canvas, drive) {
    const pts = drive.points;
    const ctx = canvas.getContext('2d');
    const W = canvas.width;
    const H = canvas.height;
    ctx.clearRect(0, 0, W, H);

    if (!pts || pts.length < 2) {
        ctx.fillStyle = 'rgba(255,255,255,0.2)';
        ctx.font = '11px sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText('No GPS data', W / 2, H / 2);
        return;
    }

    // Compute bounding box
    let minLat = Infinity, maxLat = -Infinity, minLng = Infinity, maxLng = -Infinity;
    for (const p of pts) {
        if (p[0] < minLat) minLat = p[0];
        if (p[0] > maxLat) maxLat = p[0];
        if (p[1] < minLng) minLng = p[1];
        if (p[1] > maxLng) maxLng = p[1];
    }

    const pad = 14;
    const latRange = maxLat - minLat || 0.001;
    const lngRange = maxLng - minLng || 0.001;

    // Preserve aspect ratio
    const drawW = W - pad * 2;
    const drawH = H - pad * 2;
    const scaleX = drawW / lngRange;
    const scaleY = drawH / latRange;
    const scale = Math.min(scaleX, scaleY);
    const offX = pad + (drawW - lngRange * scale) / 2;
    const offY = pad + (drawH - latRange * scale) / 2;

    const project = (lat, lng) => [
        offX + (lng - minLng) * scale,
        offY + (maxLat - lat) * scale,
    ];

    // Draw route as colored segments based on autopilot state
    ctx.lineWidth = 2.5;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    let segStart = 0;
    let curAp = pts[0][4];

    const flushSegment = (endIdx) => {
        if (endIdx <= segStart) return;
        ctx.beginPath();
        ctx.strokeStyle = curAp > 0 ? FSD_COLOR : MANUAL_COLOR;
        const [sx, sy] = project(pts[segStart][0], pts[segStart][1]);
        ctx.moveTo(sx, sy);
        for (let i = segStart + 1; i <= endIdx; i++) {
            const [x, y] = project(pts[i][0], pts[i][1]);
            ctx.lineTo(x, y);
        }
        ctx.stroke();
    };

    for (let i = 1; i < pts.length; i++) {
        if (pts[i][4] !== curAp) {
            flushSegment(i - 1);
            segStart = i - 1; // overlap by 1 point for continuity
            curAp = pts[i][4];
        }
    }
    flushSegment(pts.length - 1);

    // Draw start dot
    const [sx, sy] = project(pts[0][0], pts[0][1]);
    ctx.beginPath();
    ctx.arc(sx, sy, 3.5, 0, Math.PI * 2);
    ctx.fillStyle = '#ffffff';
    ctx.fill();

    // Draw end dot
    const [ex, ey] = project(pts[pts.length - 1][0], pts[pts.length - 1][1]);
    ctx.beginPath();
    ctx.arc(ex, ey, 3.5, 0, Math.PI * 2);
    ctx.fillStyle = '#aaaaaa';
    ctx.fill();
}

/**
 * Create a single drive list item element.
 */
function createDriveItem(drive, hasClips, useMetric) {
    const item = document.createElement('div');
    item.className = 'drive-item';
    item.dataset.driveId = String(drive.id);

    const durationStr = formatDriveDuration(drive.durationMs);
    const distanceStr = formatDriveDistance(drive, useMetric);
    const timeRange = `${drive.startTimeDisplay} – ${drive.endTimeDisplay}`;
    const clipCount = `${drive.clipCount} clip${drive.clipCount !== 1 ? 's' : ''}`;

    // Footage badge
    const footageBadge = hasClips
        ? `<span class="badge drive-footage-badge" title="Footage available">Footage</span>`
        : '';

    // FSD badge
    const fsdBadge = drive.hasFsd
        ? `<span class="badge drive-fsd-badge" title="FSD engaged ${Math.round(drive.fsdPercent)}%">FSD</span>`
        : '';

    // Tag badges (max 3)
    const tagBadges = drive.tags.slice(0, 3).map(tag =>
        `<span class="badge drive-tag-badge">${escapeHtml(tag)}</span>`
    ).join('');

    item.innerHTML = `
        <div class="drive-item-main">
            <div class="drive-item-time">${escapeHtml(timeRange)}</div>
            <div class="drive-item-stats">
                <span class="drive-stat">
                    <svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" stroke-width="2">
                        <circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>
                    </svg>
                    ${escapeHtml(durationStr)}
                </span>
                <span class="drive-stat">
                    <svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" stroke-width="2">
                        <circle cx="12" cy="12" r="3"/><path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83"/>
                    </svg>
                    ${escapeHtml(distanceStr)}
                </span>
                <span class="drive-stat drive-stat-muted">${escapeHtml(clipCount)}</span>
            </div>
            <div class="drive-item-badges">
                ${footageBadge}${fsdBadge}${tagBadges}
            </div>
        </div>
    `;

    item.onclick = () => {
        selectedDriveId = drive.id;
        highlightSelectedDrive();
        onDriveSelected?.(drive);
    };

    // Hover: show route map tooltip
    item.addEventListener('mouseenter', () => {
        if (!routeTooltip || !routeCanvas || !drive.points?.length) return;
        renderRouteOnCanvas(routeCanvas, drive);

        const rect = item.getBoundingClientRect();
        // Prefer right side; flip left if it would overflow the viewport
        const tooltipW = routeCanvas.width + 16;
        const tooltipH = routeCanvas.height + 16;
        let left = rect.right + 6;
        if (left + tooltipW > window.innerWidth) {
            left = rect.left - tooltipW - 6;
        }
        let top = rect.top;
        if (top + tooltipH > window.innerHeight) {
            top = window.innerHeight - tooltipH - 4;
        }
        routeTooltip.style.left = `${Math.max(4, left)}px`;
        routeTooltip.style.top = `${Math.max(4, top)}px`;
        routeTooltip.classList.add('visible');
    });

    item.addEventListener('mouseleave', () => {
        routeTooltip?.classList.remove('visible');
    });

    return item;
}

/**
 * Highlight the currently selected drive.
 */
export function highlightSelectedDrive() {
    if (!driveList) return;
    for (const el of driveList.querySelectorAll('.drive-item')) {
        el.classList.toggle('selected', el.dataset.driveId === String(selectedDriveId));
    }
}

/**
 * Set the tag filter and re-render.
 */
export function setDriveTagFilter(tag) {
    activeTagFilter = tag || '';
    renderDriveList();
}

/**
 * Update the drive list subtitle/status in the header.
 */
export function updateDriveBrowserStatus(statusEl) {
    if (!statusEl) return;
    const driveState = getDriveState?.();
    if (!driveState?.loaded) {
        statusEl.textContent = 'No drive data';
        return;
    }
    const { drives, hasFootage } = driveState;
    const footageCount = hasFootage?.size ?? 0;
    const oldest = drives[0]?.date ?? '';
    const newest = drives[drives.length - 1]?.date ?? '';
    const dateRange = oldest === newest ? oldest : `${oldest} – ${newest}`;
    const footagePart = footageCount > 0 ? ` · ${footageCount} with footage` : ' · load matching clips folder';
    statusEl.textContent = `${drives.length} drive${drives.length !== 1 ? 's' : ''} · ${dateRange}${footagePart}`;
}

/**
 * Format a YYYY-MM-DD string as a display date.
 */
function formatDateDisplay(dateStr) {
    if (!dateStr || dateStr.length < 10) return dateStr;
    try {
        const [y, m, d] = dateStr.split('-').map(Number);
        return new Date(y, m - 1, d).toLocaleDateString(undefined, {
            weekday: 'short', year: 'numeric', month: 'short', day: 'numeric'
        });
    } catch {
        return dateStr;
    }
}
