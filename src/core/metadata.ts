import { APP_NAME, REPO_URL, type Spec } from './types';

/**
 * Metadata written inside every generated file.
 *
 * Each container expresses it in its own way, so the encoders call
 * `buildMetadata` and then translate it. The content should not change
 * between formats.
 */
export interface FileMetadata {
  /** `El Coso 3000` */
  software: string;
  /** `El Coso 3000` */
  comment: string;
  /** URL of the repo. */
  source: string;
  /** `Placeholder 1920x1080` */
  title: string;
  description: string;
  // Context about the placeholder, useful when inspecting the file by hand.
  width: number;
  height: number;
  palette: string;
  /** Pastel palette, `#RRGGBB`, images only. */
  background: string;
  foreground: string;
  /** Video and animated formats only. */
  duration?: string;
  fps?: string;
}

export function buildMetadata(spec: Spec): FileMetadata {
  const dims = `${spec.width}x${spec.height}`;
  const isAnimated = spec.duration > 0;
  const description =
    `Placeholder ${dims}. Background #${spec.bg}, text #${spec.fg}, palette ${spec.paletteName}.` +
    (isAnimated ? ` ${spec.duration}s at ${spec.fps} fps, on a loop.` : ' Still image.');

  return {
    software: APP_NAME,
    comment: APP_NAME,
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

/** Block ready to write into a text container (SVG, XMP, AVI COM chunk). */
export function metadataAsText(meta: FileMetadata): string {
  return [
    `Software: ${meta.software}`,
    `Comment: ${meta.comment}`,
    `Source: ${meta.source}`,
    `Title: ${meta.title}`,
    `Description: ${meta.description}`,
  ].join('\n');
}

/** Flat key/value pairs, for `tEXt` chunks or `INFO` fields. */
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
