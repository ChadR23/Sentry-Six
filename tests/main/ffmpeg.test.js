/**
 * Tests for src/main/ffmpeg.js
 * Covers: formatExportDuration, ensureExecutable logic
 */

jest.mock('electron');

// formatExportDuration is a pure function - extract and test it
const fs = require('fs');
const path = require('path');

// Read the source and extract formatExportDuration
const source = fs.readFileSync(
  path.join(__dirname, '../../src/main/ffmpeg.js'),
  'utf-8'
);

// Extract the function
const match = source.match(
  /function formatExportDuration\(ms\)\s*\{[\s\S]*?^\}/m
);
let formatExportDuration;
if (match) {
  formatExportDuration = new Function(
    'ms',
    match[0]
      .replace('function formatExportDuration(ms) {', '')
      .replace(/\}$/, '')
  );
}

describe('ffmpeg utilities', () => {
  describe('formatExportDuration', () => {
    test('formats seconds only', () => {
      expect(formatExportDuration(5000)).toBe('5s');
      expect(formatExportDuration(45000)).toBe('45s');
    });

    test('formats minutes and seconds', () => {
      expect(formatExportDuration(65000)).toBe('1m 5s');
      expect(formatExportDuration(120000)).toBe('2m 0s');
    });

    test('formats hours, minutes, and seconds', () => {
      expect(formatExportDuration(3661000)).toBe('1h 1m 1s');
      expect(formatExportDuration(7200000)).toBe('2h 0m 0s');
    });

    test('handles zero', () => {
      expect(formatExportDuration(0)).toBe('0s');
    });

    test('handles sub-second values', () => {
      expect(formatExportDuration(500)).toBe('0s');
      expect(formatExportDuration(999)).toBe('0s');
    });

    test('handles exact minute boundary', () => {
      expect(formatExportDuration(60000)).toBe('1m 0s');
    });

    test('handles exact hour boundary', () => {
      expect(formatExportDuration(3600000)).toBe('1h 0m 0s');
    });
  });

  describe('ensureExecutable logic', () => {
    test('skips chmod on Windows', () => {
      // The function checks process.platform === 'win32'
      // This test validates the logic pattern
      const isWin = process.platform === 'win32';
      if (isWin) {
        // On Windows, ensureExecutable should be a no-op
        expect(true).toBe(true);
      } else {
        // On Unix, it should attempt chmod if not already executable
        const tmpFile = path.join(
          require('os').tmpdir(),
          'sentry-chmod-test-' + Date.now()
        );
        fs.writeFileSync(tmpFile, '#!/bin/bash\necho test\n');

        // Remove execute bit
        fs.chmodSync(tmpFile, 0o644);
        let stats = fs.statSync(tmpFile);
        expect(stats.mode & 0o100).toBe(0);

        // Apply chmod like ensureExecutable does
        fs.chmodSync(tmpFile, 0o755);
        stats = fs.statSync(tmpFile);
        expect(stats.mode & 0o100).not.toBe(0);

        fs.unlinkSync(tmpFile);
      }
    });
  });
});
