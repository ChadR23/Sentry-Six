/**
 * Welcome Screen
 * Handles the first-run privacy and update consent screen
 */

console.log('[WELCOME] Module loaded');

// DOM helper
const $ = id => document.getElementById(id);

// State
let welcomeModal = null;
let acceptBtn = null;

function getElements() {
    if (!welcomeModal) {
        welcomeModal = $('softTcModal');
        acceptBtn = $('softTcAcceptBtn');
    }
}

/**
 * Show the welcome modal
 */
function showWelcomeModal() {
    getElements();
    if (!welcomeModal) return;
    
    // Show modal
    welcomeModal.classList.remove('hidden');
    
    // Focus the accept button
    if (acceptBtn) {
        acceptBtn.focus();
    }
}

/**
 * Hide the welcome modal
 */
function hideWelcomeModal() {
    getElements();
    if (welcomeModal) {
        welcomeModal.classList.add('hidden');
    }
}

/**
 * Initialize the welcome screen system
 * Checks if first run is complete and shows modal if needed
 */
export async function initWelcomeScreen() {
    getElements();
    
    console.log('[WELCOME] Initializing welcome screen...');
    
    // Check if first run is complete
    if (window.electronAPI?.getSetting) {
        console.log('[WELCOME] Checking settings...');
        const firstRunComplete = await window.electronAPI.getSetting('firstRunComplete');
        const hasAnalyticsSetting = await window.electronAPI.getSetting('anonymousAnalytics');
        
        console.log('[WELCOME] Settings loaded:', { firstRunComplete, hasAnalyticsSetting });
        console.log('[WELCOME] Condition check:', {
            firstRunNotComplete: firstRunComplete !== true,
            analyticsUndefined: hasAnalyticsSetting === undefined,
            shouldShow: firstRunComplete !== true || hasAnalyticsSetting === undefined
        });
        
        // Show modal if first run not complete OR if analytics setting doesn't exist (existing user)
        if (firstRunComplete !== true || hasAnalyticsSetting === undefined) {
            // First run or existing user - show the modal
            console.log('[WELCOME] First run or existing user detected, showing welcome modal');
            showWelcomeModal();
            
            // Set up accept button handler
            if (acceptBtn) {
                acceptBtn.addEventListener('click', async () => {
                    console.log('[WELCOME] Accept button clicked, saving settings...');
                    
                    // Set firstRunComplete to true and anonymousAnalytics to true (default enabled)
                    if (window.electronAPI?.setSetting) {
                        const result1 = await window.electronAPI.setSetting('firstRunComplete', true);
                        const result2 = await window.electronAPI.setSetting('anonymousAnalytics', true);
                        console.log('[WELCOME] Settings saved:', { firstRunComplete: result1, anonymousAnalytics: result2 });
                    }
                    
                    // Hide modal
                    hideWelcomeModal();
                    
                    // Trigger initial update check with telemetry
                    if (window.electronAPI?.checkForUpdates) {
                        console.log('[SOFT_TC] Triggering initial update check');
                        window.electronAPI.checkForUpdates();
                    }
                });
            }
            
            // Prevent closing by clicking outside
            if (welcomeModal) {
                welcomeModal.addEventListener('click', (e) => {
                    if (e.target === welcomeModal) {
                        e.preventDefault();
                        e.stopPropagation();
                    }
                });
            }
            
            // Prevent ESC key from closing
            document.addEventListener('keydown', function escHandler(e) {
                if (e.key === 'Escape' && !welcomeModal.classList.contains('hidden')) {
                    e.preventDefault();
                    e.stopPropagation();
                }
            });
            
            return true; // Modal was shown
        }
    } else {
        console.log('[WELCOME] First run already complete and analytics setting exists, not showing modal');
        
        // For debugging: show a temporary notification
        if (typeof notify === 'function') {
            notify('Welcome screen skipped - first run complete', { type: 'info', duration: 3000 });
        }
    }
    
    return false; // Modal was not shown (first run already complete)
}
