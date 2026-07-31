import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createInitialSegmentDurations,
  resolveSegmentDurations
} from '../../src/shared/playbackTiming.mjs';

test('uses profile-specific duration estimates before metadata is available', () => {
  assert.deepEqual(createInitialSegmentDurations(3, 'tesla'), [60, 60, 60]);
  assert.deepEqual(
    createInitialSegmentDurations(3, 'gm_surroundvision'),
    [300, 300, 300]
  );
});

test('keeps mixed one-minute and five-minute metadata durations exactly', async () => {
  const groups = [{ duration: 60 }, { duration: 300 }, { duration: 75.5 }];
  const durations = await resolveSegmentDurations(groups, {
    profileId: 'gm_surroundvision',
    probe: async group => group.duration,
    concurrency: 2
  });

  assert.deepEqual(durations, [60, 300, 75.5]);
});

test('falls back per segment when metadata probing fails or is invalid', async () => {
  const groups = [{ result: 61 }, { result: NaN }, { error: true }];
  const durations = await resolveSegmentDurations(groups, {
    profileId: 'gm_surroundvision',
    probe: async group => {
      if (group.error) throw new Error('unreadable');
      return group.result;
    },
    concurrency: 2
  });

  assert.deepEqual(durations, [61, 300, 300]);
});

test('limits metadata probes to the requested concurrency', async () => {
  let active = 0;
  let peak = 0;
  const groups = Array.from({ length: 8 }, (_, index) => ({ index }));

  await resolveSegmentDurations(groups, {
    profileId: 'tesla',
    concurrency: 3,
    probe: async () => {
      active++;
      peak = Math.max(peak, active);
      await new Promise(resolve => setTimeout(resolve, 5));
      active--;
      return 60;
    }
  });

  assert.equal(peak, 3);
});
