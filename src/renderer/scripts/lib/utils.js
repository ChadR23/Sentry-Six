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
 * Encode a file path for use in a file:// URL.
 * Unlike encodeURI(), this also encodes # and ? characters which are valid URI
 * characters but have special meaning (fragment/query) and break file paths.
 * @param {string} filePath - The file path to encode
 * @returns {string} The encoded file:// URL
 */
export function filePathToUrl(filePath) {
  const normalizedPath = filePath.replace(/\\/g, '/');
  // encodeURI handles most characters but NOT # and ? which have special URL meaning
  // We need to encode those separately after encodeURI
  const encoded = encodeURI(normalizedPath)
    .replace(/#/g, '%23')
    .replace(/\?/g, '%3F');
  return normalizedPath.startsWith('/') 
    ? `file://${encoded}` 
    : `file:///${encoded}`;
}

