/**
 * Test sound tests.
 *
 * The samples are plain math, so they are checked here without a browser, the
 * same way the frames are: the level, the timing of the beep, and the two
 * things that make a generated sound feel broken instead of quiet, which are a
 * click at either end and a track that differs between exports.
 *
 * Run: `bun test`
 */

import { describe, expect, test } from 'bun:test';

import {
  AUDIO_SAMPLE_RATE,
  TANGO_SAMPLE_RATE,
  soundShape,
  toneSamples,
  type TestTone,
} from '../src/core/audio';
import { DEFAULT_VIDEO_TONE, VIDEO_TONES, type VideoTone } from '../src/core/types';

/**
 * The tones that are plain math. The tango is not one of them: rendering it
 * needs Web Audio, so it is checked in a real browser instead.
 */
const TEST_TONES = VIDEO_TONES.filter((tone): tone is TestTone => tone !== 'tango');

const peak = (samples: Float32Array): number =>
  samples.reduce((max, value) => Math.max(max, Math.abs(value)), 0);

interface Burst {
  /** First sample that is not zero. */
  from: number;
  /** Last sample that is not zero. */
  to: number;
  /** Length in seconds. */
  seconds: number;
}

/**
 * Contiguous runs of samples that are not exactly zero. The loop runs one step
 * past the end so a burst that reaches the last sample is closed too.
 */
function bursts(samples: Float32Array): Burst[] {
  const runs: Burst[] = [];
  let from = -1;
  for (let i = 0; i <= samples.length; i++) {
    const sounding = i < samples.length && samples[i] !== 0;
    if (sounding && from < 0) from = i;
    if (!sounding && from >= 0) {
      runs.push({ from, to: i - 1, seconds: (i - from) / AUDIO_SAMPLE_RATE });
      from = -1;
    }
  }
  return runs;
}

/** The first burst, or a failure that names what was expected. */
function firstBurst(samples: Float32Array): Burst {
  const first = bursts(samples)[0];
  if (!first) throw new Error('the track has no burst of sound in it');
  return first;
}

describe('length', () => {
  test('one sample per step at 48 kHz', () => {
    expect(toneSamples('beep', 5).length).toBe(5 * AUDIO_SAMPLE_RATE);
    expect(toneSamples('beep', 0.5, 8000).length).toBe(4000);
  });

  test('a video with no time left produces no samples', () => {
    expect(toneSamples('beep', 0).length).toBe(0);
    expect(toneSamples('noise', -3).length).toBe(0);
  });
});

describe('level', () => {
  // -20 dBFS is where a test signal is aligned, and the tones that never stop
  // sit below it. A louder one would be a mistake, not a feature.
  test('the beep peaks at -20 dBFS', () => {
    const p = peak(toneSamples('beep', 3));
    expect(p).toBeGreaterThan(0.08);
    expect(p).toBeLessThanOrEqual(0.1);
  });

  test.each<TestTone>(['tone', 'noise'])('%s sits lower, because it never stops', (tone) => {
    const p = peak(toneSamples(tone, 3));
    expect(p).toBeGreaterThan(0.04);
    // The ceiling carries a tolerance: the peak lands in a `Float32Array`,
    // which cannot hold 0.05 exactly.
    expect(p).toBeLessThanOrEqual(0.05 + 1e-6);
  });

  test('no tone is louder than the beep, which is the one meant to be heard', () => {
    const beep = peak(toneSamples('beep', 3));
    for (const tone of TEST_TONES) {
      if (tone === 'beep') continue;
      expect(peak(toneSamples(tone, 3))).toBeLessThan(beep);
    }
  });
});

describe('no clicks', () => {
  // A waveform that starts or ends at full amplitude is an audible click in
  // every player, so the first and the last sample have to be at zero.
  test.each(TEST_TONES.map((tone) => [tone] as [TestTone]))('%s starts and ends at zero', (tone) => {
    const samples = toneSamples(tone, 3);
    expect(Math.abs(samples.at(0) ?? 0)).toBeLessThan(1e-4);
    expect(Math.abs(samples.at(-1) ?? 0)).toBeLessThan(1e-4);
  });

  test('a beep is silent at both of its edges', () => {
    const samples = toneSamples('beep', 3);
    const first = firstBurst(samples);
    // The window opens at zero, so the burst starts from nothing and the
    // sample before it is silence.
    expect(samples.at(first.from - 1)).toBe(0);
    expect(Math.abs(samples.at(first.from) ?? 0)).toBeLessThan(1e-4);
    expect(Math.abs(samples.at(first.to) ?? 0)).toBeLessThan(1e-4);
    expect(samples.at(first.to + 1)).toBe(0);
  });
});

describe('the beep', () => {
  const seconds = 3;
  const samples = toneSamples('beep', seconds);

  test('sounds once per second, for as long as the video', () => {
    expect(bursts(samples)).toHaveLength(seconds);
  });

  test('each burst is short, around 80 ms', () => {
    expect(firstBurst(samples).seconds).toBeGreaterThan(0.06);
    expect(firstBurst(samples).seconds).toBeLessThan(0.1);
  });

  test('the bursts start on the second', () => {
    bursts(samples).forEach((burst, index) => {
      expect(burst.from / AUDIO_SAMPLE_RATE).toBeCloseTo(index, 3);
    });
  });

  test('it is a 440 Hz sine: one zero crossing per cycle', () => {
    const first = firstBurst(samples);
    const burst = samples.slice(first.from, first.to + 1);
    let crossings = 0;
    for (let i = 1; i < burst.length; i++) {
      if ((burst[i - 1] ?? 0) <= 0 && (burst[i] ?? 0) > 0) crossings++;
    }
    const cycles = first.seconds * 440;
    expect(Math.abs(crossings - cycles)).toBeLessThanOrEqual(1);
  });

  test('the rest of the second is silence', () => {
    expect(samples.at(Math.round(0.5 * AUDIO_SAMPLE_RATE))).toBe(0);
  });
});

describe('the shape', () => {
  // The encoder is probed with this shape, and mediabunny configures the
  // encoder from the buffer it is handed, so the two have to be the same thing.
  test('the test tones are mono at 48 kHz', () => {
    for (const tone of TEST_TONES) {
      expect(soundShape(tone)).toEqual({ numberOfChannels: 1, sampleRate: AUDIO_SAMPLE_RATE });
    }
  });

  test('the tango is stereo at the rate it was rendered at', () => {
    expect(soundShape('tango')).toEqual({ numberOfChannels: 2, sampleRate: TANGO_SAMPLE_RATE });
  });
});

describe('the default', () => {
  // The picker lists the tones in the same order, so with the tango first the
  // select and this constant cannot drift apart.
  test('is the tango, and it comes first in the list the picker is built from', () => {
    expect(DEFAULT_VIDEO_TONE).toBe('tango');
    expect<string>(VIDEO_TONES[0]).toBe(DEFAULT_VIDEO_TONE);
  });
});

describe('the noise', () => {
  test('is the same on every export, so two files of the same video match', () => {
    expect(toneSamples('noise', 2)).toEqual(toneSamples('noise', 2));
  });

  test('changes over time instead of being one value', () => {
    const samples = toneSamples('noise', 1);
    expect(new Set(samples.slice(1, 100)).size).toBeGreaterThan(50);
  });
});
