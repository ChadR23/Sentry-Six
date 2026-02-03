export function cssEscape(s) {
  if (window.CSS?.escape) return window.CSS.escape(String(s));
  // minimal escape for attribute selector usage
  return String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

export function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  }[c]));
}

/**
 * Check if we're running in web mode (no Electron)
 * @returns {boolean}
 */
export function isWebMode() {
  return typeof window !== 'undefined' && window._sentryWebMode === true;
}

/**
 * Encode a file path for use in a video URL.
 * In Electron mode: uses file:// protocol
 * In Web mode: uses /api/video/ endpoint
 * @param {string} filePath - The file path to encode
 * @returns {string} The encoded URL
 */
export function filePathToUrl(filePath) {
  const normalizedPath = filePath.replace(/\\/g, '/');
  
  // In web mode, use the API endpoint for video streaming
  if (isWebMode()) {
    // The path needs to be appended directly (server handles /api/video/*)
    // Encode special characters that could break the URL
    const encodedPath = normalizedPath
      .replace(/#/g, '%23')
      .replace(/\?/g, '%3F');
    return `/api/video${encodedPath}`;
  }
  
  // Electron mode: use file:// protocol
  // encodeURI handles most characters but NOT # and ? which have special URL meaning
  // We need to encode those separately after encodeURI
  const encoded = encodeURI(normalizedPath)
    .replace(/#/g, '%23')
    .replace(/\?/g, '%3F');
  return normalizedPath.startsWith('/') 
    ? `file://${encoded}` 
    : `file:///${encoded}`;
}

