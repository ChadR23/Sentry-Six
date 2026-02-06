/**
 * SEI Telemetry Extraction
 * Extracts GPS and vehicle telemetry data from Tesla dashcam video files
 */

import { filePathToUrl } from '../lib/utils.js';

/**
 * Check if SEI data contains valid GPS coordinates
 * @param {Object} sei - SEI telemetry data
 * @returns {boolean}
 */
export function hasValidGps(sei) {
    // Tesla SEI can be missing, zeroed, or invalid while parked / initializing GPS.
    const lat = Number(sei?.latitudeDeg ?? sei?.latitude_deg);
    const lon = Number(sei?.longitudeDeg ?? sei?.longitude_deg);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return false;
    // Treat (0,0) as "no fix" (real-world clips should never be there).
    if (lat === 0 && lon === 0) return false;
    // Basic sanity bounds.
    if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return false;
    return true;
}

/**
 * Extract SEI from an ArrayBuffer
 * @param {ArrayBuffer} buffer - Video file buffer
 * @param {string} seiType - SEI type identifier for DashcamMP4 parser
 * @returns {{seiData: Array, mapPath: Array}}
 */
export function extractSeiFromBuffer(buffer, seiType) {
    const seiData = [];
    const mapPath = [];
    
    try {
        const mp4 = new DashcamMP4(buffer);
        const frames = mp4.parseFrames(seiType);
        
        for (const frame of frames) {
            if (frame.sei) {
                seiData.push({ timestampMs: frame.timestamp, sei: frame.sei });
                if (hasValidGps(frame.sei)) {
                    const lat = frame.sei.latitudeDeg ?? frame.sei.latitude_deg;
                    const lon = frame.sei.longitudeDeg ?? frame.sei.longitude_deg;
                    // Include autopilot state: 1 or 2 = engaged, 0 or undefined = manual
                    const apState = frame.sei.autopilotState ?? frame.sei.autopilot_state ?? 0;
                    const isAutopilot = apState === 1 || apState === 2;
                    mapPath.push({ lat, lon, autopilot: isAutopilot });
                }
            }
        }
    } catch (err) {
        console.warn('Failed to extract SEI:', err);
    }
    
    return { seiData, mapPath };
}

/**
 * Extract SEI telemetry from a video File object
 * @param {File} file - Video file
 * @param {string} seiType - SEI type identifier
 * @returns {Promise<{seiData: Array, mapPath: Array}>}
 */
export async function extractSeiFromFile(file, seiType) {
    try {
        const buffer = await file.arrayBuffer();
        return extractSeiFromBuffer(buffer, seiType);
    } catch (err) {
        console.warn('Failed to extract SEI from file:', err);
        return { seiData: [], mapPath: [] };
    }
}

/**
 * Extract SEI telemetry from an entry (handles both File objects and Electron paths)
 * @param {Object} entry - Clip entry with file property
 * @param {string} seiType - SEI type identifier
 * @returns {Promise<{seiData: Array, mapPath: Array}>}
 */
export async function extractSeiFromEntry(entry, seiType) {
    if (!entry) return { seiData: [], mapPath: [] };
    
    // If it's an Electron file with path, fetch via file:// protocol
    if (entry.file?.isElectronFile && entry.file?.path) {
        try {
            const fileUrl = filePathToUrl(entry.file.path);
            const response = await fetch(fileUrl);
            const buffer = await response.arrayBuffer();
            return extractSeiFromBuffer(buffer, seiType);
        } catch (err) {
            console.warn('Failed to extract SEI from Electron file:', err);
            return { seiData: [], mapPath: [] };
        }
    }
    
    // Regular File object
    if (entry.file && entry.file instanceof File) {
        return extractSeiFromFile(entry.file, seiType);
    }
    
    return { seiData: [], mapPath: [] };
}

/**
 * Find the closest SEI data for a given timestamp
 * @param {Array} seiData - Array of {timestampMs, sei} objects
 * @param {number} timestampMs - Target timestamp in milliseconds
 * @returns {Object|null} SEI data or null
 */
export function findSeiAtTime(seiData, timestampMs) {
    if (!seiData || !seiData.length) return null;
    
    let closest = seiData[0];
    let minDiff = Math.abs(seiData[0].timestampMs - timestampMs);
    
    for (let i = 1; i < seiData.length; i++) {
        const diff = Math.abs(seiData[i].timestampMs - timestampMs);
        if (diff < minDiff) {
            minDiff = diff;
            closest = seiData[i];
        }
        // Since data is sorted, if diff starts increasing, we passed the closest
        if (seiData[i].timestampMs > timestampMs && diff > minDiff) break;
    }
    
    return closest?.sei || null;
}
