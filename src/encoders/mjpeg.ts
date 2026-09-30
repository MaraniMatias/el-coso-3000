/**
 * Two animated JPEG outputs, for handing off to design or opening in a video
 * editor.
 *
 * - `exportMjpegAvi`: an AVI with one complete JPEG per frame (Motion-JPEG),
 *   understood by ffmpeg, Premiere, and other editors.
 * - `exportJpegZip`: the same sequence as separate files in a ZIP, for
 *   pipelines that process images frame by frame.
 *
 * Both share the renderer: each frame comes from `drawFrame` and is encoded as
 * `image/jpeg`, so the preview and file cannot diverge.
 *
 * The containers are assembled by hand. Their structure is fixed, and adding a
 * dependency for this would trade a byte problem for a dependency problem. For
 * the same reason, the byte builders are separate from the exporters: they are
 * pure and can be tested without a canvas.
 */

import { drawFrame } from "../core/draw-frame";
import { filenameForSpec, mimeFor } from "../core/filename";
import {
  buildMetadata,
  metadataAsPairs,
  metadataAsText,
  type FileMetadata,
} from "../core/metadata";
import type { ExportResult, ProgressCallback, Spec } from "../core/types";
import { crc32 } from "./image";

/**
 * Newly allocated bytes. The generic matters: `Blob` only accepts views over
 * a real `ArrayBuffer`, while a bare `Uint8Array` is typed as potentially
 * shared.
 */
type Bytes = Uint8Array<ArrayBuffer>;

/** Any drawable canvas. */
type Surface = HTMLCanvasElement | OffscreenCanvas;

const JPEG_MIME = "image/jpeg";
const UTF8 = new TextEncoder();

// ── Byte utilities ────────────────────────────────────────────────────────

function viewOf(bytes: Uint8Array): DataView {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

/**
 * Joins the pieces into one. Containers are built in three passes (headers,
 * payloads, directories), and the last two need the previous size to calculate
 * offsets, so they cannot be written incrementally to a `Blob`.
 */
function concatBytes(parts: Bytes[]): Bytes {
  let total = 0;
  for (const part of parts) total += part.length;
  const out = new Uint8Array(total);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

/** RIFF fourCCs are exactly 4 ASCII bytes. */
function tagBytes(tag: string): Bytes {
  const out = new Uint8Array(4);
  for (let i = 0; i < 4; i++) out[i] = tag.charCodeAt(i) & 0xff;
  return out;
}

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
  // `CanvasRenderingContext2D`, but it has the same drawing and measurement
  // methods used by the core.
  return ctx as CanvasRenderingContext2D;
}

function releaseSurface(surface: Surface): void {
  // Zeroing the surface immediately releases its backing store: long video
  // exports can use tens of MB.
  surface.width = 0;
  surface.height = 0;
}

function encodeJpegBlob(surface: Surface, quality: number): Promise<Blob> {
  // `OffscreenCanvas` has no `toBlob`; it exposes `convertToBlob`, the same
  // concept using promises instead of a callback.
  if ("convertToBlob" in surface)
    return surface.convertToBlob({ type: JPEG_MIME, quality });
  return new Promise<Blob>((resolve, reject) => {
    surface.toBlob(
      (blob) =>
        blob
          ? resolve(blob)
          : reject(new Error("This browser cannot export JPEG.")),
      JPEG_MIME,
      quality,
    );
  });
}

async function encodeJpeg(
  surface: Surface,
  quality: number,
  signal?: AbortSignal,
): Promise<Bytes> {
  const blob = await encodeJpegBlob(surface, quality);
  // `toBlob`/`convertToBlob` do not observe the `AbortSignal`, so check the
  // flag manually when they return.
  checkAbort(signal);
  return new Uint8Array(await blob.arrayBuffer());
}

/** `max(1, …)`: duration 0 still produces one frame, so the file is not empty. */
function frameCount(spec: Spec): number {
  return Math.max(1, Math.round(spec.duration * spec.fps));
}

/**
 * Renders the complete sequence of JPEG frames.
 *
 * Render one at a time and accumulate the bytes: keeping N surfaces alive to
 * produce frames in parallel multiplies memory use by N without changing the result.
 *
 * @param span Portion of 0..1 used by rendering in the total progress; the
 * rest is used to write the container.
 */
async function renderJpegFrames(
  spec: Spec,
  totalFrames: number,
  onProgress: ProgressCallback | undefined,
  signal: AbortSignal | undefined,
  span: [number, number],
): Promise<Bytes[]> {
  const surface = createSurface(spec.width, spec.height);
  const frames: Bytes[] = [];
  try {
    const ctx = context2d(surface);
    for (let i = 0; i < totalFrames; i++) {
      checkAbort(signal);
      drawFrame(ctx, spec, i / totalFrames);
      frames.push(await encodeJpeg(surface, spec.quality, signal));
      const done = (i + 1) / totalFrames;
      onProgress?.({
        progress: span[0] + (span[1] - span[0]) * done,
        frame: i + 1,
        totalFrames,
        message: `Encoding JPEG ${i + 1}/${totalFrames}`,
      });
    }
  } finally {
    releaseSurface(surface);
  }
  return frames;
}

// ── AVI / RIFF ────────────────────────────────────────────────────────────
//
// AVI is RIFF, a generic chunk container. Everything has this structure:
//
//   'RIFF' <u32 LE size> 'AVI ' <chunk> <chunk> ...
//
// Each chunk is `<fourcc 4 bytes> <u32 LE size> <payload>`, followed by a
// padding byte if the payload length is odd. A list is a 'LIST' chunk whose
// payload starts with the list type's fourcc: 'hdrl', 'strl', 'movi', 'INFO'.
//
// All sizes and offsets are little-endian, without exception. RIFF originated
// on Windows, and its defining structs (`MainAVIHeader`, `AVIStreamHeader`,
// `BITMAPINFOHEADER`) are little-endian blobs like a C `struct`. Writing one in
// big-endian creates a file that looks valid but cannot be decoded because its
// sizes are absurd.

/** `dwFlags` in `avih`: the file has an index, so it can be seeked. */
const AVIF_HASINDEX = 0x10;
/** `dwFlags` for each `idx1` entry: a complete JPEG is always a keyframe. */
const AVIIF_KEYFRAME = 0x10;
/** `fccType`/`biCompression` for the codec: Motion-JPEG. */
const FCC_VIDS = "vids";
const FCC_MJPG = "MJPG";
/** Fourcc of the video chunk in `movi`: stream 0, compressed data. */
const MOVI_CHUNK = "00dc";

export interface MjpegAviParams {
  width: number;
  height: number;
  fps: number;
  meta: FileMetadata;
}

/** `<fourcc> <LE size> <payload>`, with RIFF's even-byte padding. */
function riffChunk(tag: string, payload: Bytes): Bytes {
  const out = new Uint8Array(8 + payload.length + (payload.length % 2));
  const view = viewOf(out);
  out.set(tagBytes(tag), 0);
  // The size excludes the 8-byte header and padding.
  view.setUint32(4, payload.length, true);
  out.set(payload, 8);
  return out;
}

/** `LIST`: a 'LIST' chunk whose payload starts with the list type. */
function riffList(type: string, payload: Bytes): Bytes {
  return riffChunk("LIST", concatBytes([tagBytes(type), payload]));
}

/**
 * `MainAVIHeader` (14 × u32, 56 bytes).
 *
 * `dwMicroSecPerFrame` and the `strh` pair `dwScale`/`dwRate` must agree: here
 * they come from 1/fps, and in `strh` from 1 and fps.
 */
function avihHeader(
  p: MjpegAviParams,
  frames: number,
  maxFrame: number,
): Bytes {
  const out = new Uint8Array(56);
  const view = viewOf(out);
  view.setUint32(0, Math.round(1_000_000 / p.fps), true); // dwMicroSecPerFrame
  view.setUint32(4, Math.round(maxFrame * p.fps), true); // dwMaxBytesPerSec
  view.setUint32(8, 0, true); // dwPaddingGranularity
  view.setUint32(12, AVIF_HASINDEX, true); // dwFlags
  view.setUint32(16, frames, true); // dwTotalFrames
  view.setUint32(20, 0, true); // dwInitialFrames
  view.setUint32(24, 1, true); // dwStreams
  view.setUint32(28, maxFrame, true); // dwSuggestedBufferSize
  view.setUint32(32, p.width, true); // dwWidth
  view.setUint32(36, p.height, true); // dwHeight
  // Keep dwReserved[4] at zero, as every reader expects.
  return out;
}

/** `AVIStreamHeader` (56 bytes): describes the stream, not the pixels. */
function streamHeader(
  p: MjpegAviParams,
  frames: number,
  maxFrame: number,
): Bytes {
  const out = new Uint8Array(56);
  const view = viewOf(out);
  out.set(tagBytes(FCC_VIDS), 0); // fccType
  out.set(tagBytes(FCC_MJPG), 4); // fccHandler
  view.setUint32(8, 0, true); // dwFlags
  view.setUint16(12, 0, true); // wPriority
  view.setUint16(14, 0, true); // wLanguage
  view.setUint32(16, 0, true); // dwInitialFrames
  view.setUint32(20, 1, true); // dwScale
  // dwRate over dwScale = one frame's duration. 1/fps s = 1e6/fps µs, matching
  // `dwMicroSecPerFrame` in `avih`.
  view.setUint32(24, p.fps, true); // dwRate
  view.setUint32(28, 0, true); // dwStart
  view.setUint32(32, frames, true); // dwLength
  view.setUint32(36, maxFrame, true); // dwSuggestedBufferSize
  view.setUint32(40, 0xffffffff, true); // dwQuality: -1 = default
  view.setUint32(44, 0, true); // dwSampleSize
  // rcFrame: left, top, right, bottom, as int16.
  view.setInt16(48, 0, true);
  view.setInt16(50, 0, true);
  view.setInt16(52, p.width, true);
  view.setInt16(54, p.height, true);
  return out;
}

/** `BITMAPINFOHEADER` (40 bytes): each Motion-JPEG frame is a complete JPEG. */
function bitmapInfoHeader(p: MjpegAviParams): Bytes {
  const out = new Uint8Array(40);
  const view = viewOf(out);
  view.setUint32(0, 40, true); // biSize
  view.setInt32(4, p.width, true); // biWidth
  // A positive biHeight means bottom-up. It does not matter: the complete JPEG
  // is decoded with its own reading order.
  view.setInt32(8, p.height, true); // biHeight
  view.setUint16(12, 1, true); // biPlanes
  view.setUint16(14, 24, true); // biBitCount
  // biCompression is a fourCC, not the numeric ID used by BMP and PNG.
  out.set(tagBytes(FCC_MJPG), 16);
  view.setUint32(20, p.width * p.height * 3, true); // biSizeImage
  view.setUint32(24, 0, true); // biXPelsPerMeter
  view.setUint32(28, 0, true); // biYPelsPerMeter
  view.setUint32(32, 0, true); // biClrUsed
  view.setUint32(36, 0, true); // biClrImportant
  return out;
}

/** Standard RIFF `INFO` tags for metadata pairs that have one. */
const INFO_TAG: Record<string, string> = {
  Software: "ISFT",
  Comment: "ICMT",
  Source: "ISBJ",
  Title: "INAM",
  Description: "IDSC",
};

/** Tag fourCC: the standard one if available, otherwise the key truncated to 4. */
function infoTag(key: string): string {
  return INFO_TAG[key] ?? key.toUpperCase().padEnd(4, " ").slice(0, 4);
}

/**
 * `INFO` list with metadata tags.
 *
 * `ISBJ` is the subject and holds the repo URL; `ICMT` is the comment. Readers
 * ignore unknown tags, so pairs without a standard tag use the truncated key
 * instead of being discarded.
 */
function infoList(meta: FileMetadata): Bytes {
  const chunks = metadataAsPairs(meta).map(([key, value]) =>
    riffChunk(infoTag(key), UTF8.encode(value)),
  );
  return riffList("INFO", concatBytes(chunks));
}

/**
 * Index table: 16 bytes per frame (`fourcc`, flags, offset, size).
 *
 * Offsets are relative to the position of the `movi` fourcc minus 4, that is,
 * to the `LIST` size field. The first chunk is therefore at 8 (4 for the size +
 * 4 for the `movi` fourcc), not 0. This is the convention written by ffmpeg
 * and assumed by readers; using another base makes the file fail to open or
 * start at the wrong frame.
 */
function indexChunk(frames: Bytes[]): Bytes {
  const out = new Uint8Array(16 * frames.length);
  const view = viewOf(out);
  let at = 8;
  for (let i = 0; i < frames.length; i++) {
    const size = frames[i]!.length;
    const base = i * 16;
    out.set(tagBytes(MOVI_CHUNK), base);
    view.setUint32(base + 4, AVIIF_KEYFRAME, true);
    view.setUint32(base + 8, at, true);
    // The size is that of the payload, excluding the padding byte.
    view.setUint32(base + 12, size, true);
    at += 8 + size + (size % 2);
  }
  return riffChunk("idx1", out);
}

/**
 * Builds the complete AVI from already encoded JPEG frames.
 *
 * Structure: `hdrl` (`avih` + `strl`/`strh`+`strf`), `INFO` with metadata,
 * `movi` with one `00dc` chunk per frame, and `idx1` at the end.
 */
export function buildMjpegAvi(frames: Bytes[], params: MjpegAviParams): Bytes {
  const maxFrame = frames.reduce((n, f) => Math.max(n, f.length), 0);
  const hdrl = riffList(
    "hdrl",
    concatBytes([
      riffChunk("avih", avihHeader(params, frames.length, maxFrame)),
      riffList(
        "strl",
        concatBytes([
          riffChunk("strh", streamHeader(params, frames.length, maxFrame)),
          riffChunk("strf", bitmapInfoHeader(params)),
        ]),
      ),
    ]),
  );
  const movi = riffList(
    "movi",
    concatBytes(frames.map((frame) => riffChunk(MOVI_CHUNK, frame))),
  );
  const body = concatBytes([
    hdrl,
    infoList(params.meta),
    movi,
    indexChunk(frames),
  ]);

  // The header is 12 bytes: 'RIFF', the size, and the 'AVI ' type.
  const out = new Uint8Array(12 + body.length);
  const view = viewOf(out);
  out.set(tagBytes("RIFF"), 0);
  // The RIFF size excludes its own 8-byte header.
  view.setUint32(4, out.length - 8, true);
  out.set(tagBytes("AVI "), 8);
  out.set(body, 12);
  return out;
}

// ── ZIP ───────────────────────────────────────────────────────────────────
//
// ZIP structure, in file order:
//
//   [local header][name][data]       (repeated for each entry)
//   [central directory]              (one 46-byte entry + name per entry)
//   [EOCD] [comment]
//
// Local headers are written first and the central directory later, so each
// entry must remember where its local header ended up: that offset relative to
// the start of the file goes in field 42 of the central header, which causes
// most bugs in this structure. The EOCD at the end only says where the central
// directory starts and how large it is.

const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_EOCD = 0x06054b50;
const METHOD_STORE = 0;
const METHOD_DEFLATE = 8;
/** Bit 11 of the general flag: the entry name is UTF-8. */
const FLAG_UTF8 = 0x0800;
/** Classic filename limit. Beyond it, the file cannot be opened. */
const MAX_NAME_BYTES = 255;
/** The EOCD comment field is a u16. */
const MAX_COMMENT_BYTES = 0xffff;
/** The entry count is also a u16: 65535 frames are ~36 min at 30 fps. */
const MAX_ENTRIES = 0xffff;
/**
 * Entry date and time fixed to the MS-DOS epoch (1/1/1980 00:00).
 * Preferable to the current time: two exports of the same `Spec` produce the
 * same bytes, making the placeholder comparable across runs.
 */
const DOS_TIME = 0;
const DOS_DATE = (1 << 5) | 1; // year 1980 counted from 0, month 1, day 1

export interface JpegZipEntry {
  name: string;
  data: Bytes;
}

interface ZipFields {
  name: Bytes;
  flags: number;
  method: number;
  crc: number;
  compressedSize: number;
  size: number;
  /** Offset of the local header, relative to the start of the file. */
  offset: number;
}

/** `deflate-raw`: bare deflate, without zlib's 2-byte header. */
async function deflateRaw(data: Bytes): Promise<Bytes> {
  const source = new ReadableStream<BufferSource>({
    start(controller) {
      controller.enqueue(data);
      controller.close();
    },
  });
  const deflated = source.pipeThrough(new CompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(deflated).arrayBuffer());
}

/** Trims to a complete UTF-8 byte sequence, without splitting one in half. */
function fitComment(text: string): Bytes {
  const bytes = UTF8.encode(text);
  if (bytes.length <= MAX_COMMENT_BYTES) return bytes;
  // `bytes[end]` is the first discarded byte. If it is a continuation byte
  // (10xxxxxx), it belongs to an incomplete sequence, so move back to its lead
  // byte, which is never a continuation byte.
  let end = MAX_COMMENT_BYTES;
  while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end -= 1;
  return bytes.slice(0, end);
}

function localHeader(f: ZipFields): Bytes {
  const out = new Uint8Array(30);
  const view = viewOf(out);
  view.setUint32(0, SIG_LOCAL, true);
  view.setUint16(4, 20, true); // version needed: 2.0, the minimum for deflate
  view.setUint16(6, f.flags, true);
  view.setUint16(8, f.method, true);
  view.setUint16(10, DOS_TIME, true);
  view.setUint16(12, DOS_DATE, true);
  view.setUint32(14, f.crc, true);
  // With `deflate-raw`, the CRC and sizes are always for the original data,
  // never the payload: the decompressor has no way to infer them.
  view.setUint32(18, f.compressedSize, true);
  view.setUint32(22, f.size, true);
  view.setUint16(26, f.name.length, true);
  view.setUint16(28, 0, true); // no extra field
  return out;
}

function centralHeader(f: ZipFields): Bytes {
  const out = new Uint8Array(46);
  const view = viewOf(out);
  view.setUint32(0, SIG_CENTRAL, true);
  view.setUint16(4, 20, true); // version made by
  view.setUint16(6, 20, true); // version needed
  view.setUint16(8, f.flags, true);
  view.setUint16(10, f.method, true);
  view.setUint16(12, DOS_TIME, true);
  view.setUint16(14, DOS_DATE, true);
  view.setUint32(16, f.crc, true);
  view.setUint32(20, f.compressedSize, true);
  view.setUint32(24, f.size, true);
  view.setUint16(28, f.name.length, true);
  view.setUint16(30, 0, true); // extra field length
  view.setUint16(32, 0, true); // comment length
  view.setUint16(34, 0, true); // disk number start
  view.setUint16(36, 0, true); // internal attributes
  view.setUint32(38, 0, true); // external attributes
  view.setUint32(42, f.offset, true);
  return out;
}

function endOfCentralDirectory(
  count: number,
  cdSize: number,
  cdOffset: number,
  comment: Bytes,
): Bytes {
  const out = new Uint8Array(22 + comment.length);
  const view = viewOf(out);
  view.setUint32(0, SIG_EOCD, true);
  view.setUint16(4, 0, true); // disk number
  view.setUint16(6, 0, true); // central directory disk
  view.setUint16(8, count, true); // entries on this disk
  view.setUint16(10, count, true); // total entries
  view.setUint32(12, cdSize, true);
  view.setUint32(16, cdOffset, true);
  view.setUint16(20, comment.length, true);
  out.set(comment, 22);
  return out;
}

function hasNonAscii(bytes: Bytes): boolean {
  return bytes.some((b) => b > 0x7f);
}

/**
 * Builds the ZIP. No canvas or `Spec`: it takes the finished bytes, as the test
 * requires.
 *
 * @param comment Goes in the EOCD comment field, where a quick reader looks
 * before opening the central directory.
 */
export async function buildJpegZip(
  entries: JpegZipEntry[],
  comment = "",
  signal?: AbortSignal,
): Promise<Bytes> {
  if (entries.length > MAX_ENTRIES) {
    throw new Error(
      `A ZIP supports ${MAX_ENTRIES} entries, but ${entries.length} were requested.`,
    );
  }

  const locals: Bytes[] = [];
  const central: Bytes[] = [];
  let offset = 0;

  for (const entry of entries) {
    checkAbort(signal);
    const name = UTF8.encode(entry.name);
    if (name.length > MAX_NAME_BYTES) {
      throw new Error(
        `Filename too long for a ZIP (${name.length} bytes, maximum ${MAX_NAME_BYTES}).`,
      );
    }
    const deflated = await deflateRaw(entry.data);
    // JPEG (and PNG) are already compressed: if deflate does not save a byte,
    // store the entry. This is valid and avoids decompressing twice on every
    // extraction.
    const compressed = deflated.length < entry.data.length;
    const payload = compressed ? deflated : entry.data;
    const fields: ZipFields = {
      name,
      flags: hasNonAscii(name) ? FLAG_UTF8 : 0,
      method: compressed ? METHOD_DEFLATE : METHOD_STORE,
      crc: crc32(entry.data),
      compressedSize: payload.length,
      size: entry.data.length,
      offset,
    };
    const block = concatBytes([localHeader(fields), name, payload]);
    locals.push(block);
    central.push(concatBytes([centralHeader(fields), name]));
    offset += block.length;
  }

  const directory = concatBytes(central);
  // The central directory starts just where the local headers end, which is
  // what the EOCD declares: if `offset` does not match `directory`, the file
  // cannot be opened even if the headers look perfect.
  return concatBytes([
    ...locals,
    directory,
    endOfCentralDirectory(
      entries.length,
      directory.length,
      offset,
      fitComment(comment),
    ),
  ]);
}

// ── Exporters ─────────────────────────────────────────────────────────────

/**
 * Motion-JPEG AVI. Commonly used for handoff to design or opening in an editor.
 *
 * The browser does not play it: the app preview shows a single frame.
 * The file is still valid and supported by the tools.
 */
export async function exportMjpegAvi(
  spec: Spec,
  onProgress?: ProgressCallback,
  signal?: AbortSignal,
): Promise<ExportResult> {
  checkAbort(signal);
  const totalFrames = frameCount(spec);
  const frames = await renderJpegFrames(
    spec,
    totalFrames,
    onProgress,
    signal,
    [0, 0.85],
  );
  checkAbort(signal);

  onProgress?.({ progress: 0.9, message: "Writing AVI…" });
  const avi = buildMjpegAvi(frames, {
    width: spec.width,
    height: spec.height,
    fps: spec.fps,
    meta: buildMetadata(spec),
  });

  const mimeType = mimeFor("mjpeg-avi");
  const blob = new Blob([avi], { type: mimeType });
  onProgress?.({ progress: 1, message: "Done" });
  return {
    blob,
    filename: filenameForSpec(spec, "mjpeg-avi"),
    mimeType,
    size: blob.size,
  };
}

/** JPEG sequence in a ZIP, with metadata inside and in the comment. */
export async function exportJpegZip(
  spec: Spec,
  onProgress?: ProgressCallback,
  signal?: AbortSignal,
): Promise<ExportResult> {
  checkAbort(signal);
  const totalFrames = frameCount(spec);
  const frames = await renderJpegFrames(
    spec,
    totalFrames,
    onProgress,
    signal,
    [0, 0.8],
  );
  checkAbort(signal);

  onProgress?.({ progress: 0.85, message: "Packing ZIP…" });
  const meta = buildMetadata(spec);
  const entries: JpegZipEntry[] = [
    { name: "metadata.json", data: UTF8.encode(JSON.stringify(meta, null, 2)) },
    ...frames.map((data, i) => ({
      name: `frame_${String(i + 1).padStart(5, "0")}.jpg`,
      data,
    })),
  ];
  const zip = await buildJpegZip(entries, metadataAsText(meta), signal);

  const mimeType = mimeFor("jpeg-zip");
  const blob = new Blob([zip], { type: mimeType });
  onProgress?.({ progress: 1, message: "Done" });
  return {
    blob,
    filename: filenameForSpec(spec, "jpeg-zip"),
    mimeType,
    size: blob.size,
  };
}
