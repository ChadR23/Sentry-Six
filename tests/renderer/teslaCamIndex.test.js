/**
 * Tests for src/renderer/scripts/core/teslaCamIndex.js
 * Covers: parseTeslaCamPath, parseClipFilename, normalizeCamera,
 *         getRootFolderNameFromWebkitRelativePath, getBestEffortRelPath
 */

// Mock browser-specific imports that teslaCamIndex depends on
jest.mock('../../src/renderer/scripts/ui/loadingOverlay.js', () => ({
  yieldToUI: jest.fn(() => Promise.resolve())
}));
jest.mock('../../src/renderer/scripts/lib/i18n.js', () => ({
  t: jest.fn((key) => key)
}));
jest.mock('../../src/renderer/scripts/core/clipBrowser.js', () => ({
  parseTimestampKeyToEpochMs: jest.fn((key) => {
    if (!key) return null;
    // Parse YYYY-MM-DD_HH-MM-SS to epoch ms
    const [date, time] = key.split('_');
    if (!date || !time) return null;
    const [y, m, d] = date.split('-').map(Number);
    const [h, min, s] = time.split('-').map(Number);
    return new Date(y, m - 1, d, h, min, s).getTime();
  })
}));

const {
  parseTeslaCamPath,
  parseClipFilename,
  normalizeCamera,
  getRootFolderNameFromWebkitRelativePath,
  getBestEffortRelPath,
  buildDayCollections
} = require('../../src/renderer/scripts/core/teslaCamIndex.js');

describe('teslaCamIndex', () => {
  describe('parseTeslaCamPath', () => {
    test('parses TeslaCam/RecentClips path', () => {
      const result = parseTeslaCamPath('TeslaCam/RecentClips/2025-01-15_12-30-00-front.mp4');
      expect(result.tag).toBe('RecentClips');
      expect(result.rest).toEqual(['2025-01-15_12-30-00-front.mp4']);
    });

    test('parses TeslaCam/SentryClips with event folder', () => {
      const result = parseTeslaCamPath('TeslaCam/SentryClips/2025-01-15_12-30-00/2025-01-15_12-30-00-front.mp4');
      expect(result.tag).toBe('SentryClips');
      expect(result.rest).toEqual(['2025-01-15_12-30-00', '2025-01-15_12-30-00-front.mp4']);
    });

    test('parses TeslaCam/SavedClips path', () => {
      const result = parseTeslaCamPath('TeslaCam/SavedClips/2025-01-15_12-30-00/2025-01-15_12-30-00-back.mp4');
      expect(result.tag).toBe('SavedClips');
    });

    test('handles backslash paths (Windows)', () => {
      const result = parseTeslaCamPath('TeslaCam\\RecentClips\\2025-01-15_12-30-00-front.mp4');
      expect(result.tag).toBe('RecentClips');
    });

    test('handles teslausb root folder', () => {
      const result = parseTeslaCamPath('teslausb/RecentClips/clip.mp4');
      expect(result.tag).toBe('RecentClips');
    });

    test('returns Unknown tag for bare filename', () => {
      const result = parseTeslaCamPath('clip.mp4');
      expect(result.tag).toBe('Unknown');
    });

    test('handles empty/null input', () => {
      const result = parseTeslaCamPath('');
      expect(result.tag).toBe('Unknown');

      const result2 = parseTeslaCamPath(null);
      expect(result2.tag).toBe('Unknown');
    });

    test('handles non-standard folder as best-effort tag', () => {
      const result = parseTeslaCamPath('MyDashcam/2025-01-15_12-30-00-front.mp4');
      expect(result.tag).toBe('MyDashcam');
      expect(result.rest).toEqual(['2025-01-15_12-30-00-front.mp4']);
    });
  });

  describe('parseClipFilename', () => {
    test('parses standard Tesla filename', () => {
      const result = parseClipFilename('2025-01-15_12-30-00-front.mp4');
      expect(result).not.toBeNull();
      expect(result.timestampKey).toBe('2025-01-15_12-30-00');
      expect(result.camera).toBe('front');
    });

    test('parses back camera', () => {
      const result = parseClipFilename('2025-01-15_12-30-00-back.mp4');
      expect(result.camera).toBe('back');
    });

    test('parses left_repeater camera', () => {
      const result = parseClipFilename('2025-01-15_12-30-00-left_repeater.mp4');
      expect(result.camera).toBe('left_repeater');
    });

    test('parses right_repeater camera', () => {
      const result = parseClipFilename('2025-01-15_12-30-00-right_repeater.mp4');
      expect(result.camera).toBe('right_repeater');
    });

    test('parses pillar cameras', () => {
      const left = parseClipFilename('2025-01-15_12-30-00-left_pillar.mp4');
      expect(left.camera).toBe('left_pillar');

      const right = parseClipFilename('2025-01-15_12-30-00-right_pillar.mp4');
      expect(right.camera).toBe('right_pillar');
    });

    test('returns null for non-mp4 files', () => {
      expect(parseClipFilename('photo.jpg')).toBeNull();
      expect(parseClipFilename('data.json')).toBeNull();
    });

    test('returns null for event.mp4', () => {
      expect(parseClipFilename('event.mp4')).toBeNull();
    });

    test('returns null for malformed filenames', () => {
      expect(parseClipFilename('random-file.mp4')).toBeNull();
      expect(parseClipFilename('no-date.mp4')).toBeNull();
    });

    test('is case-insensitive for extension', () => {
      const result = parseClipFilename('2025-01-15_12-30-00-front.MP4');
      expect(result).not.toBeNull();
      expect(result.camera).toBe('front');
    });
  });

  describe('normalizeCamera', () => {
    test('normalizes standard camera names', () => {
      expect(normalizeCamera('front')).toBe('front');
      expect(normalizeCamera('back')).toBe('back');
      expect(normalizeCamera('left_repeater')).toBe('left_repeater');
      expect(normalizeCamera('right_repeater')).toBe('right_repeater');
    });

    test('normalizes short forms', () => {
      expect(normalizeCamera('left')).toBe('left_repeater');
      expect(normalizeCamera('right')).toBe('right_repeater');
    });

    test('normalizes pillar cameras', () => {
      expect(normalizeCamera('left_pillar')).toBe('left_pillar');
      expect(normalizeCamera('right_pillar')).toBe('right_pillar');
    });

    test('is case-insensitive', () => {
      expect(normalizeCamera('FRONT')).toBe('front');
      expect(normalizeCamera('Back')).toBe('back');
      expect(normalizeCamera('LEFT_REPEATER')).toBe('left_repeater');
    });

    test('returns unknown for empty/null input', () => {
      expect(normalizeCamera('')).toBe('unknown');
      expect(normalizeCamera(null)).toBe('unknown');
      expect(normalizeCamera(undefined)).toBe('unknown');
    });

    test('passes through unrecognized camera names', () => {
      expect(normalizeCamera('cabin')).toBe('cabin');
      expect(normalizeCamera('side')).toBe('side');
    });
  });

  describe('getRootFolderNameFromWebkitRelativePath', () => {
    test('extracts root folder from webkit path', () => {
      expect(getRootFolderNameFromWebkitRelativePath('TeslaCam/RecentClips/file.mp4')).toBe('TeslaCam');
    });

    test('returns single segment for flat path', () => {
      expect(getRootFolderNameFromWebkitRelativePath('file.mp4')).toBe('file.mp4');
    });

    test('returns null for empty/null input', () => {
      expect(getRootFolderNameFromWebkitRelativePath('')).toBeNull();
      expect(getRootFolderNameFromWebkitRelativePath(null)).toBeNull();
      expect(getRootFolderNameFromWebkitRelativePath(undefined)).toBeNull();
    });
  });

  describe('getBestEffortRelPath', () => {
    test('prefers webkitRelativePath', () => {
      const file = { name: 'clip.mp4', webkitRelativePath: 'TeslaCam/clip.mp4' };
      expect(getBestEffortRelPath(file)).toBe('TeslaCam/clip.mp4');
    });

    test('falls back to _teslaPath', () => {
      const file = { name: 'clip.mp4', _teslaPath: '/TeslaCam/RecentClips/clip.mp4' };
      expect(getBestEffortRelPath(file)).toBe('TeslaCam/RecentClips/clip.mp4');
    });

    test('strips leading slash from _teslaPath', () => {
      const file = { name: 'clip.mp4', _teslaPath: '/TeslaCam/clip.mp4' };
      expect(getBestEffortRelPath(file)).toBe('TeslaCam/clip.mp4');
    });

    test('constructs path from directoryName and filename', () => {
      const file = { name: 'clip.mp4' };
      expect(getBestEffortRelPath(file, 'TeslaCam')).toBe('TeslaCam/clip.mp4');
    });

    test('returns just filename as last resort', () => {
      const file = { name: 'clip.mp4' };
      expect(getBestEffortRelPath(file)).toBe('clip.mp4');
    });
  });
});
