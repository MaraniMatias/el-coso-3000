/**
 * Video exporter: MP4, MOV, WebM, and MKV.
 *
 * Everything uses the same `drawFrame` as images, so video and PNG cannot
 * diverge. The difference from image exporters is the codec, which brings two
 * things that do not exist in the other path: browser capabilities (WebCodecs)
 * and backpressure.
 *
 * Backpressure is the non-obvious part: `await source.add(...)` does NOT wait
 * for the frame's scheduled time; it waits until the encoder and muxer have
 * room for the next frame. The loop therefore runs at the machine's encoding
 * speed, not for `duration` seconds: a 10s video at 60fps has 600 frames and
 * takes however long the machine needs, not 10s. Waiting on the clock would
 * make each placeholder export take 10s for no benefit. Since `await` is the
 * only thing that pauses the loop, the codec stays consistent: frame N+1 is
 * never passed in before N has been consumed.
 *
 * ── What could NOT be exercised in Bun ─────────────────────────────────────
 * Bun has no `VideoEncoder`, `OffscreenCanvas`, or `showSaveFilePicker`.
 * That means the `exportVideo` path from `output.start()` through `finalize()`
 * has no automated coverage. Tests do cover (in `test/video.test.ts`) the
 * container and codec table, frame arithmetic, keyframes, progress and ETA,
 * limits, metadata, and the encoding loop with fake `drawFrame` and
 * `source.add` calls through `encodeFrames`, the only seam needed to exercise
 * it without a codec.
 */

import {
  BufferTarget,
  CanvasSource,
  MkvOutputFormat,
  MovOutputFormat,
  Mp4OutputFormat,
  Output,
  Quality,
  WebMOutputFormat,
  getFirstEncodableVideoCodec,
  type MetadataTags,
  type OutputFormat,
  type VideoCodec,
} from 'mediabunny';

import { drawFrame } from '../core/draw-frame';
import { evenDimensions, filenameForSpec, mimeFor } from '../core/filename';
import { buildMetadata, metadataAsText } from '../core/metadata';
import type { ExportResult, ProgressCallback, ProgressInfo, Spec, VideoFormat } from '../core/types';

// ── Limits ────────────────────────────────────────────────────────────────

/**
 * Per-side limit. 4096 is a comfortable limit for hardware encoders; beyond it,
 * video encoding is very slow or may fail. Do not silently crop: declare the
 * placeholder at its actual size.
 */
export const MAX_VIDEO_DIMENSION = 4096;

/**
 * Soft frame limit per export. 3600 frames are 60s at 60fps. This is a
 * placeholder; a ten-minute loop is unnecessary.
 */
export const MAX_TOTAL_FRAMES = 3600;

/**
 * Seconds between keyframes. This is mediabunny's default and allows scrubbing
 * the player bar without jumping by a second and a half. `keyFrameEvery` is
 * derived from this so the interval given to the codec and the one marked on
 * each frame do not drift apart.
 */
const KEY_FRAME_SECONDS = 2;

// ── Containers and codecs ─────────────────────────────────────────────────

export interface VideoFormatProfile {
  /** Human-readable label for the UI and messages. */
  label: string;
  /** Name of the mediabunny class that implements the container. */
  container: string;
  /** Creates the container. */
  createFormat: () => OutputFormat;
  /**
   * Codecs in preference order. Use the first one the browser can encode at
   * the requested dimensions. H.264 comes first in MP4/MOV because it opens
   * almost anywhere; VP9 comes first in WebM/MKV because it is native to those
   * containers.
   */
  codecs: readonly VideoCodec[];
}

export const VIDEO_FORMATS_TABLE: Record<VideoFormat, VideoFormatProfile> = {
  mp4: {
    label: 'MP4',
    container: 'Mp4OutputFormat',
    createFormat: () => new Mp4OutputFormat(),
    codecs: ['avc', 'av1', 'vp9'],
  },
  mov: {
    label: 'MOV',
    container: 'MovOutputFormat',
    createFormat: () => new MovOutputFormat(),
    codecs: ['avc', 'av1', 'vp9'],
  },
  webm: {
    label: 'WebM',
    container: 'WebMOutputFormat',
    createFormat: () => new WebMOutputFormat(),
    codecs: ['vp9', 'vp8'],
  },
  mkv: {
    label: 'MKV',
    container: 'MkvOutputFormat',
    createFormat: () => new MkvOutputFormat(),
    codecs: ['vp9', 'vp8', 'av1'],
  },
};

/** mediabunny container for a listed format. */
export function outputFormatFor(format: VideoFormat): OutputFormat {
  return VIDEO_FORMATS_TABLE[format].createFormat();
}

/**
 * Codec to export with, or `null` if the browser cannot use any at those
 * dimensions.
 *
 * Filter by container first on purpose: offering a codec that the muxer later
 * rejects turns an early, clear error into a late, cryptic one mid-encoding.
 */
async function resolveCodec(format: VideoFormat, width: number, height: number): Promise<VideoCodec | null> {
  const supported = new Set(outputFormatFor(format).getSupportedVideoCodecs());
  const wanted = VIDEO_FORMATS_TABLE[format].codecs.filter((codec) => supported.has(codec));
  if (wanted.length === 0) return null;
  return getFirstEncodableVideoCodec(wanted, { width, height });
}

// ── Browser support ───────────────────────────────────────────────────────

/**
 * Shown to the user when video cannot be exported. It must say what is missing
 * and where, since an offline app cannot infer it.
 */
export const NO_ENCODER_MESSAGE =
  'This browser cannot export video because it does not have WebCodecs (VideoEncoder), ' +
  'the only way to write video in the browser without a server. ' +
  'It is not implemented in Firefox for Android; it works in desktop Chrome, Edge, or Safari. ' +
  'In the meantime, you can export the placeholder as a still image or GIF.';

/** Can this browser encode video? Synchronous and side-effect free. */
export function isVideoExportSupported(): boolean {
  return 'VideoEncoder' in globalThis;
}

/**
 * Codec probing wraps `VideoEncoder.isConfigSupported` in a promise and is too
 * expensive to repeat on every UI keystroke. Cache by dimensions, the only
 * variable that changes the result.
 */
const supportCache = new Map<string, Promise<VideoFormat[]>>();

/**
 * Formats actually available here, in the core's `VIDEO_FORMATS` order. The UI
 * should check this before offering anything: exporting a format not in this
 * list will fail.
 */
export function availableVideoFormats(width: number, height: number): Promise<VideoFormat[]> {
  const key = `${width}x${height}`;
  const cached = supportCache.get(key);
  if (cached) return cached;

  const probing = probeFormats(width, height);
  supportCache.set(key, probing);
  return probing;
}

async function probeFormats(width: number, height: number): Promise<VideoFormat[]> {
  if (!isVideoExportSupported()) return [];
  const available: VideoFormat[] = [];
  for (const format of Object.keys(VIDEO_FORMATS_TABLE) as VideoFormat[]) {
    if (await resolveCodec(format, width, height)) available.push(format);
  }
  return available;
}

// ── Plan ───────────────────────────────────────────────────────────────────

export interface VideoPlan {
  /** The `Spec` with the actual dimensions used for drawing and naming. */
  spec: Spec;
  width: number;
  height: number;
  fps: number;
  /** `max(1, round(duration * fps))`. At 5s and 30fps, this is 150, not 300. */
  totalFrames: number;
  /** Duration of each frame, `1 / fps`. */
  frameDuration: number;
  /** Number of frames between keyframes. */
  keyEvery: number;
}

export function totalFramesFor(duration: number, fps: number): number {
  const product = (Number.isFinite(duration) ? duration : 0) * (Number.isFinite(fps) ? fps : 0);
  return Math.max(1, Math.round(product));
}

export function keyFrameEvery(fps: number): number {
  return Math.max(1, Math.round(fps * KEY_FRAME_SECONDS));
}

/**
 * Resolves the `Spec` to the values used for export and fails immediately if
 * it cannot proceed. It can reject three things:
 *
 * - odd dimensions: H.264 with 4:2:0 requires even dimensions, so round up
 *   and put the actual dimensions in the filename so the placeholder's size
 *   is accurate;
 * - impossible dimensions: more than 4096 per side must not be silently cropped;
 * - too many frames: this is a placeholder, not a render.
 */
export function planExport(spec: Spec): VideoPlan {
  if (!Number.isFinite(spec.fps) || spec.fps <= 0) {
    throw new Error('FPS must be a number greater than zero.');
  }
  if (!Number.isFinite(spec.duration) || spec.duration < 0) {
    throw new Error('Duration must be a number greater than or equal to zero.');
  }

  const dims = evenDimensions(spec.width, spec.height);
  if (dims.width > MAX_VIDEO_DIMENSION || dims.height > MAX_VIDEO_DIMENSION) {
    throw new Error(
      `The video would be ${dims.width}x${dims.height}, but the limit is ${MAX_VIDEO_DIMENSION} px per side. ` +
        'Reduce the placeholder dimensions and try again.',
    );
  }

  const totalFrames = totalFramesFor(spec.duration, spec.fps);
  if (totalFrames > MAX_TOTAL_FRAMES) {
    throw new Error(
      `The video would have ${totalFrames} frames (${spec.duration}s at ${spec.fps} fps), but the limit is ` +
        `${MAX_TOTAL_FRAMES}. Reduce the duration or FPS: 10s at 30fps just fits.`,
    );
  }

  return {
    spec: { ...spec, width: dims.width, height: dims.height },
    width: dims.width,
    height: dims.height,
    fps: spec.fps,
    totalFrames,
    frameDuration: 1 / spec.fps,
    keyEvery: keyFrameEvery(spec.fps),
  };
}

// ── Progress ──────────────────────────────────────────────────────────────

const clamp01 = (n: number): number => Math.min(1, Math.max(0, n));

/** `less than 1 s`, `12 s`, `2 min 5 s`. */
export function formatEta(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0.5) return 'less than 1 s';
  const total = Math.round(seconds);
  return total < 60 ? `${total} s` : `${Math.floor(total / 60)} min ${total % 60} s`;
}

/**
 * One progress tick. `done` is the number of frames already through the
 * encoder, so ETA uses the measured speed rather than the requested duration:
 * at 5s and 30fps, 149 frames remain after the first, not `5 * 60 - 1`.
 */
export function progressInfo(plan: VideoPlan, done: number, elapsedSeconds: number): ProgressInfo {
  const total = plan.totalFrames;
  const frame = Math.min(total, Math.max(0, Math.round(done)));
  const remaining = total - frame;
  const perFrame = frame > 0 ? elapsedSeconds / frame : 0;
  const eta = remaining > 0 ? perFrame * remaining : 0;

  // Below half a second, "less than 1 s" is not a useful ETA, so do not show it.
  const message = `Encoding ${frame}/${total}` + (eta > 0.5 ? ` · ~${formatEta(eta)} left` : '');

  return { progress: clamp01(frame / total), frame, totalFrames: total, message };
}

// ── Encoding loop ─────────────────────────────────────────────────────────

/**
 * Where frames go. This is an interface rather than `CanvasSource` itself so
 * the loop can be exercised without `VideoEncoder`: the real encoder passes
 * the canvas and source; tests pass counters.
 */
export interface FrameSink {
  /** Draws the frame at `progress` (0..1) on the bar. */
  draw(progress: number): void;
  /** Queues the drawn frame. Resolves when processing can continue. */
  add(timestamp: number, duration: number, keyFrame: boolean): Promise<void>;
}

/**
 * Draws and queues `totalFrames` in order with exact timestamps.
 *
 * Awaiting `add` provides backpressure and is also the only place to check
 * cancellation without yielding the CPU from the loop. If the signal is
 * already aborted, stop before drawing frame N+1; the caller handles the
 * corresponding `output.cancel()` because only it has the output.
 */
export async function encodeFrames(
  plan: VideoPlan,
  sink: FrameSink,
  onProgress?: ProgressCallback,
  signal?: AbortSignal,
): Promise<void> {
  const startedAt = performance.now();
  for (let i = 0; i < plan.totalFrames; i++) {
    if (signal?.aborted) throw abortError();
    // The first frame shows an empty bar and the clock at 0, as in a still
    // image: drawn progress comes from the frame, not the cursor.
    sink.draw(i / plan.totalFrames);
    // Backpressure pauses the loop, not the clock.
    await sink.add(i / plan.fps, plan.frameDuration, i % plan.keyEvery === 0);
    onProgress?.(progressInfo(plan, i + 1, (performance.now() - startedAt) / 1000));
  }
}

// ── Metadata ──────────────────────────────────────────────────────────────

/**
 * File metadata, using the same `buildMetadata` as images.
 *
 * In MP4/MOV, the muxer writes `©nam`/`©des`/`©cmt` from normalized fields, so
 * put the full text block in `comment` to preserve `Software` and `Source`
 * (`comment` is the only free field respected by all four containers). Also
 * include them in `raw`, where they live unchanged in Matroska/WebM: the
 * ISOBMFF muxer discards keys longer than 4 characters, so in MP4 and MOV
 * those two exist only inside `comment`.
 */
export function videoMetadataTags(spec: Spec): MetadataTags {
  const meta = buildMetadata(spec);
  return {
    title: meta.title,
    description: meta.description,
    comment: metadataAsText(meta),
    artist: meta.software,
    raw: { Software: meta.software, Source: meta.source },
  };
}

// ── Canvas ────────────────────────────────────────────────────────────────
// Same three helpers as in `image.ts`. They are repeated instead of extracted
// to a new module: they are twenty lines, and the core need not grow for this.

type Surface = HTMLCanvasElement | OffscreenCanvas;

function createSurface(width: number, height: number): Surface {
  if (typeof OffscreenCanvas === 'function') return new OffscreenCanvas(width, height);
  if (typeof document !== 'undefined') {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    return canvas;
  }
  throw new Error('No canvas is available: OffscreenCanvas or a document is required.');
}

function context2d(surface: Surface): CanvasRenderingContext2D {
  const ctx = surface.getContext('2d');
  if (!ctx) throw new Error('The browser did not provide a 2D canvas context.');
  // In the types, an `OffscreenCanvas` context is not a
  // `CanvasRenderingContext2D`, but it has the same drawing and measurement
  // methods used by the core.
  return ctx as CanvasRenderingContext2D;
}

function releaseSurface(surface: Surface): void {
  // Zeroing the surface immediately releases its backing store; waiting for
  // the GC leaves several MB of GPU allocations alive during repeated exports.
  surface.width = 0;
  surface.height = 0;
}

function abortError(): DOMException {
  return new DOMException('Export canceled', 'AbortError');
}

function checkAbort(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError();
}

/** mediabunny errors are in English; add context in English. */
function withContext(err: unknown, label: string): unknown {
  if (err instanceof DOMException && err.name === 'AbortError') return err;
  return new Error(`Could not export video as ${label}: ${err instanceof Error ? err.message : String(err)}`, {
    cause: err,
  });
}

// ── Export ────────────────────────────────────────────────────────────────

/**
 * Exports the placeholder as video.
 *
 * @param format `mp4`, `webm`, `mov`, or `mkv`. Only offer formats returned by
 * `availableVideoFormats`.
 * @throws {Error} in English if the browser cannot export, a limit is exceeded,
 * or the codec fails.
 * @throws {DOMException} `AbortError` if canceled.
 */
export async function exportVideo(
  spec: Spec,
  format: VideoFormat,
  onProgress?: ProgressCallback,
  signal?: AbortSignal,
): Promise<ExportResult> {
  if (!isVideoExportSupported()) throw new Error(NO_ENCODER_MESSAGE);
  checkAbort(signal);

  const plan = planExport(spec);
  const label = VIDEO_FORMATS_TABLE[format].label;

  // Check for a codec before asking where to save: without one, there is nothing to save.
  const codec = await resolveCodec(format, plan.width, plan.height);
  if (!codec) {
    throw new Error(
      `This browser cannot encode ${label} at ${plan.width}x${plan.height}. ` +
        'Try another format or smaller dimensions.',
    );
  }
  checkAbort(signal);

  // Write to a `BufferTarget` and return the `Blob` instead of using
  // `StreamTarget` with `openSaveTarget`, even when the picker is available.
  // `SaveTarget.write` only appends bytes, and none of the four containers
  // writes in order: the ISOBMFF muxer seeks back to patch the `mdat` size
  // (and Matroska does the same for the `Segment` element), so an append-only
  // target would silently save a corrupt file. Forcing monotonic writes would
  // require `fastStart: 'fragmented'` for MP4/MOV and `appendOnly` for MKV,
  // changing the underlying container (fMP4 instead of MP4, unknown-size
  // `Segment`) to save a few MB of RAM. With limits of 4096px and 3600 frames,
  // the buffer is bounded while the file is not.
  const target = new BufferTarget();
  const output = new Output({ format: outputFormatFor(format), target });
  // Before `start()`: after that, the muxer is already writing.
  output.setMetadataTags(videoMetadataTags(plan.spec));

  const surface = createSurface(plan.width, plan.height);
  try {
    const source = new CanvasSource(surface, {
      codec,
      // `spec.quality` is for JPEG/WebP; use a fixed quality level here.
      quality: new Quality('high'),
      keyFrameInterval: KEY_FRAME_SECONDS,
    });
    // `frameRate` tells the muxer the timestamp rate so it can align them to
    // the grid instead of accumulating drift.
    output.addVideoTrack(source, { frameRate: plan.fps });

    onProgress?.({ progress: 0, frame: 0, totalFrames: plan.totalFrames, message: `Encoding ${label}…` });
    await output.start();

    const ctx = context2d(surface);
    await encodeFrames(
      plan,
      {
        draw: (progress) => drawFrame(ctx, plan.spec, progress),
        add: (timestamp, duration, keyFrame) => source.add(timestamp, duration, { keyFrame }),
      },
      onProgress,
      signal,
    );

    // `close` is not required, but prevents mediabunny from waiting for more frames.
    source.close();
    await output.finalize();
  } catch (err) {
    // Manual cancellation is required: otherwise the encoder stays alive with
    // a partially written output and the process hangs.
    await output.cancel().catch(() => {});
    throw withContext(err, label);
  } finally {
    releaseSurface(surface);
  }

  const bytes = target.buffer;
  if (!bytes) throw new Error(`The muxer returned no data: the ${label} video is empty.`);

  const mimeType = mimeFor(format, true);
  // `plan.spec` already has the actual dimensions, which the filename reports.
  const filename = filenameForSpec(plan.spec, format);
  const blob = new Blob([bytes], { type: mimeType });
  onProgress?.({ progress: 1, frame: plan.totalFrames, totalFrames: plan.totalFrames, message: 'Done' });
  return { blob, filename, mimeType, size: blob.size };
}
