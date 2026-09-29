import type { ImageFormat, Spec, VideoFormat } from './types';

const EXT: Record<ImageFormat | VideoFormat, string> = {
  png: 'png',
  jpeg: 'jpg',
  webp: 'webp',
  svg: 'svg',
  gif: 'gif',
  'mjpeg-avi': 'avi',
  'jpeg-zip': 'zip',
  mp4: 'mp4',
  webm: 'webm',
  mov: 'mov',
  mkv: 'mkv',
};

const MIME: Record<ImageFormat | VideoFormat, string> = {
  png: 'image/png',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  gif: 'image/gif',
  'mjpeg-avi': 'video/x-msvideo',
  'jpeg-zip': 'application/zip',
  mp4: 'video/mp4',
  webm: 'video/webm',
  mov: 'video/quicktime',
  mkv: 'video/x-matroska',
};

/** MIME del contenedor para WebM, que sí distingue el códec interno. */
export function mimeFor(format: ImageFormat | VideoFormat, isVideo = false): string {
  if (isVideo) {
    // Matroska no tiene un MIME registrado. `video/x-matroska` es el que
    // acepta la gente de la web, y es lo que entienden Chrome y ffmpeg.
    if (format === 'mp4') return 'video/mp4';
    if (format === 'mov') return 'video/quicktime';
    if (format === 'mkv') return 'video/x-matroska';
    return `video/${format}`;
  }
  return MIME[format];
}

/**
 * H.264 exige dimensiones pares para el muestreo 4:2:0. Redondear hacia arriba
 * es preferible a recortar: el placeholder se declara con el tamaño que
 * realmente tiene, así que el nombre no miente.
 */
export function evenDimensions(width: number, height: number): { width: number; height: number; changed: boolean } {
  const w = width % 2 === 0 ? width : width + 1;
  const h = height % 2 === 0 ? height : height + 1;
  return { width: w, height: h, changed: w !== width || h !== height };
}

export interface NameParts {
  width: number;
  height: number;
  format: ImageFormat | VideoFormat;
  /** Sólo para video y formatos animados. */
  fps?: number;
  duration?: number;
  /** FPS real tras cuantizar al delay del GIF, en centésimas. */
  effectiveFps?: number;
}

/**
 * El nombre siempre arranca por las dimensiones, que es lo primero que uno
 * quiere saber de un placeholder. Después van los parámetros que no se
 * deducen del archivo.
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
    // El GIF sólo admite delay en centésimas, así que el FPS pedido casi nunca
    // es el que sale. Se anota el real, que es el que vale.
    segments.push(`${trimNumber(parts.effectiveFps)}fps`);
  } else if (parts.fps !== undefined) {
    segments.push(`${trimNumber(parts.fps)}fps`);
  }

  if (parts.duration !== undefined) {
    segments.push(`${trimNumber(parts.duration)}s`);
  }

  return `${segments.join('-')}.${ext}`;
}

/**
 * Sólo los formatos con una línea de tiempo llevan fps y duración en el
 * nombre. Una imagen fija tiene `duration: 0` y `fps` de relleno, así que
 * ponerlos produce nombres como `320x240-15fps-0s.png`, que son ruido: el
 * `0s` además confunde, porque parece un video de duración cero.
 */
const TIMED_FORMATS: ReadonlySet<ImageFormat | VideoFormat> = new Set<ImageFormat | VideoFormat>([
  'gif',
  'mjpeg-avi',
  'jpeg-zip',
  'mp4',
  'webm',
  'mov',
  'mkv',
]);

/** Nombre a partir de un `Spec`. Los encoders pasan las dimensiones reales. */
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

/** `10` en vez de `10.0`, `2.5` en vez de `2.50`. */
export function trimNumber(n: number): string {
  return String(Math.round(n * 100) / 100);
}

export { EXT, MIME };
