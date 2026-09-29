/**
 * Tests del encoder de video.
 *
 * Bun no tiene `VideoEncoder`, ni canvas, ni `showSaveFilePicker`, así que la
 * línea de `exportVideo` que va de `output.start()` a `finalize()` no se puede
 * ejercitar acá. Lo que sí se testea es todo lo que la rodea y todo lo que
 * decide: qué contenedor y qué códec le toca a cada formato, la aritmética de
 * frames, keyframes, progreso y ETA, los topes con sus mensajes, la metadata, y
 * el bucle de encoding con un `drawFrame` y un `source.add` falsos.
 *
 * Corre: `bun test`
 */

import { describe, expect, test } from 'bun:test';

import { filenameForSpec, mimeFor } from '../src/core/filename';
import { APP_NAME, REPO_URL, VIDEO_FORMATS, type Spec } from '../src/core/types';
import {
  MAX_TOTAL_FRAMES,
  MAX_VIDEO_DIMENSION,
  NO_ENCODER_MESSAGE,
  VIDEO_FORMATS_TABLE,
  availableVideoFormats,
  encodeFrames,
  exportVideo,
  formatEta,
  isVideoExportSupported,
  keyFrameEvery,
  outputFormatFor,
  planExport,
  progressInfo,
  totalFramesFor,
  videoMetadataTags,
  type FrameSink,
} from '../src/encoders/video';

// ── Helpers ────────────────────────────────────────────────────────────────

const spec = (over: Partial<Spec> = {}): Spec => ({
  width: 1920,
  height: 1080,
  bg: 'FFE4E4',
  fg: '5A2A2A',
  paletteName: 'rose',
  duration: 5,
  fps: 30,
  showProgressBar: true,
  showTime: true,
  quality: 0.92,
  ...over,
});

/** Mensaje de error de lo que lanza, o `null` si no lanzó. */
function errorOf(fn: () => unknown): string | null {
  try {
    fn();
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

const close = (a: number, b: number) => Math.abs(a - b) < 1e-9;

// ── Contenedores ───────────────────────────────────────────────────────────

describe('tabla de contenedores', () => {
  test('cada formato usa la clase de mediabunny que le corresponde', () => {
    expect(outputFormatFor('mp4').constructor.name).toBe('Mp4OutputFormat');
    expect(outputFormatFor('mov').constructor.name).toBe('MovOutputFormat');
    expect(outputFormatFor('webm').constructor.name).toBe('WebMOutputFormat');
    expect(outputFormatFor('mkv').constructor.name).toBe('MkvOutputFormat');
  });

  test('la tabla dice el mismo nombre de clase que produce', () => {
    for (const format of VIDEO_FORMATS) {
      expect(VIDEO_FORMATS_TABLE[format].container).toBe(outputFormatFor(format).constructor.name);
    }
  });

  test('la tabla cubre exactamente los formatos del core', () => {
    expect(Object.keys(VIDEO_FORMATS_TABLE).sort()).toEqual([...VIDEO_FORMATS].sort());
  });

  test('extensión y MIME de cada contenedor', () => {
    const expected = {
      mp4: ['.mp4', 'video/mp4'],
      mov: ['.mov', 'video/quicktime'],
      webm: ['.webm', 'video/webm'],
      mkv: ['.mkv', 'video/x-matroska'],
    } as const;
    for (const format of VIDEO_FORMATS) {
      const [extension, mime] = expected[format];
      expect(outputFormatFor(format).fileExtension).toBe(extension);
      expect(outputFormatFor(format).mimeType).toBe(mime);
      expect(mimeFor(format, true)).not.toBe('');
    }
  });
});

describe('preferencia de códec', () => {
  const expectedCodecs = {
    mp4: 'avc,av1,vp9',
    mov: 'avc,av1,vp9',
    webm: 'vp9,vp8',
    mkv: 'vp9,vp8,av1',
  } as const;

  test('el orden de preferencia es el del contenedor', () => {
    for (const format of VIDEO_FORMATS) {
      expect(VIDEO_FORMATS_TABLE[format].codecs.join()).toBe(expectedCodecs[format]);
    }
  });

  // Si un códec preferido no lo acepta el contenedor, el filtro por contenedor
  // lo saca y nunca llega al muxer, que después tiraría a mitad de la
  // codificación con un error que no dice nada del contexto.
  test('ningún códec preferido queda afuera del contenedor', () => {
    for (const format of VIDEO_FORMATS) {
      const supported = outputFormatFor(format).getSupportedVideoCodecs();
      expect(VIDEO_FORMATS_TABLE[format].codecs.filter((codec) => !supported.includes(codec))).toEqual([]);
    }
  });

  test('el filtro tiene algo que filtrar: webm no acepta avc, mp4 sí', () => {
    expect(outputFormatFor('webm').getSupportedVideoCodecs()).not.toContain('avc');
    expect(outputFormatFor('mp4').getSupportedVideoCodecs()[0]).toBe('avc');
  });
});

// ── Aritmética ─────────────────────────────────────────────────────────────

describe('totalFrames = max(1, round(duration * fps))', () => {
  test.each([
    [5, 30, 150],
    [0.5, 1, 1],
    [10, 60, 600],
    [0, 30, 1],
    [3.7, 24, 89],
    [1, 1, 1],
    [2.5, 25, 63],
  ])('%ss a %ifs → %i frames', (duration, fps, expected) => {
    expect(totalFramesFor(duration, fps)).toBe(expected);
  });

  test('5s a 30fps NO son 5 * 60 (el error clásico del ETA)', () => {
    expect(totalFramesFor(5, 30)).not.toBe(5 * 60);
    expect(totalFramesFor(5, 30)).toBe(150);
  });
});

describe('keyEvery = max(1, round(fps * 2))', () => {
  test.each([
    [30, 60],
    [24, 48],
    [60, 120],
    [1, 2],
    [0.4, 1],
    [0, 1],
  ])('%ifs → keyframe cada %i frames', (fps, expected) => {
    expect(keyFrameEvery(fps)).toBe(expected);
  });
});

// ── Plan ───────────────────────────────────────────────────────────────────

describe('planExport', () => {
  test('redondea las dimensiones a pares y deja el Spec con las reales', () => {
    const plan = planExport(spec({ width: 641, height: 361 }));
    expect([plan.width, plan.height]).toEqual([642, 362]);
    expect([plan.spec.width, plan.spec.height]).toEqual([642, 362]);
    // El redondeo no puede cambiar la cuenta de frames.
    expect(plan.totalFrames).toBe(150);
  });

  test('el nombre del archivo lleva las dimensiones reales', () => {
    expect(filenameForSpec(planExport(spec({ width: 641, height: 361 })).spec, 'mp4')).toBe('642x362-30fps-5s.mp4');
    expect(filenameForSpec(planExport(spec({ width: 641, height: 361 })).spec, 'webm')).toBe('642x362-30fps-5s.webm');
    expect(filenameForSpec(planExport(spec()).spec, 'mov')).toBe('1920x1080-30fps-5s.mov');
  });

  test('deja las dimensiones que ya son pares', () => {
    const plan = planExport(spec());
    expect([plan.width, plan.height]).toEqual([1920, 1080]);
    expect(plan.totalFrames).toBe(150);
    expect(plan.keyEvery).toBe(60);
    expect(plan.frameDuration).toBe(1 / 30);
  });

  test('media duración con fps bajo da un solo frame, nunca cero', () => {
    expect(planExport(spec({ duration: 0.5, fps: 1 })).totalFrames).toBe(1);
  });
});

describe('topes: se rechazan con un mensaje, nunca en silencio', () => {
  test(`más de ${MAX_VIDEO_DIMENSION} px por lado`, () => {
    const message = errorOf(() => planExport(spec({ width: 7680, height: 4320 })));
    expect(message).toContain(String(MAX_VIDEO_DIMENSION));
    expect(message).toContain('7680x4320');
  });

  test('el tope corre por cualquier lado, no sólo por el ancho', () => {
    expect(errorOf(() => planExport(spec({ width: 1920, height: 5000 })))).toContain(String(MAX_VIDEO_DIMENSION));
  });

  test(`justo en el tope entra`, () => {
    expect(errorOf(() => planExport(spec({ width: MAX_VIDEO_DIMENSION, height: MAX_VIDEO_DIMENSION, duration: 0.1, fps: 1 })))).toBeNull();
  });

  test(`más de ${MAX_TOTAL_FRAMES} frames dice cuántos serían`, () => {
    const message = errorOf(() => planExport(spec({ duration: 61, fps: 60 })));
    expect(message).toContain('3660');
    expect(message).toContain(String(MAX_TOTAL_FRAMES));
  });

  test('el tope de frames entra justo por los dos lados', () => {
    expect(errorOf(() => planExport(spec({ duration: 60, fps: 60 })))).toBeNull();
    expect(errorOf(() => planExport(spec({ duration: 60, fps: 30 })))).toBeNull();
  });

  test.each([
    ['fps 0', { fps: 0 }],
    ['fps negativo', { fps: -30 }],
    ['duración NaN', { duration: Number.NaN }],
    ['duración negativa', { duration: -1 }],
  ])('%s se rechaza', (_label, over) => {
    expect(errorOf(() => planExport(spec(over)))).not.toBeNull();
  });
});

// ── Soporte del navegador ──────────────────────────────────────────────────

describe('detección de capacidad (en Bun no hay WebCodecs)', () => {
  test('isVideoExportSupported() es false y no tira', () => {
    expect(isVideoExportSupported()).toBe(false);
  });

  test('el mensaje dice qué falta y dónde no está', () => {
    expect(NO_ENCODER_MESSAGE).toContain('WebCodecs');
    expect(NO_ENCODER_MESSAGE).toContain('Firefox');
    expect(NO_ENCODER_MESSAGE).toContain('Android');
  });

  test('availableVideoFormats() devuelve [] sin códecs, sin tirar', async () => {
    expect(await availableVideoFormats(1920, 1080)).toEqual([]);
  });

  test('el resultado se cachea por dimensiones', async () => {
    const first = availableVideoFormats(1280, 720);
    expect(await availableVideoFormats(1280, 720)).toBe(await first);
    expect(await availableVideoFormats(641, 361)).not.toBe(await first);
  });

  test('exportVideo corta antes de tocar nada si no hay WebCodecs', async () => {
    expect(exportVideo(spec(), 'mp4')).rejects.toThrow(NO_ENCODER_MESSAGE);
  });
});

// ── Progreso y ETA ─────────────────────────────────────────────────────────

describe('formatEta', () => {
  test.each([
    [0, 'menos de 1 s'],
    [0.2, 'menos de 1 s'],
    [0.5, 'menos de 1 s'],
    [1, '1 s'],
    [3.4, '3 s'],
    [59.4, '59 s'],
    [59.6, '1 min 0 s'],
    [60, '1 min 0 s'],
    [125.4, '2 min 5 s'],
  ])('%is → "%s"', (seconds, expected) => {
    expect(formatEta(seconds)).toBe(expected);
  });

  test('nunca escribe "min 60 s"', () => {
    expect(formatEta(119.6)).not.toContain('60 s');
  });
});

describe('progressInfo', () => {
  const plan = planExport(spec({ duration: 5, fps: 30 }));

  test('todos los ticks dan progreso en 0..1 y son consistentes', () => {
    for (let done = 0; done <= plan.totalFrames; done++) {
      const info = progressInfo(plan, done, done * 0.01);
      expect(info.progress).toBeGreaterThanOrEqual(0);
      expect(info.progress).toBeLessThanOrEqual(1);
      expect(info.frame).toBe(done);
      expect(info.totalFrames).toBe(plan.totalFrames);
    }
  });

  test('el primero va en 0 y el último en 1, con los 150 frames declarados', () => {
    expect(progressInfo(plan, 0, 0).progress).toBe(0);
    const last = progressInfo(plan, plan.totalFrames, 20);
    expect(last.progress).toBe(1);
    expect(last.frame).toBe(150);
    expect(last.totalFrames).toBe(150);
  });

  test('el progreso nunca retrocede', () => {
    let previous = 0;
    for (let done = 0; done <= plan.totalFrames; done++) {
      const { progress } = progressInfo(plan, done, done * 0.01);
      expect(progress).toBeGreaterThanOrEqual(previous);
      previous = progress;
    }
  });

  test('`done` fuera de rango se clampa', () => {
    expect(progressInfo(plan, -5, 0).progress).toBe(0);
    expect(progressInfo(plan, -5, 0).frame).toBe(0);
    expect(progressInfo(plan, 9999, 0).progress).toBe(1);
    expect(progressInfo(plan, 9999, 0).frame).toBe(150);
  });

  test('el mensaje lleva frame/total y ningún NaN', () => {
    expect(progressInfo(plan, 120, 1.2).message).toContain('120/150');
    const messages = Array.from({ length: 151 }, (_, done) => progressInfo(plan, done, done * 0.01).message ?? '');
    expect(messages.join('|')).not.toMatch(/NaN|Infinity/);
  });

  // El ETA sale de frames medidos, no de `duration * 60`. Con 150 frames y un
  // segundo real por frame, después del primero faltan 149 segundos, no 299.
  test('el ETA se mide en frames, no en segundos de reloj', () => {
    expect(progressInfo(plan, 1, 1).message).toContain('faltan ~2 min 29 s');
    expect(progressInfo(plan, 75, 15).message).toContain('faltan ~15 s');
  });

  test('sin frames medidos no se inventa un ETA, y al terminar no hay', () => {
    expect(progressInfo(plan, 0, 0).message).not.toContain('faltan');
    expect(progressInfo(plan, plan.totalFrames, 20).message).not.toContain('faltan');
  });
});

// ── Metadata ───────────────────────────────────────────────────────────────

describe('metadata del video', () => {
  const tags = videoMetadataTags(planExport(spec({ width: 641, height: 361 })).spec);

  test('los campos normalizados salen de buildMetadata con las dimensiones reales', () => {
    expect(tags.title).toBe('Placeholder 642x362');
    expect(tags.description).toContain('Placeholder 642x362');
    expect(tags.artist).toContain(APP_NAME);
  });

  test('raw lleva Software y Source', () => {
    expect(tags.raw?.Software).toBe(APP_NAME);
    expect(tags.raw?.Source).toBe(REPO_URL);
  });

  // El muxer ISOBMFF descarta las keys de `raw` de más de 4 caracteres, así que
  // el bloque completo va en `comment`, que sí respetan los cuatro contenedores.
  test('comment lleva el bloque completo, Software y Source incluidos', () => {
    expect(tags.comment).toContain(`Software: ${APP_NAME}`);
    expect(tags.comment).toContain(`Source: ${REPO_URL}`);
  });
});

// ── Bucle de encoding ──────────────────────────────────────────────────────

interface Recorded {
  drawn: number[];
  added: Array<{ timestamp: number; duration: number; keyFrame: boolean }>;
  progress: Array<{ frame?: number; progress: number }>;
}

/** Sink falso: cuenta en vez de dibujar y codificar. */
function recordingSink(onAdd?: (index: number) => void): FrameSink & { log: Recorded } {
  const log: Recorded = { drawn: [], added: [], progress: [] };
  return {
    log,
    draw: (progress) => {
      log.drawn.push(progress);
    },
    add: async (timestamp, duration, keyFrame) => {
      log.added.push({ timestamp, duration, keyFrame });
      onAdd?.(log.added.length - 1);
    },
  };
}

const loopPlan = () => planExport(spec({ duration: 5, fps: 30 }));

describe('bucle de encoding', () => {
  test('5s a 30fps: 150 frames dibujados y encolados', async () => {
    const run = recordingSink();
    await encodeFrames(loopPlan(), run);
    expect(run.log.drawn).toHaveLength(150);
    expect(run.log.added).toHaveLength(150);
  });

  test('el frame i se dibuja con su propio avance y va en i/30s', async () => {
    const run = recordingSink();
    await encodeFrames(loopPlan(), run);
    // El primero dibuja la barra vacía, como la imagen estática.
    expect(run.log.drawn[0]).toBe(0);
    expect(run.log.drawn.every((progress, i) => close(progress, i / 150))).toBe(true);
    expect(run.log.added.every((a, i) => close(a.timestamp, i / 30) && close(a.duration, 1 / 30))).toBe(true);
    // El último arranca en 4.9667s, no en 5s: los timestamps son del frame, no
    // del final del video.
    expect(run.log.added[149]?.timestamp).toBe(149 / 30);
  });

  test('keyframes cada 2 segundos de reloj, para poder scrubbear', async () => {
    const run = recordingSink();
    await encodeFrames(loopPlan(), run);
    expect(run.log.added.filter((a) => a.keyFrame).map((a) => a.timestamp)).toEqual([0, 2, 4]);
    expect(run.log.added.map((a) => a.keyFrame)).toEqual(
      Array.from({ length: 150 }, (_, i) => i % 60 === 0),
    );
  });

  test('un tick de progreso por frame, y el último cierra en 1', async () => {
    const run = recordingSink();
    await encodeFrames(loopPlan(), run, (info) => run.log.progress.push(info));
    expect(run.log.progress).toHaveLength(150);
    expect(run.log.progress.every((p, i) => p.frame === i + 1)).toBe(true);
    expect(run.log.progress.at(-1)?.progress).toBe(1);
  });

  test('0.5s a 1fps es un frame solo, y además keyframe', async () => {
    const run = recordingSink();
    await encodeFrames(planExport(spec({ duration: 0.5, fps: 1 })), run);
    expect(run.log.added).toEqual([{ timestamp: 0, duration: 1, keyFrame: true }]);
  });
});

describe('bucle de encoding: cancelación', () => {
  test('con el signal ya cortado no dibuja nada', async () => {
    const controller = new AbortController();
    controller.abort();
    const run = recordingSink();
    expect(encodeFrames(loopPlan(), run, undefined, controller.signal)).rejects.toThrow(
      expect.objectContaining({ name: 'AbortError' }),
    );
    expect(run.log.drawn).toHaveLength(0);
    expect(run.log.added).toHaveLength(0);
  });

  test.each([0, 41, 100])('cancelar en el frame %i para ahí', async (stopAt) => {
    const controller = new AbortController();
    const run = recordingSink((index) => {
      if (index === stopAt) controller.abort();
    });

    expect(encodeFrames(loopPlan(), run, undefined, controller.signal)).rejects.toThrow(
      expect.objectContaining({ name: 'AbortError' }),
    );
    expect(run.log.added).toHaveLength(stopAt + 1);
    expect(run.log.drawn).toHaveLength(stopAt + 1);
    expect(run.log.added.every((a, i) => close(a.timestamp, i / 30))).toBe(true);
  });

  test('cortar en el último frame no es una cancelación: ya no queda nada', async () => {
    const controller = new AbortController();
    const plan = loopPlan();
    const run = recordingSink((index) => {
      if (index === plan.totalFrames - 1) controller.abort();
    });

    await encodeFrames(plan, run, undefined, controller.signal);
    expect(run.log.added).toHaveLength(150);
  });
});

describe('bucle de encoding: backpressure', () => {
  test('nunca hay dos `add` en vuelo a la vez: el `await` serializa', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const seen: number[] = [];
    const slow: FrameSink = {
      draw: () => {},
      add: async (timestamp) => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        seen.push(timestamp);
        await Promise.resolve();
        inFlight -= 1;
      },
    };

    await encodeFrames(loopPlan(), slow);
    expect(seen).toHaveLength(150);
    expect(maxInFlight).toBe(1);
  });
});
