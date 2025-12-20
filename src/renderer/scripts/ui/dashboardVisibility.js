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
    dashboardVis.classList.toggle('user-hidden', !state?.ui?.dashboardEnabled);
}
