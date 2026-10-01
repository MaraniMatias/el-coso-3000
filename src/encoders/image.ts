/**
 * Static image exporters: PNG, JPEG, WebP, and SVG.
 *
 * All four paths use the same `drawFrame`, so raster and vector output cannot
 * diverge. Only the final step differs: the three raster formats use `toBlob`,
 * while SVG is emitted by hand using the core layout (`layoutDimensions` /
 * `layoutLine`) to avoid reimplementing auto-fit.
 *
 * Since `toBlob` exposes no hook to write metadata, metadata
 * is injected into the bytes after encoding: `tEXt` chunks in PNG, a `COM`
 * segment in JPEG, and an `XMP ` chunk in WebP. These are three separate
 * injections, but this is the only way to meet the requirement that the file
 * contain its metadata.
 */

import { hexToRgba } from "../core/color";
import { drawFrame, frameGeometry, timecode } from "../core/draw-frame";
import { filenameForSpec, mimeFor } from "../core/filename";
import { FONT_FACE_CSS, FONT_STACK } from "../core/font";
import {
  layoutDimensions,
  layoutLine,
  paddingFor,
  type TextLayout,
} from "../core/fit-text";
import {
  buildMetadata,
  esc,
  metadataAsPairs,
  metadataAsText,
  metadataAsXmp,
} from "../core/metadata";
import {
  FONT_WEIGHT,
  supportsAlpha,
  type ExportResult,
  type ProgressCallback,
  type Spec,
} from "../core/types";

export type StillImageFormat = "png" | "jpeg" | "webp" | "svg";

/** Formats where `quality` has an effect. It does nothing in PNG. */
const QUALITY_FORMATS = new Set<StillImageFormat>(["jpeg", "webp"]);

/** Human-readable label for error messages. */
const FORMAT_LABEL: Record<StillImageFormat, string> = {
  png: "PNG",
  jpeg: "JPEG",
  webp: "WebP",
  svg: "SVG",
};

/**
 * Opacity of the bar guide. It must match `TRACK_ALPHA` in `draw-frame.ts`;
 * it is not exported from the core because only the footer uses it.
 */
const TRACK_ALPHA = 0.16;

/** Any drawable canvas. */
type Surface = HTMLCanvasElement | OffscreenCanvas;

/**
 * Newly allocated bytes. The generic matters: `Blob` only accepts views over
 * a real `ArrayBuffer`, while a bare `Uint8Array` is typed as potentially
 * shared.
 */
type Bytes = Uint8Array<ArrayBuffer>;

// ── Canvas ────────────────────────────────────────────────────────────────

function abortError(): DOMException {
  return new DOMException("Export canceled", "AbortError");
}

function checkAbort(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError();
}

function createSurface(width: number, height: number): Surface {
  if (typeof OffscreenCanvas === "function")
    return new OffscreenCanvas(width, height);
  if (typeof document !== "undefined") {
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    return canvas;
  }
  throw new Error(
    "No canvas is available: OffscreenCanvas or a document is required.",
  );
}

function context2d(surface: Surface): CanvasRenderingContext2D {
  const ctx = surface.getContext("2d");
  if (!ctx) throw new Error("The browser did not provide a 2D canvas context.");
  // In the types, `OffscreenCanvasRenderingContext2D` is not a
  // `CanvasRenderingContext2D` (it lacks `reset`, `isContextLost`, and
  // `drawFocusIfNeeded`), but it has the same drawing and measurement methods
  // used by the core, so it is interchangeable for `drawFrame` and layout.
  return ctx as CanvasRenderingContext2D;
}

function releaseSurface(surface: Surface): void {
  // Zeroing the surface immediately releases its backing store. Waiting for the
  // GC leaves several MB of GPU allocations alive if the user exports repeatedly.
  surface.width = 0;
  surface.height = 0;
}

function encodeCanvas(
  surface: Surface,
  format: StillImageFormat,
  quality: number,
  signal?: AbortSignal,
): Promise<Blob> {
  const type = mimeFor(format);
  const unsupported = () =>
    new Error(
      `This browser cannot export ${FORMAT_LABEL[format]}. Try another format.`,
    );

  // `OffscreenCanvas` has no `toBlob`; it exposes `convertToBlob`, the same
  // concept using promises instead of a callback.
  if ("convertToBlob" in surface) {
    return surface
      .convertToBlob(QUALITY_FORMATS.has(format) ? { type, quality } : { type })
      .then((blob) => {
        // `toBlob`/`convertToBlob` do not observe the `AbortSignal`, so check
        // the flag manually when they return.
        checkAbort(signal);
        if (!blob) throw unsupported();
        return blob;
      });
  }

  return new Promise<Blob>((resolve, reject) => {
    surface.toBlob(
      (blob) => {
        if (signal?.aborted) return reject(abortError());
        if (!blob) return reject(unsupported());
        resolve(blob);
      },
      type,
      quality,
    );
  });
}

// ── CRC32 ────────────────────────────────────────────────────────────────

/** Table for the reflected polynomial 0xEDB88320 required by the PNG spec. */
const CRC_TABLE = ((): Uint32Array => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let bit = 0; bit < 8; bit++)
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c >>> 0;
  }
  return table;
})();

/** CRC32 (polynomial 0xEDB88320), as required by the PNG spec. */
export function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++)
    c = (CRC_TABLE[(c ^ bytes[i]!) & 0xff] ?? 0) ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// ── Byte utilities ────────────────────────────────────────────────────────

function fourCC(bytes: Uint8Array, offset: number): string {
  return String.fromCharCode(
    bytes[offset] ?? 0,
    bytes[offset + 1] ?? 0,
    bytes[offset + 2] ?? 0,
    bytes[offset + 3] ?? 0,
  );
}

function viewOf(bytes: Uint8Array): DataView {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

function matchesAt(
  bytes: Uint8Array,
  offset: number,
  expected: readonly number[],
): boolean {
  return expected.every((b, i) => bytes[offset + i] === b);
}

// ── PNG ───────────────────────────────────────────────────────────────────

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] as const;

/** Builds a PNG chunk: BE length, ASCII type, data, CRC32 of type+data. */
export function pngChunk(type: string, data: Uint8Array): Bytes {
  const out = new Uint8Array(12 + data.length);
  const view = viewOf(out);
  view.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  // Calculate the CRC over type + data, never the length.
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

/**
 * Inserts prebuilt chunks immediately before the first `IDAT`.
 *
 * The PNG spec places ancillary chunks that describe the image before the pixel
 * data. Inserting after `IDAT` (which is what "before `IEND`" means, since
 * `IEND` is last) is legal but `exiftool` then warns that the text chunks "may
 * be ignored by some readers", because plenty of decoders only look at what
 * precedes the first scanline.
 *
 * Walking from `IHDR` keeps this correct even if the file has extra chunks
 * before `IDAT`, and still fails loudly on something that is not a PNG.
 */
export function insertPngChunks(png: Uint8Array, chunks: Bytes[]): Bytes {
  if (!matchesAt(png, 0, PNG_SIGNATURE))
    throw new Error("Not a PNG: signature mismatch.");

  const view = viewOf(png);
  let offset = 8;
  let idat = -1;
  while (offset + 8 <= png.length) {
    if (fourCC(png, offset + 4) === "IDAT") {
      idat = offset;
      break;
    }
    offset += 12 + view.getUint32(offset);
  }
  if (idat < 0) throw new Error("Invalid PNG: IDAT chunk not found.");

  const extra = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(png.length + extra);
  out.set(png.subarray(0, idat), 0);
  let at = idat;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.length;
  }
  out.set(png.subarray(idat), at);
  return out;
}

/**
 * One `iTXt` chunk: `keyword \0 flag method language \0 translated \0 text`.
 *
 * `tEXt` would be simpler but the spec pins it to Latin-1, and replacing
 * non-Latin-1 characters with `?` mangles names like `Matías`. `iTXt` is
 * UTF-8 by definition; the compression flag stays 0 because the packet is small
 * and an uncompressed chunk can always be read.
 */
export function pngTextChunks(pairs: Array<[string, string]>): Bytes[] {
  return pairs.map(([key, value]) =>
    pngChunk("iTXt", itxtData(key, new TextEncoder().encode(value))),
  );
}

/** The `iTXt` payload: keyword, three empty strings, then UTF-8 text. */
function itxtData(keyword: string, text: Uint8Array): Uint8Array {
  const key = new TextEncoder().encode(keyword);
  const data = new Uint8Array(key.length + 5 + text.length);
  data.set(key, 0);
  // NUL after the keyword, then compression flag + method (both 0), then the
  // empty language tag, empty translated keyword: five NULs before the text.
  data.set(text, key.length + 5);
  return data;
}

/** `iTXt` chunk holding the XMP packet, which is what exiftool reads as XMP. */
export function pngXmpChunk(payload: Uint8Array): Bytes {
  return pngChunk("iTXt", itxtData("XML:com.adobe.xmp", payload));
}

// ── JPEG ──────────────────────────────────────────────────────────────────

/** Signature of an XMP payload inside `APP1`. */
const XMP_SIGNATURE = "http://ns.adobe.com/xap/1.0/";

/** A segment length is a 16-bit field that includes its own 2 bytes. */
const MAX_SEGMENT_PAYLOAD = 0xffff - 2;

/**
 * Inserts a segment (marker + payload) immediately after `SOI`.
 *
 * Only some segments are padded: `APPn` with a length that leaves an odd
 * payload needs one, but `COM` and the XMP `APP1` do not, and adding a byte
 * would make readers show a trailing NUL. So the length is exactly what the
 * payload needs.
 *
 * The size is checked before allocating: the length field is 16 bits, so an
 * oversized payload would wrap to a smaller number and produce a segment no
 * reader can parse, silently dropping the metadata and the rest of the file.
 * Put the segment first because `SOI` is the only thing the parser requires
 * before it.
 */
function insertJpegSegment(jpeg: Uint8Array, marker: number, payload: Bytes): Bytes {
  if (!matchesAt(jpeg, 0, [0xff, 0xd8]))
    throw new Error("Not a JPEG: SOI marker missing.");

  if (payload.length > MAX_SEGMENT_PAYLOAD)
    throw new Error(
      `JPEG segment too large: ${payload.length} bytes of payload, maximum ${MAX_SEGMENT_PAYLOAD}.`,
    );

  const out = new Uint8Array(jpeg.length + 4 + payload.length);
  out.set(jpeg.subarray(0, 2), 0);

  let at = 2;
  out[at] = 0xff;
  out[at + 1] = marker;
  viewOf(out).setUint16(at + 2, 2 + payload.length);
  at += 4;
  out.set(payload, at);
  at += payload.length;

  out.set(jpeg.subarray(2), at);
  return out;
}

/**
 * Inserts a `COM` segment (0xFFFE) immediately after `SOI`.
 *
 * `COM` does not specify a charset, so the text goes in as UTF-8, which
 * inspection tools read today. It is the human-readable fallback for tools that
 * ignore XMP.
 */
export function insertJpegComment(jpeg: Uint8Array, text: string): Bytes {
  return insertJpegSegment(jpeg, 0xfe, new TextEncoder().encode(text));
}

/**
 * Inserts an `APP1` segment (0xFFE1) with the XMP packet after `SOI`.
 *
 * `APP1` is the standard home for XMP in JPEG, identified by the null-
 * terminated `http://ns.adobe.com/xap/1.0/` signature that follows the length.
 */
export function insertJpegXmp(jpeg: Uint8Array, packet: Uint8Array): Bytes {
  const payload = new Uint8Array(XMP_SIGNATURE.length + 1 + packet.length);
  payload.set(new TextEncoder().encode(XMP_SIGNATURE), 0);
  payload[XMP_SIGNATURE.length] = 0; // NUL terminator of the signature
  payload.set(packet, XMP_SIGNATURE.length + 1);
  return insertJpegSegment(jpeg, 0xe1, payload);
}

// ── WebP ──────────────────────────────────────────────────────────────────

/** Pixel chunks: EXIF/XMP go before the first of these. */
const WEBP_IMAGE_CHUNKS = new Set(["VP8 ", "VP8L", "ANMF"]);

/**
 * Inserts an `XMP ` chunk into the RIFF container.
 *
 * Two details that trip up many implementations: the RIFF length (offset 4) is
 * `file - 8` and must be updated, and chunk payloads are aligned to an even
 * byte with padding. Insert the chunk before the first image chunk to follow
 * the order required by the WebP spec.
 */
export function insertWebpXmp(webp: Uint8Array, payload: Uint8Array): Bytes {
  if (fourCC(webp, 0) !== "RIFF" || fourCC(webp, 8) !== "WEBP") {
    throw new Error("Not a WebP: RIFF/WEBP header missing.");
  }

  const view = viewOf(webp);
  let offset = 12;
  while (offset + 8 <= webp.length) {
    if (WEBP_IMAGE_CHUNKS.has(fourCC(webp, offset))) break;
    const size = view.getUint32(offset + 4, true);
    offset += 8 + size + (size % 2);
  }
  const at = Math.min(offset, webp.length);

  const pad = payload.length % 2;
  const out = new Uint8Array(webp.length + 8 + payload.length + pad);
  const outView = viewOf(out);
  out.set(webp.subarray(0, at), 0);

  let cursor = at;
  out[cursor] = 0x58; // 'X'
  out[cursor + 1] = 0x4d; // 'M'
  out[cursor + 2] = 0x50; // 'P'
  out[cursor + 3] = 0x20; // space: the fourCC is 'XMP '
  outView.setUint32(cursor + 4, payload.length, true);
  cursor += 8;
  out.set(payload, cursor);
  cursor += payload.length;
  if (pad) {
    out[cursor] = 0x00;
    cursor += 1;
  }

  out.set(webp.subarray(at), cursor);
  // The RIFF length excludes its own 8-byte header.
  outView.setUint32(4, out.length - 8, true);
  return out;
}

// ── XML ───────────────────────────────────────────────────────────────────

/** Attributes need no more than two decimals, which keeps the file small. */
function num(n: number): string {
  return String(Math.round(n * 100) / 100);
}

// ── SVG ───────────────────────────────────────────────────────────────────

/**
 * One `<text>` per line, with the baseline where `paintText` would put it:
 * `blockTop + ascent`, advancing by `lineHeight`. SVG defaults to
 * `text-anchor: start` and an alphabetic baseline, so canvas `center` becomes
 * `text-anchor="middle"` and `y` is the baseline.
 */
function svgTextLines(
  layout: TextLayout,
  centerX: number,
  top: number,
  areaHeight: number,
  fill: string,
): string[] {
  const blockTop = top + (areaHeight - layout.height) / 2;
  let baseline = blockTop + layout.ascent;
  const out: string[] = [];
  for (const line of layout.lines) {
    out.push(
      `<text x="${num(centerX)}" y="${num(baseline)}" fill="${esc(fill)}" font-family="${esc(FONT_STACK)}"` +
        ` font-weight="${FONT_WEIGHT}" font-size="${num(layout.fontSize)}" text-anchor="middle">${esc(line)}</text>`,
    );
    baseline += layout.lineHeight;
  }
  return out;
}

/**
 * Emits the complete SVG.
 *
 * `measure` is only used to measure text; nothing is drawn with it. The layout
 * comes entirely from the core with the same parameters as `drawFrame`, so the
 * SVG and PNG say exactly the same thing.
 */
export function buildSvg(
  spec: Spec,
  measure: CanvasRenderingContext2D,
): string {
  const { width, height } = spec;
  const geo = frameGeometry(spec);
  const contentHeight = height - geo.stripHeight;
  const pad = paddingFor(width, height);

  // No background rect when it is transparent: SVG has no alpha to fill, the
  // absence of the rect IS the transparency.
  const body: string[] = spec.transparent
    ? []
    : [`<rect width="${num(width)}" height="${num(height)}" fill="#${esc(spec.bg)}"/>`];

  const dims = layoutDimensions(
    measure,
    spec,
    Math.max(1, width - pad * 2),
    Math.max(1, contentHeight - pad * 2),
    { fontWeight: FONT_WEIGHT },
  );
  if (dims && dims.fontSize >= 6) {
    body.push(...svgTextLines(dims, width / 2, 0, contentHeight, spec.fg));
  }

  if (geo.stripHeight > 0) {
    const barTop = height - geo.barHeight;
    if (spec.showTime && geo.timeFontSize > 0) {
      // Static image: `drawFrame` without progress uses 0.
      const clock = layoutLine(
        measure,
        timecode(0, spec.duration),
        width - pad,
        geo.timeFontSize * 1.5,
        {
          fontWeight: FONT_WEIGHT,
          minFontSize: 7,
          maxFontSize: geo.timeFontSize,
        },
      );
      if (clock) {
        body.push(
          ...svgTextLines(
            clock,
            width / 2,
            barTop - geo.timeFontSize * 1.5,
            geo.timeFontSize * 1.5,
            spec.fg,
          ),
        );
      }
    }
    if (spec.showProgressBar && geo.barHeight > 0) {
      // The bar is empty in a static image: only draw the guide, as
      // `drawFrame` does with `progress` set to 0.
      body.push(
        `<rect y="${num(barTop)}" width="${num(width)}" height="${num(geo.barHeight)}" fill="${esc(hexToRgba(spec.fg, TRACK_ALPHA))}"/>`,
      );
    }
  }

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<svg xmlns="http://www.w3.org/2000/svg" width="${num(width)}" height="${num(height)}" viewBox="0 0 ${num(width)} ${num(height)}">`,
    // `<metadata>` is the first thing read from the file, before defs.
    `<metadata>${esc(metadataAsText(buildMetadata(spec)))}</metadata>`,
    // Embed the font so the SVG remains correct when opened on a machine
    // without Montserrat. CDATA avoids having to escape the CSS.
    `<defs><style type="text/css"><![CDATA[${FONT_FACE_CSS}]]></style></defs>`,
    ...body,
    "</svg>",
  ].join("\n");
}

// ── Export ────────────────────────────────────────────────────────────────

/**
 * Exports the placeholder as a still image.
 *
 * @param format `png`, `jpeg`, `webp`, or `svg`.
 */
export async function exportImage(
  spec: Spec,
  format: StillImageFormat,
  onProgress?: ProgressCallback,
  signal?: AbortSignal,
): Promise<ExportResult> {
  checkAbort(signal);
  // A format without alpha gets an opaque background, whatever the spec says.
  // JPEG has no alpha to store, and `toBlob` would composite the transparent
  // pixels over an undefined color (black in most browsers), so the file would
  // come out with a background nobody chose.
  const opaque: Spec = supportsAlpha(format) ? spec : { ...spec, transparent: false };
  const mimeType = mimeFor(format);
  const filename = filenameForSpec(opaque, format);

  const finish = (bytes: Bytes | string): ExportResult => {
    const blob = new Blob([bytes], { type: mimeType });
    onProgress?.({ progress: 1, message: "Done" });
    return { blob, filename, mimeType, size: blob.size };
  };

  if (format === "svg") {
    onProgress?.({ progress: 0, message: "Measuring text…" });
    // The SVG canvas only provides a context for measuring.
    const surface = createSurface(opaque.width, opaque.height);
    let svg: string;
    try {
      svg = buildSvg(opaque, context2d(surface));
    } finally {
      releaseSurface(surface);
    }
    checkAbort(signal);
    onProgress?.({ progress: 0.3, message: "Writing SVG…" });
    return finish(svg);
  }

  const surface = createSurface(opaque.width, opaque.height);
  let blob: Blob;
  try {
    onProgress?.({ progress: 0, message: "Drawing…" });
    drawFrame(context2d(surface), opaque);
    checkAbort(signal);
    onProgress?.({
      progress: 0.3,
      message: `Encoding ${FORMAT_LABEL[format]}…`,
    });
    blob = await encodeCanvas(surface, format, opaque.quality, signal);
  } finally {
    releaseSurface(surface);
  }

  const raw = new Uint8Array(await blob.arrayBuffer());
  checkAbort(signal);
  // Metadata is needed here; SVG emits it in `buildSvg`.
  // Both layers: flat keywords for tools that ignore XMP, XMP for the ones that
  // do not. `quality` only reaches the formats where it changes the bytes.
  const meta = buildMetadata(
    opaque,
    QUALITY_FORMATS.has(format) ? { quality: opaque.quality } : {},
  );
  switch (format) {
    case "png":
      return finish(
        insertPngChunks(raw, [
          ...pngTextChunks(metadataAsPairs(meta)),
          pngXmpChunk(metadataAsXmp(meta)),
        ]),
      );
    case "jpeg":
      // XMP first, then the comment, so `COM` lands before `APP1`: readers that
      // stop at the first segment still find the readable text.
      return finish(
        insertJpegComment(
          insertJpegXmp(raw, metadataAsXmp(meta)),
          metadataAsText(meta),
        ),
      );
    case "webp":
      return finish(insertWebpXmp(raw, metadataAsXmp(meta)));
  }
}
