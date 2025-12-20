/**
 * Loading Overlay Helpers
 * Shows/hides a loading spinner with progress information during heavy operations
 */

// DOM element references (lazily cached)
let loadingOverlay = null;
let loadingText = null;
let loadingProgress = null;
let loadingBar = null;

function getElements() {
    if (!loadingOverlay) {
        loadingOverlay = document.getElementById('loadingOverlay');
        loadingText = document.getElementById('loadingText');
        loadingProgress = document.getElementById('loadingProgress');
        loadingBar = document.getElementById('loadingBar');
    }
}

/**
 * Show the loading overlay
 * @param {string} text - Main loading message
 * @param {string} progress - Progress sub-text
 */
export function showLoading(text = 'Scanning folder...', progress = '') {
    getElements();
    if (loadingOverlay) loadingOverlay.classList.remove('hidden');
    if (loadingText) loadingText.textContent = text;
    if (loadingProgress) loadingProgress.textContent = progress;
    if (loadingBar) loadingBar.style.width = '0%';
}

/**
 * Update the loading overlay with new text and progress
 * @param {string} text - Main loading message
 * @param {string} progress - Progress sub-text
 * @param {number} percent - Progress bar percentage (0-100)
 */
export function updateLoading(text, progress, percent = 0) {
    getElements();
    if (loadingText) loadingText.textContent = text;
    if (loadingProgress) loadingProgress.textContent = progress;
    if (loadingBar) loadingBar.style.width = `${Math.min(100, Math.max(0, percent))}%`;
}

/**
 * Hide the loading overlay
 */
export function hideLoading() {
    getElements();
    if (loadingOverlay) loadingOverlay.classList.add('hidden');
}

/**
 * Yield to the event loop to prevent UI freezing during heavy processing
 * @returns {Promise<void>}
 */
export function yieldToUI() {
    return new Promise(resolve => setTimeout(resolve, 0));
}
