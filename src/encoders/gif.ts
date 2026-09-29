/**
 * Animated GIF exporter.
 *
 * Mediabunny has no GIF output, so the file is assembled by hand. The
 * structure follows the usual layout:
 *
 *   "GIF89a" · Logical Screen Descriptor · Global Color Table
 *   · Application Extension (NETSCAPP2.0, bucle infinito)
 *   · Comment Extension (product metadata)
 *   · per frame: Graphic Control Extension + Image Descriptor + LZW data
 *   · 0x3B
 *
 * The palette is global and shared by all frames (see `quantize.ts`),
 * so there is nothing to quantize here: only index, compress, and concatenate.
 */

import { drawFrame } from '../core/draw-frame';
import { buildFilename, mimeFor, trimNumber } from '../core/filename';
import { buildMetadata, metadataAsText } from '../core/metadata';
import type { ExportResult, ProgressCallback, Spec } from '../core/types';
import { ByteWriter, lzwCompress, pushUint16, writeSubBlocks, type Bytes } from './lzw';
import { buildPalette, createPaletteMapper, type Palette } from './quantize';

// ── File structure ────────────────────────────────────────────────────────

const SIGNATURE = new TextEncoder().encode('GIF89a');
const NETSCAPE_APP = new TextEncoder().encode('NETSCAPP2.0');

/** The GCT is a power of 2 between 2 and 256 entries. */
const MAX_GCT_ENTRIES = 256;

/**
 * Request 255 colors, not 256, because the last table index is reserved for
 * the alpha channel: without that free slot, transparent pixels have nowhere
 * to go. The table still has 256 entries.
 */
const MAX_PALETTE_COLORS = 255;

/** Per-frame sample limit for the palette. Four colors need far less. */
const MAX_SAMPLES_PER_FRAME = 65_536;

/** Any drawable canvas. */
type Surface = HTMLCanvasElement | OffscreenCanvas;

export interface GifHeader {
  width: number;
  height: number;
  /** RGB triples from the global palette, 3 bytes each. */
  palette: Uint8Array;
  /** Comment Extension text. */
  comment: string;
  /** Loop count. `0` means infinite, which is what we use. */
  loop: number;
}

/** Values derived from the palette before writing any bytes. */
interface Layout {
  /** GCT index reserved for transparent pixels. */
  transparentIndex: number;
  /** Actual GCT entries. */
  gctSize: number;
  /** The descriptor's 3 low bits: `log2(gctSize) - 1`. */
  sizeBits: number;
  /** Bits per index in the LZW data. */
  minCodeSize: number;
}

function layoutOf(header: GifHeader): Layout {
  const colors = header.palette.length / 3;
  if (!Number.isInteger(colors) || colors < 1) {
    throw new Error('The GIF palette is empty.');
  }
  // Reserve the first free palette index for transparency.
  // No opaque pixel can use it, so transparency cannot overwrite a color.
  const transparentIndex = colors;
  let gctSize = 2;
  while (gctSize < transparentIndex + 1) gctSize *= 2;
  if (gctSize > MAX_GCT_ENTRIES) {
    throw new Error(`The palette does not fit in a GCT: ${colors} colors.`);
  }
  const sizeBits = Math.round(Math.log2(gctSize)) - 1;
  // The spec does not allow a one-bit initial code: small tables still need
  // at least 2 bits, leaving a couple of codes unused by LZW data.
  const minCodeSize = Math.max(2, sizeBits + 1);
  return { transparentIndex, gctSize, sizeBits, minCodeSize };
}

/** Header + GCT + loop + comment. Leaves the file ready for frames. */
export function writeGifHeader(out: ByteWriter, header: GifHeader): void {
  const { width, height, palette, comment, loop } = header;
  if (width > 0xffff || height > 0xffff) {
    throw new Error(`GIF dimensions out of range: ${width}x${height}.`);
  }
  const layout = layoutOf(header);
  const colors = palette.length / 3;

  out.pushBytes(SIGNATURE);
  // Logical Screen Descriptor: the canvas's logical size, in little-endian.
  pushUint16(out, width);
  pushUint16(out, height);
  // Bit 7: GCT present. Bits 6-4: 8 bits per primary color. Bit 3: unsorted.
  // Bits 2-0: log2(entries) - 1.
  out.push(0x80 | 0x70 | layout.sizeBits);
  // Point the background to the transparent index: in frame 0, undrawn pixels
  // show the viewer's background instead of an invented black.
  out.push(layout.transparentIndex);
  out.push(0x00); // pixel aspect ratio: no information

  out.pushBytes(palette);
  // Fill unused table entries with black. Their color does not matter: none
  // are indexed, except for the one reserved for transparency.
  for (let i = colors * 3; i < layout.gctSize * 3; i++) out.push(0x00);

  // Application Extension: NETSCAPP2.0 is the loop request honored by all
  // viewers. The block has a fixed length (0x0B), the sub-block is 0x03, and
  // the count is little-endian. `0` = infinite.
  out.push(0x21);
  out.push(0xff);
  out.push(0x0b);
  out.pushBytes(NETSCAPE_APP);
  out.push(0x03);
  out.push(0x01);
  pushUint16(out, loop);
  out.push(0x00);

  // Comment Extension: metadata lives in the file, not the filename.
  out.push(0x21);
  out.push(0xfe);
  writeSubBlocks(out, new TextEncoder().encode(comment));
}

/**
 * One frame: Graphic Control Extension, Image Descriptor, and LZW data.
 *
 * @param indices `width * height` indices into the header palette.
 * @param delayCs Duration in hundredths of a second.
 */
export function writeGifFrame(out: ByteWriter, header: GifHeader, indices: Uint8Array, delayCs: number): void {
  const { width, height } = header;
  const layout = layoutOf(header);
  if (indices.length !== width * height) {
    throw new Error(`The frame has ${indices.length} pixels, but the canvas requires ${width * height}.`);
  }

  // Graphic Control Extension.
  out.push(0x21);
  out.push(0xf9);
  out.push(0x04);
  // Disposal 1 = "leave the frame on screen." Each frame fills the canvas
  // and is opaque except for alpha, so nothing needs clearing between frames
  // and drawing over the previous one leaves no edges. The low bit is the
  // transparency flag.
  out.push((1 << 2) | 0x01);
  pushUint16(out, delayCs);
  out.push(layout.transparentIndex);
  out.push(0x00);

  // Image Descriptor: at (0,0), full size, with no local table or interlacing.
  // All pixels come from the GCT.
  out.push(0x2c);
  pushUint16(out, 0);
  pushUint16(out, 0);
  pushUint16(out, width);
  pushUint16(out, height);
  out.push(0x00);

  out.push(layout.minCodeSize);
  // LZW already returns the sub-block chain with its terminator, so do not wrap
  // it again here: that would add an extra terminator.
  out.pushBytes(lzwCompress(indices, layout.minCodeSize));
}

/** Closes the file. */
export function writeGifTrailer(out: ByteWriter): void {
  out.push(0x3b);
}

// ── Timing ────────────────────────────────────────────────────────────────

export interface GifTiming {
  totalFrames: number;
  /** Duration of each frame in hundredths of a second, the GIF unit. */
  delayCs: number;
  /** FPS implied by the delay, which often differs from the requested value. */
  effectiveFps: number;
}

/**
 * Converts the requested duration and FPS to GIF timing.
 *
 * The delay is in hundredths of a second, so FPS is quantized to
 * `100 / delayCs`: requesting 30fps gives 3cs and the file plays at
 * 33.33fps. This is a format limitation, not a bug, but since the file does not
 * store FPS, at least report it in the filename and progress. A delay of 0
 * means "play as fast as possible" in some viewers, so values above 100fps use 1cs.
 */
export function gifTiming(fps: number, duration: number): GifTiming {
  const totalFrames = Math.max(1, Math.round(duration * fps));
  const delayCs = Math.max(1, Math.round(100 / fps));
  return { totalFrames, delayCs, effectiveFps: 100 / delayCs };
}

// ── Canvas ────────────────────────────────────────────────────────────────

function abortError(): DOMException {
  return new DOMException('Export canceled', 'AbortError');
}

function checkAbort(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError();
}

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
  // In the types, `OffscreenCanvasRenderingContext2D` is not a
  // `CanvasRenderingContext2D` (it lacks `reset`, `isContextLost`, and
  // `drawFocusIfNeeded`), but it has the same drawing and measurement methods
  // used by the core, so they are interchangeable for `drawFrame`.
  return ctx as CanvasRenderingContext2D;
}

function releaseSurface(surface: Surface): void {
  // Zeroing the surface immediately releases its backing store. Otherwise,
  // exporting a 1080p GIF leaves several MB of GPU memory alive until the GC runs.
  surface.width = 0;
  surface.height = 0;
}

/** Yields to the event loop; otherwise the `AbortSignal` never fires. */
function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * Samples a few frames to build the global palette.
 *
 * Take the first, middle, and last frames: in an animated placeholder, only the
 * progress bar and clock change between frames, so these three contain every
 * color that will appear. Sampling every frame for the palette would be wasted
 * work because the palette is the same.
 */
function samplePalette(ctx: CanvasRenderingContext2D, spec: Spec, totalFrames: number): Uint8Array {
  const picks = [...new Set([0, Math.floor(totalFrames / 2), totalFrames - 1])];
  const pixels = spec.width * spec.height;
  const stride = Math.max(1, Math.ceil(pixels / MAX_SAMPLES_PER_FRAME));

  const out = new Uint8Array(picks.length * Math.min(pixels, MAX_SAMPLES_PER_FRAME) * 3);
  let at = 0;
  for (const frame of picks) {
    drawFrame(ctx, spec, frame / totalFrames);
    const { data } = ctx.getImageData(0, 0, spec.width, spec.height);
    for (let p = 0; p < pixels; p += stride) {
      const o = p * 4;
      // A fully transparent pixel's RGB is not a color in the image, so it does
      // not belong in the palette.
      if ((data[o + 3] ?? 0) === 0) continue;
      out[at++] = data[o]!;
      out[at++] = data[o + 1]!;
      out[at++] = data[o + 2]!;
    }
  }
  return out.subarray(0, at);
}

// ── Export ────────────────────────────────────────────────────────────────

/**
 * Exports the placeholder as an animated GIF.
 *
 * @param onProgress Receives per-frame progress.
 * @param signal Cancellation. Throws a `DOMException` `AbortError`.
 */
export async function exportGif(
  spec: Spec,
  onProgress?: ProgressCallback,
  signal?: AbortSignal,
): Promise<ExportResult> {
  checkAbort(signal);

  const { totalFrames, delayCs, effectiveFps } = gifTiming(spec.fps, spec.duration);
  const mimeType = mimeFor('gif');
  const filename = buildFilename({
    width: spec.width,
    height: spec.height,
    format: 'gif',
    // With duration 0, the GIF is a valid one-frame loop. Omit `-0s` from the
    // filename so it does not look like a misconfigured video.
    fps: spec.duration > 0 ? spec.fps : undefined,
    duration: spec.duration > 0 ? spec.duration : undefined,
    // Include actual FPS in the filename when it differs from the requested
    // value: it is the only place in the file that records playback speed.
    effectiveFps: spec.duration > 0 ? effectiveFps : undefined,
  });
  const pixels = spec.width * spec.height;
  const out = new ByteWriter(pixels);
  const surface = createSurface(spec.width, spec.height);
  let bytes: Bytes;

  try {
    const ctx = context2d(surface);

    onProgress?.({ progress: 0, message: 'Sampling colors…' });
    const palette: Palette = buildPalette(samplePalette(ctx, spec, totalFrames), MAX_PALETTE_COLORS);
    checkAbort(signal);

    const header: GifHeader = {
      width: spec.width,
      height: spec.height,
      palette: palette.rgb,
      comment: metadataAsText(buildMetadata(spec)),
      loop: 0,
    };
    // `writeGifHeader` reserves index `palette.size` for transparency, the first
    // slot that no opaque color can use.
    const toIndex = createPaletteMapper(palette);
    const transparentIndex = palette.size;
    const indices = new Uint8Array(pixels);

    writeGifHeader(out, header);

    for (let frame = 0; frame < totalFrames; frame++) {
      checkAbort(signal);
      drawFrame(ctx, spec, frame / totalFrames);
      const { data } = ctx.getImageData(0, 0, spec.width, spec.height);
      for (let p = 0, o = 0; p < pixels; p++, o += 4) {
        const alpha = data[o + 3]!;
        indices[p] = alpha === 0
          ? transparentIndex
          : toIndex((data[o]! << 16) | (data[o + 1]! << 8) | data[o + 2]!);
      }
      writeGifFrame(out, header, indices, delayCs);

      onProgress?.({
        progress: (frame + 1) / totalFrames,
        frame: frame + 1,
        totalFrames,
        message: `Encoding ${frame + 1}/${totalFrames}`,
      });
      // Without yielding to the event loop, the frame loop blocks the UI and
      // cancellation never fires.
      await yieldToEventLoop();
    }

    writeGifTrailer(out);
    checkAbort(signal);
    bytes = out.finish();
  } finally {
    releaseSurface(surface);
  }

  const blob = new Blob([bytes], { type: mimeType });
  onProgress?.({
    progress: 1,
    message: `Done: ${trimNumber(effectiveFps)} actual fps (${delayCs} cs delay)`,
  });
  return { blob, filename, mimeType, size: blob.size };
}
