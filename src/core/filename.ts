import type { ImageFormat, Spec, VideoFormat } from "./types";

const EXT: Record<ImageFormat | VideoFormat, string> = {
  png: "png",
  jpeg: "jpg",
  webp: "webp",
  svg: "svg",
  gif: "gif",
  "mjpeg-avi": "avi",
  "jpeg-zip": "zip",
  mp4: "mp4",
  webm: "webm",
  mov: "mov",
  mkv: "mkv",
};

const MIME: Record<ImageFormat | VideoFormat, string> = {
  png: "image/png",
  jpeg: "image/jpeg",
  webp: "image/webp",
  svg: "image/svg+xml",
  gif: "image/gif",
  "mjpeg-avi": "video/x-msvideo",
  "jpeg-zip": "application/zip",
  mp4: "video/mp4",
  webm: "video/webm",
  mov: "video/quicktime",
  mkv: "video/x-matroska",
};

/** Container MIME for WebM, which does distinguish the inner codec. */
export function mimeFor(
  format: ImageFormat | VideoFormat,
  isVideo = false,
): string {
  if (isVideo) {
    // Matroska has no registered MIME. `video/x-matroska` is the one people on
    // the web accept, and the one Chrome and ffmpeg understand.
    if (format === "mp4") return "video/mp4";
    if (format === "mov") return "video/quicktime";
    if (format === "mkv") return "video/x-matroska";
    return `video/${format}`;
  }
  return MIME[format];
}

/**
 * H.264 requires even dimensions for 4:2:0 chroma subsampling. Rounding up is
 * preferable to cropping: the placeholder declares the size it really has, so
 * the name does not lie.
 */
export function evenDimensions(
  width: number,
  height: number,
): { width: number; height: number; changed: boolean } {
  const w = width % 2 === 0 ? width : width + 1;
  const h = height % 2 === 0 ? height : height + 1;
  return { width: w, height: h, changed: w !== width || h !== height };
}

export interface NameParts {
  width: number;
  height: number;
  format: ImageFormat | VideoFormat;
  /** Only for video and the animated formats. */
  fps?: number;
  duration?: number;
  /** Real FPS after quantizing to the GIF delay, in hundredths. */
  effectiveFps?: number;
}

/**
 * The name always starts with the dimensions, which is the first thing anyone
 * wants to know about a placeholder. After that go the parameters that cannot
 * be inferred from the file.
 *
 *   `1920x1080.png`
 *   `1920x1080-15fps.gif`
 *   `1920x1080-30fps-10s.mp4`
 */
export function buildFilename(parts: NameParts): string {
  const ext = EXT[parts.format];
  const dims = `${parts.width}x${parts.height}`;
  const segments: string[] = [dims];

  if (parts.effectiveFps !== undefined && parts.effectiveFps !== parts.fps) {
    // The GIF only takes hundredth delays, so the requested FPS is almost never
    // the one that comes out. The real one is annotated, because that is the
    // one that counts.
    segments.push(`${trimNumber(parts.effectiveFps)}fps`);
  } else if (parts.fps !== undefined) {
    segments.push(`${trimNumber(parts.fps)}fps`);
  }

  if (parts.duration !== undefined) {
    segments.push(`${trimNumber(parts.duration)}s`);
  }

  return `${segments.join("-")}.${ext}`;
}

/**
 * Only the formats with a timeline carry the fps and the duration in the name.
 * A still image has `duration: 0` and a filler fps, so putting them in produces
 * names like `320x240-15fps-0s.png`, which is noise: the `0s` also confuses,
 * because it looks like a video of zero length.
 */
const TIMED_FORMATS: ReadonlySet<ImageFormat | VideoFormat> = new Set<
  ImageFormat | VideoFormat
>(["gif", "mjpeg-avi", "jpeg-zip", "mp4", "webm", "mov", "mkv"]);

/** Name out of a `Spec`. The encoders pass the real dimensions. */
export function filenameForSpec(
  spec: Spec,
  format: ImageFormat | VideoFormat,
  dims?: { width: number; height: number },
): string {
  const timed = TIMED_FORMATS.has(format) && spec.duration > 0;
  return buildFilename({
    width: dims?.width ?? spec.width,
    height: dims?.height ?? spec.height,
    format,
    fps: timed ? spec.fps : undefined,
    duration: timed ? spec.duration : undefined,
  });
}

/** `10` instead of `10.0`, `2.5` instead of `2.50`. */
export function trimNumber(n: number): string {
  return String(Math.round(n * 100) / 100);
}

export { EXT, MIME };
