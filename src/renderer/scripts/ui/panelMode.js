import { CLIPS_MODE_KEY } from '../lib/storageKeys.js';

// Clips panel mode (floating / collapsed only)
export function createClipsPanelMode({ map, clipsCollapseBtn } = {}) {
  function applyClipsMode(mode) {
    const m = (mode === 'collapsed') ? 'collapsed' : 'floating';
    document.body.classList.remove('clips-mode-floating', 'clips-mode-docked', 'clips-mode-collapsed');
    document.body.classList.add(`clips-mode-${m}`);
    localStorage.setItem(CLIPS_MODE_KEY, m);

    if (clipsCollapseBtn) {
      const isCollapsed = (m === 'collapsed');
      clipsCollapseBtn.title = isCollapsed ? 'Expand panel' : 'Collapse panel';
      clipsCollapseBtn.setAttribute('aria-label', isCollapsed ? 'Expand panel' : 'Collapse panel');
    }

    // Leaflet sometimes needs a nudge when UI moves around.
    if (map) setTimeout(() => { try { map.invalidateSize(); } catch { } }, 150);
  }

  function initClipsPanelMode() {
    // Always start in floating mode
    applyClipsMode('floating');
  }

  function toggleCollapsedMode() {
    const current = localStorage.getItem(CLIPS_MODE_KEY) || 'floating';
    if (current === 'collapsed') {
      applyClipsMode('floating');
      return;
    }
    applyClipsMode('collapsed');
  }

  return { initClipsPanelMode, applyClipsMode, toggleCollapsedMode };
}

