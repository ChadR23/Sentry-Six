/**
 * Auto-Update System
 * Handles checking for and installing application updates
 * Includes changelog display with version comparison
 */

// DOM helper
const $ = id => document.getElementById(id);

// State
let updateComplete = false;
let changelogData = null;

// DOM element references (lazily cached)
let updateModal = null;
let updateProgress = null;
let updateProgressBar = null;
let updateProgressText = null;
let currentVersionDisplay = null;
let latestVersionDisplay = null;
let changelogContent = null;
let skipUpdateBtn = null;
let installUpdateBtn = null;
let updateModalFooter = null;

function getElements() {
    if (!updateModal) {
        updateModal = $('updateModal');
        updateProgress = $('updateProgress');
        updateProgressBar = $('updateProgressBar');
        updateProgressText = $('updateProgressText');
        currentVersionDisplay = $('currentVersionDisplay');
        latestVersionDisplay = $('latestVersionDisplay');
        changelogContent = $('changelogContent');
        skipUpdateBtn = $('skipUpdateBtn');
        installUpdateBtn = $('installUpdateBtn');
        updateModalFooter = $('updateModalFooter');
    }
}

/**
 * Compare two semantic version strings
 * @param {string} v1 - First version
 * @param {string} v2 - Second version
 * @returns {number} -1 if v1 < v2, 0 if equal, 1 if v1 > v2
 */
function compareVersions(v1, v2) {
    const parts1 = v1.replace(/^v/i, '').split('.').map(Number);
    const parts2 = v2.replace(/^v/i, '').split('.').map(Number);
    
    for (let i = 0; i < Math.max(parts1.length, parts2.length); i++) {
        const p1 = parts1[i] || 0;
        const p2 = parts2[i] || 0;
        if (p1 < p2) return -1;
        if (p1 > p2) return 1;
    }
    return 0;
}

/**
 * Get changelog entries newer than the current version
 * @param {string} currentVersion - Current app version
 * @returns {Array} Array of version entries newer than current
 */
function getRelevantChangelog(currentVersion) {
    if (!changelogData?.versions) return [];
    
    return changelogData.versions.filter(entry => {
        return compareVersions(entry.version, currentVersion) > 0;
    });
}

/**
 * Generate HTML for changelog entries
 * @param {Array} entries - Changelog entries to display
 * @returns {string} HTML string
 */
function renderChangelog(entries) {
    if (!entries || entries.length === 0) {
        return '<div class="changelog-loading">No changelog available</div>';
    }
    
    const typeIcons = {
        feature: '✦',
        improvement: '↑',
        fix: '✓'
    };
    
    return entries.map(entry => `
        <div class="changelog-version">
            <div class="changelog-version-header">
                <span class="changelog-version-tag">v${entry.version}</span>
                <span class="changelog-version-date">${formatDate(entry.date)}</span>
            </div>
            <div class="changelog-version-title">${entry.title}</div>
            <div class="changelog-changes">
                ${entry.changes.map(change => `
                    <div class="changelog-item">
                        <span class="changelog-item-type ${change.type}">${typeIcons[change.type] || '•'}</span>
                        <span>${change.description}</span>
                    </div>
                `).join('')}
            </div>
        </div>
    `).join('');
}

/**
 * Format date string for display
 * @param {string} dateStr - ISO date string
 * @returns {string} Formatted date
 */
function formatDate(dateStr) {
    try {
        const date = new Date(dateStr);
        return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
    } catch {
        return dateStr;
    }
}

/**
 * Load changelog data from file
 */
async function loadChangelog() {
    try {
        if (window.electronAPI?.getChangelog) {
            changelogData = await window.electronAPI.getChangelog();
        }
    } catch (err) {
        console.error('Failed to load changelog:', err);
        changelogData = null;
    }
}

/**
 * Show the update modal with version info
 * @param {Object} updateInfo - Update information
 */
export async function showUpdateModal(updateInfo) {
    getElements();
    updateComplete = false;
    if (!updateModal) return;
    
    // Display version info
    if (currentVersionDisplay) currentVersionDisplay.textContent = updateInfo.currentVersion;
    if (latestVersionDisplay) latestVersionDisplay.textContent = updateInfo.latestVersion;
    
    // Reset state
    if (updateProgress) updateProgress.classList.add('hidden');
    if (updateModalFooter) updateModalFooter.style.display = '';
    updateModal.querySelector('.update-modal')?.classList.remove('updating');
    
    // Show loading state for changelog
    if (changelogContent) {
        changelogContent.innerHTML = '<div class="changelog-loading">Loading changelog...</div>';
    }
    
    // Show modal
    updateModal.classList.remove('hidden');
    
    // Load and display changelog
    await loadChangelog();
    if (changelogContent) {
        const relevantEntries = getRelevantChangelog(updateInfo.currentVersion);
        changelogContent.innerHTML = renderChangelog(relevantEntries);
    }
}

/**
 * Hide the update modal
 */
export function hideUpdateModal() {
    getElements();
    if (updateModal) updateModal.classList.add('hidden');
}

/**
 * Handle the install update button click
 */
export async function handleInstallUpdate() {
    getElements();
    if (!window.electronAPI?.installUpdate) return;
    
    // Show progress, hide buttons
    if (updateProgress) updateProgress.classList.remove('hidden');
    if (updateModalFooter) updateModalFooter.style.display = 'none';
    updateModal?.querySelector('.update-modal')?.classList.add('updating');
    
    if (updateProgressBar) updateProgressBar.style.width = '0%';
    if (updateProgressText) updateProgressText.textContent = 'Starting update...';
    
    try {
        const result = await window.electronAPI.installUpdate();
        
        if (!result.success) {
            if (updateProgressText) updateProgressText.textContent = `Update failed: ${result.error}`;
            if (updateModalFooter) updateModalFooter.style.display = '';
            updateModal?.querySelector('.update-modal')?.classList.remove('updating');
        } else {
            showUpdateCompleteState();
        }
    } catch (err) {
        console.error('Update install error:', err);
        if (updateProgressText) updateProgressText.textContent = `Error: ${err.message}`;
        if (updateModalFooter) updateModalFooter.style.display = '';
        updateModal?.querySelector('.update-modal')?.classList.remove('updating');
    }
}

/**
 * Show the update complete state with exit button
 */
function showUpdateCompleteState() {
    getElements();
    updateComplete = true;
    
    if (updateProgressText) {
        updateProgressText.textContent = 'Update installed successfully!';
    }
    
    if (updateModalFooter) {
        updateModalFooter.innerHTML = `
            <p class="restart-message">Please restart the app with <code>npm start</code></p>
            <button id="exitAppBtn" class="btn btn-danger">Exit App</button>
        `;
        updateModalFooter.style.display = '';
        
        const exitBtn = document.getElementById('exitAppBtn');
        if (exitBtn) {
            exitBtn.addEventListener('click', () => {
                if (window.electronAPI?.exitApp) {
                    window.electronAPI.exitApp();
                }
            });
        }
    }
    
    updateModal?.querySelector('.update-modal')?.classList.remove('updating');
}

/**
 * Initialize the auto-update system
 */
export function initAutoUpdate() {
    getElements();
    
    // Set up update event listeners
    if (window.electronAPI?.on) {
        // Listen for update available event from main process
        window.electronAPI.on('update:available', (updateInfo) => {
            console.log('Update available:', updateInfo);
            showUpdateModal(updateInfo);
        });
        
        // Listen for update progress
        window.electronAPI.on('update:progress', (progress) => {
            getElements();
            if (updateProgressBar) updateProgressBar.style.width = `${progress.percentage}%`;
            if (updateProgressText) updateProgressText.textContent = progress.message;
        });
    }
    
    // Button handlers
    if (skipUpdateBtn) {
        skipUpdateBtn.addEventListener('click', () => {
            hideUpdateModal();
            if (window.electronAPI?.skipUpdate) {
                window.electronAPI.skipUpdate();
            }
        });
    }
    
    if (installUpdateBtn) {
        installUpdateBtn.addEventListener('click', handleInstallUpdate);
    }
    
    // Close modal when clicking outside (but not after update is complete)
    if (updateModal) {
        updateModal.addEventListener('click', (e) => {
            if (e.target === updateModal && !updateComplete) {
                hideUpdateModal();
            }
        });
    }
}
