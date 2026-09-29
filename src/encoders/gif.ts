/**
 * Exportador de GIF animado.
 *
 * Mediabunny no tiene salida GIF, así que el archivo se arma a mano. La
 * estructura es la de siempre:
 *
 *   "GIF89a" · Logical Screen Descriptor · Global Color Table
 *   · Application Extension (NETSCAPP2.0, bucle infinito)
 *   · Comment Extension (la metadata del producto)
 *   · por frame: Graphic Control Extension + Image Descriptor + datos LZW
 *   · 0x3B
 *
 * La paleta es global y compartida por todos los frames (ver `quantize.ts`),
 * así que acá no hay nada que cuantizar: sólo indexar, comprimir y concatenar.
 */

import { drawFrame } from '../core/draw-frame';
import { buildFilename, mimeFor, trimNumber } from '../core/filename';
import { buildMetadata, metadataAsText } from '../core/metadata';
import type { ExportResult, ProgressCallback, Spec } from '../core/types';
import { ByteWriter, lzwCompress, pushUint16, writeSubBlocks, type Bytes } from './lzw';
import { buildPalette, createPaletteMapper, type Palette } from './quantize';

// ── Estructura del archivo ────────────────────────────────────────────────

const SIGNATURE = new TextEncoder().encode('GIF89a');
const NETSCAPE_APP = new TextEncoder().encode('NETSCAPP2.0');

/** La GCT es una potencia de 2 entre 2 y 256 entradas. */
const MAX_GCT_ENTRIES = 256;

/**
 * Se piden 255 colores y no 256 porque el último índice de la tabla queda
 * reservado para el canal alfa: sin ese slot libre no hay dónde mandar los
 * píxeles transparentes. La tabla sigue siendo de 256 entradas.
 */
const MAX_PALETTE_COLORS = 255;

/** Tope de muestras por frame para la paleta. A 4 colores sobra y sobra. */
const MAX_SAMPLES_PER_FRAME = 65_536;

/** Cualquier lienzo en el que se pueda dibujar. */
type Surface = HTMLCanvasElement | OffscreenCanvas;

export interface GifHeader {
  width: number;
  height: number;
  /** Tripletas RGB de la paleta global, de a 3 bytes. */
  palette: Uint8Array;
  /** Texto del Comment Extension. */
  comment: string;
  /** Repeticiones del bucle. `0` es infinito, que es lo que se usa. */
  loop: number;
}

/** Lo que hay que derivar de la paleta antes de escribir cualquier byte. */
interface Layout {
  /** Índice de la GCT reservado para los píxeles transparentes. */
  transparentIndex: number;
  /** Entradas reales de la GCT. */
  gctSize: number;
  /** Los 3 bits bajos del descriptor: `log2(gctSize) - 1`. */
  sizeBits: number;
  /** Bits por índice en los datos LZW. */
  minCodeSize: number;
}

function layoutOf(header: GifHeader): Layout {
  const colors = header.palette.length / 3;
  if (!Number.isInteger(colors) || colors < 1) {
    throw new Error('La paleta del GIF está vacía.');
  }
  // El primer índice libre de la paleta es el que se reserva para transparencia.
  // Ningún píxel opaco puede caer ahí, así que la transparencia no pisa un color.
  const transparentIndex = colors;
  let gctSize = 2;
  while (gctSize < transparentIndex + 1) gctSize *= 2;
  if (gctSize > MAX_GCT_ENTRIES) {
    throw new Error(`La paleta no entra en una GCT: ${colors} colores.`);
  }
  const sizeBits = Math.round(Math.log2(gctSize)) - 1;
  // La spec no admite un código inicial de un bit: con tablas chicas el mínimo
  // sigue siendo 2, sobrando un par de códigos que el LZW no usa para datos.
  const minCodeSize = Math.max(2, sizeBits + 1);
  return { transparentIndex, gctSize, sizeBits, minCodeSize };
}

/** Cabecera + GCT + bucle + comentario. Deja el archivo listo para los frames. */
export function writeGifHeader(out: ByteWriter, header: GifHeader): void {
  const { width, height, palette, comment, loop } = header;
  if (width > 0xffff || height > 0xffff) {
    throw new Error(`Dimensiones fuera del rango del GIF: ${width}x${height}.`);
  }
  const layout = layoutOf(header);
  const colors = palette.length / 3;

  out.pushBytes(SIGNATURE);
  // Logical Screen Descriptor: el tamaño lógico del lienzo, en little-endian.
  pushUint16(out, width);
  pushUint16(out, height);
  // Bit 7: hay GCT. Bits 6-4: 8 bits por color primario. Bit 3: sin ordenar.
  // Bits 2-0: log2(entradas) - 1.
  out.push(0x80 | 0x70 | layout.sizeBits);
  // El fondo apunta al índice transparente: en el frame 0 los píxeles sin
  // dibujar se ven como el fondo del visor, no como un negro inventado.
  out.push(layout.transparentIndex);
  out.push(0x00); // aspecto del píxel: sin información

  out.pushBytes(palette);
  // Las entradas sobrantes de la tabla se completan en negro. Da igual cuál sea
  // su color: ninguna se indexa, salvo la reservada para transparencia.
  for (let i = colors * 3; i < layout.gctSize * 3; i++) out.push(0x00);

  // Application Extension: NETSCAPP2.0 es el pedido de bucle que respetan todos
  // los visores. El bloque tiene largo fijo (0x0B), el sub-bloque 0x03, y el
  // conteo va en little-endian. `0` = infinito.
  out.push(0x21);
  out.push(0xff);
  out.push(0x0b);
  out.pushBytes(NETSCAPE_APP);
  out.push(0x03);
  out.push(0x01);
  pushUint16(out, loop);
  out.push(0x00);

  // Comment Extension: la metadata vive dentro del archivo, no en el nombre.
  out.push(0x21);
  out.push(0xfe);
  writeSubBlocks(out, new TextEncoder().encode(comment));
}

/**
 * Un frame: Graphic Control Extension, Image Descriptor y datos LZW.
 *
 * @param indices `width * height` índices contra la paleta de la cabecera.
 * @param delayCs Duración en centésimas de segundo.
 */
export function writeGifFrame(out: ByteWriter, header: GifHeader, indices: Uint8Array, delayCs: number): void {
  const { width, height } = header;
  const layout = layoutOf(header);
  if (indices.length !== width * height) {
    throw new Error(`El frame tiene ${indices.length} píxeles y el lienzo pide ${width * height}.`);
  }

  // Graphic Control Extension.
  out.push(0x21);
  out.push(0xf9);
  out.push(0x04);
  // Disposal 1 = "dejar el frame en pantalla". Cada frame ocupa el lienzo entero
  // y es opaco salvo por el alfa, así que no hay nada que limpiar entre frames
  // y dibujar encima del anterior no deja bordes. El bit bajo es el flag de
  // transparencia.
  out.push((1 << 2) | 0x01);
  pushUint16(out, delayCs);
  out.push(layout.transparentIndex);
  out.push(0x00);

  // Image Descriptor: en (0,0), a tamaño completo, sin tabla local y sin
  // interlazado. Los píxeles salen todos de la GCT.
  out.push(0x2c);
  pushUint16(out, 0);
  pushUint16(out, 0);
  pushUint16(out, width);
  pushUint16(out, height);
  out.push(0x00);

  out.push(layout.minCodeSize);
  // El LZW ya devuelve la cadena de sub-blocales con su terminador, así que acá
  // no se vuelve a enrollar: hacerlo produciría un terminador de más.
  out.pushBytes(lzwCompress(indices, layout.minCodeSize));
}

/** Cierra el archivo. */
export function writeGifTrailer(out: ByteWriter): void {
  out.push(0x3b);
}

// ── Tiempos ───────────────────────────────────────────────────────────────

export interface GifTiming {
  totalFrames: number;
  /** Duración de cada frame en centésimas de segundo, que es la unidad del GIF. */
  delayCs: number;
  /** FPS que realmente sale del delay, que no suele ser el pedido. */
  effectiveFps: number;
}

/**
 * Traduce duración y FPS pedidos a los tiempos del GIF.
 *
 * El delay va en centésimas de segundo, así que el FPS queda cuantizado a
 * `100 / delayCs`: pedir 30fps produce 3cs y el archivo se reproduce a
 * 33.33fps. No es un bug, es lo que el formato permite, pero como el archivo no
 * guarda el FPS hay que al menos decirlo en el nombre y en el progreso. Un
 * delay de 0 significa "reproducir lo más rápido posible" en varios visores, así
 * que por encima de 100fps se fuerza 1cs.
 */
export function gifTiming(fps: number, duration: number): GifTiming {
  const totalFrames = Math.max(1, Math.round(duration * fps));
  const delayCs = Math.max(1, Math.round(100 / fps));
  return { totalFrames, delayCs, effectiveFps: 100 / delayCs };
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
  // tipos (le faltan `reset`, `isContextLost`, `drawFocusIfNeeded`), pero trae
  // el mismo subconjunto de dibujo y medición que usa el core, así que para
  // `drawFrame` son intercambiables.
  return ctx as CanvasRenderingContext2D;
}

function releaseSurface(surface: Surface): void {
  // Dejar la superficie en cero suelta el backing store en el acto. Sin esto,
  // exportar un GIF de 1080p deja varios MB de memoria de GPU vivos hasta que
  // corra el GC.
  surface.width = 0;
  surface.height = 0;
}

/** Cede el control al event loop. Sin esto el `AbortSignal` no se dispara nunca. */
function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * Muestrea unos pocos frames para construir la paleta global.
 *
 * Se toman el primero, uno del medio y el último: en un placeholder animado lo
 * único que cambia entre frames es la barra de progreso y el reloj, así que con
 * esos tres ya están todos los colores que van a aparecer. Muestrear todos los
 * frames para la paleta sería trabajo tirado: la paleta es la misma.
 */
function samplePalette(ctx: CanvasRenderingContext2D, spec: Spec, totalFrames: number): Uint8Array {
  const picks = [...new Set([0, Math.floor(totalFrames / 2), totalFrames - 1])];
  const pixels = spec.width * spec.height;
  const stride = Math.max(1, Math.ceil(pixels / MAX_SAMPLES_PER_FRAME));

  const out = new Uint8Array(picks.length * Math.min(pixels, MAX_SAMPLES_PER_FRAME) * 3);
  let at = 0;
  for (const frame of picks) {
    drawFrame(ctx, spec, frame / totalFrames);
    const { data } = ctx.getImageData(0, 0, spec.width, spec.height);
    for (let p = 0; p < pixels; p += stride) {
      const o = p * 4;
      // El RGB de un píxel totalmente transparente no es un color que exista en
      // la imagen, así que no entra a la paleta.
      if ((data[o + 3] ?? 0) === 0) continue;
      out[at++] = data[o]!;
      out[at++] = data[o + 1]!;
      out[at++] = data[o + 2]!;
    }
  }
  return out.subarray(0, at);
}

// ── Exportación ───────────────────────────────────────────────────────────

/**
 * Exporta el placeholder como GIF animado.
 *
 * @param onProgress Recibe el avance por frame.
 * @param signal Cancelación. Lanza una `DOMException` `AbortError`.
 */
export async function exportGif(
  spec: Spec,
  onProgress?: ProgressCallback,
  signal?: AbortSignal,
): Promise<ExportResult> {
  checkAbort(signal);

  const { totalFrames, delayCs, effectiveFps } = gifTiming(spec.fps, spec.duration);
  const mimeType = mimeFor('gif');
  const filename = buildFilename({
    width: spec.width,
    height: spec.height,
    format: 'gif',
    // Con duración 0 el GIF es un loop de un solo frame, que es un caso
    // legítimo: el archivo tiene que nombrarse sin un `-0s` que parece un
    // video mal configurado.
    fps: spec.duration > 0 ? spec.fps : undefined,
    duration: spec.duration > 0 ? spec.duration : undefined,
    // El nombre lleva el FPS real cuando difiere del pedido: es el único lugar
    // del archivo donde queda anotado a qué velocidad se reproduce.
    effectiveFps: spec.duration > 0 ? effectiveFps : undefined,
  });
  const pixels = spec.width * spec.height;
  const out = new ByteWriter(pixels);
  const surface = createSurface(spec.width, spec.height);
  let bytes: Bytes;

  try {
    const ctx = context2d(surface);

    onProgress?.({ progress: 0, message: 'Midiendo los colores…' });
    const palette: Palette = buildPalette(samplePalette(ctx, spec, totalFrames), MAX_PALETTE_COLORS);
    checkAbort(signal);

    const header: GifHeader = {
      width: spec.width,
      height: spec.height,
      palette: palette.rgb,
      comment: metadataAsText(buildMetadata(spec)),
      loop: 0,
    };
    // `writeGifHeader` reserva el índice `palette.size` para transparencia, que
    // es el primer slot que ningún color opaco puede ocupar.
    const toIndex = createPaletteMapper(palette);
    const transparentIndex = palette.size;
    const indices = new Uint8Array(pixels);

    writeGifHeader(out, header);

    for (let frame = 0; frame < totalFrames; frame++) {
      checkAbort(signal);
      drawFrame(ctx, spec, frame / totalFrames);
      const { data } = ctx.getImageData(0, 0, spec.width, spec.height);
      for (let p = 0, o = 0; p < pixels; p++, o += 4) {
        const alpha = data[o + 3]!;
        indices[p] = alpha === 0
          ? transparentIndex
          : toIndex((data[o]! << 16) | (data[o + 1]! << 8) | data[o + 2]!);
      }
      writeGifFrame(out, header, indices, delayCs);

      onProgress?.({
        progress: (frame + 1) / totalFrames,
        frame: frame + 1,
        totalFrames,
        message: `Codificando ${frame + 1}/${totalFrames}`,
      });
      // Sin ceder el event loop el bucle de frames bloquea la interfaz y la
      // cancelación no llega a dispararse nunca.
      await yieldToEventLoop();
    }

    writeGifTrailer(out);
    checkAbort(signal);
    bytes = out.finish();
  } finally {
    releaseSurface(surface);
  }

  const blob = new Blob([bytes], { type: mimeType });
  onProgress?.({
    progress: 1,
    message: `Listo: ${trimNumber(effectiveFps)} fps reales (delay de ${delayCs} cs)`,
  });
  return { blob, filename, mimeType, size: blob.size };
}
