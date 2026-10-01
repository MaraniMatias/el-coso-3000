/**
 * Video encoder tests.
 *
 * Bun has no `VideoEncoder`, canvas, or `showSaveFilePicker`, so the part of
 * `exportVideo` from `output.start()` to `finalize()` cannot be exercised here.
 * What is tested is everything around it and everything it decides: which
 * container and codec each format uses, frame arithmetic, keyframes, progress
 * and ETA, the limits and their messages, metadata, and the encoding loop with
 * fake `drawFrame` and `source.add` calls.
 *
 * Run: `bun test`
 */

import { describe, expect, test } from 'bun:test';

import { filenameForSpec, mimeFor } from '../src/core/filename';
import { APP_NAME, AUTHOR, REPO_URL, VIDEO_FORMATS, type Spec } from '../src/core/types';
import {
  MAX_TOTAL_FRAMES,
  MAX_VIDEO_DIMENSION,
  NO_ENCODER_MESSAGE,
  VIDEO_FORMATS_TABLE,
  availableVideoFormats,
  encodeFrames,
  exportVideo,
  formatEta,
  isVideoExportSupported,
  keyFrameEvery,
  outputFormatFor,
  planExport,
  progressInfo,
  resolveAudioCodec,
  totalFramesFor,
  videoMetadataTags,
  type FrameSink,
} from '../src/encoders/video';

// ── Helpers ────────────────────────────────────────────────────────────────

const spec = (over: Partial<Spec> = {}): Spec => ({
  width: 1920,
  height: 1080,
  bg: 'FFE4E4',
  fg: '5A2A2A',
  paletteName: 'rose',
  duration: 5,
  fps: 30,
  showProgressBar: true,
  showTime: true,
  transparent: false,
  quality: 0.92,
  ...over,
});

/** Error message from the thrown value, or `null` if nothing was thrown. */
function errorOf(fn: () => unknown): string | null {
  try {
    fn();
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

const close = (a: number, b: number) => Math.abs(a - b) < 1e-9;

// ── Containers ────────────────────────────────────────────────────────────

describe('container table', () => {
  test('each format uses its corresponding mediabunny class', () => {
    expect(outputFormatFor('mp4').constructor.name).toBe('Mp4OutputFormat');
    expect(outputFormatFor('mov').constructor.name).toBe('MovOutputFormat');
    expect(outputFormatFor('webm').constructor.name).toBe('WebMOutputFormat');
    expect(outputFormatFor('mkv').constructor.name).toBe('MkvOutputFormat');
  });

  test('the table lists the same class name that is produced', () => {
    for (const format of VIDEO_FORMATS) {
      expect(VIDEO_FORMATS_TABLE[format].container).toBe(outputFormatFor(format).constructor.name);
    }
  });

  test('the table covers exactly the core formats', () => {
    expect(Object.keys(VIDEO_FORMATS_TABLE).sort()).toEqual([...VIDEO_FORMATS].sort());
  });

  test('extension and MIME type for each container', () => {
    const expected = {
      mp4: ['.mp4', 'video/mp4'],
      mov: ['.mov', 'video/quicktime'],
      webm: ['.webm', 'video/webm'],
      mkv: ['.mkv', 'video/x-matroska'],
    } as const;
    for (const format of VIDEO_FORMATS) {
      const [extension, mime] = expected[format];
      expect(outputFormatFor(format).fileExtension).toBe(extension);
      expect(outputFormatFor(format).mimeType).toBe(mime);
      expect(mimeFor(format, true)).not.toBe('');
    }
  });
});

describe('codec preference', () => {
  const expectedCodecs = {
    mp4: 'avc,av1,vp9',
    mov: 'avc,av1,vp9',
    webm: 'vp9,vp8',
    mkv: 'vp9,vp8,av1',
  } as const;

  test('the preference order matches the container', () => {
    for (const format of VIDEO_FORMATS) {
      expect(VIDEO_FORMATS_TABLE[format].codecs.join()).toBe(expectedCodecs[format]);
    }
  });

  // If a preferred codec is not accepted by the container, the container
  // filter removes it before it reaches the muxer, which would otherwise throw
  // midway through encoding with an error that gives no context.
  test('no preferred codec is unsupported by its container', () => {
    for (const format of VIDEO_FORMATS) {
      const supported = outputFormatFor(format).getSupportedVideoCodecs();
      expect(VIDEO_FORMATS_TABLE[format].codecs.filter((codec) => !supported.includes(codec))).toEqual([]);
    }
  });

  test('the filter has something to filter: webm rejects avc, mp4 accepts it', () => {
    expect(outputFormatFor('webm').getSupportedVideoCodecs()).not.toContain('avc');
    expect(outputFormatFor('mp4').getSupportedVideoCodecs()[0]).toBe('avc');
  });
});

describe('audio codec preference', () => {
  const expectedCodecs = {
    mp4: 'aac,opus',
    mov: 'aac,opus',
    webm: 'opus,vorbis',
    mkv: 'opus,aac,vorbis',
  } as const;

  test('the preference order matches the container', () => {
    for (const format of VIDEO_FORMATS) {
      expect(VIDEO_FORMATS_TABLE[format].audioCodecs.join()).toBe(expectedCodecs[format]);
    }
  });

  // Same reason as the video codecs: a preferred audio codec the container
  // rejects would be filtered out, leaving nothing to encode with.
  test('no preferred audio codec is unsupported by its container', () => {
    for (const format of VIDEO_FORMATS) {
      const supported = outputFormatFor(format).getSupportedAudioCodecs();
      expect(VIDEO_FORMATS_TABLE[format].audioCodecs.filter((codec) => !supported.includes(codec))).toEqual([]);
    }
  });

  test('the filter has something to filter: webm rejects aac, mp4 accepts it', () => {
    expect(outputFormatFor('webm').getSupportedAudioCodecs()).not.toContain('aac');
    expect(outputFormatFor('mp4').getSupportedAudioCodecs()).toContain('aac');
  });

  // Without WebCodecs there is nothing to resolve, and the export has to say so
  // before it starts drawing instead of failing once it is half encoded.
  test('a browser with no AudioEncoder cannot resolve one', async () => {
    expect(isVideoExportSupported()).toBe(false);
    expect(await resolveAudioCodec('mp4')).toBeNull();
  });
});

// ── Arithmetic ────────────────────────────────────────────────────────────

describe('totalFrames = max(1, round(duration * fps))', () => {
  test.each([
    [5, 30, 150],
    [0.5, 1, 1],
    [10, 60, 600],
    [0, 30, 1],
    [3.7, 24, 89],
    [1, 1, 1],
    [2.5, 25, 63],
  ])('%ss at %ifps → %i frames', (duration, fps, expected) => {
    expect(totalFramesFor(duration, fps)).toBe(expected);
  });

  test('5s at 30fps is NOT 5 * 60 (the classic ETA mistake)', () => {
    expect(totalFramesFor(5, 30)).not.toBe(5 * 60);
    expect(totalFramesFor(5, 30)).toBe(150);
  });
});

describe('keyEvery = max(1, round(fps * 2))', () => {
  test.each([
    [30, 60],
    [24, 48],
    [60, 120],
    [1, 2],
    [0.4, 1],
    [0, 1],
  ])('%ifs → keyframe every %i frames', (fps, expected) => {
    expect(keyFrameEvery(fps)).toBe(expected);
  });
});

// ── Plan ───────────────────────────────────────────────────────────────────

describe('planExport', () => {
  test('rounds dimensions up to even numbers and keeps the Spec dimensions accurate', () => {
    const plan = planExport(spec({ width: 641, height: 361 }));
    expect([plan.width, plan.height]).toEqual([642, 362]);
    expect([plan.spec.width, plan.spec.height]).toEqual([642, 362]);
    // Rounding must not change the frame count.
    expect(plan.totalFrames).toBe(150);
  });

  test('the filename uses the actual dimensions', () => {
    expect(filenameForSpec(planExport(spec({ width: 641, height: 361 })).spec, 'mp4')).toBe('642x362-30fps-5s.mp4');
    expect(filenameForSpec(planExport(spec({ width: 641, height: 361 })).spec, 'webm')).toBe('642x362-30fps-5s.webm');
    expect(filenameForSpec(planExport(spec()).spec, 'mov')).toBe('1920x1080-30fps-5s.mov');
  });

  test('keeps dimensions that are already even', () => {
    const plan = planExport(spec());
    expect([plan.width, plan.height]).toEqual([1920, 1080]);
    expect(plan.totalFrames).toBe(150);
    expect(plan.keyEvery).toBe(60);
    expect(plan.frameDuration).toBe(1 / 30);
  });

  test('a short duration at low fps gives one frame, never zero', () => {
    expect(planExport(spec({ duration: 0.5, fps: 1 })).totalFrames).toBe(1);
  });
});

describe('limits: reject with a message, never silently', () => {
  test(`more than ${MAX_VIDEO_DIMENSION} px on either side`, () => {
    const message = errorOf(() => planExport(spec({ width: 7680, height: 4320 })));
    expect(message).toContain(String(MAX_VIDEO_DIMENSION));
    expect(message).toContain('7680x4320');
  });

  test('the limit applies to either side, not just the width', () => {
    expect(errorOf(() => planExport(spec({ width: 1920, height: 5000 })))).toContain(String(MAX_VIDEO_DIMENSION));
  });

  test(`exactly at the limit is allowed`, () => {
    expect(errorOf(() => planExport(spec({ width: MAX_VIDEO_DIMENSION, height: MAX_VIDEO_DIMENSION, duration: 0.1, fps: 1 })))).toBeNull();
  });

  test(`more than ${MAX_TOTAL_FRAMES} frames reports how many there would be`, () => {
    const message = errorOf(() => planExport(spec({ duration: 61, fps: 60 })));
    expect(message).toContain('3660');
    expect(message).toContain(String(MAX_TOTAL_FRAMES));
  });

  test('the frame limit is allowed exactly at both tested frame rates', () => {
    expect(errorOf(() => planExport(spec({ duration: 60, fps: 60 })))).toBeNull();
    expect(errorOf(() => planExport(spec({ duration: 60, fps: 30 })))).toBeNull();
  });

  test.each([
    ['fps 0', { fps: 0 }],
    ['negative fps', { fps: -30 }],
    ['NaN duration', { duration: Number.NaN }],
    ['negative duration', { duration: -1 }],
  ])('%s is rejected', (_label, over) => {
    expect(errorOf(() => planExport(spec(over)))).not.toBeNull();
  });
});

// ── Browser support ───────────────────────────────────────────────────────

describe('capability detection (Bun has no WebCodecs)', () => {
  test('isVideoExportSupported() is false and does not throw', () => {
    expect(isVideoExportSupported()).toBe(false);
  });

  test('the message says what is missing and where it is unavailable', () => {
    expect(NO_ENCODER_MESSAGE).toContain('WebCodecs');
    expect(NO_ENCODER_MESSAGE).toContain('Firefox');
    expect(NO_ENCODER_MESSAGE).toContain('Android');
  });

  test('availableVideoFormats() returns [] without codecs and does not throw', async () => {
    expect(await availableVideoFormats(1920, 1080)).toEqual([]);
  });

  test('the result is cached by dimensions', async () => {
    const first = availableVideoFormats(1280, 720);
    expect(await availableVideoFormats(1280, 720)).toBe(await first);
    expect(await availableVideoFormats(641, 361)).not.toBe(await first);
  });

  test('exportVideo stops before doing anything if WebCodecs is unavailable', async () => {
    expect(exportVideo(spec(), 'mp4')).rejects.toThrow(NO_ENCODER_MESSAGE);
  });
});

// ── Progress and ETA ──────────────────────────────────────────────────────

describe('formatEta', () => {
  test.each([
    [0, 'less than 1 s'],
    [0.2, 'less than 1 s'],
    [0.5, 'less than 1 s'],
    [1, '1 s'],
    [3.4, '3 s'],
    [59.4, '59 s'],
    [59.6, '1 min 0 s'],
    [60, '1 min 0 s'],
    [125.4, '2 min 5 s'],
  ])('formatEta(%is) returns the expected ETA', (seconds, expected) => {
    expect(formatEta(seconds)).toBe(expected);
  });

  test('never writes "min 60 s"', () => {
    expect(formatEta(119.6)).not.toContain('60 s');
  });
});

describe('progressInfo', () => {
  const plan = planExport(spec({ duration: 5, fps: 30 }));

  test('all ticks report progress in 0..1 and are consistent', () => {
    for (let done = 0; done <= plan.totalFrames; done++) {
      const info = progressInfo(plan, done, done * 0.01);
      expect(info.progress).toBeGreaterThanOrEqual(0);
      expect(info.progress).toBeLessThanOrEqual(1);
      expect(info.frame).toBe(done);
      expect(info.totalFrames).toBe(plan.totalFrames);
    }
  });

  test('the first is 0 and the last is 1, with all 150 frames accounted for', () => {
    expect(progressInfo(plan, 0, 0).progress).toBe(0);
    const last = progressInfo(plan, plan.totalFrames, 20);
    expect(last.progress).toBe(1);
    expect(last.frame).toBe(150);
    expect(last.totalFrames).toBe(150);
  });

  test('progress never goes backward', () => {
    let previous = 0;
    for (let done = 0; done <= plan.totalFrames; done++) {
      const { progress } = progressInfo(plan, done, done * 0.01);
      expect(progress).toBeGreaterThanOrEqual(previous);
      previous = progress;
    }
  });

  test('`done` is clamped when out of range', () => {
    expect(progressInfo(plan, -5, 0).progress).toBe(0);
    expect(progressInfo(plan, -5, 0).frame).toBe(0);
    expect(progressInfo(plan, 9999, 0).progress).toBe(1);
    expect(progressInfo(plan, 9999, 0).frame).toBe(150);
  });

  test('the message includes frame/total and never contains NaN', () => {
    expect(progressInfo(plan, 120, 1.2).message).toContain('120/150');
    const messages = Array.from({ length: 151 }, (_, done) => progressInfo(plan, done, done * 0.01).message ?? '');
    expect(messages.join('|')).not.toMatch(/NaN|Infinity/);
  });

  // ETA is based on measured frames, not `duration * 60`. With 150 frames and
  // one real second per frame, after the first frame 149 seconds remain, not 299.
  test('ETA is measured in frames, not wall-clock seconds', () => {
    expect(progressInfo(plan, 1, 1).message).toContain('~2 min 29 s left');
    expect(progressInfo(plan, 75, 15).message).toContain('~15 s left');
  });

  test('no ETA is invented without measured frames, and none remains at the end', () => {
    expect(progressInfo(plan, 0, 0).message).not.toContain('faltan');
    expect(progressInfo(plan, plan.totalFrames, 20).message).not.toContain('faltan');
  });
});

// ── Metadata ──────────────────────────────────────────────────────────────

describe('video metadata', () => {
  const tags = videoMetadataTags(planExport(spec({ width: 641, height: 361 })).spec);

  test('normalized fields come from buildMetadata with the actual dimensions', () => {
    expect(tags.title).toBe('Placeholder 642x362');
    expect(tags.description).toContain('Placeholder 642x362');
    // The artist is the person, not the tool: `Software` already covers the app.
    expect(tags.artist).toBe(AUTHOR);
  });

  test('raw contains Software and Source', () => {
    expect(tags.raw?.Software).toBe(APP_NAME);
    expect(tags.raw?.Source).toBe(REPO_URL);
  });

  // The ISOBMFF muxer drops `raw` keys longer than 4 characters, so the full
  // block goes in `comment`, which all four containers preserve.
  test('comment contains the full block, including Software and Source', () => {
    expect(tags.comment).toContain(`Software: ${APP_NAME}`);
    expect(tags.comment).toContain(`Source: ${REPO_URL}`);
  });
});

// ── Encoding loop ─────────────────────────────────────────────────────────

interface Recorded {
  drawn: number[];
  added: Array<{ timestamp: number; duration: number; keyFrame: boolean }>;
  progress: Array<{ frame?: number; progress: number }>;
}

/** Fake sink: counts instead of drawing and encoding. */
function recordingSink(onAdd?: (index: number) => void): FrameSink & { log: Recorded } {
  const log: Recorded = { drawn: [], added: [], progress: [] };
  return {
    log,
    draw: (progress) => {
      log.drawn.push(progress);
    },
    add: async (timestamp, duration, keyFrame) => {
      log.added.push({ timestamp, duration, keyFrame });
      onAdd?.(log.added.length - 1);
    },
  };
}

const loopPlan = () => planExport(spec({ duration: 5, fps: 30 }));

describe('encoding loop', () => {
  test('5s at 30fps: 150 frames drawn and enqueued', async () => {
    const run = recordingSink();
    await encodeFrames(loopPlan(), run);
    expect(run.log.drawn).toHaveLength(150);
    expect(run.log.added).toHaveLength(150);
  });

  test('frame i is drawn with its own progress and timestamp i/30s', async () => {
    const run = recordingSink();
    await encodeFrames(loopPlan(), run);
    // The first frame draws the empty progress bar, like the still image.
    expect(run.log.drawn[0]).toBe(0);
    expect(run.log.drawn.every((progress, i) => close(progress, i / 150))).toBe(true);
    expect(run.log.added.every((a, i) => close(a.timestamp, i / 30) && close(a.duration, 1 / 30))).toBe(true);
    // The last frame starts at 4.9667s, not 5s: timestamps belong to the frame,
    // not to the end of the video.
    expect(run.log.added[149]?.timestamp).toBe(149 / 30);
  });

  test('keyframes every 2 seconds of wall-clock time for scrubbing', async () => {
    const run = recordingSink();
    await encodeFrames(loopPlan(), run);
    expect(run.log.added.filter((a) => a.keyFrame).map((a) => a.timestamp)).toEqual([0, 2, 4]);
    expect(run.log.added.map((a) => a.keyFrame)).toEqual(
      Array.from({ length: 150 }, (_, i) => i % 60 === 0),
    );
  });

  test('one progress tick per frame, with the last ending at 1', async () => {
    const run = recordingSink();
    await encodeFrames(loopPlan(), run, (info) => run.log.progress.push(info));
    expect(run.log.progress).toHaveLength(150);
    expect(run.log.progress.every((p, i) => p.frame === i + 1)).toBe(true);
    expect(run.log.progress.at(-1)?.progress).toBe(1);
  });

  test('0.5s at 1fps is a single frame, and it is also a keyframe', async () => {
    const run = recordingSink();
    await encodeFrames(planExport(spec({ duration: 0.5, fps: 1 })), run);
    expect(run.log.added).toEqual([{ timestamp: 0, duration: 1, keyFrame: true }]);
  });
});

describe('encoding loop: cancellation', () => {
  test('with an already-aborted signal, nothing is drawn', async () => {
    const controller = new AbortController();
    controller.abort();
    const run = recordingSink();
    expect(encodeFrames(loopPlan(), run, undefined, controller.signal)).rejects.toThrow(
      expect.objectContaining({ name: 'AbortError' }),
    );
    expect(run.log.drawn).toHaveLength(0);
    expect(run.log.added).toHaveLength(0);
  });

  test.each([0, 41, 100])('cancelling at frame %i stops there', async (stopAt) => {
    const controller = new AbortController();
    const run = recordingSink((index) => {
      if (index === stopAt) controller.abort();
    });

    expect(encodeFrames(loopPlan(), run, undefined, controller.signal)).rejects.toThrow(
      expect.objectContaining({ name: 'AbortError' }),
    );
    expect(run.log.added).toHaveLength(stopAt + 1);
    expect(run.log.drawn).toHaveLength(stopAt + 1);
    expect(run.log.added.every((a, i) => close(a.timestamp, i / 30))).toBe(true);
  });

  test('aborting on the last frame is not a cancellation: nothing remains', async () => {
    const controller = new AbortController();
    const plan = loopPlan();
    const run = recordingSink((index) => {
      if (index === plan.totalFrames - 1) controller.abort();
    });

    await encodeFrames(plan, run, undefined, controller.signal);
    expect(run.log.added).toHaveLength(150);
  });
});

describe('encoding loop: backpressure', () => {
  test('there are never two `add` calls in flight: `await` serializes them', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const seen: number[] = [];
    const slow: FrameSink = {
      draw: () => {},
      add: async (timestamp) => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        seen.push(timestamp);
        await Promise.resolve();
        inFlight -= 1;
      },
    };

    await encodeFrames(loopPlan(), slow);
    expect(seen).toHaveLength(150);
    expect(maxInFlight).toBe(1);
  });
});
