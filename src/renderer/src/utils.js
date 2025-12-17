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


