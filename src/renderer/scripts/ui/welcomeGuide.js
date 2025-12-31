/**
 * Welcome Guide Module
 * Interactive tour for first-time users with mock UI previews
 */

const $ = id => document.getElementById(id);

const TOTAL_STEPS = 9;
let currentStep = 1;
let isOpen = false;

/**
 * Check if the welcome guide should be shown (first run)
 * @returns {Promise<boolean>}
 */
export async function shouldShowWelcomeGuide() {
    if (window.electronAPI?.getSetting) {
        const completed = await window.electronAPI.getSetting('welcomeGuideCompleted');
        return completed !== true;
    }
    // Fallback to localStorage if electronAPI not available
    return localStorage.getItem('welcomeGuideCompleted') !== 'true';
}

/**
 * Mark welcome guide as completed
 */
async function markCompleted() {
    if (window.electronAPI?.setSetting) {
        await window.electronAPI.setSetting('welcomeGuideCompleted', true);
    }
    // Also store in localStorage as backup
    localStorage.setItem('welcomeGuideCompleted', 'true');
}

/**
 * Reset welcome guide (for developer testing)
 */
export async function resetWelcomeGuide() {
    if (window.electronAPI?.setSetting) {
        await window.electronAPI.setSetting('welcomeGuideCompleted', false);
    }
    localStorage.removeItem('welcomeGuideCompleted');
}

/**
 * Open the welcome guide modal
 */
export function openWelcomeGuide() {
    const modal = $('welcomeGuideModal');
    if (modal) {
        currentStep = 1;
        updateStep(1);
        modal.classList.remove('hidden');
        isOpen = true;
    }
}

/**
 * Close the welcome guide modal
 * @param {boolean} completed - Whether the tour was completed or skipped
 */
export async function closeWelcomeGuide(completed = false) {
    const modal = $('welcomeGuideModal');
    if (modal) {
        modal.classList.add('hidden');
        isOpen = false;
        
        // Always mark as completed when closing (either finished or skipped)
        await markCompleted();
    }
}

/**
 * Go to a specific step
 * @param {number} step - Step number (1-based)
 */
function goToStep(step) {
    if (step < 1 || step > TOTAL_STEPS) return;
    currentStep = step;
    updateStep(step);
}

/**
 * Go to next step
 */
function nextStep() {
    if (currentStep < TOTAL_STEPS) {
        goToStep(currentStep + 1);
    } else {
        // Last step - close and mark complete
        closeWelcomeGuide(true);
    }
}

/**
 * Go to previous step
 */
function prevStep() {
    if (currentStep > 1) {
        goToStep(currentStep - 1);
    }
}

/**
 * Update the UI to show the current step
 * @param {number} step - Step number (1-based)
 */
function updateStep(step) {
    // Update step content visibility
    const steps = document.querySelectorAll('.welcome-step');
    steps.forEach(s => {
        const stepNum = parseInt(s.dataset.step, 10);
        s.classList.toggle('active', stepNum === step);
    });
    
    // Update indicators
    const indicators = document.querySelectorAll('.welcome-indicator');
    indicators.forEach(ind => {
        const indStep = parseInt(ind.dataset.step, 10);
        ind.classList.toggle('active', indStep === step);
        ind.classList.toggle('completed', indStep < step);
    });
    
    // Update navigation buttons
    const prevBtn = $('welcomePrevBtn');
    const nextBtn = $('welcomeNextBtn');
    const skipBtn = $('welcomeSkipBtn');
    
    if (prevBtn) {
        prevBtn.disabled = step === 1;
    }
    
    if (nextBtn) {
        if (step === TOTAL_STEPS) {
            nextBtn.innerHTML = `
                Get Started
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <polyline points="20 6 9 17 4 12"/>
                </svg>
            `;
        } else {
            nextBtn.innerHTML = `
                Next
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <polyline points="9 18 15 12 9 6"/>
                </svg>
            `;
        }
    }
    
    if (skipBtn) {
        // Hide skip button on last step
        skipBtn.style.display = step === TOTAL_STEPS ? 'none' : '';
    }
}

/**
 * Initialize the welcome guide module
 */
export function initWelcomeGuide() {
    const modal = $('welcomeGuideModal');
    const closeBtn = $('closeWelcomeGuide');
    const skipBtn = $('welcomeSkipBtn');
    const prevBtn = $('welcomePrevBtn');
    const nextBtn = $('welcomeNextBtn');
    
    // Close button
    if (closeBtn) {
        closeBtn.onclick = () => closeWelcomeGuide(false);
    }
    
    // Skip button
    if (skipBtn) {
        skipBtn.onclick = () => closeWelcomeGuide(false);
    }
    
    // Navigation buttons
    if (prevBtn) {
        prevBtn.onclick = prevStep;
    }
    
    if (nextBtn) {
        nextBtn.onclick = nextStep;
    }
    
    // Click outside to close (only on backdrop)
    if (modal) {
        modal.onclick = (e) => {
            if (e.target === modal) {
                closeWelcomeGuide(false);
            }
        };
    }
    
    // Step indicators are clickable
    const indicators = document.querySelectorAll('.welcome-indicator');
    indicators.forEach(ind => {
        ind.onclick = () => {
            const step = parseInt(ind.dataset.step, 10);
            if (step) goToStep(step);
        };
    });
    
    // Keyboard navigation
    document.addEventListener('keydown', (e) => {
        if (!isOpen) return;
        
        if (e.key === 'Escape') {
            closeWelcomeGuide(false);
        } else if (e.key === 'ArrowRight' || e.key === 'Enter') {
            nextStep();
        } else if (e.key === 'ArrowLeft') {
            prevStep();
        }
    });
}

/**
 * Auto-show welcome guide on first run
 */
export async function checkAndShowWelcomeGuide() {
    const shouldShow = await shouldShowWelcomeGuide();
    if (shouldShow) {
        // Small delay to let the app initialize first
        setTimeout(() => {
            openWelcomeGuide();
        }, 500);
    }
}
