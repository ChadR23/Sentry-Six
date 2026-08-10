/**
 * Tests for the update channel in src/main/autoUpdate.js.
 *
 * The channel decides two things that must never disagree: which GitHub branch
 * the raw-file paths read (version.json, changelog, dev-install zip) and which
 * release feed electron-updater points at. It also has to keep faith with the
 * legacy `updateBranch` setting written by the dropdown that shipped until the
 * 2026.6.11 UI overhaul removed it.
 */

jest.mock('electron');
jest.mock('electron-updater', () => ({
  autoUpdater: {
    setFeedURL: jest.fn(),
    allowPrerelease: false,
    allowDowngrade: false
  }
}));

const { autoUpdater } = require('electron-updater');
const {
  UPDATE_CONFIG,
  UPDATE_CHANNELS,
  applyUpdateChannel,
  resolveUpdateChannel
} = require('../../src/main/autoUpdate');

beforeEach(() => {
  autoUpdater.setFeedURL.mockClear();
  autoUpdater.allowPrerelease = false;
  autoUpdater.allowDowngrade = false;
});

describe('resolveUpdateChannel', () => {
  test('defaults to stable when nothing is configured', () => {
    expect(resolveUpdateChannel({}).id).toBe('stable');
    expect(resolveUpdateChannel(undefined).id).toBe('stable');
  });

  test('honours an explicit channel', () => {
    const channel = resolveUpdateChannel({ updateChannel: 'prerelease' });

    expect(channel.id).toBe('prerelease');
    expect(channel.branch).toBe('Dev-SEI');
    expect(channel.releaseType).toBe('prerelease');
  });

  test('stable channel tracks the default branch', () => {
    const channel = resolveUpdateChannel({ updateChannel: 'stable' });

    expect(channel.branch).toBe(UPDATE_CONFIG.defaultBranch);
    expect(channel.releaseType).toBe('release');
  });

  test('falls back to stable for an unknown channel id', () => {
    expect(resolveUpdateChannel({ updateChannel: 'nightly' }).id).toBe('stable');
  });

  // Anyone who picked Dev-SEI in the old dropdown still has updateBranch set and
  // no updateChannel — they must stay on pre-releases, not be moved to stable.
  test('migrates a legacy non-default updateBranch to the prerelease channel', () => {
    expect(resolveUpdateChannel({ updateBranch: 'Dev-SEI' }).id).toBe('prerelease');
  });

  test('treats a legacy main updateBranch as stable', () => {
    expect(resolveUpdateChannel({ updateBranch: 'main' }).id).toBe('stable');
  });

  test('an explicit channel wins over a stale legacy branch', () => {
    const settings = { updateChannel: 'stable', updateBranch: 'Dev-SEI' };

    expect(resolveUpdateChannel(settings).id).toBe('stable');
  });
});

describe('applyUpdateChannel', () => {
  test('points the feed at published releases on stable', () => {
    applyUpdateChannel(UPDATE_CHANNELS.stable, '2026.32.34');

    expect(autoUpdater.allowPrerelease).toBe(false);
    expect(autoUpdater.setFeedURL).toHaveBeenCalledWith({
      provider: 'github',
      owner: UPDATE_CONFIG.owner,
      repo: UPDATE_CONFIG.repo,
      releaseType: 'release'
    });
  });

  test('does not allow downgrades for a stable build on stable', () => {
    applyUpdateChannel(UPDATE_CHANNELS.stable, '2026.32.34');

    expect(autoUpdater.allowDowngrade).toBe(false);
  });

  // An RC sorts below the stable release it precedes, so the pre-release
  // channel can only install anything if downgrades are permitted.
  test('allows prereleases and downgrades on the prerelease channel', () => {
    applyUpdateChannel(UPDATE_CHANNELS.prerelease, '2026.32.34');

    expect(autoUpdater.allowPrerelease).toBe(true);
    expect(autoUpdater.allowDowngrade).toBe(true);
    expect(autoUpdater.setFeedURL).toHaveBeenCalledWith({
      provider: 'github',
      owner: UPDATE_CONFIG.owner,
      repo: UPDATE_CONFIG.repo,
      releaseType: 'prerelease'
    });
  });

  // Switching back to stable from an RC means moving *down* to the newest
  // stable build, which is still a downgrade.
  test('allows a downgrade back to stable when the running build is an RC', () => {
    applyUpdateChannel(UPDATE_CHANNELS.stable, '2026.32.35-rc1');

    expect(autoUpdater.allowPrerelease).toBe(false);
    expect(autoUpdater.allowDowngrade).toBe(true);
  });

  test('returns the channel it applied', () => {
    expect(applyUpdateChannel(UPDATE_CHANNELS.prerelease, '2026.32.34'))
      .toBe(UPDATE_CHANNELS.prerelease);
  });
});
