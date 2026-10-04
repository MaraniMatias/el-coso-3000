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
 * Sounds a video can carry. A `Spec` without one is silent, which is the
 * default.
 *
 * The first three are test sounds: they exist to prove the file has an audio
 * track and that it stays in sync, not to be listened to. The tango is the odd
 * one, a synthesized tango nuevo for when the placeholder should not be silent
 * in the room it plays in, and it is the default when sound is asked for.
 */
export const VIDEO_TONES = ['tango', 'beep', 'tone', 'noise'] as const;
export type VideoTone = (typeof VIDEO_TONES)[number];

/** The sound chosen when the box is ticked without picking one. */
export const DEFAULT_VIDEO_TONE: VideoTone = 'tango';

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

/**
 * Animated blurred-sphere backgrounds drawn over the solid color, ported from
 * the CSS demo in `docs/`.
 *
 * `none` is the flat background: it covers both the solid fill and the
 * transparent one, which `Spec.transparent` is the one deciding.
 */
export const TEXTURES = ['none', 'mix', 'fog', 'focus', 'rise'] as const;
export type Texture = (typeof TEXTURES)[number];

/** What the image tab asks for: soft, slow and out of the way of the text. */
export const DEFAULT_IMAGE_TEXTURE: Texture = 'fog';

/** What the video tab asks for: blurred spheres with grain, the liveliest one. */
export const DEFAULT_VIDEO_TEXTURE: Texture = 'mix';

/**
 * How fast the textures move. It divides every animation period, so 2 is twice
 * as fast as the demo in `docs/`.
 *
 * `0` is the low end and not a rounding: it holds the first frame for the whole
 * clip, which is a texture that is painted but not animated. Preview and
 * exports read the same value, so what is on screen is what lands in the file.
 */
export const TEXTURE_SPEEDS = [0, 1, 1.5, 2, 2.5, 3] as const;
export type TextureSpeed = (typeof TEXTURE_SPEEDS)[number];

/** The speed a video asks for when nothing is chosen. */
export const DEFAULT_TEXTURE_SPEED: TextureSpeed = 2;

/**
 * Formats that cannot carry the texture: the SVG is written as text, and the
 * two look different enough that pretending otherwise would be a lie. Every
 * other format paints through the canvas, which is the same path for the
 * preview, the still images and every timeline format.
 */
export const FORMATS_WITHOUT_TEXTURE: ReadonlySet<ImageFormat | VideoFormat> = new Set<ImageFormat | VideoFormat>([
  'svg',
]);

/** True when the format is painted with a canvas, so it can carry a texture. */
export function supportsTexture(format: ImageFormat | VideoFormat): boolean {
  return !FORMATS_WITHOUT_TEXTURE.has(format);
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
   * The background color still decides the text color while the text is being
   * computed from it: with no background to contrast against, `fg` is still the
   * derived one so the placeholder keeps a readable pairing wherever it lands.
   * Only the fill is skipped.
   */
  transparent: boolean;
  /**
   * Animated background drawn over `bg`, or `none` for the flat one.
   *
   * A texture paints the whole frame, so it and `transparent` are exclusive:
   * a textured frame is opaque by definition.
   */
  texture: Texture;
  /**
   * How fast a texture moves, as a multiple of the demo in `docs/`.
   *
   * It only means something with a timeline: a still image draws its single
   * frame at t = 0, where every speed gives the same picture.
   */
  textureSpeed: number;
  /**
   * Soundtrack for a video export. Absent means silent: sound is opt-in, and
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
