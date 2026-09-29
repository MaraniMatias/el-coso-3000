import { APP_NAME, REPO_URL, type Spec } from './types';

/**
 * Metadata que se escribe dentro de todos los archivos generados.
 *
 * Cada contenedor la expresa a su manera, así que los encoders llaman a
 * `buildMetadata` y después latraducen. El contenido no debería cambiar
 * entre formatos.
 */
export interface FileMetadata {
  /** `el-coso-3000` */
  software: string;
  /** `Generado por el-coso-3000` */
  comment: string;
  /** URL del repo. */
  source: string;
  /** `Placeholder 1920x1080` */
  title: string;
  description: string;
  // Contexto del placeholder, útil al inspeccionar el archivo a mano.
  width: number;
  height: number;
  palette: string;
  /** Paleta pastel, `#RRGGBB`, sólo imagen. */
  background: string;
  foreground: string;
  /** Sólo video y formatos animados. */
  duration?: string;
  fps?: string;
}

export function buildMetadata(spec: Spec): FileMetadata {
  const dims = `${spec.width}x${spec.height}`;
  const isAnimated = spec.duration > 0;
  const description =
    `Placeholder ${dims}. Fondo #${spec.bg}, texto #${spec.fg}, paleta ${spec.paletteName}.` +
    (isAnimated ? ` ${spec.duration}s a ${spec.fps} fps, en bucle.` : ' Imagen estática.');

  return {
    software: APP_NAME,
    comment: `Generado por ${APP_NAME}`,
    source: REPO_URL,
    title: `Placeholder ${dims}`,
    description,
    width: spec.width,
    height: spec.height,
    palette: spec.paletteName,
    background: `#${spec.bg}`,
    foreground: `#${spec.fg}`,
    ...(isAnimated ? { duration: `${spec.duration}s`, fps: `${spec.fps}` } : {}),
  };
}

/** Bloque listo para escribir en un contenedor de texto (SVG, XMP, COM de AVI). */
export function metadataAsText(meta: FileMetadata): string {
  return [
    `Software: ${meta.software}`,
    `Comment: ${meta.comment}`,
    `Source: ${meta.source}`,
    `Title: ${meta.title}`,
    `Description: ${meta.description}`,
  ].join('\n');
}

/** Pares clave/valor planos, para chunks tipo `tEXt` o campos `INFO`. */
export function metadataAsPairs(meta: FileMetadata): Array<[string, string]> {
  return [
    ['Software', meta.software],
    ['Comment', meta.comment],
    ['Source', meta.source],
    ['Title', meta.title],
    ['Description', meta.description],
    ['Placeholder', `${meta.width}x${meta.height}`],
    ['Palette', meta.palette],
    ['Background', meta.background],
    ['Foreground', meta.foreground],
    ...(meta.duration ? ([['Duration', meta.duration], ['FPS', meta.fps ?? '']] as Array<[string, string]>) : []),
  ];
}
