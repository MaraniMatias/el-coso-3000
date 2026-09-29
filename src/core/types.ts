/**
 * Contratos compartidos de el-coso-3000.
 *
 * Todo el app (UI, encoders, preview) habla únicamente a través de `Spec`.
 * Si cambiás la forma de `Spec`, tocá los encoders en el mismo commit.
 */

/** Identidad de la herramienta. Aparece en la metadata de todo archivo generado. */
export const APP_NAME = 'el-coso-3000';

/**
 * URL del repo. Cambiala acá y se propaga a la metadata de los archivos
 * generados y al pie de la UI.
 */
export const REPO_URL = 'https://github.com/elcoso3000/el-coso-3000';

/** Tipografía embebida. Montserrat SemiBold (ver `fonts/`). */
export const FONT_FAMILY = 'Montserrat';
export const FONT_WEIGHT = 600;

/** Formatos de imagen estática y animada. */
export const IMAGE_FORMATS = ['png', 'jpeg', 'webp', 'svg', 'gif', 'mjpeg-avi', 'jpeg-zip'] as const;
export type ImageFormat = (typeof IMAGE_FORMATS)[number];

/** Contenedores de video. */
export const VIDEO_FORMATS = ['mp4', 'webm', 'mov', 'mkv'] as const;
export type VideoFormat = (typeof VIDEO_FORMATS)[number];

/** Formatos queH.264 no soporta transparency / que pierden el canal alfa. */
export const FORMATS_WITHOUT_ALPHA: ReadonlySet<ImageFormat | VideoFormat> = new Set<ImageFormat>([
  'jpeg',
  'mjpeg-avi',
  'jpeg-zip',
]);

/** Niveles de conformidad WCAG 2.1 para contraste de texto normal. */
export type ContrastLevel = 'AAA' | 'AA' | 'AA-large' | 'fail';

export interface ContrastResult {
  /** Ratio de contraste, ej. `7.24`. */
  ratio: number;
  /** Ratio formateado con dos decimales, ej. `7.24:1`. */
  label: string;
  level: ContrastLevel;
}

export interface PaletteEntry {
  /** Identificador estable, usado en el nombre del archivo. Ej. `rose`. */
  name: string;
  /** Etiqueta legible en la UI, en español. Ej. `Rosa`. */
  label: string;
  /** Tono base en grados, 0–360. */
  hue: number;
  bg: string;
  fg: string;
  contrast: ContrastResult;
}

/**
 * Descripción completa de un placeholder. Es la única entrada que aceptan
 * `drawFrame` y todos los encoders.
 */
export interface Spec {
  width: number;
  height: number;

  /** Fondo, hex de 6 dígitos sin `#`, ej. `FFE4E4`. */
  bg: string;
  /** Texto, hex de 6 dígitos sin `#`. */
  fg: string;

  /** Nombre de la paleta de la que salió `bg`/`fg`. `custom` si fue manual. */
  paletteName: string;

  /**
   * Texto del frame. Por diseño solo contiene las dimensiones.
   * Se recalcula desde `width`/`height` salvo que se pase explícitamente.
   */
  label?: string;

  // --- Video ---
  /** Duración en segundos. */
  duration: number;
  /** FPS pedido por el usuario. */
  fps: number;
  /** Dibuja la barra de progreso al pie. */
  showProgressBar: boolean;
  /** Dibuja `0:03 / 0:10` sobre la barra. */
  showTime: boolean;

  // --- Imagen estática ---
  /** JPEG/WebP quality 0..1. */
  quality: number;
}

export type ProgressCallback = (info: ProgressInfo) => void;

export interface ProgressInfo {
  /** 0..1. */
  progress: number;
  /** Frames ya procesados, cuando aplica. */
  frame?: number;
  /** Frames totales, cuando aplica. */
  totalFrames?: number;
  /** Etiqueta lista para mostrar, ej. `Codificando 120/300`. */
  message?: string;
}

/**
 * Resultado de toda exportación. `filename` ya incluye las dimensiones.
 */
export interface ExportResult {
  blob: Blob;
  filename: string;
  /** MIME type resultante. */
  mimeType: string;
  /** Bytes. */
  size: number;
}

/** Firma común de los 7 exportadores. */
export type Exporter<TFormat extends string> = (
  spec: Spec,
  format: TFormat,
  onProgress?: ProgressCallback,
  signal?: AbortSignal,
) => Promise<ExportResult>;
