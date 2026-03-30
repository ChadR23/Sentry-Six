/**
 * Centralized API Configuration
 * All API base URLs in one place, overridable via environment variables.
 *
 * Set SENTRY_API_URL to override the main API host (e.g. for staging/local dev).
 * Defaults to production: https://api.sentry-six.com
 */

const API_BASE_URL = process.env.SENTRY_API_URL || 'https://api.sentry-six.com';

// Derived endpoints — all built from the single base URL
const API_ENDPOINTS = {
  clipUpload:    `${API_BASE_URL}/share/upload`,
  clipDelete:    `${API_BASE_URL}/share/delete`,
  clipConfig:    `${API_BASE_URL}/share/config`,
  clipReserve:   `${API_BASE_URL}/share/reserve`,
  clipCheckCodes:`${API_BASE_URL}/share/check-codes`,
  support:       API_BASE_URL,
  updateCheck:   API_BASE_URL,
};

module.exports = { API_BASE_URL, API_ENDPOINTS };
