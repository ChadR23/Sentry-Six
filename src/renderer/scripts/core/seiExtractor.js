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
 * Extract SEI telemetry from an ArrayBuffer using DashcamMP4 parser
 * @param {ArrayBuffer} buffer - Video file buffer
 * @returns {Promise<{seiData: Array, mapPath: Array}>}
 */
async function extractSeiFromBuffer(buffer) {
    if (!window.DashcamMP4 || !window.DashcamHelpers) {
        return { seiData: [], mapPath: [] };
    }
    
    const { SeiMetadata } = await window.DashcamHelpers.initProtobuf();
    const mp4 = new window.DashcamMP4(buffer);
    const frames = mp4.parseFrames(SeiMetadata);
    
    const seiData = [];
    const mapPath = [];
    let runningMs = 0;
    
    for (const frame of frames) {
        runningMs += frame.duration;
        if (frame.sei) {
            seiData.push({ timestampMs: runningMs, sei: frame.sei });
            if (hasValidGps(frame.sei)) {
                const lat = Number(frame.sei.latitudeDeg ?? frame.sei.latitude_deg);
                const lon = Number(frame.sei.longitudeDeg ?? frame.sei.longitude_deg);
                const apState = frame.sei.autopilotState ?? frame.sei.autopilot_state;
                const autopilot = apState != null && apState !== 0 && apState !== 'DISABLED';
                mapPath.push({ lat, lon, timestampMs: runningMs, autopilot });
            }
        }
    }
    
    return { seiData, mapPath };
}

/**
 * Extract SEI telemetry from a File object
 * @param {File} file - Video File object
 * @returns {Promise<{seiData: Array, mapPath: Array}>}
 */
async function extractSeiFromFile(file) {
    const buffer = await file.arrayBuffer();
    return extractSeiFromBuffer(buffer);
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
            return extractSeiFromBuffer(buffer);
        } catch (err) {
            console.warn('Failed to extract SEI from Electron file:', err);
            return { seiData: [], mapPath: [] };
        }
    }
    
    // Regular File object
    if (entry.file && entry.file instanceof File) {
        return extractSeiFromFile(entry.file);
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
    
    // Binary search for the closest timestamp (data is sorted by timestampMs)
    let lo = 0, hi = seiData.length - 1;
    while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (seiData[mid].timestampMs <= timestampMs) lo = mid;
        else hi = mid - 1;
    }
    
    // lo is now the last entry with timestampMs <= target.
    // Check if lo+1 is closer (if it exists).
    let closest = seiData[lo];
    if (lo + 1 < seiData.length) {
        const diffLo = Math.abs(seiData[lo].timestampMs - timestampMs);
        const diffHi = Math.abs(seiData[lo + 1].timestampMs - timestampMs);
        if (diffHi < diffLo) closest = seiData[lo + 1];
    }
    
    return closest?.sei || null;
}
