/**
 * Exportadores de imagen estática: PNG, JPEG, WebP y SVG.
 *
 * Los cuatro caminos salen del mismo `drawFrame`, así que el rástero y el
 * vector no pueden divergir. La diferencia es sólo el último tramo: los tres
 * rásteros pasan por `toBlob`, y el SVG se emite a mano reusando el layout del
 * core (`layoutDimensions` / `layoutLine`) para no reimplementar el auto-ajuste.
 *
 * `toBlob` no expone ningún hook para escribir metadata, así que la metadata se
 * inyecta en los bytes después de codificar: chunks `tEXt` en PNG, un segmento
 * `COM` en JPEG y un chunk `XMP ` en WebP. Son las tres inyecciones
 * consecutivas, pero es el único camino que hay para cumplir el requisito de
 * que el archivo lleve los datos dentro.
 */

import { hexToRgba } from '../core/color';
import { drawFrame, frameGeometry, timecode } from '../core/draw-frame';
import { filenameForSpec, mimeFor } from '../core/filename';
import { FONT_FACE_CSS, FONT_STACK } from '../core/font';
import { layoutDimensions, layoutLine, paddingFor, type TextLayout } from '../core/fit-text';
import { buildMetadata, metadataAsPairs, metadataAsText, type FileMetadata } from '../core/metadata';
import { FONT_WEIGHT, type ExportResult, type ProgressCallback, type Spec } from '../core/types';

export type StillImageFormat = 'png' | 'jpeg' | 'webp' | 'svg';

/** Formatos donde `quality` significa algo. En PNG no tiene efecto. */
const QUALITY_FORMATS = new Set<StillImageFormat>(['jpeg', 'webp']);

/** Nombre legible para los mensajes de error. */
const FORMAT_LABEL: Record<StillImageFormat, string> = {
  png: 'PNG',
  jpeg: 'JPEG',
  webp: 'WebP',
  svg: 'SVG',
};

/**
 * Opacidad de la guía de la barra. Tiene que coincidir con `TRACK_ALPHA` de
 * `draw-frame.ts`; no se exporta desde el core porque sólo la usa el pie.
 */
const TRACK_ALPHA = 0.16;

/** Cualquier lienzo en el que se pueda dibujar. */
type Surface = HTMLCanvasElement | OffscreenCanvas;

/**
 * Bytes recién asignados. El genérico importa: `Blob` sólo acepta vistas sobre
 * un `ArrayBuffer` real, y un `Uint8Array` pelado se tipa como potencialmente
 * compartido.
 */
type Bytes = Uint8Array<ArrayBuffer>;

// ── Lienzo ───────────────────────────────────────────────────────────────

function abortError(): DOMException {
  return new DOMException('Exportación cancelada', 'AbortError');
}

function checkAbort(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError();
}

function createSurface(width: number, height: number): Surface {
  if (typeof OffscreenCanvas === 'function') return new OffscreenCanvas(width, height);
  if (typeof document !== 'undefined') {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    return canvas;
  }
  throw new Error('No hay canvas disponible: se necesita OffscreenCanvas o un documento.');
}

function context2d(surface: Surface): CanvasRenderingContext2D {
  const ctx = surface.getContext('2d');
  if (!ctx) throw new Error('El navegador no entregó un contexto 2D para el canvas.');
  // `OffscreenCanvasRenderingContext2D` no es `CanvasRenderingContext2D` en los
  // tipos (le faltan `reset`, `isContextLost`, `drawFocusIfNeeded`), pero trae
  // el mismo subconjunto de dibujo y medición que usa el core, así que para
  // `drawFrame` y el layout son intercambiables.
  return ctx as CanvasRenderingContext2D;
}

function releaseSurface(surface: Surface): void {
  // Dejar la superficie en cero suelta el backing store en el acto. Esperar al
  // GC deja varios MB de allocations de GPU vivos si el usuario exporta en ráfaga.
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
  const unsupported = () => new Error(`Este navegador no puede exportar ${FORMAT_LABEL[format]}. Probá con otro formato.`);

  // `OffscreenCanvas` no tiene `toBlob`: expone `convertToBlob`, que es el
  // mismo concepto con promesas en vez de callback.
  if ('convertToBlob' in surface) {
    return surface
      .convertToBlob(QUALITY_FORMATS.has(format) ? { type, quality } : { type })
      .then((blob) => {
        // `toBlob`/`convertToBlob` no observan el `AbortSignal`, así que el
        // flag se mira a mano cuando vuelven.
        checkAbort(signal);
        if (!blob) throw unsupported();
        return blob;
      });
  }

  return new Promise<Blob>((resolve, reject) => {
    surface.toBlob((blob) => {
      if (signal?.aborted) return reject(abortError());
      if (!blob) return reject(unsupported());
      resolve(blob);
    }, type, quality);
  });
}

// ── CRC32 ────────────────────────────────────────────────────────────────

/** Tabla del polinomio reflejado 0xEDB88320, el que exige la spec de PNG. */
const CRC_TABLE = ((): Uint32Array => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let bit = 0; bit < 8; bit++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c >>> 0;
  }
  return table;
})();

/** CRC32 (polinomio 0xEDB88320), el que exige la spec de PNG. */
export function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = (CRC_TABLE[(c ^ bytes[i]!) & 0xff] ?? 0) ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// ── Utilidades de bytes ───────────────────────────────────────────────────

function fourCC(bytes: Uint8Array, offset: number): string {
  return String.fromCharCode(bytes[offset] ?? 0, bytes[offset + 1] ?? 0, bytes[offset + 2] ?? 0, bytes[offset + 3] ?? 0);
}

function viewOf(bytes: Uint8Array): DataView {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

function matchesAt(bytes: Uint8Array, offset: number, expected: readonly number[]): boolean {
  return expected.every((b, i) => bytes[offset + i] === b);
}

// ── PNG ───────────────────────────────────────────────────────────────────

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] as const;

/** Arma un chunk PNG: largo BE, tipo ASCII, datos, CRC32 de tipo+datos. */
export function pngChunk(type: string, data: Uint8Array): Bytes {
  const out = new Uint8Array(12 + data.length);
  const view = viewOf(out);
  view.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  // El CRC se calcula sobre tipo + datos, nunca sobre el largo.
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

/**
 * Inserta chunks ya armados justo antes del `IEND`.
 *
 * El `IEND` tiene que seguir siendo el último chunk: si no, los decodificadores
 * lo toman como basura y el PNG no abre. Por eso se lo busca recorriendo desde
 * el `IHDR` en vez de asumir que está al final a ciegas.
 */
export function insertPngChunks(png: Uint8Array, chunks: Bytes[]): Bytes {
  if (!matchesAt(png, 0, PNG_SIGNATURE)) throw new Error('No es un PNG: la firma no cierra.');

  const view = viewOf(png);
  let offset = 8;
  let iend = -1;
  while (offset + 8 <= png.length) {
    if (fourCC(png, offset + 4) === 'IEND') {
      iend = offset;
      break;
    }
    offset += 12 + view.getUint32(offset);
  }
  if (iend < 0) throw new Error('PNG inválido: no se encontró el chunk IEND.');

  const extra = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(png.length + extra);
  out.set(png.subarray(0, iend), 0);
  let at = iend;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.length;
  }
  out.set(png.subarray(iend), at);
  return out;
}

/**
 * `tEXt` es Latin-1 según la spec. El vocabulario de la metadata entra entero
 * en Latin-1, pero lo que se pase de 255 degrada a `?` en vez de romper el
 * chunk (un UTF-8 a medias deja basura en cualquier lector).
 */
export function pngTextChunks(pairs: Array<[string, string]>): Bytes[] {
  return pairs.map(([key, value]) => {
    const data = new Uint8Array(key.length + 1 + value.length);
    for (let i = 0; i < key.length; i++) data[i] = key.charCodeAt(i);
    data[key.length] = 0; // separador NUL entre clave y valor
    for (let i = 0; i < value.length; i++) {
      const code = value.charCodeAt(i);
      data[key.length + 1 + i] = code <= 0xff ? code : 0x3f;
    }
    return pngChunk('tEXt', data);
  });
}

// ── JPEG ──────────────────────────────────────────────────────────────────

/**
 * Inserta un segmento `COM` (0xFFFE) inmediatamente después del `SOI`.
 *
 * El campo de largo incluye sus propios 2 bytes, y todo segmento JPEG tiene que
 * ser de largo par, así que si el texto deja el largo impar se agrega un byte
 * de relleno. El `COM` va primero porque el `SOI` es lo único que el parser exige
 * ver antes de cualquier otra cosa.
 */
export function insertJpegComment(jpeg: Uint8Array, text: string): Bytes {
  if (!matchesAt(jpeg, 0, [0xff, 0xd8])) throw new Error('No es un JPEG: falta el marcador SOI.');

  // El `COM` no fija charset, así que va UTF-8, que es lo que leen las
  // herramientas de inspección hoy.
  const payload = new TextEncoder().encode(text);
  const pad = (2 + payload.length) % 2;
  const out = new Uint8Array(jpeg.length + 4 + payload.length + pad);
  out.set(jpeg.subarray(0, 2), 0);

  let at = 2;
  out[at] = 0xff;
  out[at + 1] = 0xfe;
  viewOf(out).setUint16(at + 2, 2 + payload.length + pad);
  at += 4;
  out.set(payload, at);
  at += payload.length;
  if (pad) {
    out[at] = 0x00;
    at += 1;
  }

  out.set(jpeg.subarray(2), at);
  return out;
}

// ── WebP ──────────────────────────────────────────────────────────────────

/** Chunks de píxeles: EXIF/XMP van antes del primero de estos. */
const WEBP_IMAGE_CHUNKS = new Set(['VP8 ', 'VP8L', 'ANMF']);

/**
 * Inserta un chunk `XMP ` en el contenedor RIFF.
 *
 * Dos detalles que hacen fallar la mitad de las implementaciones: el largo de
 * RIFF (offset 4) es `archivo - 8` y hay que actualizarlo, y los payloads de
 * chunk se alinean a byte par con un byte de relleno. El chunk va antes del
 * primer chunk de imagen para respetar el orden que fija la spec de WebP.
 */
export function insertWebpXmp(webp: Uint8Array, payload: Uint8Array): Bytes {
  if (fourCC(webp, 0) !== 'RIFF' || fourCC(webp, 8) !== 'WEBP') {
    throw new Error('No es un WebP: falta la cabecera RIFF/WEBP.');
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
  out[cursor + 3] = 0x20; // espacio: el fourCC es 'XMP '
  outView.setUint32(cursor + 4, payload.length, true);
  cursor += 8;
  out.set(payload, cursor);
  cursor += payload.length;
  if (pad) {
    out[cursor] = 0x00;
    cursor += 1;
  }

  out.set(webp.subarray(at), cursor);
  // El largo declarado por RIFF no incluye los 8 bytes de su propia cabecera.
  outView.setUint32(4, out.length - 8, true);
  return out;
}

/** XMP mínimo pero válido, para que las herramientas lo lean como metadata. */
function xmpPayload(meta: FileMetadata): Bytes {
  const packet = [
    '<?xpacket begin="" id="W5M0MpCehiHzreSzNTczkc9d"?>',
    '<x:xmpmeta xmlns:x="adobe:ns:meta/">',
    '<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">',
    '<rdf:Description rdf:about="" xmlns:xmp="http://ns.adobe.com/xap/1.0/" xmlns:dc="http://purl.org/dc/elements/1.1/">',
    `<xmp:CreatorTool>${esc(meta.software)}</xmp:CreatorTool>`,
    `<dc:title>${esc(meta.title)}</dc:title>`,
    `<dc:description>${esc(meta.description)}</dc:description>`,
    `<dc:rights>${esc(meta.source)}</dc:rights>`,
    '</rdf:Description></rdf:RDF></x:xmpmeta>',
    '<?xpacket end="w"?>',
  ].join('\n');
  return new TextEncoder().encode(packet);
}

// ── XML ───────────────────────────────────────────────────────────────────

const XML_ENTITIES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&apos;',
};

/** Escapa todo lo que puede romper un nodo de texto o un atributo. */
function esc(text: string): string {
  return text.replace(/[&<>"']/g, (c) => XML_ENTITIES[c] ?? c);
}

/** Los atributos no necesitan más de dos decimales, y así el archivo queda chico. */
function num(n: number): string {
  return String(Math.round(n * 100) / 100);
}

// ── SVG ───────────────────────────────────────────────────────────────────

/**
 * Un renglón por `<text>`, con la línea base en el mismo lugar que pondría
 * `paintText`: `blockTop + ascent` y avanzando `lineHeight`. SVG usa por
 * defecto `text-anchor: start` y línea base alfabética, así que el `center` del
 * canvas se traduce a `text-anchor="middle"` y la `y` es la línea base.
 */
function svgTextLines(layout: TextLayout, centerX: number, top: number, areaHeight: number, fill: string): string[] {
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
 * Emite el SVG completo.
 *
 * `measure` sólo se usa para medir texto: no se dibuja nada con él. El layout
 * sale entero del core con los mismos parámetros que usa `drawFrame`, así que
 * el SVG y el PNG dicen exactamente lo mismo.
 */
export function buildSvg(spec: Spec, measure: CanvasRenderingContext2D): string {
  const { width, height } = spec;
  const geo = frameGeometry(spec);
  const contentHeight = height - geo.stripHeight;
  const pad = paddingFor(width, height);

  const body: string[] = [`<rect width="${num(width)}" height="${num(height)}" fill="#${esc(spec.bg)}"/>`];

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
      // Imagen estática: `drawFrame` sin progreso marca 0.
      const clock = layoutLine(
        measure,
        timecode(0, spec.duration),
        width - pad,
        geo.timeFontSize * 1.5,
        { fontWeight: FONT_WEIGHT, minFontSize: 7, maxFontSize: geo.timeFontSize },
      );
      if (clock) {
        body.push(...svgTextLines(clock, width / 2, barTop - geo.timeFontSize * 1.5, geo.timeFontSize * 1.5, spec.fg));
      }
    }
    if (spec.showProgressBar && geo.barHeight > 0) {
      // En una imagen estática la barra va vacía: sólo se dibuja la guía, tal
      // como hace `drawFrame` con `progress` en 0.
      body.push(
        `<rect y="${num(barTop)}" width="${num(width)}" height="${num(geo.barHeight)}" fill="${esc(hexToRgba(spec.fg, TRACK_ALPHA))}"/>`,
      );
    }
  }

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<svg xmlns="http://www.w3.org/2000/svg" width="${num(width)}" height="${num(height)}" viewBox="0 0 ${num(width)} ${num(height)}">`,
    // `<metadata>` es lo primero que se lee del archivo, antes que el defs.
    `<metadata>${esc(metadataAsText(buildMetadata(spec)))}</metadata>`,
    // La fuente va embebida: el SVG tiene que seguir siendo correcto abierto en
    // una máquina sin Montserrat. El CDATA evita tener que escapar el CSS.
    `<defs><style type="text/css"><![CDATA[${FONT_FACE_CSS}]]></style></defs>`,
    ...body,
    '</svg>',
  ].join('\n');
}

// ── Exportación ───────────────────────────────────────────────────────────

/**
 * Exporta el placeholder como imagen fija.
 *
 * @param format `png`, `jpeg`, `webp` o `svg`.
 */
export async function exportImage(
  spec: Spec,
  format: StillImageFormat,
  onProgress?: ProgressCallback,
  signal?: AbortSignal,
): Promise<ExportResult> {
  checkAbort(signal);
  const mimeType = mimeFor(format);
  const filename = filenameForSpec(spec, format);

  const finish = (bytes: Bytes | string): ExportResult => {
    const blob = new Blob([bytes], { type: mimeType });
    onProgress?.({ progress: 1, message: 'Listo' });
    return { blob, filename, mimeType, size: blob.size };
  };

  if (format === 'svg') {
    onProgress?.({ progress: 0, message: 'Midiendo el texto…' });
    // El canvas del SVG sólo existe para tener un contexto con el que medir.
    const surface = createSurface(spec.width, spec.height);
    let svg: string;
    try {
      svg = buildSvg(spec, context2d(surface));
    } finally {
      releaseSurface(surface);
    }
    checkAbort(signal);
    onProgress?.({ progress: 0.3, message: 'Escribiendo el SVG…' });
    return finish(svg);
  }

  const surface = createSurface(spec.width, spec.height);
  let blob: Blob;
  try {
    onProgress?.({ progress: 0, message: 'Dibujando…' });
    drawFrame(context2d(surface), spec);
    checkAbort(signal);
    onProgress?.({ progress: 0.3, message: `Codificando ${FORMAT_LABEL[format]}…` });
    blob = await encodeCanvas(surface, format, spec.quality, signal);
  } finally {
    releaseSurface(surface);
  }

  const raw = new Uint8Array(await blob.arrayBuffer());
  checkAbort(signal);
  // Acá sí hace falta la metadata: el SVG la emite `buildSvg` por su cuenta.
  const meta = buildMetadata(spec);
  switch (format) {
    case 'png':
      return finish(insertPngChunks(raw, pngTextChunks(metadataAsPairs(meta))));
    case 'jpeg':
      return finish(insertJpegComment(raw, metadataAsText(meta)));
    case 'webp':
      return finish(insertWebpXmp(raw, xmpPayload(meta)));
  }
}
