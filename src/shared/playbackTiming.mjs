import { getDashcamProfile } from './dashcamProfiles.mjs';

export function createInitialSegmentDurations(count, profileId) {
  const fallback = getDashcamProfile(profileId).defaultSegmentDurationSeconds;
  return new Array(Math.max(0, Number(count) || 0)).fill(fallback);
}

export async function resolveSegmentDurations(groups, options = {}) {
  const items = Array.isArray(groups) ? groups : [];
  const fallback = getDashcamProfile(options.profileId)
    .defaultSegmentDurationSeconds;
  const probe = options.probe;
  const concurrency = Math.max(
    1,
    Math.min(items.length || 1, Number(options.concurrency) || 4)
  );
  const results = new Array(items.length).fill(fallback);
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < items.length) {
      const index = nextIndex++;
      try {
        const duration = await probe(items[index], index);
        if (Number.isFinite(duration) && duration > 0) {
          results[index] = duration;
        }
      } catch {
        results[index] = fallback;
      }
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  return results;
}
