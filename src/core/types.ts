/**
 * Contracts shared across el-coso-3000.
 *
 * The whole app (UI, encoders, preview) talks only through `Spec`. If the
 * shape of `Spec` changes, the encoders have to change in the same commit.
 */

/** Tool identity. It ends up in the metadata of every generated file. */
export const APP_NAME = 'El Coso 3000';

/** Released version, written to the metadata of every generated file. */
export const APP_VERSION = '1.0.0';

/** Author, as it appears in the metadata of the page. */
export const AUTHOR = 'Matias Ezequiel Marani';

/**
 * URL of the repo. Change it here and it propagates to the metadata of the
 * generated files and to the footer of the UI.
 */
export const REPO_URL = 'https://github.com/MaraniMatias/el-coso-3000';

/** License of the code and of the generated files, as stated in `LICENSE`. */
export const LICENSE = 'MIT';
export const LICENSE_URL = `${REPO_URL}/blob/main/LICENSE`;

/** Embedded typeface. Montserrat SemiBold (see `fonts/`). */
export const FONT_FAMILY = 'Montserrat';
export const FONT_WEIGHT = 600;

/** Static and animated image formats. */
export const IMAGE_FORMATS = ['png', 'jpeg', 'webp', 'svg', 'gif', 'mjpeg-avi', 'jpeg-zip'] as const;
export type ImageFormat = (typeof IMAGE_FORMATS)[number];

/** Video containers. */
export const VIDEO_FORMATS = ['mp4', 'webm', 'mov', 'mkv'] as const;
export type VideoFormat = (typeof VIDEO_FORMATS)[number];

/**
 * Everything with a timeline, which is what the video tab produces: the real
 * containers plus the image formats that carry a timeline of their own.
 */
export const TIMELINE_FORMATS = ['mp4', 'webm', 'mov', 'mkv', 'gif', 'mjpeg-avi', 'jpeg-zip'] as const;
export type TimelineFormat = (typeof TIMELINE_FORMATS)[number];

/**
 * Test sounds a video can carry. They exist to prove the file has an audio
 * track and that it stays in sync, not to be listened to: a soft beep every
 * second, a quiet continuous tone, and white noise. A `Spec` without one is
 * silent, which is the default.
 */
export const VIDEO_TONES = ['beep', 'tone', 'noise'] as const;
export type VideoTone = (typeof VIDEO_TONES)[number];

/**
 * Formats that cannot carry an alpha channel: JPEG by definition, and the
 * video containers, whose encoders (H.264, VP8/VP9, AV1 as configured here)
 * are fed frames without alpha. The GIF is not in this list: it is binary
 * transparent and the encoder already reserves an index for it.
 */
export const FORMATS_WITHOUT_ALPHA: ReadonlySet<ImageFormat | VideoFormat> = new Set<ImageFormat | VideoFormat>([
  'jpeg',
  'mjpeg-avi',
  'jpeg-zip',
  'mp4',
  'mov',
  'mkv',
  'webm',
]);

/** True when the format can store transparent pixels. */
export function supportsAlpha(format: ImageFormat | VideoFormat): boolean {
  return !FORMATS_WITHOUT_ALPHA.has(format);
}

/** WCAG 2.1 conformance levels for normal-size text. */
export type ContrastLevel = 'AAA' | 'AA' | 'AA-large' | 'fail';

export interface ContrastResult {
  /** Contrast ratio, e.g. `7.24`. */
  ratio: number;
  /** Formatted with two decimals, e.g. `7.24:1`. */
  label: string;
  level: ContrastLevel;
}

export interface PaletteEntry {
  /** Stable identifier, used in the file name. E.g. `rose`. */
  name: string;
  /** Readable label in the UI. E.g. `Rose`. */
  label: string;
  /** Base hue in degrees, 0-360. */
  hue: number;
  bg: string;
  fg: string;
  contrast: ContrastResult;
}

/**
 * Full description of a placeholder. It is the only input accepted by
 * `drawFrame` and by every encoder.
 */
export interface Spec {
  width: number;
  height: number;

  /** Background, 6-digit hex without `#`, e.g. `FFE4E4`. */
  bg: string;
  /** Text, 6-digit hex without `#`. */
  fg: string;

  /** Name of the palette `bg`/`fg` came from. `custom` when picked by hand. */
  paletteName: string;

  /**
   * Frame text. By design it only holds the dimensions. It is recomputed from
   * `width`/`height` unless it is passed explicitly.
   */
  label?: string;

  // --- Video ---
  /** Duration in seconds. */
  duration: number;
  /** Requested FPS. */
  fps: number;
  /** Draws a progress bar at the bottom. */
  showProgressBar: boolean;
  /** Draws the `0:03 / 0:10` clock over the progress bar. */
  showTime: boolean;

  /**
   * Leaves the background unpainted, so the file carries an alpha channel.
   *
   * The background color still decides the text color: with no background to
   * contrast against, `fg` is still derived from `bg` so the placeholder keeps
   * a readable pairing wherever it lands. Only the fill is skipped.
   */
  transparent: boolean;
  /**
   * Test sound for a video export. Absent means silent: sound is opt-in, and
   * only the video containers can take it.
   */
  tone?: VideoTone;

  // --- Still image ---
  /** JPEG/WebP quality 0..1. */
  quality: number;
}

export type ProgressCallback = (info: ProgressInfo) => void;

export interface ProgressInfo {
  /** 0..1. */
  progress: number;
  /** Frame index, when it applies. */
  frame?: number;
  /** Total frames, when it applies. */
  totalFrames?: number;
  /** Ready-to-show string, e.g. `Encoding 120/300`. */
  message?: string;
}

/**
 * Result of any export. `filename` already includes the dimensions.
 */
export interface ExportResult {
  blob: Blob;
  filename: string;
  /** Resulting MIME type. */
  mimeType: string;
  /** Size in bytes. */
  size: number;
}

/** Shared signature of the 7 exporters. */
export type Exporter<TFormat extends string> = (
  spec: Spec,
  format: TFormat,
  onProgress?: ProgressCallback,
  signal?: AbortSignal,
) => Promise<ExportResult>;
