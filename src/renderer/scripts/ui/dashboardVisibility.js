/**
 * Dashboard Visibility
 * Handles dashboard overlay visibility toggle
 */

// Dependencies set via init
let getDashboardVis = null;
let getState = null;

/**
 * Initialize dashboard visibility module with dependencies
 * @param {Object} deps - Dependencies
 */
export function initDashboardVisibility(deps) {
    getDashboardVis = deps.getDashboardVis;
    getState = deps.getState;
}

/**
 * Update dashboard visibility based on user toggle
 */
export function updateDashboardVisibility() {
    const dashboardVis = getDashboardVis?.();
    const state = getState?.();
    
    if (!dashboardVis) return;
    
    // Get current dashboard layout setting
    const compactDash = document.getElementById('dashboardVisCompact');
    const dashboardLayout = window.dashboardLayout || 'default';
    
    // Show/hide based on layout and enabled state
    if (dashboardLayout === 'compact' && compactDash) {
        dashboardVis.classList.add('user-hidden');
        if (state?.ui?.dashboardEnabled) {
            compactDash.classList.remove('user-hidden', 'hidden');
            compactDash.classList.add('visible');
        } else {
            compactDash.classList.add('user-hidden');
            compactDash.classList.remove('visible');
        }
    } else {
        dashboardVis.classList.toggle('user-hidden', !state?.ui?.dashboardEnabled);
        if (compactDash) {
            compactDash.classList.add('user-hidden', 'hidden');
            compactDash.classList.remove('visible');
        }
    }
}
