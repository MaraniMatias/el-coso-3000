/**
 * Dos salidas de JPEG animado, para entregar a diseño o para abrir en un
 * editor de video.
 *
 * - `exportMjpegAvi`: un AVI con un JPEG completo por frame (Motion-JPEG). Es
 *   lo que entienden ffmpeg, Premiere y cualquier otro editor.
 * - `exportJpegZip`: la misma secuencia suelta en un ZIP, para pipelines que
 *   tratan la imagen frame a frame.
 *
 * Los dos comparten el render: cada frame sale de `drawFrame` y se codifica
 * como `image/jpeg`, así que el preview y el archivo no pueden divergir.
 *
 * Los containers se arman a mano. Son formatos de estructura fija y metreles
 * una dependencia por eso sería cambiar un problema de bytes por otro de
 * dependencias. Por la misma razón los constructores de bytes están separados
 * de los exportadores: son puros y se pueden testear sin canvas.
 */

import { drawFrame } from '../core/draw-frame';
import { filenameForSpec, mimeFor } from '../core/filename';
import { buildMetadata, metadataAsPairs, metadataAsText, type FileMetadata } from '../core/metadata';
import type { ExportResult, ProgressCallback, Spec } from '../core/types';
import { crc32 } from './image';

/**
 * Bytes recién asignados. El genérico importa: `Blob` sólo acepta vistas
 * sobre un `ArrayBuffer` real, y un `Uint8Array` pelado se tipa como
 * potencialmente compartido.
 */
type Bytes = Uint8Array<ArrayBuffer>;

/** Cualquier lienzo en el que se pueda dibujar. */
type Surface = HTMLCanvasElement | OffscreenCanvas;

const JPEG_MIME = 'image/jpeg';
const UTF8 = new TextEncoder();

// ── Utilidades de bytes ───────────────────────────────────────────────────

function viewOf(bytes: Uint8Array): DataView {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

/**
 * Junta los pedazos en una sola pieza. Los containers se arman en tres
 * pasadas (headers, payloads, directorios) y en las dos últimas hay que
 * conocer el tamaño de lo anterior para calcular offsets, así que no se puede
 * ir escribiendo sobre un `Blob` incremental.
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

/** Los fourCC de RIFF son 4 bytes ASCII exactos. */
function tagBytes(tag: string): Bytes {
  const out = new Uint8Array(4);
  for (let i = 0; i < 4; i++) out[i] = tag.charCodeAt(i) & 0xff;
  return out;
}

// ── Lienzo ────────────────────────────────────────────────────────────────

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
  // tipos, pero trae el mismo subconjunto de dibujo y medición que usa el core.
  return ctx as CanvasRenderingContext2D;
}

function releaseSurface(surface: Surface): void {
  // Dejar la superficie en cero suelta el backing store en el acto: son
  // decenas de MB si el usuario exporta un video largo.
  surface.width = 0;
  surface.height = 0;
}

function encodeJpegBlob(surface: Surface, quality: number): Promise<Blob> {
  // `OffscreenCanvas` no tiene `toBlob`: expone `convertToBlob`, que es el
  // mismo concepto con promesas en vez de callback.
  if ('convertToBlob' in surface) return surface.convertToBlob({ type: JPEG_MIME, quality });
  return new Promise<Blob>((resolve, reject) => {
    surface.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error('Este navegador no puede exportar JPEG.'))),
      JPEG_MIME,
      quality,
    );
  });
}

async function encodeJpeg(surface: Surface, quality: number, signal?: AbortSignal): Promise<Bytes> {
  const blob = await encodeJpegBlob(surface, quality);
  // `toBlob`/`convertToBlob` no observan el `AbortSignal`, así que el flag se
  // mira a mano cuando vuelven.
  checkAbort(signal);
  return new Uint8Array(await blob.arrayBuffer());
}

/** `max(1, …)`: con duración 0 sale un frame igual, para no dejar el archivo vacío. */
function frameCount(spec: Spec): number {
  return Math.max(1, Math.round(spec.duration * spec.fps));
}

/**
 * Renderiza la secuencia completa de frames JPEG.
 *
 * Se hace de a uno y se acumulan los bytes: mantener N surfaces vivas para
 * producir en paralelo multiplica la memoria por N sin cambiar el resultado.
 *
 * @param span porción del 0..1 que ocupa el render en el progreso total; el
 * resto es el de escribir el container.
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
        message: `Codificando JPEG ${i + 1}/${totalFrames}`,
      });
    }
  } finally {
    releaseSurface(surface);
  }
  return frames;
}

// ── AVI / RIFF ────────────────────────────────────────────────────────────
//
// AVI es un RIFF, que es un contenedor de chunks genérico. Todo tiene esta forma:
//
//   'RIFF' <tamaño u32 LE> 'AVI ' <chunk> <chunk> ...
//
// y cada chunk es `<fourcc 4 bytes> <tamaño u32 LE> <payload>` seguido de un byte
// de relleno si el payload quedó impar. Una lista es un chunk 'LIST' cuyo
// payload arranca con el fourcc del tipo: 'hdrl', 'strl', 'movi', 'INFO'.
//
// Todos los tamaños y offsets son little-endian, sin excepción. RIFF nació en
// Windows y las structs que lo definen (`MainAVIHeader`, `AVIStreamHeader`,
// `BITMAPINFOHEADER`) son blobs de little-endian al estilo de un `struct` de C.
// Escribir uno en big-endian produce un archivo que parece sano y no se puede
// decodificar, porque los tamaños salen absurdos.

/** `dwFlags` de `avih`: el archivo trae índice, así que se puede saltar. */
const AVIF_HASINDEX = 0x10;
/** `dwFlags` de cada entrada de `idx1`: JPEG entero = siempre keyframe. */
const AVIIF_KEYFRAME = 0x10;
/** `fccType`/`biCompression` del códec: Motion-JPEG. */
const FCC_VIDS = 'vids';
const FCC_MJPG = 'MJPG';
/** Fourcc del chunk de video dentro de `movi`: stream 0, datos comprimidos. */
const MOVI_CHUNK = '00dc';

export interface MjpegAviParams {
  width: number;
  height: number;
  fps: number;
  meta: FileMetadata;
}

/** `<fourcc> <tamaño LE> <payload>`, con el relleno a byte par del RIFF. */
function riffChunk(tag: string, payload: Bytes): Bytes {
  const out = new Uint8Array(8 + payload.length + (payload.length % 2));
  const view = viewOf(out);
  out.set(tagBytes(tag), 0);
  // El tamaño excluye la cabecera de 8 bytes y el relleno.
  view.setUint32(4, payload.length, true);
  out.set(payload, 8);
  return out;
}

/** `LIST`: un chunk 'LIST' cuyo payload arranca con el tipo de lista. */
function riffList(type: string, payload: Bytes): Bytes {
  return riffChunk('LIST', concatBytes([tagBytes(type), payload]));
}

/**
 * `MainAVIHeader` (14 × u32, 56 bytes).
 *
 * `dwMicroSecPerFrame` y el par `dwScale`/`dwRate` del `strh` tienen que
 * decir lo mismo: acá sale de 1/fps, y en el `strh` de 1 y fps.
 */
function avihHeader(p: MjpegAviParams, frames: number, maxFrame: number): Bytes {
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
  // dwReserved[4] queda en cero, que es lo que espera todo lector.
  return out;
}

/** `AVIStreamHeader` (56 bytes): describe el stream, no los píxeles. */
function streamHeader(p: MjpegAviParams, frames: number, maxFrame: number): Bytes {
  const out = new Uint8Array(56);
  const view = viewOf(out);
  out.set(tagBytes(FCC_VIDS), 0); // fccType
  out.set(tagBytes(FCC_MJPG), 4); // fccHandler
  view.setUint32(8, 0, true); // dwFlags
  view.setUint16(12, 0, true); // wPriority
  view.setUint16(14, 0, true); // wLanguage
  view.setUint32(16, 0, true); // dwInitialFrames
  view.setUint32(20, 1, true); // dwScale
  // dwRate sobre dwScale = duración de un frame. 1/fps s = 1e6/fps µs, igual
  // que `dwMicroSecPerFrame` del `avih`.
  view.setUint32(24, p.fps, true); // dwRate
  view.setUint32(28, 0, true); // dwStart
  view.setUint32(32, frames, true); // dwLength
  view.setUint32(36, maxFrame, true); // dwSuggestedBufferSize
  view.setUint32(40, 0xffffffff, true); // dwQuality: -1 = default
  view.setUint32(44, 0, true); // dwSampleSize
  // rcFrame: left, top, right, bottom, en int16.
  view.setInt16(48, 0, true);
  view.setInt16(50, 0, true);
  view.setInt16(52, p.width, true);
  view.setInt16(54, p.height, true);
  return out;
}

/** `BITMAPINFOHEADER` (40 bytes): en Motion-JPEG cada frame es un JPEG entero. */
function bitmapInfoHeader(p: MjpegAviParams): Bytes {
  const out = new Uint8Array(40);
  const view = viewOf(out);
  view.setUint32(0, 40, true); // biSize
  view.setInt32(4, p.width, true); // biWidth
  // biHeight positivo significa bottom-up. Da igual: el JPEG se decodifica
  // entero y trae su propio orden de lectura.
  view.setInt32(8, p.height, true); // biHeight
  view.setUint16(12, 1, true); // biPlanes
  view.setUint16(14, 24, true); // biBitCount
  // biCompression es un fourCC, no el id numérico que usan BMP y PNG.
  out.set(tagBytes(FCC_MJPG), 16);
  view.setUint32(20, p.width * p.height * 3, true); // biSizeImage
  view.setUint32(24, 0, true); // biXPelsPerMeter
  view.setUint32(28, 0, true); // biYPelsPerMeter
  view.setUint32(32, 0, true); // biClrUsed
  view.setUint32(36, 0, true); // biClrImportant
  return out;
}

/** Tags `INFO` estándar de RIFF para los pares de metadata que tienen uno. */
const INFO_TAG: Record<string, string> = {
  Software: 'ISFT',
  Comment: 'ICMT',
  Source: 'ISBJ',
  Title: 'INAM',
  Description: 'IDSC',
};

/** FourCC del tag: el estándar si existe, si no la clave recortada a 4. */
function infoTag(key: string): string {
  return INFO_TAG[key] ?? key.toUpperCase().padEnd(4, ' ').slice(0, 4);
}

/**
 * Lista `INFO` con los tags de la metadata.
 *
 * `ISBJ` es el subject y es donde va la URL del repo; `ICMT` es el comentario.
 * Los lectores ignoran los tags que no conocen, así que los pares sin tag
 * estándar van con la clave recortada en vez de descartarse.
 */
function infoList(meta: FileMetadata): Bytes {
  const chunks = metadataAsPairs(meta).map(([key, value]) => riffChunk(infoTag(key), UTF8.encode(value)));
  return riffList('INFO', concatBytes(chunks));
}

/**
 * Tabla de índices: 16 bytes por frame (`fourcc`, flags, offset, tamaño).
 *
 * Convención de offsets: son relativos a la posición del fourcc `movi` menos 4,
 * o sea al campo de tamaño del `LIST`. Por eso el primer chunk queda en 8
 * (4 del tamaño + 4 del fourcc `movi`) y no en 0. Es la convención que escribe
 * ffmpeg y la que asumen los lectores; un índice con offsets relativos a otra
 * base hace que el archivo no abra o que abra desde el frame equivocado.
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
    // El tamaño es el del payload, sin el byte de relleno.
    view.setUint32(base + 12, size, true);
    at += 8 + size + (size % 2);
  }
  return riffChunk('idx1', out);
}

/**
 * Arma el AVI completo a partir de frames JPEG ya codificados.
 *
 * Estructura: `hdrl` (`avih` + `strl`/`strh`+`strf`), `INFO` con la metadata,
 * `movi` con un chunk `00dc` por frame, y `idx1` al final.
 */
export function buildMjpegAvi(frames: Bytes[], params: MjpegAviParams): Bytes {
  const maxFrame = frames.reduce((n, f) => Math.max(n, f.length), 0);
  const hdrl = riffList(
    'hdrl',
    concatBytes([
      riffChunk('avih', avihHeader(params, frames.length, maxFrame)),
      riffList(
        'strl',
        concatBytes([
          riffChunk('strh', streamHeader(params, frames.length, maxFrame)),
          riffChunk('strf', bitmapInfoHeader(params)),
        ]),
      ),
    ]),
  );
  const movi = riffList('movi', concatBytes(frames.map((frame) => riffChunk(MOVI_CHUNK, frame))));
  const body = concatBytes([hdrl, infoList(params.meta), movi, indexChunk(frames)]);

  // La cabecera es de 12 bytes: 'RIFF', el tamaño y el tipo 'AVI '.
  const out = new Uint8Array(12 + body.length);
  const view = viewOf(out);
  out.set(tagBytes('RIFF'), 0);
  // El tamaño declarado por RIFF excluye su propia cabecera de 8 bytes.
  view.setUint32(4, out.length - 8, true);
  out.set(tagBytes('AVI '), 8);
  out.set(body, 12);
  return out;
}

// ── ZIP ───────────────────────────────────────────────────────────────────
//
// Estructura de un ZIP, en el orden en que va en el archivo:
//
//   [local header][nombre][datos]  (repetido por entry)
//   [central directory]             (una entrada de 46 bytes + nombre por entry)
//   [EOCD] [comentario]
//
// Los local headers se escriben primero y el central directory después, así que
// cada entrada tiene que recordar dónde quedó su local header: ese offset
// relativo al comienzo del archivo va en el campo 42 del central, y es de ahí
// de donde salen la mayoría de los bugs de esta estructura. El EOCD, al final,
// sólo dice dónde empieza el central y cuánto mide.

const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_EOCD = 0x06054b50;
const METHOD_STORE = 0;
const METHOD_DEFLATE = 8;
/** Bit 11 del flag general: el nombre del entry está en UTF-8. */
const FLAG_UTF8 = 0x0800;
/** Límite clásico de nombre de archivo. Pasado, el archivo no se puede abrir. */
const MAX_NAME_BYTES = 255;
/** El campo de comentario del EOCD es un u16. */
const MAX_COMMENT_BYTES = 0xffff;
/** El conteo de entries también es un u16: 65535 frames son ~36 min a 30 fps. */
const MAX_ENTRIES = 0xffff;
/**
 * Fecha y hora de la entrada, fijas en el cero de MS-DOS (1/1/1980 00:00).
 * Preferible a la hora actual: dos exportaciones del mismo `Spec` dan los
 * mismos bytes, y eso hace que el placeholder se pueda comparar entre corridas.
 */
const DOS_TIME = 0;
const DOS_DATE = (1 << 5) | 1; // año 1980 contado desde 0, mes 1, día 1

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
  /** Offset del local header, relativo al comienzo del archivo. */
  offset: number;
}

/** `deflate-raw`: el deflate pelado, sin el encabezado de 2 bytes de zlib. */
async function deflateRaw(data: Bytes): Promise<Bytes> {
  const source = new ReadableStream<BufferSource>({
    start(controller) {
      controller.enqueue(data);
      controller.close();
    },
  });
  const deflated = source.pipeThrough(new CompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(deflated).arrayBuffer());
}

/** Recorta a byte de UTF-8 entero, para no partir una secuencia a la mitad. */
function fitComment(text: string): Bytes {
  const bytes = UTF8.encode(text);
  if (bytes.length <= MAX_COMMENT_BYTES) return bytes;
  // `bytes[end]` es el primer byte descartado. Si es continuación (10xxxxxx)
  // pertenece a una secuencia que quedó incompleta, así que se retrocede
  // hasta su byte lead, que nunca es de continuación.
  let end = MAX_COMMENT_BYTES;
  while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end -= 1;
  return bytes.slice(0, end);
}

function localHeader(f: ZipFields): Bytes {
  const out = new Uint8Array(30);
  const view = viewOf(out);
  view.setUint32(0, SIG_LOCAL, true);
  view.setUint16(4, 20, true); // version needed: 2.0, lo mínimo para deflate
  view.setUint16(6, f.flags, true);
  view.setUint16(8, f.method, true);
  view.setUint16(10, DOS_TIME, true);
  view.setUint16(12, DOS_DATE, true);
  view.setUint32(14, f.crc, true);
  // Con `deflate-raw` el CRC y los tamaños son siempre los del dato original,
  // nunca los del payload: el descompresor no tiene forma de adivinarlos.
  view.setUint32(18, f.compressedSize, true);
  view.setUint32(22, f.size, true);
  view.setUint16(26, f.name.length, true);
  view.setUint16(28, 0, true); // sin extra field
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

function endOfCentralDirectory(count: number, cdSize: number, cdOffset: number, comment: Bytes): Bytes {
  const out = new Uint8Array(22 + comment.length);
  const view = viewOf(out);
  view.setUint32(0, SIG_EOCD, true);
  view.setUint16(4, 0, true); // número de disco
  view.setUint16(6, 0, true); // disco del central directory
  view.setUint16(8, count, true); // entries en este disco
  view.setUint16(10, count, true); // entries totales
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
 * Arma el ZIP. Sin canvas ni `Spec`: recibe los bytes ya hechos, que es lo que
 * necesita el test.
 *
 * @param comment va al campo de comentario del EOCD, que es donde un lector
 * rápido mira antes de abrir el central directory.
 */
export async function buildJpegZip(entries: JpegZipEntry[], comment = '', signal?: AbortSignal): Promise<Bytes> {
  if (entries.length > MAX_ENTRIES) {
    throw new Error(`Un ZIP admite ${MAX_ENTRIES} entradas y se pidieron ${entries.length}.`);
  }

  const locals: Bytes[] = [];
  const central: Bytes[] = [];
  let offset = 0;

  for (const entry of entries) {
    checkAbort(signal);
    const name = UTF8.encode(entry.name);
    if (name.length > MAX_NAME_BYTES) {
      throw new Error(`Nombre de archivo demasiado largo para un ZIP (${name.length} bytes, máximo ${MAX_NAME_BYTES}).`);
    }
    const deflated = await deflateRaw(entry.data);
    // JPEG (y PNG) ya vienen comprimidos: si deflate no ahorra un solo byte,
    // el entry va stored. Es perfectamente válido y evita el doble trabajo de
    // descomprimir en cada extracción.
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
  // El central arranca justo donde terminaron los local headers, y eso es lo
  // que el EOCD declara: si `offset` no cuadra con `directory`, el archivo no
  // se puede abrir aunque los headers estén impecable.
  return concatBytes([...locals, directory, endOfCentralDirectory(entries.length, directory.length, offset, fitComment(comment))]);
}

// ── Exportadores ──────────────────────────────────────────────────────────

/**
 * AVI con Motion-JPEG. Lo habitual para entregar a diseño o abrir en un editor.
 *
 * El browser no lo reproduce: el preview de la app muestra un frame suelto.
 * El archivo igual está bien, es el que entienden las herramientas.
 */
export async function exportMjpegAvi(
  spec: Spec,
  onProgress?: ProgressCallback,
  signal?: AbortSignal,
): Promise<ExportResult> {
  checkAbort(signal);
  const totalFrames = frameCount(spec);
  const frames = await renderJpegFrames(spec, totalFrames, onProgress, signal, [0, 0.85]);
  checkAbort(signal);

  onProgress?.({ progress: 0.9, message: 'Escribiendo el AVI…' });
  const avi = buildMjpegAvi(frames, {
    width: spec.width,
    height: spec.height,
    fps: spec.fps,
    meta: buildMetadata(spec),
  });

  const mimeType = mimeFor('mjpeg-avi');
  const blob = new Blob([avi], { type: mimeType });
  onProgress?.({ progress: 1, message: 'Listo' });
  return { blob, filename: filenameForSpec(spec, 'mjpeg-avi'), mimeType, size: blob.size };
}

/** Secuencia de JPEG en un ZIP, con la metadata adentro y en el comentario. */
export async function exportJpegZip(
  spec: Spec,
  onProgress?: ProgressCallback,
  signal?: AbortSignal,
): Promise<ExportResult> {
  checkAbort(signal);
  const totalFrames = frameCount(spec);
  const frames = await renderJpegFrames(spec, totalFrames, onProgress, signal, [0, 0.8]);
  checkAbort(signal);

  onProgress?.({ progress: 0.85, message: 'Empaquetando el ZIP…' });
  const meta = buildMetadata(spec);
  const entries: JpegZipEntry[] = [
    { name: 'metadata.json', data: UTF8.encode(JSON.stringify(meta, null, 2)) },
    ...frames.map((data, i) => ({ name: `frame_${String(i + 1).padStart(5, '0')}.jpg`, data })),
  ];
  const zip = await buildJpegZip(entries, metadataAsText(meta), signal);

  const mimeType = mimeFor('jpeg-zip');
  const blob = new Blob([zip], { type: mimeType });
  onProgress?.({ progress: 1, message: 'Listo' });
  return { blob, filename: filenameForSpec(spec, 'jpeg-zip'), mimeType, size: blob.size };
}
