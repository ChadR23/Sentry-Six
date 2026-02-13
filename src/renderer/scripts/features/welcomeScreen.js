/**
 * Welcome Screen
 * Handles the mandatory security notice screen with privacy-version gating.
 * Shows on first run AND whenever the privacy version is bumped.
 */

import { t } from '../lib/i18n.js';

console.log('[WELCOME] Module loaded');

// Privacy version — bump this whenever the data-collection terms change
const CURRENT_PRIVACY_VERSION = 2;

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
 * Apply the correct text variant to the modal
 * @param {boolean} isReturningUser - true if the user has completed first run before
 */
function applyModalVariant(isReturningUser) {
    const titleEl = document.querySelector('#softTcModal .modal-header h2');
    const subtitleEl = document.getElementById('softTcPrivacyTitle');
    const messageEl = document.getElementById('softTcPrivacyMessage');

    if (isReturningUser) {
        if (titleEl) titleEl.textContent = t('welcomeScreen.returningTitle') || 'Quick Update: Privacy & Security';
        if (subtitleEl) subtitleEl.textContent = t('welcomeScreen.returningSubtitle') || 'What Changed';
        if (messageEl) messageEl.textContent = t('welcomeScreen.returningMessage') || "We've updated Sentry-Six to improve security. Your footage still stays on your device. To prevent API abuse and ensure compatibility, the app now shares basic system info (OS, App Version, and a secure device hash) during update checks.";
    } else {
        if (titleEl) titleEl.textContent = t('welcomeScreen.title') || 'Welcome to Sentry-Six';
        if (subtitleEl) subtitleEl.textContent = t('welcomeScreen.privacyTitle') || 'Privacy & Security';
        if (messageEl) messageEl.textContent = t('welcomeScreen.privacyMessage') || 'By using Sentry-Six, you agree to our Terms of Service and Privacy Policy. Your dashcam footage remains strictly on your device. To ensure app security and compatibility, Sentry-Six automatically shares basic system info (OS, App Version, and a secure device hash) during update checks. This prevents API abuse and ensures you are running the most secure version of the app.';
    }
}

/**
 * Show the welcome modal
 * @param {boolean} isReturningUser - whether this is a returning user seeing updated terms
 */
function showWelcomeModal(isReturningUser = false) {
    getElements();
    if (!welcomeModal) return;

    // Apply the correct text variant before showing
    applyModalVariant(isReturningUser);
    
    // Show modal
    welcomeModal.classList.remove('hidden');
    
    // Set up external links for Terms and Privacy
    const termsLink = document.getElementById('softTcTermsLink');
    const privacyLink = document.getElementById('softTcPrivacyLink');
    
    if (termsLink) {
        termsLink.addEventListener('click', (e) => {
            e.preventDefault();
            window.electronAPI?.openExternal?.('https://sentry-six.com/terms');
        });
    }
    if (privacyLink) {
        privacyLink.addEventListener('click', (e) => {
            e.preventDefault();
            window.electronAPI?.openExternal?.('https://sentry-six.com/privacy');
        });
    }
    
    // Active acknowledgment: disable Accept button for 2 seconds
    if (acceptBtn) {
        acceptBtn.disabled = true;
        acceptBtn.style.opacity = '0.5';
        acceptBtn.style.cursor = 'not-allowed';
        setTimeout(() => {
            acceptBtn.disabled = false;
            acceptBtn.style.opacity = '';
            acceptBtn.style.cursor = '';
            acceptBtn.focus();
        }, 2000);
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
 * Uses privacyVersion gating — shows modal if acceptedPrivacyVersion is missing or outdated
 */
export async function initWelcomeScreen() {
    getElements();
    
    console.log('[WELCOME] Initializing welcome screen...');
    
    if (window.electronAPI?.getSetting) {
        const firstRunComplete = await window.electronAPI.getSetting('firstRunComplete');
        const acceptedPrivacyVersion = await window.electronAPI.getSetting('acceptedPrivacyVersion');
        
        console.log('[WELCOME] Settings:', { firstRunComplete, acceptedPrivacyVersion, required: CURRENT_PRIVACY_VERSION });
        
        const needsPrivacyAcceptance = !acceptedPrivacyVersion || acceptedPrivacyVersion < CURRENT_PRIVACY_VERSION;
        
        if (needsPrivacyAcceptance) {
            const isReturningUser = firstRunComplete === true;
            console.log('[WELCOME] Showing modal:', isReturningUser ? 'returning user' : 'first run');
            showWelcomeModal(isReturningUser);
            
            // Set up accept button handler
            if (acceptBtn) {
                acceptBtn.addEventListener('click', async () => {
                    console.log('[WELCOME] Accept button clicked, saving settings...');
                    
                    if (window.electronAPI?.setSetting) {
                        await window.electronAPI.setSetting('firstRunComplete', true);
                        await window.electronAPI.setSetting('acceptedPrivacyVersion', CURRENT_PRIVACY_VERSION);
                    }
                    
                    // Hide modal
                    hideWelcomeModal();
                    
                    // Trigger initial update check
                    if (window.electronAPI?.checkForUpdates) {
                        console.log('[WELCOME] Triggering initial update check');
                        window.electronAPI.checkForUpdates();
                    }
                    
                    // Show welcome guide/tour after privacy acceptance
                    if (window._checkAndShowWelcomeGuide) {
                        setTimeout(() => window._checkAndShowWelcomeGuide(), 500);
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
    }
    
    console.log('[WELCOME] Privacy terms already accepted, skipping modal');
    return false; // Modal was not shown
}

/**
 * Reset the welcome screen (for developer testing)
 */
export async function resetWelcomeScreen() {
    if (window.electronAPI?.setSetting) {
        await window.electronAPI.setSetting('firstRunComplete', false);
        await window.electronAPI.setSetting('acceptedPrivacyVersion', 0);
    }
}

/**
 * Show the welcome screen manually (for developer testing)
 */
export function showWelcomeScreen() {
    showWelcomeModal(false);
}
