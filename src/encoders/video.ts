/**
 * Exportador de video: MP4, MOV, WebM y MKV.
 *
 * Todo sale del mismo `drawFrame` que las imágenes, así que el video y el PNG
 * no pueden divergir. La diferencia con los exportadores de imagen es que acá
 * hay un códec de por medio, y con él dos cosas que no existen en el otro lado:
 * las capacidades del navegador (WebCodecs) y la backpressure.
 *
 * Sobre la backpressure, que es lo no obvio del archivo: `await source.add(...)`
 * NO espera a que el frame "le toque" en el reloj, espera a que el encoder y el
 * muxer tengan lugar para el frame siguiente. Por eso el bucle va a la velocidad
 * a la que la máquina pueda codificar y no a `duration` segundos reales: un video
 * de 10s a 60fps son 600 frames y sale en el tiempo que tarde la máquina, no en
 * 10s. Si se esperara al reloj, exportar un placeholder costaría 10s por archivo
 * sin ganar nada. Y como el `await` es lo único que frena, el códec queda
 * consistente: nunca se le pasa frame N+1 antes de que haya tragado el N.
 *
 * ── Qué NO se pudo ejercitar en Bun ────────────────────────────────────────
 * Bun no tiene `VideoEncoder`, ni `OffscreenCanvas`, ni `showSaveFilePicker`.
 * O sea: la línea de `exportVideo` desde `output.start()` hasta `finalize()` no
 * tiene ninguna cobertura automatizada. Lo que sí está testeado (en
 * `test/video.test.ts`) es la tabla de contenedores y códecs, la aritmética
 * de frames, keyframes, progreso y ETA, los topes, la metadata, y el bucle de
 * encoding con un `drawFrame` y un `source.add` falsos vía `encodeFrames`, que
 * es la única costura que hace falta para ejercitarlo sin códec.
 */

import {
  BufferTarget,
  CanvasSource,
  MkvOutputFormat,
  MovOutputFormat,
  Mp4OutputFormat,
  Output,
  Quality,
  WebMOutputFormat,
  getFirstEncodableVideoCodec,
  type MetadataTags,
  type OutputFormat,
  type VideoCodec,
} from 'mediabunny';

import { drawFrame } from '../core/draw-frame';
import { evenDimensions, filenameForSpec, mimeFor } from '../core/filename';
import { buildMetadata, metadataAsText } from '../core/metadata';
import type { ExportResult, ProgressCallback, ProgressInfo, Spec, VideoFormat } from '../core/types';

// ── Límites ────────────────────────────────────────────────────────────────

/**
 * Tope por lado. 4096 es el límite cómodo para los encoders por hardware; más
 * allá el video sale lentísimo o directamente no se puede codificar. No se
 * recorta en silencio: el placeholder se declara con el tamaño que tiene.
 */
export const MAX_VIDEO_DIMENSION = 4096;

/**
 * Tope blando de frames por exportación. 3600 frames son 60s a 60fps. Es un
 * placeholder, no hace falta un video de diez minutos en loop.
 */
export const MAX_TOTAL_FRAMES = 3600;

/**
 * Segundos entre keyframes. Es el default de mediabunny y lo que hace falta
 * para poder scrubbear la barra del reproductor sin que pegue un salto de un
 * segundo y medio. `keyFrameEvery` deriva de acá para que el intervalo que se
 * le dice al códec y el que se marca frame a frame no se desincronicen.
 */
const KEY_FRAME_SECONDS = 2;

// ── Contenedores y códecs ─────────────────────────────────────────────────

export interface VideoFormatProfile {
  /** Etiqueta legible para la UI y los mensajes. */
  label: string;
  /** Nombre de la clase de mediabunny que implementa el contenedor. */
  container: string;
  /** Crea el contenedor. */
  createFormat: () => OutputFormat;
  /**
   * Códecs en orden de preferencia. Gana el primero que el navegador sepa
   * codificar en las dimensiones pedidas. H.264 primero en MP4/MOV porque es
   * lo que abre cualquier cosa; en WebM/MKV primero VP9, que es lo nativo de
   * esos contenedores.
   */
  codecs: readonly VideoCodec[];
}

export const VIDEO_FORMATS_TABLE: Record<VideoFormat, VideoFormatProfile> = {
  mp4: {
    label: 'MP4',
    container: 'Mp4OutputFormat',
    createFormat: () => new Mp4OutputFormat(),
    codecs: ['avc', 'av1', 'vp9'],
  },
  mov: {
    label: 'MOV',
    container: 'MovOutputFormat',
    createFormat: () => new MovOutputFormat(),
    codecs: ['avc', 'av1', 'vp9'],
  },
  webm: {
    label: 'WebM',
    container: 'WebMOutputFormat',
    createFormat: () => new WebMOutputFormat(),
    codecs: ['vp9', 'vp8'],
  },
  mkv: {
    label: 'MKV',
    container: 'MkvOutputFormat',
    createFormat: () => new MkvOutputFormat(),
    codecs: ['vp9', 'vp8', 'av1'],
  },
};

/** Contenedor de mediabunny para un formato de la lista. */
export function outputFormatFor(format: VideoFormat): OutputFormat {
  return VIDEO_FORMATS_TABLE[format].createFormat();
}

/**
 * Códec con el que se va a exportar, o `null` si el navegador no puede con
 * ninguno para esas dimensiones.
 *
 * El filtro por contenedor va primero a propósito: ofrecer un códec que el
 * muxer después rechaza cambia un error temprano y claro por uno tardío y
 * críptico a mitad de la codificación.
 */
async function resolveCodec(format: VideoFormat, width: number, height: number): Promise<VideoCodec | null> {
  const supported = new Set(outputFormatFor(format).getSupportedVideoCodecs());
  const wanted = VIDEO_FORMATS_TABLE[format].codecs.filter((codec) => supported.has(codec));
  if (wanted.length === 0) return null;
  return getFirstEncodableVideoCodec(wanted, { width, height });
}

// ── Soporte del navegador ──────────────────────────────────────────────────

/**
 * Lo que se le muestra al usuario cuando no se puede exportar video. Tiene que
 * decir qué falta y dónde, porque desde adentro de una app offline no hay
 * forma de adivinarlo.
 */
export const NO_ENCODER_MESSAGE =
  'Este navegador no puede exportar video porque no tiene WebCodecs (VideoEncoder), ' +
  'que es lo único que sabe escribir un video en el navegador sin servidor. ' +
  'No está implementado en Firefox para Android; en Chrome, Edge o Safari de escritorio sí anda. ' +
  'Mientras tanto podés exportar el placeholder como imagen estática o como GIF.';

/** ¿Este navegador tiene con qué codificar video? Síncrono y sin tocar nada. */
export function isVideoExportSupported(): boolean {
  return 'VideoEncoder' in globalThis;
}

/**
 * El sondeo de códecs es una promesa con `VideoEncoder.isConfigSupported`
 * adentro: caro de repetir en cada keystroke de la UI. Se cachea por
 * dimensiones porque es la única variable que lo cambia.
 */
const supportCache = new Map<string, Promise<VideoFormat[]>>();

/**
 * Formatos realmente disponibles acá, en el orden de `VIDEO_FORMATS` del core.
 * Es lo que la UI debería mirar antes de ofrecer nada: si un formato no está en
 * la lista, exportar en ese formato va a fallar.
 */
export function availableVideoFormats(width: number, height: number): Promise<VideoFormat[]> {
  const key = `${width}x${height}`;
  const cached = supportCache.get(key);
  if (cached) return cached;

  const probing = probeFormats(width, height);
  supportCache.set(key, probing);
  return probing;
}

async function probeFormats(width: number, height: number): Promise<VideoFormat[]> {
  if (!isVideoExportSupported()) return [];
  const available: VideoFormat[] = [];
  for (const format of Object.keys(VIDEO_FORMATS_TABLE) as VideoFormat[]) {
    if (await resolveCodec(format, width, height)) available.push(format);
  }
  return available;
}

// ── Plan ───────────────────────────────────────────────────────────────────

export interface VideoPlan {
  /** El `Spec` con las dimensiones reales con las que se dibuja y se nombra. */
  spec: Spec;
  width: number;
  height: number;
  fps: number;
  /** `max(1, round(duration * fps))`. Con 5s a 30fps son 150, no 300. */
  totalFrames: number;
  /** Duración de cada frame, `1 / fps`. */
  frameDuration: number;
  /** Cada cuántos frames va un keyframe. */
  keyEvery: number;
}

export function totalFramesFor(duration: number, fps: number): number {
  const product = (Number.isFinite(duration) ? duration : 0) * (Number.isFinite(fps) ? fps : 0);
  return Math.max(1, Math.round(product));
}

export function keyFrameEvery(fps: number): number {
  return Math.max(1, Math.round(fps * KEY_FRAME_SECONDS));
}

/**
 * Resuelve el `Spec` a los números con los que se va a exportar, y corta en
 * seco si no se puede. Las tres cosas que puede rechazar:
 *
 * - dimensiones impares: H.264 con 4:2:0 exige pares, así que se redondean
 *   hacia arriba y el nombre del archivo lleva las dimensiones reales, para
 *   que el placeholder no mienta sobre su tamaño;
 * - dimensiones imposibles: más de 4096 por lado no se corta en silencio;
 * - demasiados frames: es un placeholder, no un render.
 */
export function planExport(spec: Spec): VideoPlan {
  if (!Number.isFinite(spec.fps) || spec.fps <= 0) {
    throw new Error('Los FPS tienen que ser un número mayor que cero.');
  }
  if (!Number.isFinite(spec.duration) || spec.duration < 0) {
    throw new Error('La duración tiene que ser un número mayor o igual a cero.');
  }

  const dims = evenDimensions(spec.width, spec.height);
  if (dims.width > MAX_VIDEO_DIMENSION || dims.height > MAX_VIDEO_DIMENSION) {
    throw new Error(
      `El video mediría ${dims.width}x${dims.height} y el tope es de ${MAX_VIDEO_DIMENSION} px por lado. ` +
        'Bajá las dimensiones del placeholder e intentá de nuevo.',
    );
  }

  const totalFrames = totalFramesFor(spec.duration, spec.fps);
  if (totalFrames > MAX_TOTAL_FRAMES) {
    throw new Error(
      `El video tendría ${totalFrames} frames (${spec.duration}s a ${spec.fps} fps) y el tope es de ` +
        `${MAX_TOTAL_FRAMES}. Bajá la duración o los FPS: 10s a 30fps entran justo.`,
    );
  }

  return {
    spec: { ...spec, width: dims.width, height: dims.height },
    width: dims.width,
    height: dims.height,
    fps: spec.fps,
    totalFrames,
    frameDuration: 1 / spec.fps,
    keyEvery: keyFrameEvery(spec.fps),
  };
}

// ── Progreso ───────────────────────────────────────────────────────────────

const clamp01 = (n: number): number => Math.min(1, Math.max(0, n));

/** `menos de 1 s`, `12 s`, `2 min 5 s`. */
export function formatEta(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0.5) return 'menos de 1 s';
  const total = Math.round(seconds);
  return total < 60 ? `${total} s` : `${Math.floor(total / 60)} min ${total % 60} s`;
}

/**
 * Un tick de progreso. `done` son frames que ya pasaron por el encoder, así que
 * el ETA sale de la velocidad real medida y no de la duración pedida: con 5s a
 * 30fps quedan 149 frames después del primero, no `5 * 60 - 1`.
 */
export function progressInfo(plan: VideoPlan, done: number, elapsedSeconds: number): ProgressInfo {
  const total = plan.totalFrames;
  const frame = Math.min(total, Math.max(0, Math.round(done)));
  const remaining = total - frame;
  const perFrame = frame > 0 ? elapsedSeconds / frame : 0;
  const eta = remaining > 0 ? perFrame * remaining : 0;

  // Por debajo de medio segundo "menos de 1 s" no es un ETA, así que mejor no
  // mostrarlo.
  const message = `Codificando ${frame}/${total}` + (eta > 0.5 ? ` · faltan ~${formatEta(eta)}` : '');

  return { progress: clamp01(frame / total), frame, totalFrames: total, message };
}

// ── Bucle de encoding ──────────────────────────────────────────────────────

/**
 * A dónde van los frames. Es una interfaz y no el `CanvasSource` directo para
 * que el bucle se pueda ejercitar sin `VideoEncoder`: el encoder real le pasa
 * el canvas y la fuente; los tests le pasan contadores.
 */
export interface FrameSink {
  /** Dibuja el frame que va en `progress` (0..1) de la barra. */
  draw(progress: number): void;
  /** Encola el frame dibujado. Resolve cuando se puede seguir. */
  add(timestamp: number, duration: number, keyFrame: boolean): Promise<void>;
}

/**
 * Dibuja y encola los `totalFrames` frames, en orden y con timestamps exactos.
 *
 * El `await` de `add` es el mecanismo de backpressure y también el único lugar
 * donde se puede mirar la cancelación sin sacar la CPU del bucle. Si el signal
 * ya está cortado, corta antes de dibujar el frame N+1; el `output.cancel()`
 * correspondiente lo hace el que llama, porque sólo él tiene el output.
 */
export async function encodeFrames(
  plan: VideoPlan,
  sink: FrameSink,
  onProgress?: ProgressCallback,
  signal?: AbortSignal,
): Promise<void> {
  const startedAt = performance.now();
  for (let i = 0; i < plan.totalFrames; i++) {
    if (signal?.aborted) throw abortError();
    // El primer frame muestra la barra vacía y el reloj en 0, igual que la
    // imagen estática: el progreso dibujado va del frame, no del cursor.
    sink.draw(i / plan.totalFrames);
    // Backpressure: esto frena el bucle, no el reloj.
    await sink.add(i / plan.fps, plan.frameDuration, i % plan.keyEvery === 0);
    onProgress?.(progressInfo(plan, i + 1, (performance.now() - startedAt) / 1000));
  }
}

// ── Metadata ───────────────────────────────────────────────────────────────

/**
 * Metadata del archivo, con el mismo `buildMetadata` que usan las imágenes.
 *
 * En MP4/MOV el muxer escribe `©nam`/`©des`/`©cmt` desde los campos
 * normalizados, así que el bloque entero de texto va en `comment` para que
 * `Software` y `Source` no se pierdan (el `comment` es el único campo libre que
 * los cuatro contenedores respetan). Además van en `raw`, que es donde viven
 * tal cual en Matroska/WebM: el muxer ISOBMFF descarta las keys de más de 4
 * caracteres, así que en MP4 y MOV esas dos sólo existen dentro del `comment`.
 */
export function videoMetadataTags(spec: Spec): MetadataTags {
  const meta = buildMetadata(spec);
  return {
    title: meta.title,
    description: meta.description,
    comment: metadataAsText(meta),
    artist: meta.software,
    raw: { Software: meta.software, Source: meta.source },
  };
}

// ── Lienzo ─────────────────────────────────────────────────────────────────
// Mismos tres helpers que en `image.ts`. Se repiten en vez de extraerse a un
// módulo nuevo: son veinte líneas y el core no debería crecer por esto.

type Surface = HTMLCanvasElement | OffscreenCanvas;

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
  // El contexto de un `OffscreenCanvas` no es `CanvasRenderingContext2D` en los
  // tipos, pero trae el mismo subconjunto de dibujo y medición que usa el core.
  return ctx as CanvasRenderingContext2D;
}

function releaseSurface(surface: Surface): void {
  // Poner la superficie en cero suelta el backing store en el acto; esperar al
  // GC deja varios MB de allocations de GPU vivos si se exporta en ráfaga.
  surface.width = 0;
  surface.height = 0;
}

function abortError(): DOMException {
  return new DOMException('Exportación cancelada', 'AbortError');
}

function checkAbort(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError();
}

/** Los errores de mediabunny vienen en inglés; se les da contexto en español. */
function withContext(err: unknown, label: string): unknown {
  if (err instanceof DOMException && err.name === 'AbortError') return err;
  return new Error(`No se pudo exportar el video en ${label}: ${err instanceof Error ? err.message : String(err)}`, {
    cause: err,
  });
}

// ── Exportación ────────────────────────────────────────────────────────────

/**
 * Exporta el placeholder como video.
 *
 * @param format `mp4`, `webm`, `mov` o `mkv`. Conviene ofrecer sólo los que
 * devuelva `availableVideoFormats`.
 * @throws {Error} en español si el navegador no puede, si se pasa de los topes
 * o si falla el códec.
 * @throws {DOMException} `AbortError` si se cancela.
 */
export async function exportVideo(
  spec: Spec,
  format: VideoFormat,
  onProgress?: ProgressCallback,
  signal?: AbortSignal,
): Promise<ExportResult> {
  if (!isVideoExportSupported()) throw new Error(NO_ENCODER_MESSAGE);
  checkAbort(signal);

  const plan = planExport(spec);
  const label = VIDEO_FORMATS_TABLE[format].label;

  // Antes de preguntar dónde guardar: si no hay códec, no hay nada que guardar.
  const codec = await resolveCodec(format, plan.width, plan.height);
  if (!codec) {
    throw new Error(
      `Este navegador no puede codificar ${label} a ${plan.width}x${plan.height}. ` +
        'Probá con otro formato o con dimensiones más chicas.',
    );
  }
  checkAbort(signal);

  // Se escribe a un `BufferTarget` y se devuelve el `Blob` en vez de usar
  // `StreamTarget` sobre `openSaveTarget`, aunque el selector esté disponible.
  // `SaveTarget.write` sólo anexa bytes, y ninguno de los cuatro contenedores
  // escribe en orden: el muxer ISOBMFF vuelve atrás a parchear el tamaño del
  // `mdat` (y el de Matroska, el del elemento `Segment`), así que un destino
  // append-only guardaría un archivo corrupto en silencio. Habría que pedir
  // `fastStart: 'fragmented'` en MP4/MOV y `appendOnly` en MKV para forzar
  // escrituras monotónicas, y eso cambia el contenedor por debajo (fMP4 en vez
  // de MP4, `Segment` de tamaño desconocido) a cambio de unos MB de RAM. Con
  // los topes de 4096px y 3600 frames el buffer es acotado y el archivo, no.
  const target = new BufferTarget();
  const output = new Output({ format: outputFormatFor(format), target });
  // Antes de `start()`: después, el muxer ya está escribiendo.
  output.setMetadataTags(videoMetadataTags(plan.spec));

  const surface = createSurface(plan.width, plan.height);
  try {
    const source = new CanvasSource(surface, {
      codec,
      // `spec.quality` es el de JPEG/WebP; acá va un nivel cualitativo fijo.
      quality: new Quality('high'),
      keyFrameInterval: KEY_FRAME_SECONDS,
    });
    // `frameRate` le dice al muxer a qué ritmo van los timestamps, para que los
    // ajuste a la grilla en vez de acumular deriva.
    output.addVideoTrack(source, { frameRate: plan.fps });

    onProgress?.({ progress: 0, frame: 0, totalFrames: plan.totalFrames, message: `Codificando ${label}…` });
    await output.start();

    const ctx = context2d(surface);
    await encodeFrames(
      plan,
      {
        draw: (progress) => drawFrame(ctx, plan.spec, progress),
        add: (timestamp, duration, keyFrame) => source.add(timestamp, duration, { keyFrame }),
      },
      onProgress,
      signal,
    );

    // `close` no es obligatorio pero evita que mediabunny espere por más frames.
    source.close();
    await output.finalize();
  } catch (err) {
    // Cancelar a mano es obligatorio: sin esto el encoder queda vivo con el
    // output a medio escribir y el proceso se cuelga.
    await output.cancel().catch(() => {});
    throw withContext(err, label);
  } finally {
    releaseSurface(surface);
  }

  const bytes = target.buffer;
  if (!bytes) throw new Error(`El muxer no devolvió datos: el video ${label} salió vacío.`);

  const mimeType = mimeFor(format, true);
  // `plan.spec` ya trae las dimensiones reales, que es lo que declara el nombre.
  const filename = filenameForSpec(plan.spec, format);
  const blob = new Blob([bytes], { type: mimeType });
  onProgress?.({ progress: 1, frame: plan.totalFrames, totalFrames: plan.totalFrames, message: 'Listo' });
  return { blob, filename, mimeType, size: blob.size };
}
