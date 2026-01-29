/**
 * Time Display Utilities
 * Formats and displays playback time information
 */

// DOM element references (lazily cached)
let currentTimeEl = null;
let totalTimeEl = null;

function getElements() {
    if (!currentTimeEl) {
        currentTimeEl = document.getElementById('currentTime');
        totalTimeEl = document.getElementById('totalTime');
    }
}

/**
 * Format seconds as HH:MM:SS or MM:SS
 * @param {number} seconds - Time in seconds
 * @returns {string} Formatted time string
 */
export function formatTimeHMS(seconds) {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);
    if (h > 0) {
        return `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
    }
    return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
}

/**
 * Update the time display with current and total time
 * @param {number} currentSec - Current playback position in seconds
 * @param {number} totalSec - Total duration in seconds
 */
export function updateTimeDisplayNew(currentSec, totalSec) {
    getElements();
    if (currentTimeEl) currentTimeEl.textContent = formatTimeHMS(currentSec);
    if (totalTimeEl) totalTimeEl.textContent = formatTimeHMS(totalSec);
}

/**
 * Format time based on user's time format preference (12h or 24h)
 * @param {number} hours - Hours (0-23)
 * @param {number} minutes - Minutes (0-59)
 * @param {number} seconds - Seconds (0-59)
 * @param {string} timeFormat - '12h' or '24h'
 * @returns {string} Formatted time string
 */
export function formatTimeWithPreference(hours, minutes, seconds, timeFormat) {
    const m = String(minutes).padStart(2, '0');
    const s = String(seconds).padStart(2, '0');
    
    if (timeFormat === '24h') {
        const h = String(hours).padStart(2, '0');
        return `${h}:${m}:${s}`;
    } else {
        const ampm = hours >= 12 ? 'PM' : 'AM';
        const h12 = hours % 12 || 12;
        return `${h12}:${m}:${s} ${ampm}`;
    }
}

/**
 * Update the recording time display from segment timestamp
 * @param {Object} opts - Options
 * @param {Object} opts.collection - Active collection
 * @param {number} opts.segIdx - Current segment index
 * @param {number} opts.videoCurrentTime - Current video time in seconds
 */
export function updateRecordingTime(opts) {
    const { collection, segIdx, videoCurrentTime } = opts;
    const timeText = document.getElementById('recordingTimeText');
    const timeTextCompact = document.getElementById('recordingTimeTextCompact');
    if (!timeText && !timeTextCompact) return;
    
    try {
        const group = collection?.groups?.[segIdx];
        if (!group) return;
        
        // Get any file from the group to extract timestamp
        let filename = null;
        if (group.filesByCamera) {
            const iter = group.filesByCamera.values();
            const first = iter.next();
            if (first.value?.file?.name) filename = first.value.file.name;
        }
        if (!filename) return;
        
        // Tesla filename format: 2024-12-15_14-30-45-front.mp4
        const match = filename.match(/(\d{4})-(\d{2})-(\d{2})_(\d{2})-(\d{2})-(\d{2})/);
        if (match) {
            const [, , , , hour, min, sec] = match;
            // Add current video position to the base timestamp
            const vidSec = Math.floor(videoCurrentTime || 0);
            
            // Calculate actual time
            let totalSeconds = parseInt(hour) * 3600 + parseInt(min) * 60 + parseInt(sec) + vidSec;
            totalSeconds = totalSeconds % 86400; // Wrap at 24 hours
            const h = Math.floor(totalSeconds / 3600);
            const m = Math.floor((totalSeconds % 3600) / 60);
            const s = totalSeconds % 60;
            
            // Use user's time format preference (default to 12h)
            const timeFormat = window._timeFormat || '12h';
            const formattedTime = formatTimeWithPreference(h, m, s, timeFormat);
            if (timeText) timeText.textContent = formattedTime;
            if (timeTextCompact) timeTextCompact.textContent = formattedTime;
        }
    } catch (e) {
        console.warn('updateRecordingTime error:', e);
    }
}
