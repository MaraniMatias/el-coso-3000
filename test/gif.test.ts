/**
 * Tests del encoder de GIF.
 *
 * Bun no tiene DOM ni canvas, así que acá no se prueba `exportGif` de punta a
 * punta: lo que se prueba es toda la lógica pura que hay debajo. El compresor
 * se verifica decodificando su propia salida, la paleta contra la calidad de
 * una paleta al azar, y el archivo con un parser escrito acá mismo, que es la
 * única forma de saber que el GIF está bien armado y no sólo que no tira.
 */

import { describe, expect, test } from 'bun:test';

import { buildMetadata, metadataAsText } from '../src/core/metadata';
import type { Spec } from '../src/core/types';
import { writeGifFrame, writeGifHeader, writeGifTrailer, type GifHeader } from '../src/encoders/gif';
import { ByteWriter, lzwCompress } from '../src/encoders/lzw';
import { buildPalette, createPaletteMapper } from '../src/encoders/quantize';

// ── Decoder de LZW (implementación de referencia, sólo para testear) ──────

/** Junta los sub-bloques de datos LZW en un stream plano de bytes. */
function readSubBlocks(bytes: Uint8Array, at: number): { data: Uint8Array; next: number } {
  const chunks: Uint8Array[] = [];
  let cursor = at;
  for (;;) {
    const len = bytes[cursor];
    if (len === undefined) throw new Error('GIF truncado: sub-bloque sin largo.');
    cursor += 1;
    if (len === 0) break;
    chunks.push(bytes.subarray(cursor, cursor + len));
    cursor += len;
  }

  const data = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let written = 0;
  for (const chunk of chunks) {
    data.set(chunk, written);
    written += chunk.length;
  }
  return { data, next: cursor };
}

/**
 * Decoder LZW de GIF. replica el crecimiento de código del codificador a
 * propósito: si el codificador se desfasara un código, el roundtrip falla acá.
 */
function decodeLzw(bytes: Uint8Array, at: number, minCodeSize: number): { pixels: Uint8Array; next: number } {
  const { data, next } = readSubBlocks(bytes, at);
  const clearCode = 1 << minCodeSize;
  const eoiCode = clearCode + 1;

  const dict: number[][] = [];
  const out: number[] = [];
  let codeSize = minCodeSize + 1;
  let nextCode = eoiCode + 1;
  let prev: number[] | null = null;
  let bit = 0;

  for (;;) {
    if (bit + codeSize > data.length * 8) throw new Error('LZW truncado: se terminó el stream antes del EOI.');
    let code = 0;
    for (let k = 0; k < codeSize; k++) {
      const byte = data[bit >> 3]!;
      code |= ((byte >> (bit & 7)) & 1) << k;
      bit += 1;
    }

    if (code === clearCode) {
      codeSize = minCodeSize + 1;
      nextCode = eoiCode + 1;
      prev = null;
      continue;
    }
    if (code === eoiCode) return { pixels: Uint8Array.from(out), next };

    let entry: number[];
    if (code < clearCode) {
      entry = [code];
    } else if (code < nextCode) {
      // La entrada existe si y sólo si está por debajo de la próxima a asignar.
      // No alcanza con "¿fue asignada alguna vez?": después de un clear la
      // tabla arranca de cero y las entradas viejas dejan de existir. Sin esto
      // el decoder desarma GIFs reales (verificado contra uno de ffmpeg) y
      // acepta entradas que el encoder nunca emitió.
      entry = dict[code]!;
    } else if (prev !== null) {
      // Caso KwKwK: el código es el que acaba de definirse y su primer byte es
      // el del prefijo.
      entry = [...prev, prev[0]!];
    } else {
      throw new Error(`LZW inválido: código ${code} sin prefijo.`);
    }

    for (const value of entry) out.push(value);
    if (prev !== null && nextCode < 4096) {
      dict[nextCode] = [...prev, entry[0]!];
      nextCode += 1;
      if (nextCode === 1 << codeSize && codeSize < 12) codeSize += 1;
    }
    prev = entry;
  }
}

/**
 * Cuenta cuántos códigos CLEAR emitted hay en la cadena.
 *
 * Sirve para que un roundtrip no pase por cubrir a medias el reinicio del
 * diccionario: el bug del ancho era invisible en los casos chica y sólo
 * aparecía cuando la tabla se llenaba y había que emitir un clear en el
 * medio. Un test que dice "esto cubre el clear" tiene que poder demostrarlo.
 *
 * El recorrido es el mismo que el del decoder (mismo orden del clear, mismo
 * crecimiento de ancho) pero sin armar cadenas: sólo cuenta.
 */
function countClearCodes(bytes: Uint8Array, minCodeSize: number): number {
  const { data } = readSubBlocks(bytes, 0);
  const clearCode = 1 << minCodeSize;
  const eoiCode = clearCode + 1;
  let codeSize = minCodeSize + 1;
  let nextCode = eoiCode + 1;
  let hasPrev = false;
  let bit = 0;
  let clears = 0;

  for (;;) {
    if (bit + codeSize > data.length * 8) throw new Error('LZW truncado al contar los clears.');
    let code = 0;
    for (let k = 0; k < codeSize; k++) {
      code |= ((data[bit >> 3]! >> (bit & 7)) & 1) << k;
      bit += 1;
    }
    if (code === clearCode) {
      clears += 1;
      codeSize = minCodeSize + 1;
      nextCode = eoiCode + 1;
      hasPrev = false;
      continue;
    }
    if (code === eoiCode) return clears;
    if (hasPrev && nextCode < 4096) {
      nextCode += 1;
      if (nextCode === 1 << codeSize && codeSize < 12) codeSize += 1;
    }
    hasPrev = true;
  }
}

// ── Parser de GIF ─────────────────────────────────────────────────────────

interface ParsedFrame {
  delayCs: number;
  transparentIndex: number | null;
  left: number;
  top: number;
  width: number;
  height: number;
  pixels: Uint8Array;
  minCodeSize: number;
}

interface ParsedGif {
  signature: string;
  version: string;
  width: number;
  height: number;
  gct: Uint8Array | null;
  backgroundIndex: number;
  loop: number | null;
  comment: string;
  frames: ParsedFrame[];
  trailer: number;
}

const text = (bytes: Uint8Array, at: number, len: number): string =>
  new TextDecoder().decode(bytes.subarray(at, at + len));

/**
 * Parser mínimo de GIF. Rechaza lo que no puede decodificar: si acepta basura,
 * el test no está probando nada.
 */
function parseGif(bytes: Uint8Array): ParsedGif {
  const u8 = bytes;
  const need = (n: number, at: number): void => {
    if (at + n > u8.length) throw new Error(`GIF truncado: se pidieron ${n} bytes en ${at} y el archivo tiene ${u8.length}.`);
  };
  const u16 = (at: number): number => {
    need(2, at);
    return (u8[at]! | (u8[at + 1]! << 8)) >>> 0;
  };

  need(13, 0);
  const signature = text(u8, 0, 3);
  if (signature !== 'GIF') throw new Error(`Firma inválida: ${signature}`);
  const version = text(u8, 3, 3);
  if (version !== '89a' && version !== '87a') throw new Error(`Versión inválida: ${version}`);

  const width = u16(6);
  const height = u16(8);
  const packed = u8[10]!;
  const backgroundIndex = u8[11]!;

  let gct: Uint8Array | null = null;
  let at = 13;
  if ((packed & 0x80) !== 0) {
    // El tamaño de la tabla está en los 3 bits bajos como exponente. Todo valor
    // de acá es legal, pero los bytes tienen que estar: si el campo promete una
    // tabla más grande de lo que el archivo tiene, el archivo está roto.
    const entries = 1 << ((packed & 0x07) + 1);
    need(entries * 3, at);
    gct = u8.slice(at, at + entries * 3);
    at += entries * 3;
  }

  const gif: ParsedGif = {
    signature,
    version,
    width,
    height,
    gct,
    backgroundIndex,
    loop: null,
    comment: '',
    frames: [],
    trailer: -1,
  };

  let pendingGce: { delayCs: number; transparentIndex: number | null } | null = null;

  for (;;) {
    need(1, at);
    const marker = u8[at]!;
    at += 1;

    if (marker === 0x3b) {
      gif.trailer = marker;
      return gif;
    }

    if (marker === 0x21) {
      need(1, at);
      const label = u8[at]!;
      at += 1;
      if (label === 0xf9) {
        need(1, at);
        const size = u8[at]!;
        need(size, at + 1);
        if (size !== 4) throw new Error(`GCE inválido: largo ${size}.`);
        const gcePacked = u8[at + 1]!;
        pendingGce = {
          delayCs: (u8[at + 2]! | (u8[at + 3]! << 8)) >>> 0,
          transparentIndex: (gcePacked & 0x01) !== 0 ? u8[at + 4]! : null,
        };
        at += 1 + size;
        need(1, at);
        at += 1; // terminador del bloque
      } else if (label === 0xff) {
        const { data, next } = readSubBlocks(u8, at);
        // 11 bytes de identificación, sub-bloque de control, luego el conteo.
        if (text(data, 0, 11) !== 'NETSCAPP2.0') throw new Error('Application Extension desconocida.');
        const count = data[13]! | (data[14]! << 8);
        gif.loop = count;
        at = next;
      } else {
        const { data, next } = readSubBlocks(u8, at);
        if (label === 0xfe) gif.comment += text(data, 0, data.length);
        at = next;
      }
      continue;
    }

    if (marker === 0x2c) {
      const left = u16(at);
      const top = u16(at + 2);
      const fw = u16(at + 4);
      const fh = u16(at + 6);
      const imgPacked = u8[at + 8]!;
      at += 9;
      if ((imgPacked & 0x80) !== 0) at += 3 * (1 << ((imgPacked & 0x07) + 1)); // tabla local
      if ((imgPacked & 0x40) !== 0) throw new Error('GIF entrelazado: no se prueba.');

      need(1, at);
      const minCodeSize = u8[at]!;
      at += 1;
      const { pixels, next } = decodeLzw(u8, at, minCodeSize);
      at = next;

      if (pixels.length !== fw * fh) {
        throw new Error(`El frame declara ${fw}x${fh} pero trae ${pixels.length} píxeles.`);
      }
      gif.frames.push({
        delayCs: pendingGce?.delayCs ?? 0,
        transparentIndex: pendingGce?.transparentIndex ?? null,
        left,
        top,
        width: fw,
        height: fh,
        pixels,
        minCodeSize,
      });
      pendingGce = null;
      continue;
    }

    throw new Error(`Bloque GIF desconocido: 0x${marker.toString(16)}.`);
  }
}

// ── Utilidades de test ────────────────────────────────────────────────────

const SPEC: Spec = {
  width: 4,
  height: 2,
  bg: 'FFE4E4',
  fg: '333333',
  paletteName: 'rose',
  duration: 1,
  fps: 30,
  showProgressBar: true,
  showTime: true,
  quality: 0.9,
};

/** PRNG determinista: los tests tienen que fallar siempre igual. */
function rng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

function buildTestGif(options: { palette?: Uint8Array; delayCs?: number; frames?: Uint8Array[] } = {}): Uint8Array {
  const header: GifHeader = {
    width: SPEC.width,
    height: SPEC.height,
    palette: options.palette ?? new Uint8Array([0x33, 0x33, 0x33, 0xff, 0xe4, 0xe4, 0x00, 0x00, 0x00]),
    comment: metadataAsText(buildMetadata(SPEC)),
    loop: 0,
  };
  // 3 colores reales + el índice 3 reservado para transparencia.
  const frames = options.frames ?? [
    Uint8Array.from([0, 0, 0, 1, 1, 1, 2, 2]),
    Uint8Array.from([1, 1, 1, 2, 2, 2, 3, 3]),
  ];

  const out = new ByteWriter(256);
  writeGifHeader(out, header);
  for (const frame of frames) writeGifFrame(out, header, frame, options.delayCs ?? 4);
  writeGifTrailer(out);
  return out.finish();
}

// ── LZW ───────────────────────────────────────────────────────────────────

/**
 * Salida de referencia de `lzwCompress` para la entrada del test "la salida es
 * byte a byte la de un encoder de referencia", en base64 (1016 bytes).
 *
 * No es una foto del output actual: son los bytes que produce ffmpeg
 * (`libavcodec/lzwenc.c`) para esa misma entrada, así que el test ata el
 * encoder a la implementación de referencia y no sólo a sí mismo.
 */
const REFERENCE_LZW =
  '/wADABggAACAggYFCCA4IIDDAQQFNjRIcGEAhQohXhxYsKFAhwcjUgwwIOFAkhoXeizZ8eHDjgcNDmTIEoBAlTMXFrxY' +
  '0qbOjxkbLjyIUgBJo0Y5AoXYkCVTg0UjXgRZ0uPGnh6JHrVJ8iJGgglpcoTK1OpBjA4/Jtw4tWXXiVAdWmQJUi5KnknP' +
  '+lR4lW9MkjILzmU4MCFCvhpRQuR7FCLXqgq5Rp5K1THFqiBPZvW5sjBZpXIhF4Up8yFDiRkRC/SJsnDKjy+7HrYaOmlj' +
  'sC4ty6642mvljZMBq4w8k23Rj0x1arTpWO3UxV41K36rO/DXh8WHAo4OPLn21BNRG//t2bHnaq3LeXrmudimTK6mE1/H' +
  'ztr0TcdVQ3bceRZ2ZKwzNYfaYyHRhR5zWel02WCFMWbaX2kNqFZ/kQ03nldIDaXTTk/FhKBKVfXEFVG2tXcUh56FJFNJ' +
  'd301knkqyeVeUEelBdZJMmKEY4M7pYWjYECORlSDD1bkFEIgVfiURIF5lJGMIzWWIos6arjSYY/JZdGMi/GHUIgadfnc' +
  'eNDNxBFcgrnXYVgi2bYlWzCdVp1QUNV5k3Iy8oYdcVoylCF7Pl6V0oo7uRmeUeyVBlZKE5m4l0hlqUfUYs2Z2VRaFll0' +
  'lX1wrdXacpIBORFOoyKYXHhZNXrdSSFtJaZQGPL/ZxeiEWH1XKgrAqXeqcyd6GdmMaEFU0YN+tSqiV/a5dtNSVp25Wkk' +
  'cvgUiNBOxdxIgokoXHh6scUqpdGxSB9nTLp31pFjWcsgt2XNRaZ256llq1PUCYciR+8GddJ/zvrYaEWIvsRXwPaapKmd' +
  'LTFXJYfj4QQcsWEBF5qrauIUbKaC9YnUpMlh+t+TfoaYrUReLVkWZKfWNRSsPJUbHbEsAZnpq0CqWOhqNc0ono4AxyTS' +
  'VkxiZtWF/mUVq1ZJQTsWlfHFWGCGF3ZZ63YtZwuXRDRt11TEkLaH1Ha02ospplHy5l2wsgUcacbGofUXgiYleuelqZmZ' +
  'GbPpPkVXpuM29vyV2eLiZRiWNWGVlF/hBU2rrTcZqxfUK5+lXHG91tqpmhStbC2JnYJqNF40dbkXe0PltCFldPJXk283' +
  'tjwp0PeRmqFjWGrpMJwxDk1VXxieht1WPMZ85l5RXhYXYCZt/aW54y24OmZ3Jqsye14H+HWt8JF1pWKS43YYTs17eGKL' +
  'W7pL0fn5NXz+ca82tjGCNn6KG3AR29br6ChP3tvTXSWZWVMiap2pEKMwc9VGNwrayFrygqb3JO89haqIipo0u0dx5mQR' +
  'Kp2vklSY1WRrQ9ApWWp6YyMLaW4/JHrL1xgDqxk16GQhugqruAQ209iPTEWzHEQCAgA=';

describe('LZW de GIF', () => {
  // Ojo con `rng(seed)()` dentro del arrow: ahí el PRNG se reinicia en cada
  // elemento y la "entrada aleatoria" sale de un solo valor repetido. Por eso
  // los generadores se crean una vez, afuera.
  const random42 = rng(42);
  const cases: Array<{ name: string; data: Uint8Array; minCodeSize: number }> = [
    { name: 'vacío', data: new Uint8Array(0), minCodeSize: 3 },
    { name: 'un byte', data: Uint8Array.from([7]), minCodeSize: 3 },
    { name: 'un byte con minCodeSize 8', data: Uint8Array.from([255]), minCodeSize: 8 },
    { name: 'todos iguales', data: new Uint8Array(50_000).fill(3), minCodeSize: 3 },
    { name: 'secuencia creciente', data: Uint8Array.from({ length: 20_000 }, (_, i) => i & 0x07), minCodeSize: 3 },
    {
      name: 'aleatorio de 100KB',
      data: Uint8Array.from({ length: 100_000 }, () => Math.floor(random42() * 256)),
      minCodeSize: 8,
    },
    {
      name: 'frame de placeholder (pocos colores)',
      data: Uint8Array.from({ length: SPEC.width * SPEC.height * 20 }, (_, i) => i % 3),
      minCodeSize: 3,
    },
  ];

  for (const { name, data, minCodeSize } of cases) {
    test(`roundtrip: ${name}`, () => {
      // `lzwCompress` devuelve la cadena de sub-bloques completa, así que el
      // decoder arranca en el offset 0.
      const { pixels } = decodeLzw(lzwCompress(data, minCodeSize), 0, minCodeSize);
      expect(pixels).toEqual(data);
    });
  }

  test('el roundtrip sobrevive al reinicio del diccionario', () => {
    // Con minCodeSize 2 el diccionario se llena a los pocos KiB, así que el
    // compresor tiene que emitir un clear en el medio. Si el ancho de código no
    // se reinicia con el clear, el decoder se desfasaría y esto falla.
    const random = rng(7);
    const data = Uint8Array.from({ length: 200_000 }, () => Math.floor(random() * 4));
    const { pixels } = decodeLzw(lzwCompress(data, 2), 0, 2);
    expect(pixels).toEqual(data);
  });

  test('rechaza un minCodeSize inválido', () => {
    expect(() => lzwCompress(Uint8Array.from([0]), 1)).toThrow(RangeError);
    expect(() => lzwCompress(Uint8Array.from([0]), 9)).toThrow(RangeError);
    expect(() => lzwCompress(Uint8Array.from([0]), 2.5)).toThrow(RangeError);
  });

  test('comprime una entrada repetitiva', () => {
    // Sanidad del algoritmo: si no comprime, el encoder no está comprimiendo
    // nada aunque el roundtrip pase.
    const data = new Uint8Array(100_000).fill(1);
    const packed = lzwCompress(data, 3);
    expect(packed.length).toBeLessThan(data.length / 100);
  });

  // ── Cobertura que faltaba ────────────────────────────────────────────────
  //
  // Los tests de arriba pasaban con el encoder roto: el bug del crecimiento
  // del ancho sólo desfasaba al pasar la entrada 2^codeSize, y con el decoder
  // roto el error se cancelaba por el camino. Estos tres están elegidos para
  // que eso no pueda pasar de nuevo.

  test('el roundtrip sobrevive con la tabla llena y un clear intermedio', () => {
    // minCodeSize 2 => los códigos de datos arrancan en el 6 y la tabla se topa
    // con el tope de 4096 al cabo de ~4090 entradas. Con esta entrada la tabla
    // se llena de verdad y el encoder tiene que emitir un clear en el medio:
    // es el escenario que ningún test de arriba tocaba.
    const random = rng(11);
    const data = Uint8Array.from({ length: 20_000 }, () => Math.floor(random() * 4));
    const packed = lzwCompress(data, 2);

    // El clear intermedio tiene que estar ahí, no "por si acaso": sin esto el
    // test pasaría igual con el encoder roto.
    expect(countClearCodes(packed, 2)).toBe(2); // el inicial + el intermedio
    expect(packed.length).toBeLessThan(data.length / 2); // y comprime de verdad
    expect(decodeLzw(packed, 0, 2).pixels).toEqual(data);
  });

  test('roundtrip con minCodeSize de 2 a 8 usando todo el rango de índices', () => {
    // El rango de índices es 0..2^minCodeSize-1 y los datos de arriba sólo
    // usaban 4 valores. Con minCodeSize 8 además el clear vale 256, así que
    // cualquier índice >= 256 es un código de datos y no una raíz: es donde se
    // rompe el tratamiento deKwKwK y de las entradas reservadas.
    for (let minCodeSize = 2; minCodeSize <= 8; minCodeSize++) {
      const range = 1 << minCodeSize;
      const data = Uint8Array.from({ length: 5_000 }, (_, i) => (i * 7 + Math.floor(i / range)) % range);
      // El generador tiene que tocar de verdad cada índice, o el test no
      // estaría probando lo que dice probar.
      expect(new Set(data).size).toBe(range);

      const { pixels } = decodeLzw(lzwCompress(data, minCodeSize), 0, minCodeSize);
      expect(pixels).toEqual(data);
    }
  });

  test('la salida es byte a byte la de un encoder de referencia', () => {
    // Vector de referencia REAL, no una foto del output actual: son los bytes
    // que produce ffmpeg (`libavcodec/lzwenc.c`) para esta misma entrada, que
    // se reproduce con:
    //
    //   ffmpeg -f rawvideo -pix_fmt pal8 -s 3000x1 -i indices.bin \
    //          -frames:v 1 -gifflags 0 out.gif
    //
    // Los pal8 entran al encoder de GIF sin reindexar, así que la entrada del
    // comando es exactamente este array de índices.
    //
    // La entrada cruza dos fronteras de ancho (9→10 al asignar la entrada 513
    // y 10→11 al asignar la 1025), o sea que un cambio en la regla de
    // crecimiento del ancho se ve en el primer byte que se desfasaría, sin
    // necesidad de un roundtrip.

    // LCG determinista: los 3000 bytes de la entrada de referencia.
    let state = 12345 >>> 0;
    const data = Uint8Array.from({ length: 3_000 }, () => {
      state = (state * 1664525 + 1013904223) >>> 0;
      return (state >>> 24) % 4;
    });
    const expected = Uint8Array.from(atob(REFERENCE_LZW), (c) => c.charCodeAt(0));

    const packed = lzwCompress(data, 8);
    expect(packed).toEqual(expected);
    // Y el vector tiene que seguir siendo el mismo caso: sin clear intermedio,
    // porque el punto de este test es el ancho, no el reinicio.
    expect(countClearCodes(packed, 8)).toBe(1);
  });
});

// ── Median cut ────────────────────────────────────────────────────────────

describe('cuantización por corte de la mediana', () => {
  /** Gradiente con ruido: muchos colores distintos, así la distancia importa. */
  function noisyGradient(n: number, seed: number): Uint8Array {
    const random = rng(seed);
    const out = new Uint8Array(n * 3);
    for (let i = 0; i < n; i++) {
      out[i * 3] = Math.floor((i / n) * 255);
      out[i * 3 + 1] = Math.floor(random() * 255);
      out[i * 3 + 2] = Math.floor((1 - i / n) * 255);
    }
    return out;
  }

  /** Distancia media de cada muestra al color más cercano de la paleta. */
  function meanError(samples: Uint8Array, rgb: Uint8Array, size: number): number {
    const mapper = createPaletteMapper({ rgb, size });
    let total = 0;
    for (let i = 0; i + 2 < samples.length; i += 3) {
      const index = mapper((samples[i]! << 16) | (samples[i + 1]! << 8) | samples[i + 2]!);
      const dr = samples[i]! - rgb[index * 3]!;
      const dg = samples[i + 1]! - rgb[index * 3 + 1]!;
      const db = samples[i + 2]! - rgb[index * 3 + 2]!;
      total += dr * dr + dg * dg + db * db;
    }
    return total / (samples.length / 3);
  }

  test('nunca supera el máximo pedido de colores', () => {
    const samples = noisyGradient(20_000, 1);
    for (const max of [1, 2, 4, 16, 64, 255, 256]) {
      const palette = buildPalette(samples, max);
      expect(palette.size).toBeLessThanOrEqual(max);
      expect(palette.rgb.length).toBe(palette.size * 3);
    }
  });

  test('colapsa a la cantidad real de colores cuando alcanza', () => {
    // El caso del placeholder: cuatro colores con 256 slots disponibles.
    const samples = new Uint8Array([0x33, 0x33, 0x33, 0xff, 0xe4, 0xe4, 0x8a, 0x8a, 0x8a, 0x00, 0x00, 0x00]);
    const palette = buildPalette(samples, 256);
    expect(palette.size).toBe(4);
  });

  test('cubre la entrada mejor que una paleta al azar del mismo tamaño', () => {
    const samples = noisyGradient(20_000, 2);
    const palette = buildPalette(samples, 16);
    const mine = meanError(samples, palette.rgb, palette.size);

    const random = rng(99);
    let bestRandom = Infinity;
    for (let attempt = 0; attempt < 5; attempt++) {
      const rgb = new Uint8Array(16 * 3);
      for (let i = 0; i < rgb.length; i++) rgb[i] = Math.floor(random() * 256);
      bestRandom = Math.min(bestRandom, meanError(samples, rgb, 16));
    }

    expect(mine).toBeLessThan(bestRandom);
  });

  test('es determinista', () => {
    const samples = noisyGradient(5_000, 3);
    const a = buildPalette(samples, 32);
    const b = buildPalette(samples, 32);
    expect(a.rgb).toEqual(b.rgb);
    expect(a.size).toBe(b.size);
  });

  test('no rompe con la entrada vacía', () => {
    const palette = buildPalette(new Uint8Array(0), 256);
    expect(palette.size).toBe(1);
    expect(palette.rgb.length).toBe(3);
  });

  test('el mapper devuelve el índice exacto de un color de la paleta', () => {
    const palette = buildPalette(noisyGradient(1_000, 4), 8);
    const mapper = createPaletteMapper(palette);
    for (let i = 0; i < palette.size; i++) {
      const packed = (palette.rgb[i * 3]! << 16) | (palette.rgb[i * 3 + 1]! << 8) | palette.rgb[i * 3 + 2]!;
      expect(mapper(packed)).toBe(i);
    }
  });
});

// ── Estructura del GIF ────────────────────────────────────────────────────

describe('estructura del GIF', () => {
  test('la cabecera y la tabla global de colores están donde deben', () => {
    const gif = parseGif(buildTestGif());

    expect(gif.signature).toBe('GIF');
    expect(gif.version).toBe('89a');
    expect(gif.width).toBe(SPEC.width);
    expect(gif.height).toBe(SPEC.height);
    expect(gif.gct).not.toBeNull();
    // 3 colores reales + 1 reservado para transparencia => 4 entradas.
    expect(gif.gct!.length).toBe(4 * 3);
    expect(gif.trailer).toBe(0x3b);
  });

  test('el bloque de bucle pide loop infinito', () => {
    expect(parseGif(buildTestGif()).loop).toBe(0);
  });

  test('la metadata viaja en el comment extension', () => {
    const gif = parseGif(buildTestGif());
    expect(gif.comment).toBe(metadataAsText(buildMetadata(SPEC)));
    expect(gif.comment).toContain('el-coso-3000');
  });

  test('cada frame lleva su GCE con el delay y el índice transparente', () => {
    const gif = parseGif(buildTestGif({ delayCs: 4 }));
    expect(gif.frames).toHaveLength(2);
    for (const frame of gif.frames) {
      expect(frame.delayCs).toBe(4);
      expect(frame.transparentIndex).toBe(3);
      expect(frame.left).toBe(0);
      expect(frame.top).toBe(0);
      expect(frame.width).toBe(SPEC.width);
      expect(frame.height).toBe(SPEC.height);
    }
  });

  test('los píxeles de los frames sobreviven al LZW', () => {
    const frames = [
      Uint8Array.from([0, 0, 0, 1, 1, 1, 2, 2]),
      Uint8Array.from([3, 3, 1, 1, 2, 2, 0, 0]),
    ];
    const gif = parseGif(buildTestGif({ frames }));
    expect(gif.frames[0]!.pixels).toEqual(frames[0]!);
    expect(gif.frames[1]!.pixels).toEqual(frames[1]!);
  });

  test('el delay se escribe en centésimas, no en segundos', () => {
    // 100/30 = 3.33 -> 3cs, que es lo que reproduce el archivo.
    expect(parseGif(buildTestGif({ delayCs: 3 })).frames[0]!.delayCs).toBe(3);
    expect(parseGif(buildTestGif({ delayCs: 1 })).frames[0]!.delayCs).toBe(1);
  });

  test('la GCT crece a potencia de dos y deja un índice libre para el alfa', () => {
    for (const colors of [1, 2, 3, 5, 17, 255]) {
      const palette = new Uint8Array(colors * 3).fill(0x20);
      const gif = parseGif(buildTestGif({ palette }));
      const entries = gif.gct!.length / 3;
      expect(entries & (entries - 1)).toBe(0); // potencia de dos
      expect(entries).toBeGreaterThanOrEqual(colors + 1);
      expect(gif.frames[0]!.transparentIndex).toBe(colors);
      expect(gif.frames[0]!.transparentIndex!).toBeLessThan(entries);
      // La GCT es la potencia de dos más chica que entra la paleta más el slot
      // transparente, así que con 17 o 255 colores no puede ser de 8: el tope
      // de 8entries aplica al caso del spec, que usa un puñado de colores.
      if (colors <= 5) expect(entries).toBeLessThanOrEqual(8);
    }
  });

  test('un frame del tamaño que no es se rechaza antes de escribir', () => {
    const header: GifHeader = {
      width: 4,
      height: 2,
      palette: new Uint8Array([0, 0, 0, 255, 255, 255]),
      comment: 'x',
      loop: 0,
    };
    expect(() => writeGifFrame(new ByteWriter(16), header, new Uint8Array(7), 4)).toThrow(/píxeles/);
  });

  // --- Casos negativos ---

  test('rechaza un GIF truncado', () => {
    const full = buildTestGif();
    // Cortar a mitad del archivo: falta el trailer y el segundo frame quedó a medias.
    expect(() => parseGif(full.subarray(0, full.length - 6))).toThrow(/truncado/);
    expect(() => parseGif(full.subarray(0, 5))).toThrow(/truncado/);
    expect(() => parseGif(new Uint8Array(0))).toThrow(/truncado/);
  });

  test('rechaza una GCT de tamaño incorrecto', () => {
    // El campo de tamaño de la tabla del descriptor_screen miente: promete 256
    // entradas y el archivo no las tiene.
    const broken = buildTestGif();
    broken[10] = (broken[10]! & 0xf8) | 0x07;
    expect(() => parseGif(broken)).toThrow(/truncado/);
  });

  test('rechaza una firma que no es GIF', () => {
    const broken = buildTestGif();
    broken[0] = 0x89;
    expect(() => parseGif(broken)).toThrow(/Firma inválida/);
  });

  test('rechaza un bloque desconocido', () => {
    const broken = buildTestGif();
    // 13 de cabecera + 12 de GCT + 19 del application extension
    // (0x21, 0xFF, 0x0B, "NETSCAPP2.0", 0x03, 0x01, 2 bytes de conteo, 0x00):
    // ahí arranca el comment extension, y 0x42 no es un marcador válido.
    broken[13 + 12 + 19] = 0x42;
    expect(() => parseGif(broken)).toThrow(/desconocido/);
  });
});
