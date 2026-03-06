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

/** Minimum Park duration (seconds) that splits drives — matches Go parkGapSeconds. */
const PARK_GAP_SECONDS = 2.0;

/** Gear constants (matches Go: GearPark=0, GearDrive=1, GearReverse=2, GearNeutral=3). */
const GEAR_PARK = 0;

/**
 * Decode a Go []uint8 JSON field.
 * Go's encoding/json marshals []byte / []uint8 as a base64 string, NOT a JSON
 * array of numbers.  This helper handles both formats so we can read the raw
 * drive-data.json correctly:
 *   - base64 string → Uint8Array
 *   - number[]      → returned as-is (in case a future version changes format)
 *   - anything else → null
 */
function decodeUint8Field(value) {
    if (Array.isArray(value)) return value;
    if (typeof value === 'string' && value.length > 0) {
        try {
            const bin = atob(value);
            const arr = new Uint8Array(bin.length);
            for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
            return arr;
        } catch { return null; }
    }
    return null;
}

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
 * Second-pass splitting: split a time-group further at Park gaps ≥ PARK_GAP_SECONDS.
 * Uses GearRuns (raw frame transitions) for sub-clip precision when available,
 * falls back to clip-level heuristic for legacy data without GearRuns.
 * Matches Go: splitByGearState / splitByGearStateLegacy in grouper.go.
 */
function splitByGearState(group) {
    if (group.length === 0) return [];

    // Check if any clip has GearRuns data (new format)
    const gearRuns = group.some(r => {
        const runs = r.GearRuns ?? r.gearRuns;
        return Array.isArray(runs) && runs.length > 0;
    });

    if (!gearRuns) return splitByGearStateLegacy(group);

    // Sub-clip splitting using GearRuns
    const result = [];
    let current = [];

    for (const clip of group) {
        const runs = clip.GearRuns ?? clip.gearRuns;
        if (!Array.isArray(runs) || runs.length === 0) {
            current.push(clip);
            continue;
        }

        const segments = splitClipAtParkGaps(clip, runs);
        for (const seg of segments) {
            if (seg.parked) {
                if (current.length > 0) {
                    result.push(current);
                    current = [];
                }
            } else {
                current.push(seg.route);
            }
        }
    }
    if (current.length > 0) result.push(current);
    return result.length > 0 ? result : [group];
}

/**
 * Legacy fallback: split by clip-level Park heuristic.
 * A clip that is majority Park is treated as a drive boundary.
 */
function splitByGearStateLegacy(group) {
    if (group.length <= 1) return [group];

    // Check if any clip has decoded gear states
    const hasGear = group.some(r => {
        const gs = decodeUint8Field(r.GearStates ?? r.gearStates);
        return gs && gs.length > 0;
    });
    if (!hasGear) return [group];

    const result = [];
    let current = [];

    for (const clip of group) {
        if (clipIsMostlyParked(clip)) {
            if (current.length > 0) {
                result.push(current);
                current = [];
            }
        } else {
            current.push(clip);
        }
    }
    if (current.length > 0) result.push(current);
    return result.length > 0 ? result : [group];
}

/** Check if a clip is majority Park using rawParkCount or decoded gearStates. */
function clipIsMostlyParked(clip) {
    const rawFrames = clip.RawFrameCount ?? clip.rawFrameCount ?? 0;
    const rawPark = clip.RawParkCount ?? clip.rawParkCount ?? 0;
    if (rawFrames > 0) return rawPark / rawFrames > 0.5;

    const gs = decodeUint8Field(clip.GearStates ?? clip.gearStates);
    if (!gs || gs.length === 0) return false;
    let parkCount = 0;
    for (let i = 0; i < gs.length; i++) { if (gs[i] === GEAR_PARK) parkCount++; }
    return parkCount > gs.length / 2;
}

/**
 * Split a single clip at Park gaps ≥ PARK_GAP_SECONDS using its GearRuns data.
 * Returns array of { route, parked } segments.
 */
function splitClipAtParkGaps(clip, runs) {
    let totalRawFrames = 0;
    for (const run of runs) totalRawFrames += (run.Frames ?? run.frames ?? 0);
    if (totalRawFrames === 0) return [{ route: clip, parked: false }];

    const secondsPerFrame = 60.0 / totalRawFrames;
    const pts = clip.Points ?? clip.points ?? [];
    const nPoints = pts.length;

    // Identify park gaps
    const rawSegs = [];
    let frame = 0;
    for (const run of runs) {
        const gear = run.Gear ?? run.gear ?? 0;
        const frames = run.Frames ?? run.frames ?? 0;
        const duration = frames * secondsPerFrame;
        rawSegs.push({
            startFrame: frame,
            endFrame: frame + frames,
            parked: gear === GEAR_PARK && duration >= PARK_GAP_SECONDS,
        });
        frame += frames;
    }

    // Merge consecutive non-parked segments
    const merged = [];
    for (const seg of rawSegs) {
        if (merged.length > 0 && !merged[merged.length - 1].parked && !seg.parked) {
            merged[merged.length - 1].endFrame = seg.endFrame;
        } else {
            merged.push({ ...seg });
        }
    }

    if (!merged.some(s => s.parked)) return [{ route: clip, parked: false }];

    // Map frame ranges to point indices and build segments
    const result = [];
    for (const seg of merged) {
        if (seg.parked) {
            result.push({ route: null, parked: true });
            continue;
        }

        const startFrac = seg.startFrame / totalRawFrames;
        const endFrac = seg.endFrame / totalRawFrames;
        let startIdx = Math.round(startFrac * nPoints);
        let endIdx = Math.round(endFrac * nPoints);
        if (startIdx >= nPoints) startIdx = nPoints - 1;
        if (endIdx > nPoints) endIdx = nPoints;
        if (startIdx < 0) startIdx = 0;
        if (endIdx <= startIdx) continue;

        // Create a sub-route with sliced parallel arrays
        const subRoute = { ...clip };
        subRoute.Points = pts.slice(startIdx, endIdx);
        if (!subRoute.Points) subRoute.points = pts.slice(startIdx, endIdx);

        // Slice parallel arrays if they exist (keeping same format — base64 already decoded elsewhere)
        const offsetDurationMs = Math.round(startFrac * CLIP_DURATION_MS);
        subRoute._startMs = clip._startMs + offsetDurationMs;

        result.push({ route: subRoute, parked: false });
    }

    return result;
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

    // Second pass: split each time group further at Park gear transitions
    // (matches Go backend's splitByGearState in grouper.go)
    const allGroups = [];
    for (const tg of rawGroups) {
        allGroups.push(...splitByGearState(tg));
    }

    // Build Drive objects with stats
    const drives = allGroups.map((group, idx) => buildDrive(idx + 1, group, driveTags));

    return { drives, driveCount: drives.length, routeCount: routesWithTime.length };
}

/**
 * Build a single Drive object from a group of routes.
 */
function buildDrive(id, routes, driveTags) {
    // Single pass over all route points:
    // - Build flatPoints for map display
    // - Compute per-point FSD stats (matching Go backend: any apState != 0 is engaged)
    // - Detect disengagement events (engaged→off transitions)
    // - Detect accel push events (pedal > 1% while FSD active, complete on return to 0%)
    const flatPoints = [];

    let fsdEngagedPoints = 0;
    let totalApPoints = 0;
    let fsdDisengagements = 0;
    let accelPushCount = 0;
    const fsdEvents = []; // { lat, lng, type: "disengagement"|"accel_push" }

    let prevEngaged = false;
    let inAccelPress = false;
    let accelPressLat = 0, accelPressLng = 0;

    for (const route of routes) {
        const pts = route.Points ?? route.points;
        if (!pts || pts.length === 0) continue;

        const speeds = route.Speeds ?? route.speeds;

        // Go's encoding/json marshals []uint8 as base64, not as a JSON array.
        // decodeUint8Field handles both base64 strings and plain arrays.
        const apRaw = route.AutopilotStates ?? route.autopilotStates;
        const apDecoded = decodeUint8Field(apRaw);
        const apArr = (apDecoded && apDecoded.length === pts.length) ? apDecoded : null;

        const accelRaw = route.AccelPositions ?? route.accelPositions;
        // AccelPositions is []float32 in Go → JSON array of numbers (not base64).
        const accelArr = (Array.isArray(accelRaw) && accelRaw.length === pts.length) ? accelRaw : null;

        for (let i = 0; i < pts.length; i++) {
            const p = pts[i];
            let lat, lng;
            if (Array.isArray(p)) {
                lat = p[0]; lng = p[1];
            } else {
                lat = p.Lat ?? p.lat; lng = p.Lng ?? p.lng;
            }
            if (!isFinite(lat) || !isFinite(lng)) continue;

            const spd = Array.isArray(p) ? (speeds?.[i] ?? 0) : (p.Speed ?? p.speed ?? 0);
            const apVal = apArr ? apArr[i] : 0;
            const engaged = !!apVal;

            flatPoints.push([lat, lng, 0, spd, engaged ? 1 : 0]);

            // Count ALL GPS points for the denominator (matches Go: durationMs = full drive time).
            // Only routes WITH valid AP data contribute engaged points to the numerator.
            totalApPoints++;
            if (apArr && engaged) fsdEngagedPoints++;

            // Detect disengagement: engaged → not-engaged transition
            if (prevEngaged && !engaged) {
                fsdDisengagements++;
                fsdEvents.push({ lat, lng, type: 'disengagement' });
            }
            prevEngaged = engaged;

            // Detect accel push while FSD active.
            // Tesla accel pedal position: 0–1 or 0–100 depending on firmware.
            // Normalize to 0–100% for the >1% threshold used by the Go backend.
            if (accelArr) {
                if (engaged) {
                    let accelPct = accelArr[i];
                    if (accelPct <= 1.0) accelPct *= 100;

                    if (!inAccelPress && accelPct > 1.0) {
                        inAccelPress = true;
                        accelPressLat = lat;
                        accelPressLng = lng;
                    }
                    if (inAccelPress && accelPct <= 0.0) {
                        accelPushCount++;
                        fsdEvents.push({ lat: accelPressLat, lng: accelPressLng, type: 'accel_push' });
                        inAccelPress = false;
                    }
                } else {
                    inAccelPress = false;
                }
            }
        }
    }

    const hasFsd = fsdEngagedPoints > 0;

    // Drive time bounds from clip filenames (local time - matches clip timestamps)
    const startMs = routes[0]._startMs;
    const endMs = routes[routes.length - 1]._startMs + CLIP_DURATION_MS;
    const durationMs = Math.max(0, endMs - startMs);

    // FSD % = engaged points / ALL points (matches Go: fsdEngagedMs / durationMs).
    // totalApPoints now counts every GPS point, so clips without AP data naturally
    // dilute the percentage (they contribute 0 to numerator, 1+ to denominator).
    const fsdPercent = totalApPoints > 0 ? (fsdEngagedPoints / totalApPoints) * 100 : 0;
    const fsdEngagedMs = (durationMs > 0 && totalApPoints > 0) ? Math.round((fsdEngagedPoints / totalApPoints) * durationMs) : 0;

    // Compute distance using haversine (route order is already chronological)
    let distanceKm = 0;
    for (let i = 1; i < flatPoints.length; i++) {
        distanceKm += haversineKm(
            flatPoints[i - 1][0], flatPoints[i - 1][1],
            flatPoints[i][0], flatPoints[i][1]
        );
    }

    // Date string YYYY-MM-DD from first route filename
    const firstBasename = (routes[0].File ?? routes[0].file ?? '').split('/').pop().split('\\').pop();
    const date = firstBasename.substring(0, 10); // "2024-01-15"

    // Human-readable start/end time for display
    const startTimeDisplay = msToTimeStr(startMs);
    const endTimeDisplay = msToTimeStr(endMs);

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
        accelPushCount,
        tags: Array.isArray(tags) ? tags : [],
        routeTimestampKeys,
        points: downsample(flatPoints, 3000),
        fsdEvents,
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
