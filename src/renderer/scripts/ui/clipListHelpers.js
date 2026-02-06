/**
 * Clip List Helpers
 * Utility functions for clip list rendering
 */

/**
 * Format event time from eventId
 * @param {string} eventId - Event ID in format "2025-12-11_17-58-00"
 * @returns {string} Formatted time "17:58:00"
 */
export function formatEventTime(eventId) {
    const parts = eventId.split('_');
    if (parts.length >= 2) {
        const timePart = parts[1];
        return timePart.replace(/-/g, ':');
    }
    return eventId;
}
