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
 * Update the recording time display from segment timestamp
 * @param {Object} opts - Options
 * @param {Object} opts.collection - Active collection
 * @param {number} opts.segIdx - Current segment index
 * @param {number} opts.videoCurrentTime - Current video time in seconds
 */
export function updateRecordingTime(opts) {
    const { collection, segIdx, videoCurrentTime } = opts;
    const timeText = document.getElementById('recordingTimeText');
    if (!timeText) return;
    
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
            
            const ampm = h >= 12 ? 'PM' : 'AM';
            const h12 = h % 12 || 12;
            timeText.textContent = `${h12}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')} ${ampm}`;
        }
    } catch (e) {
        console.warn('updateRecordingTime error:', e);
    }
}
