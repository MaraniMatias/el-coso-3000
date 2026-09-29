/**
 * GIF encoder tests.
 *
 * Bun has no DOM or canvas, so `exportGif` is not tested end to end here: what
 * is tested is all the pure logic underneath. The compressor is verified by
 * decoding its own output, the palette against the quality of a random
 * palette, and the file with a parser written right here, which is the only
 * way to know the GIF is correctly assembled and not merely that it does not throw.
 */

import { describe, expect, test } from 'bun:test';

import { buildMetadata, metadataAsText } from '../src/core/metadata';
import type { Spec } from '../src/core/types';
import { writeGifFrame, writeGifHeader, writeGifTrailer, type GifHeader } from '../src/encoders/gif';
import { ByteWriter, lzwCompress } from '../src/encoders/lzw';
import { buildPalette, createPaletteMapper } from '../src/encoders/quantize';

// ── LZW decoder (reference implementation, for testing only) ───────────────

/** Joins the LZW data sub-blocks into a flat byte stream. */
function readSubBlocks(bytes: Uint8Array, at: number): { data: Uint8Array; next: number } {
  const chunks: Uint8Array[] = [];
  let cursor = at;
  for (;;) {
    const len = bytes[cursor];
    if (len === undefined) throw new Error('Truncated GIF: sub-block without a length.');
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
 * GIF LZW decoder. It intentionally mirrors the encoder's code growth: if the
 * encoder gets one code out of sync, the roundtrip fails here.
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
    if (bit + codeSize > data.length * 8) throw new Error('Truncated LZW: the stream ended before the EOI.');
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
      // The entry exists if and only if it is below the next one to be assigned.
      // "Was it ever assigned?" is not enough: after a clear, the table starts
      // over and the old entries cease to exist. Without this, the decoder
      // mangles real GIFs (verified against one from ffmpeg) and accepts
      // entries the encoder never emitted.
      entry = dict[code]!;
    } else if (prev !== null) {
      // KwKwK case: the code is the one just defined, and its first byte is
      // the prefix byte.
      entry = [...prev, prev[0]!];
    } else {
      throw new Error(`Invalid LZW: code ${code} with no prefix.`);
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
 * Counts how many CLEAR codes are emitted in the stream.
 *
 * This ensures a roundtrip does not pass while only partially covering the
 * dictionary reset: the code-width bug was invisible in small cases and only
 * appeared when the table filled up and a clear had to be emitted midway. A
 * test that says "this covers the clear" must be able to prove it.
 *
 * The traversal is the same as the decoder's (same clear order, same width
 * growth), but without building strings: it only counts.
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
    if (bit + codeSize > data.length * 8) throw new Error('LZW truncated while counting the clears.');
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

// ── GIF parser ────────────────────────────────────────────────────────────

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
 * Minimal GIF parser. It rejects anything it cannot decode: if it accepts
 * garbage, the test is not checking anything.
 */
function parseGif(bytes: Uint8Array): ParsedGif {
  const u8 = bytes;
  const need = (n: number, at: number): void => {
    if (at + n > u8.length) throw new Error(`Truncated GIF: ${n} bytes were asked for at ${at} and the file has ${u8.length}.`);
  };
  const u16 = (at: number): number => {
    need(2, at);
    return (u8[at]! | (u8[at + 1]! << 8)) >>> 0;
  };

  need(13, 0);
  const signature = text(u8, 0, 3);
  if (signature !== 'GIF') throw new Error(`Invalid signature: ${signature}`);
  const version = text(u8, 3, 3);
  if (version !== '89a' && version !== '87a') throw new Error(`Invalid version: ${version}`);

  const width = u16(6);
  const height = u16(8);
  const packed = u8[10]!;
  const backgroundIndex = u8[11]!;

  let gct: Uint8Array | null = null;
  let at = 13;
  if ((packed & 0x80) !== 0) {
    // The table size is stored in the low 3 bits as an exponent. Every value
    // here is legal, but the bytes must be present: if the field promises a
    // larger table than the file contains, the file is broken.
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
        if (size !== 4) throw new Error(`Invalid GCE: size ${size}.`);
        const gcePacked = u8[at + 1]!;
        pendingGce = {
          delayCs: (u8[at + 2]! | (u8[at + 3]! << 8)) >>> 0,
          transparentIndex: (gcePacked & 0x01) !== 0 ? u8[at + 4]! : null,
        };
        at += 1 + size;
        need(1, at);
        at += 1; // block terminator
      } else if (label === 0xff) {
        const { data, next } = readSubBlocks(u8, at);
        // 11 identification bytes, control sub-block, then the count.
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
      if ((imgPacked & 0x80) !== 0) at += 3 * (1 << ((imgPacked & 0x07) + 1)); // local table
      if ((imgPacked & 0x40) !== 0) throw new Error('GIF entrelazado: no se prueba.');

      need(1, at);
      const minCodeSize = u8[at]!;
      at += 1;
      const { pixels, next } = decodeLzw(u8, at, minCodeSize);
      at = next;

      if (pixels.length !== fw * fh) {
        throw new Error(`The frame declares ${fw}x${fh} but carries ${pixels.length} pixels.`);
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

// ── Test utilities ────────────────────────────────────────────────────────

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

/** Deterministic PRNG: tests must always fail the same way. */
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
  // 3 actual colors + index 3 reserved for transparency.
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
 * Reference output from `lzwCompress` for the input in the test "the output
 * matches a reference encoder byte for byte", in base64 (1016 bytes).
 *
 * This is not a snapshot of the current output: these are the bytes produced
 * by ffmpeg (`libavcodec/lzwenc.c`) for the same input, so the test ties the
 * encoder to the reference implementation and not just to itself.
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

describe('GIF LZW', () => {
  // Beware of `rng(seed)()` inside the arrow: the PRNG would reset for each
  // element and the "random input" would consist of one repeated value. That
  // is why the generators are created once, outside.
  const random42 = rng(42);
  const cases: Array<{ name: string; data: Uint8Array; minCodeSize: number }> = [
    { name: 'empty', data: new Uint8Array(0), minCodeSize: 3 },
    { name: 'one byte', data: Uint8Array.from([7]), minCodeSize: 3 },
    { name: 'one byte with minCodeSize 8', data: Uint8Array.from([255]), minCodeSize: 8 },
    { name: 'all identical', data: new Uint8Array(50_000).fill(3), minCodeSize: 3 },
    { name: 'increasing sequence', data: Uint8Array.from({ length: 20_000 }, (_, i) => i & 0x07), minCodeSize: 3 },
    {
      name: '100KB random input',
      data: Uint8Array.from({ length: 100_000 }, () => Math.floor(random42() * 256)),
      minCodeSize: 8,
    },
    {
      name: 'placeholder frame (few colors)',
      data: Uint8Array.from({ length: SPEC.width * SPEC.height * 20 }, (_, i) => i % 3),
      minCodeSize: 3,
    },
  ];

  for (const { name, data, minCodeSize } of cases) {
    test(`roundtrip: ${name}`, () => {
      // `lzwCompress` returns the complete sub-block sequence, so the decoder
      // starts at offset 0.
      const { pixels } = decodeLzw(lzwCompress(data, minCodeSize), 0, minCodeSize);
      expect(pixels).toEqual(data);
    });
  }

  test('roundtrip survives a dictionary reset', () => {
    // With minCodeSize 2, the dictionary fills up after a few KiB, so the
    // compressor must emit a clear midway. If the code width is not reset with
    // the clear, the decoder gets out of sync and this fails.
    const random = rng(7);
    const data = Uint8Array.from({ length: 200_000 }, () => Math.floor(random() * 4));
    const { pixels } = decodeLzw(lzwCompress(data, 2), 0, 2);
    expect(pixels).toEqual(data);
  });

  test('rejects an invalid minCodeSize', () => {
    expect(() => lzwCompress(Uint8Array.from([0]), 1)).toThrow(RangeError);
    expect(() => lzwCompress(Uint8Array.from([0]), 9)).toThrow(RangeError);
    expect(() => lzwCompress(Uint8Array.from([0]), 2.5)).toThrow(RangeError);
  });

  test('compresses repetitive input', () => {
    // Algorithm sanity check: if it does not compress, the encoder is not
    // compressing anything even if the roundtrip passes.
    const data = new Uint8Array(100_000).fill(1);
    const packed = lzwCompress(data, 3);
    expect(packed.length).toBeLessThan(data.length / 100);
  });

  // ── Previously missing coverage ─────────────────────────────────────────
  //
  // The tests above passed with the encoder broken: the code-width growth bug
  // only caused an offset after input 2^codeSize, and with the decoder broken
  // the error canceled itself out. These three are chosen to prevent that
  // from happening again.

  test('roundtrip survives a full table and an intermediate clear', () => {
    // minCodeSize 2 => data codes start at 6 and the table reaches the 4096
    // limit after ~4090 entries. With this input the table really fills up and
    // the encoder must emit a clear midway: none of the tests above covered
    // this scenario.
    const random = rng(11);
    const data = Uint8Array.from({ length: 20_000 }, () => Math.floor(random() * 4));
    const packed = lzwCompress(data, 2);

    // The intermediate clear must be present, not merely "just in case":
    // without this, the test would still pass with the encoder broken.
    expect(countClearCodes(packed, 2)).toBe(2); // the initial one + the intermediate one
    expect(packed.length).toBeLessThan(data.length / 2); // and it really compresses
    expect(decodeLzw(packed, 0, 2).pixels).toEqual(data);
  });

  test('roundtrip with minCodeSize 2 through 8 using the full index range', () => {
    // The index range is 0..2^minCodeSize-1, and the data above used only 4
    // values. With minCodeSize 8, clear is also 256, so any index >= 256 is a
    // data code and not a root: this is where handling of KwKwK and reserved
    // entries can break.
    for (let minCodeSize = 2; minCodeSize <= 8; minCodeSize++) {
      const range = 1 << minCodeSize;
      const data = Uint8Array.from({ length: 5_000 }, (_, i) => (i * 7 + Math.floor(i / range)) % range);
      // The generator must actually hit every index, or the test would not be
      // testing what it claims to test.
      expect(new Set(data).size).toBe(range);

      const { pixels } = decodeLzw(lzwCompress(data, minCodeSize), 0, minCodeSize);
      expect(pixels).toEqual(data);
    }
  });

  test('output matches a reference encoder byte for byte', () => {
    // REAL reference vector, not a snapshot of the current output: these are
    // the bytes produced by ffmpeg (`libavcodec/lzwenc.c`) for this same input,
    // reproduced with:
    //
    //   ffmpeg -f rawvideo -pix_fmt pal8 -s 3000x1 -i indices.bin \
    //          -frames:v 1 -gifflags 0 out.gif
    //
    // pal8 is passed to the GIF encoder without reindexing, so the command's
    // input is exactly this array of indices.
    //
    // The input crosses two width boundaries (9→10 when entry 513 is assigned
    // and 10→11 when entry 1025 is assigned), so a change to the width-growth
    // rule shows up in the first byte that would go out of sync, without
    // needing a roundtrip.

    // Deterministic LCG: the 3000 bytes of the reference input.
    let state = 12345 >>> 0;
    const data = Uint8Array.from({ length: 3_000 }, () => {
      state = (state * 1664525 + 1013904223) >>> 0;
      return (state >>> 24) % 4;
    });
    const expected = Uint8Array.from(atob(REFERENCE_LZW), (c) => c.charCodeAt(0));

    const packed = lzwCompress(data, 8);
    expect(packed).toEqual(expected);
    // The vector must also remain the same case: no intermediate clear,
    // because this test is about width, not reset.
    expect(countClearCodes(packed, 8)).toBe(1);
  });
});

// ── Median cut ────────────────────────────────────────────────────────────

describe('median-cut quantization', () => {
  /** Noisy gradient: many distinct colors, so distance matters. */
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

  /** Mean distance from each sample to the nearest palette color. */
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

  test('never exceeds the requested maximum number of colors', () => {
    const samples = noisyGradient(20_000, 1);
    for (const max of [1, 2, 4, 16, 64, 255, 256]) {
      const palette = buildPalette(samples, max);
      expect(palette.size).toBeLessThanOrEqual(max);
      expect(palette.rgb.length).toBe(palette.size * 3);
    }
  });

  test('collapses to the actual number of colors when possible', () => {
    // The placeholder case: four colors with 256 slots available.
    const samples = new Uint8Array([0x33, 0x33, 0x33, 0xff, 0xe4, 0xe4, 0x8a, 0x8a, 0x8a, 0x00, 0x00, 0x00]);
    const palette = buildPalette(samples, 256);
    expect(palette.size).toBe(4);
  });

  test('covers the input better than a random palette of the same size', () => {
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

  test('is deterministic', () => {
    const samples = noisyGradient(5_000, 3);
    const a = buildPalette(samples, 32);
    const b = buildPalette(samples, 32);
    expect(a.rgb).toEqual(b.rgb);
    expect(a.size).toBe(b.size);
  });

  test('handles empty input', () => {
    const palette = buildPalette(new Uint8Array(0), 256);
    expect(palette.size).toBe(1);
    expect(palette.rgb.length).toBe(3);
  });

  test('the mapper returns the exact index of a palette color', () => {
    const palette = buildPalette(noisyGradient(1_000, 4), 8);
    const mapper = createPaletteMapper(palette);
    for (let i = 0; i < palette.size; i++) {
      const packed = (palette.rgb[i * 3]! << 16) | (palette.rgb[i * 3 + 1]! << 8) | palette.rgb[i * 3 + 2]!;
      expect(mapper(packed)).toBe(i);
    }
  });
});

// ── GIF structure ─────────────────────────────────────────────────────────

describe('GIF structure', () => {
  test('the header and global color table are in the expected locations', () => {
    const gif = parseGif(buildTestGif());

    expect(gif.signature).toBe('GIF');
    expect(gif.version).toBe('89a');
    expect(gif.width).toBe(SPEC.width);
    expect(gif.height).toBe(SPEC.height);
    expect(gif.gct).not.toBeNull();
    // 3 actual colors + 1 reserved for transparency => 4 entries.
    expect(gif.gct!.length).toBe(4 * 3);
    expect(gif.trailer).toBe(0x3b);
  });

  test('the loop block requests infinite looping', () => {
    expect(parseGif(buildTestGif()).loop).toBe(0);
  });

  test('metadata is carried in the comment extension', () => {
    const gif = parseGif(buildTestGif());
    expect(gif.comment).toBe(metadataAsText(buildMetadata(SPEC)));
    expect(gif.comment).toContain('el-coso-3000');
  });

  test('each frame has a GCE with the delay and transparent index', () => {
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

  test('frame pixels survive LZW encoding', () => {
    const frames = [
      Uint8Array.from([0, 0, 0, 1, 1, 1, 2, 2]),
      Uint8Array.from([3, 3, 1, 1, 2, 2, 0, 0]),
    ];
    const gif = parseGif(buildTestGif({ frames }));
    expect(gif.frames[0]!.pixels).toEqual(frames[0]!);
    expect(gif.frames[1]!.pixels).toEqual(frames[1]!);
  });

  test('the delay is written in centiseconds, not seconds', () => {
    // 100/30 = 3.33 -> 3cs, which is what the file reproduces.
    expect(parseGif(buildTestGif({ delayCs: 3 })).frames[0]!.delayCs).toBe(3);
    expect(parseGif(buildTestGif({ delayCs: 1 })).frames[0]!.delayCs).toBe(1);
  });

  test('the GCT grows to a power of two and leaves a free index for alpha', () => {
    for (const colors of [1, 2, 3, 5, 17, 255]) {
      const palette = new Uint8Array(colors * 3).fill(0x20);
      const gif = parseGif(buildTestGif({ palette }));
      const entries = gif.gct!.length / 3;
      expect(entries & (entries - 1)).toBe(0); // power of two
      expect(entries).toBeGreaterThanOrEqual(colors + 1);
      expect(gif.frames[0]!.transparentIndex).toBe(colors);
      expect(gif.frames[0]!.transparentIndex!).toBeLessThan(entries);
      // The GCT is the smallest power of two that fits the palette plus the
      // transparent slot, so with 17 or 255 colors it cannot be 8: the limit
      // of 8 entries applies to the spec case, which uses only a few colors.
      if (colors <= 5) expect(entries).toBeLessThanOrEqual(8);
    }
  });

  test('a frame with the wrong size is rejected before writing', () => {
    const header: GifHeader = {
      width: 4,
      height: 2,
      palette: new Uint8Array([0, 0, 0, 255, 255, 255]),
      comment: 'x',
      loop: 0,
    };
    expect(() => writeGifFrame(new ByteWriter(16), header, new Uint8Array(7), 4)).toThrow(/pixels/);
  });

  // --- Negative cases ---

  test('rejects a truncated GIF', () => {
    const full = buildTestGif();
    // Cut off halfway through the file: the trailer is missing and the second frame is incomplete.
    expect(() => parseGif(full.subarray(0, full.length - 6))).toThrow(/Truncated/);
    expect(() => parseGif(full.subarray(0, 5))).toThrow(/Truncated/);
    expect(() => parseGif(new Uint8Array(0))).toThrow(/Truncated/);
  });

  test('rejects a GCT with the wrong size', () => {
    // The table-size field in the screen descriptor lies: it promises 256
    // entries, but the file does not contain them.
    const broken = buildTestGif();
    broken[10] = (broken[10]! & 0xf8) | 0x07;
    expect(() => parseGif(broken)).toThrow(/Truncated/);
  });

  test('rejects a signature that is not GIF', () => {
    const broken = buildTestGif();
    broken[0] = 0x89;
    expect(() => parseGif(broken)).toThrow(/Invalid signature/);
  });

  test('rejects an unknown block', () => {
    const broken = buildTestGif();
    // 13-byte header + 12-byte GCT + 19-byte application extension
    // (0x21, 0xFF, 0x0B, "NETSCAPP2.0", 0x03, 0x01, 2 count bytes, 0x00):
    // the comment extension starts there, and 0x42 is not a valid marker.
    broken[13 + 12 + 19] = 0x42;
    expect(() => parseGif(broken)).toThrow(/desconocido/);
  });
});
