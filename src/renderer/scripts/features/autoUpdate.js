/**
 * Auto-Update System
 * Handles checking for and installing application updates
 */

// DOM helper
const $ = id => document.getElementById(id);

// State
let updateComplete = false;

// DOM element references (lazily cached)
let updateModal = null;
let updateProgress = null;
let updateProgressBar = null;
let updateProgressText = null;
let currentVersionDisplay = null;
let latestVersionDisplay = null;
let updateCommitMessage = null;
let updateCommitDate = null;
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
        updateCommitMessage = $('updateCommitMessage');
        updateCommitDate = $('updateCommitDate');
        skipUpdateBtn = $('skipUpdateBtn');
        installUpdateBtn = $('installUpdateBtn');
        updateModalFooter = $('updateModalFooter');
    }
}

/**
 * Show the update modal with version info
 * @param {Object} updateInfo - Update information
 */
export function showUpdateModal(updateInfo) {
    getElements();
    updateComplete = false;
    if (!updateModal) return;
    
    if (currentVersionDisplay) currentVersionDisplay.textContent = updateInfo.currentVersion;
    if (latestVersionDisplay) latestVersionDisplay.textContent = updateInfo.latestVersion;
    if (updateCommitMessage) updateCommitMessage.textContent = updateInfo.message || 'New update available';
    if (updateCommitDate) {
        const date = new Date(updateInfo.date);
        updateCommitDate.textContent = `${date.toLocaleDateString()} by ${updateInfo.author || 'Unknown'}`;
    }
    
    // Reset state
    if (updateProgress) updateProgress.classList.add('hidden');
    if (updateModalFooter) updateModalFooter.style.display = '';
    updateModal.querySelector('.update-modal')?.classList.remove('updating');
    
    updateModal.classList.remove('hidden');
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
