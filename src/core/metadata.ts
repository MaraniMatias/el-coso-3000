import { checkContrast } from './color';
import {
  APP_NAME,
  APP_VERSION,
  AUTHOR,
  LICENSE,
  LICENSE_URL,
  REPO_URL,
  type ContrastResult,
  type Spec,
} from './types';

/**
 * Metadata written inside every generated file.
 *
 * Each container expresses it in its own way, so the encoders call
 * `buildMetadata` and then translate it with one of the three serializers
 * below. The content must not change between formats: the serializers exist
 * only to encode it, never to decide it.
 */
export interface FileMetadata {
  /** `El Coso 3000` */
  software: string;
  /** `El Coso 3000 1.0.0`, what `exiftool` shows as `XMP Toolkit`. */
  toolkit: string;
  version: string;
  author: string;
  /** `(c) 2026 Matias Ezequiel Marani` */
  copyright: string;
  /** URL of the repo. */
  source: string;
  license: string;
  licenseUrl: string;
  /** `Placeholder 1920x1080` */
  title: string;
  description: string;
  /** Makes clear that the file is not real content. */
  disclaimer: string;
  /** Export instant, formatted per container by the serializers. */
  createdAt: Date;
  // Context about the placeholder, useful when inspecting the file by hand.
  width: number;
  height: number;
  palette: string;
  /** Pastel palette, `#RRGGBB`, images only. */
  background: string;
  foreground: string;
  /** WCAG contrast of `foreground` over `background`. */
  contrast: ContrastResult;
  /** What is actually drawn: the label, or the dimensions when there is none. */
  text: string;
  /** Animated background over `background`, only when it is not the flat one. */
  texture?: string;
  /** How fast that background moves, only with a timeline to move it on. */
  textureSpeed?: string;
  /** Encoder quality, only for the formats where it changes the bytes. */
  quality?: string;
  /** Video and animated formats only. */
  duration?: string;
  fps?: string;
}

/** Options that depend on the encoder, not on the placeholder itself. */
export interface BuildMetadataOptions {
  /** Injectable clock, so tests do not depend on the wall clock. */
  now?: Date;
  /** Encoder quality (0-1), only when the format really applies it. */
  quality?: number;
}

export function buildMetadata(
  spec: Spec,
  opts: BuildMetadataOptions = {},
): FileMetadata {
  const dims = `${spec.width}x${spec.height}`;
  const isAnimated = spec.duration > 0;
  const contrast = checkContrast(spec.fg, spec.bg);
  const { ratio, label: contrastLabel, level } = contrast;
  const createdAt = opts.now ?? new Date();

  const description =
    `Placeholder ${dims}, palette ${spec.paletteName}, contrast ${contrastLabel} (${level}).` +
    (isAnimated ? ` ${spec.duration}s at ${spec.fps} fps, on a loop.` : ' Still image.');

  return {
    software: APP_NAME,
    toolkit: `${APP_NAME} ${APP_VERSION}`,
    version: APP_VERSION,
    author: AUTHOR,
    // `(c)` and not `©`: RIFF `INFO` and GIF comments have no charset field, so
    // a reader that assumes Latin-1 turns the UTF-8 glyph into `Â©`.
    copyright: `(c) ${createdAt.getFullYear()} ${AUTHOR}`,
    source: REPO_URL,
    license: LICENSE,
    licenseUrl: LICENSE_URL,
    title: `Placeholder ${dims}`,
    description,
    disclaimer: 'Locally generated placeholder, not real content.',
    createdAt,
    width: spec.width,
    height: spec.height,
    palette: spec.paletteName,
    background: `#${spec.bg}`,
    foreground: `#${spec.fg}`,
    contrast,
    // Same normalization as `layoutDimensions`: newlines become spaces so the
    // value stays a single line, which the `iTXt` chunks need.
    text: spec.label ? spec.label.replace(/\s*\n+\s*/g, ' ').trim() : dims,
    // Only worth a keyword when there is something to say: a flat background is
    // what every file has had, and a flat background is not news.
    ...(spec.texture !== 'none' ? { texture: spec.texture } : {}),
    // The speed is only a fact about the file when there is a timeline to move
    // it on: a single frame is the same picture at 1x and at 3x.
    ...(spec.texture !== 'none' && isAnimated
      ? { textureSpeed: `${spec.textureSpeed}x` }
      : {}),
    ...(opts.quality === undefined
      ? {}
      : { quality: `${Math.round(opts.quality * 100)}%` }),
    ...(isAnimated ? { duration: `${spec.duration}s`, fps: `${spec.fps}` } : {}),
  };
}

/**
 * Prefix of the keywords this app owns.
 *
 * Unprefixed private keywords (`Palette`, `Background`) show up as unknown tags
 * in the PNG group, which is noise for anything reading the file. Prefixed, they
 * show as `El Coso 3000 Palette` and are grouped as one namespace.
 */
export const KEYWORD_PREFIX = 'ElCoso3000:';

/**
 * ISO 8601 in UTC, which is what `xmp:CreateDate` expects.
 */
function isoTime(date: Date): string {
  return date.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * RFC 1123 in local time, the format of the PNG `tIME` chunk, for the
 * `Creation Time` keyword.
 *
 * The PNG spec suggests ISO 8601 here, but that is what `exiftool` rejects:
 * its `ConvertPNGDate` only understands the `tIME` layout and warns
 * "Non standard PNG date/time format" under `-validate` for anything else.
 * The numeric offset keeps the instant unambiguous.
 */
function pngTime(date: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  const minutes = Math.abs(date.getTimezoneOffset());
  const offset = `${date.getTimezoneOffset() <= 0 ? '+' : '-'}${p(Math.floor(minutes / 60))}${p(minutes % 60)}`;
  return (
    `${WEEKDAYS[date.getDay()]}, ${date.getDate()} ${MONTHS[date.getMonth()]} ${date.getFullYear()} ` +
    `${p(date.getHours())}:${p(date.getMinutes())}:${p(date.getSeconds())} ${offset}`
  );
}

/** `6.80:1 (AA)`, the contrast as one readable value. */
function contrastText(meta: FileMetadata): string {
  return `${meta.contrast.label} (${meta.contrast.level})`;
}

/**
 * Language alternative, the form Adobe writes for `dc:title` and friends.
 *
 * A bare `<dc:title>text</dc:title>` is well-formed XML and `exiftool` reads
 * it, but it is not the form the XMP schema describes, and tools that go
 * through a real RDF parser see an empty value instead of the text. `x-default`
 * is the slot those tools fall back to.
 */
function alt(text: string): string {
  return `<rdf:Alt><rdf:li xml:lang="x-default">${esc(text)}</rdf:li></rdf:Alt>`;
}

/**
 * The metadata as an ordered list of flat keywords, for `iTXt` chunks or AVI
 * `INFO` fields.
 *
 * Standard keywords first, then the ones this app owns behind
 * `KEYWORD_PREFIX`. Each technical datum appears exactly once per layer: the
 * flat layer is for tools that do not read XMP (Finder, Explorer, simple
 * viewers), the XMP layer is for Lightroom, Photoshop and scripts.
 */
export function metadataAsPairs(meta: FileMetadata): Array<[string, string]> {
  const own: Array<[string, string]> = [
    ['Version', meta.version],
    ['Placeholder', `${meta.width}x${meta.height}`],
    ['Palette', meta.palette],
    ['Background', meta.background],
    ['Foreground', meta.foreground],
    ['Contrast', contrastText(meta)],
    ['Text', meta.text],
    ...(meta.texture ? ([['Texture', meta.texture]] as Array<[string, string]>) : []),
    ...(meta.textureSpeed ? ([['Texture Speed', meta.textureSpeed]] as Array<[string, string]>) : []),
    ...(meta.quality ? ([['Quality', meta.quality]] as Array<[string, string]>) : []),
    ...(meta.duration
      ? ([['Duration', meta.duration], ['FPS', meta.fps ?? '']] as Array<[string, string]>)
      : []),
  ];

  return [
    ['Software', meta.software],
    ['Title', meta.title],
    ['Description', meta.description],
    ['Author', meta.author],
    ['Copyright', meta.copyright],
    ['Source', meta.source],
    ['Disclaimer', meta.disclaimer],
    ['Creation Time', pngTime(meta.createdAt)],
    ...own.map(([key, value]) => [`${KEYWORD_PREFIX}${key}`, value] as [string, string]),
  ];
}

/**
 * Block ready to write into a text container (SVG `<metadata>`, JPEG `COM`,
 * GIF comment, video `comment`, ZIP comment).
 *
 * Built from the same list as the pairs, so the two layers cannot drift. Only
 * the prefix is spelled out, the way a person would read it.
 */
export function metadataAsText(meta: FileMetadata): string {
  return metadataAsPairs(meta)
    .map(([key, value]) =>
      key.startsWith(KEYWORD_PREFIX)
        ? `${APP_NAME} ${key.slice(KEYWORD_PREFIX.length)}: ${value}`
        : `${key}: ${value}`,
    )
    .join('\n');
}

// ── XML ────────────────────────────────────────────────────────────────────

const XML_ENTITIES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&apos;',
};

/** Escapes anything that could break a text node or attribute. */
export function esc(text: string): string {
  return text.replace(/[&<>"']/g, (c) => XML_ENTITIES[c] ?? c);
}

// ── XMP ────────────────────────────────────────────────────────────────────

/** Private namespace, versioned so the vocabulary can grow without collisions. */
const EC3K_NS = 'https://github.com/MaraniMatias/el-coso-3000/ns/1.0/';

/** `xmp:`, `dc:`, `xmpRights:` and the app's own `ec3k:` properties, in order. */
function xmpProperties(meta: FileMetadata): string {
  const own: Array<[string, string]> = [
    ['SoftwareVersion', meta.version],
    ['Placeholder', `${meta.width}x${meta.height}`],
    ['Palette', meta.palette],
    ['Background', meta.background],
    ['Foreground', meta.foreground],
    ['Contrast', contrastText(meta)],
    ['Text', meta.text],
    ...(meta.texture ? ([['Texture', meta.texture]] as Array<[string, string]>) : []),
    ...(meta.textureSpeed ? ([['TextureSpeed', meta.textureSpeed]] as Array<[string, string]>) : []),
    // No standard XMP property carries "this is not real content".
    ['Disclaimer', meta.disclaimer],
    ...(meta.quality ? ([['Quality', meta.quality]] as Array<[string, string]>) : []),
    ...(meta.duration
      ? ([['Duration', meta.duration], ['FramesPerSecond', meta.fps ?? '']] as Array<[string, string]>)
      : []),
  ];

  return [
    `<xmp:CreatorTool>${esc(meta.software)}</xmp:CreatorTool>`,
    `<xmp:CreateDate>${isoTime(meta.createdAt)}</xmp:CreateDate>`,
    `<dc:title>${alt(meta.title)}</dc:title>`,
    `<dc:description>${alt(meta.description)}</dc:description>`,
    // A sequence, not text: that is the range `dc:creator` is defined with.
    `<dc:creator><rdf:Seq><rdf:li>${esc(meta.author)}</rdf:li></rdf:Seq></dc:creator>`,
    // Dublin Core keeps the two apart: the rights holder and where the file
    // came from are different facts.
    `<dc:rights>${alt(meta.copyright)}</dc:rights>`,
    `<dc:source>${esc(meta.source)}</dc:source>`,
    `<xmpRights:WebStatement>${esc(meta.licenseUrl)}</xmpRights:WebStatement>`,
    `<xmpRights:UsageTerms>${alt(`${meta.license} License`)}</xmpRights:UsageTerms>`,
    ...own.map(([name, value]) => `<ec3k:${name}>${esc(value)}</ec3k:${name}>`),
  ].join('');
}

/**
 * XMP packet, for the PNG `iTXt`, the WebP `XMP ` chunk and the JPEG `APP1`.
 *
 * Standard properties come from `xmp:`/`dc:`/`xmpRights:`, and the technical
 * ones from the app's own namespace, so `exiftool` groups them instead of
 * listing them as unknown tags.
 */
export function metadataAsXmp(meta: FileMetadata): Uint8Array {
  const packet = [
    '<?xpacket begin="" id="W5M0MpCehiHzreSzNTczkc9d"?>',
    // `x:xmptk` is how a writer declares itself; exiftool surfaces it as
    // `XMP Toolkit`.
    `<x:xmpmeta xmlns:x="adobe:ns:meta/" x:xmptk="${esc(meta.toolkit)}">`,
    '<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">',
    `<rdf:Description rdf:about="" xmlns:xmp="http://ns.adobe.com/xap/1.0/"` +
      ` xmlns:dc="http://purl.org/dc/elements/1.1/"` +
      ` xmlns:xmpRights="http://ns.adobe.com/xap/1.0/rights/"` +
      ` xmlns:ec3k="${EC3K_NS}">`,
    xmpProperties(meta),
    '</rdf:Description></rdf:RDF></x:xmpmeta>',
    '<?xpacket end="w"?>',
  ].join('');
  return new TextEncoder().encode(packet);
}
