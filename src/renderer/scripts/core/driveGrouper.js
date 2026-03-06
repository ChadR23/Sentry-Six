/**
 * Drive Grouper
 * Groups SentryUSB drive-data.json routes into logical drives using the same
 * time-gap algorithm as the Go backend (server/drives/grouper.go).
 *
 * StoreData JSON format:
 *   { ProcessedFiles: string[], Routes: Route[], DriveTags: {key: string[]} }
 *
 * Route format:
 *   { File, Date, Points: [{Lat,Lng,Time,Speed}], GearStates, AutopilotStates,
 *     Speeds, AccelPositions, GearRuns: [{Gear,StartFrame,EndFrame}] }
 */

/** Gap > 5 minutes between clip ends and next clip start = new drive. */
const DRIVE_GAP_MS = 5 * 60 * 1000;

/** Approximate clip duration for gap calculation when no GPS points. */
const CLIP_DURATION_MS = 60_000;

/**
 * Parse epoch ms from a route filename.
 * Input: "RecentClips/2024-01-15_10-30-00-front.mp4" or similar
 * Returns: epoch ms (local time, matching Tesla clip filenames), or null.
 */
function parseRouteTimestampMs(file) {
    const basename = file.split('/').pop().split('\\').pop();
    const m = basename.match(/^(\d{4})-(\d{2})-(\d{2})_(\d{2})-(\d{2})-(\d{2})/);
    if (!m) return null;
    const [, Y, Mo, D, h, mi, s] = m;
    return new Date(+Y, +Mo - 1, +D, +h, +mi, +s, 0).getTime();
}

/**
 * Haversine distance in km between two lat/lng points.
 */
function haversineKm(lat1, lon1, lat2, lon2) {
    const R = 6371;
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a =
        Math.sin(dLat / 2) ** 2 +
        Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/**
 * Format a local-time epoch ms as "HH:MM" display string.
 */
function msToTimeStr(ms) {
    const d = new Date(ms);
    const h = String(d.getHours()).padStart(2, '0');
    const m = String(d.getMinutes()).padStart(2, '0');
    return `${h}:${m}`;
}

/**
 * Main entry point.
 * Groups StoreData routes into Drive objects and attaches tags.
 *
 * @param {Object} storeData - Parsed drive-data.json (StoreData structure)
 * @returns {{ drives: Drive[], driveCount: number, routeCount: number }}
 */
export function groupStoreDataIntoDrives(storeData) {
    const routes = storeData?.Routes ?? [];
    const driveTags = storeData?.DriveTags ?? {};

    if (routes.length === 0) {
        return { drives: [], driveCount: 0, routeCount: 0 };
    }

    // Attach parsed start timestamps and filter routes with parseable filenames
    const routesWithTime = [];
    for (const r of routes) {
        const startMs = parseRouteTimestampMs(r.File ?? r.file ?? '');
        if (startMs !== null) {
            routesWithTime.push({ ...r, _startMs: startMs });
        }
    }

    // Sort routes chronologically
    routesWithTime.sort((a, b) => a._startMs - b._startMs);

    // Group by 5-minute gap between end of one clip and start of next
    const rawGroups = [];
    let currentGroup = [routesWithTime[0]];

    for (let i = 1; i < routesWithTime.length; i++) {
        const prev = routesWithTime[i - 1];
        const curr = routesWithTime[i];
        // Treat each clip as ~60s long for gap calculation
        const prevEndMs = prev._startMs + CLIP_DURATION_MS;
        const gap = curr._startMs - prevEndMs;

        if (gap > DRIVE_GAP_MS) {
            rawGroups.push(currentGroup);
            currentGroup = [curr];
        } else {
            currentGroup.push(curr);
        }
    }
    rawGroups.push(currentGroup);

    // Build Drive objects with stats
    const drives = rawGroups.map((group, idx) => buildDrive(idx + 1, group, driveTags));

    return { drives, driveCount: drives.length, routeCount: routesWithTime.length };
}

/**
 * Build a single Drive object from a group of routes.
 */
function buildDrive(id, routes, driveTags) {
    // Flatten GPS points from all routes.
    // Points may be [lat, lng] 2-tuples or {Lat,Lng,...} objects — handle both.
    // autopilotStates is a per-route summary array (not per GPS point).
    // speeds is a parallel array to points.
    const flatPoints = [];

    for (const route of routes) {
        const pts = route.Points ?? route.points;
        if (!pts || pts.length === 0) continue;
        const speeds = route.Speeds ?? route.speeds;
        const apStates = route.AutopilotStates ?? route.autopilotStates;
        // autopilotStates is a route-level summary (single element or short array).
        // Treat the entire route as FSD-engaged if any element is truthy.
        const routeAp = apStates?.length > 0 && !!apStates[0] ? 1 : 0;

        for (let i = 0; i < pts.length; i++) {
            const p = pts[i];
            let lat, lng;
            if (Array.isArray(p)) {
                lat = p[0]; lng = p[1];          // [lat, lng] tuple format
            } else {
                lat = p.Lat ?? p.lat; lng = p.Lng ?? p.lng;  // object format
            }
            if (!isFinite(lat) || !isFinite(lng)) continue;
            const spd = Array.isArray(p) ? (speeds?.[i] ?? 0) : (p.Speed ?? p.speed ?? 0);
            flatPoints.push([lat, lng, 0, spd, routeAp]);
        }
    }

    // Compute distance using haversine (route order is already chronological)
    let distanceKm = 0;
    for (let i = 1; i < flatPoints.length; i++) {
        distanceKm += haversineKm(
            flatPoints[i - 1][0], flatPoints[i - 1][1],
            flatPoints[i][0], flatPoints[i][1]
        );
    }

    // Drive time bounds from clip filenames (local time - matches clip timestamps)
    const startMs = routes[0]._startMs;
    const endMs = routes[routes.length - 1]._startMs + CLIP_DURATION_MS;
    const durationMs = Math.max(0, endMs - startMs);

    // Date string YYYY-MM-DD from first route filename
    const firstBasename = (routes[0].File ?? routes[0].file ?? '').split('/').pop().split('\\').pop();
    const date = firstBasename.substring(0, 10); // "2024-01-15"

    // Human-readable start/end time for display
    const startTimeDisplay = msToTimeStr(startMs);
    const endTimeDisplay = msToTimeStr(endMs);

    // FSD stats — autopilotStates is a per-route summary, not per-frame
    let fsdRouteCount = 0;
    let fsdDisengagements = 0;
    let prevFsd = false;
    for (const route of routes) {
        const apStates = route.AutopilotStates ?? route.autopilotStates;
        const isFsd = apStates?.length > 0 && !!apStates[0];
        if (isFsd) fsdRouteCount++;
        if (prevFsd && !isFsd) fsdDisengagements++;
        prevFsd = isFsd;
    }
    const hasFsd = fsdRouteCount > 0;
    const fsdPercent = routes.length > 0 ? (fsdRouteCount / routes.length) * 100 : 0;
    const fsdEngagedMs = fsdRouteCount * CLIP_DURATION_MS; // ~60s per route estimate

    // Tags - DriveTags is keyed by a drive identifier.
    const tags = driveTags[String(id)] ||
        driveTags[date] ||
        driveTags[firstBasename.substring(0, 19)] ||
        [];

    // Extract timestampKeys from route filenames for clip matching
    // e.g., "2024-01-15/2024-01-15_10-30-00-front.mp4" → "2024-01-15_10-30-00"
    const routeTimestampKeys = routes
        .map(r => {
            const base = (r.File ?? r.file ?? '').split('/').pop().split('\\').pop();
            const m = base.match(/^(\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2})/);
            return m ? m[1] : null;
        })
        .filter(Boolean);

    return {
        id,
        date,
        startMs,
        endMs,
        startTimeDisplay,
        endTimeDisplay,
        durationMs,
        distanceKm,
        distanceMi: distanceKm * 0.621371,
        clipCount: routes.length,
        pointCount: flatPoints.length,
        hasFsd,
        fsdEngagedMs,
        fsdDisengagements,
        fsdPercent,
        tags: Array.isArray(tags) ? tags : [],
        routeTimestampKeys,
        // Downsampled route points for hover map: [lat, lng, 0, speedMps, autopilotState]
        points: downsample(flatPoints, 200),
    };
}

/**
 * Return at most maxPoints evenly-spaced points from an array.
 */
function downsample(arr, maxPoints) {
    if (arr.length <= maxPoints) return arr;
    const result = [];
    const step = (arr.length - 1) / (maxPoints - 1);
    for (let i = 0; i < maxPoints; i++) {
        result.push(arr[Math.round(i * step)]);
    }
    return result;
}

/**
 * Build a Set of drive IDs that have matching clips in the loaded library.
 *
 * Uses direct filename timestamp matching for accuracy and efficiency:
 *   - O(clips) to build a lookup set
 *   - O(routes) to check each drive
 *
 * @param {Object[]} drives - Computed Drive objects from groupStoreDataIntoDrives()
 * @param {Object[]} clipGroups - Library clip groups (have .timestampKey)
 * @param {Set<string>} [knownDates] - Optional set of all dates discovered in the clips folder
 *   (YYYY-MM-DD). Used as a fallback in Electron mode where clipGroups only contains
 *   clips from the currently-selected date, not all dates.
 * @returns {Set<number>} Set of drive IDs that have footage
 */
export function matchClipsTodrives(drives, clipGroups, knownDates = null) {
    if (!drives?.length) return new Set();

    // Build O(1) lookup of all clip timestamp keys from currently-loaded clips
    const clipTsSet = new Set((clipGroups ?? []).map(g => g.timestampKey).filter(Boolean));

    const hasFootage = new Set();

    for (const drive of drives) {
        // First: precise match against loaded clip groups
        for (const tsKey of drive.routeTimestampKeys) {
            if (clipTsSet.has(tsKey)) {
                hasFootage.add(drive.id);
                break;
            }
        }
        // Fallback: if clips for this drive's date exist in the folder but aren't
        // the currently-loaded date, knownDates lets us still show the Footage badge.
        if (!hasFootage.has(drive.id) && knownDates?.has(drive.date)) {
            hasFootage.add(drive.id);
        }
    }

    return hasFootage;
}

/**
 * Format duration in ms as human-readable string.
 * e.g., 5400000 → "1h 30m" or "45m"
 */
export function formatDriveDuration(ms) {
    const totalMin = Math.round(ms / 60_000);
    if (totalMin < 1) return '<1m';
    const h = Math.floor(totalMin / 60);
    const m = totalMin % 60;
    if (h === 0) return `${m}m`;
    if (m === 0) return `${h}h`;
    return `${h}h ${m}m`;
}

/**
 * Format distance with unit label.
 */
export function formatDriveDistance(drive, useMetric) {
    if (useMetric) {
        const km = drive.distanceKm;
        return Number.isFinite(km) ? `${km.toFixed(1)} km` : '— km';
    }
    const mi = drive.distanceMi;
    return Number.isFinite(mi) ? `${mi.toFixed(1)} mi` : '— mi';
}
