/**
 * Tests for the two animated JPEG containers.
 *
 * Bun has no DOM or canvas, so this tests the parts that need neither: the byte
 * builders and structural invariants. The rendering path is out of scope (see
 * `renderJpegFrames`).
 *
 * The AVI and ZIP readers are deliberately written here without reusing
 * anything from the encoder: if the test shared the muxer's code, it would
 * check that the muxer is consistent with itself, not that the file is correct.
 */

import { describe, expect, test } from 'bun:test';
import { buildMetadata, metadataAsText } from '../src/core/metadata';
import { AUTHOR, REPO_URL, type Spec } from '../src/core/types';
import { crc32 } from '../src/encoders/image';
import { buildJpegZip, buildMjpegAvi, type JpegZipEntry } from '../src/encoders/mjpeg';

// ── Helpers ───────────────────────────────────────────────────────────────

type Bytes = Uint8Array<ArrayBuffer>;

const viewOf = (bytes: Bytes): DataView => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
const u16 = (bytes: Bytes, at: number): number => viewOf(bytes).getUint16(at, true);
const u32 = (bytes: Bytes, at: number): number => viewOf(bytes).getUint32(at, true);
const i32 = (bytes: Bytes, at: number): number => viewOf(bytes).getInt32(at, true);
const tag = (bytes: Bytes, at: number, len = 4): string => String.fromCharCode(...bytes.subarray(at, at + len));
const text = (bytes: Bytes, at: number, len: number): string => new TextDecoder().decode(bytes.subarray(at, at + len));

/** Incompressible bytes: deterministic LCG to keep the test stable. */
function incompressible(length: number, seed = 1): Bytes {
  const out = new Uint8Array(length);
  let s = seed >>> 0;
  for (let i = 0; i < length; i++) {
    s = (s * 1103515245 + 12345) >>> 0;
    out[i] = (s >>> 16) & 0xff;
  }
  return out;
}

const fill = (length: number, byte: number): Bytes => new Uint8Array(length).fill(byte);

function inflateRaw(data: Bytes): Promise<Bytes> {
  const source = new ReadableStream<BufferSource>({
    start(controller) {
      controller.enqueue(data);
      controller.close();
    },
  });
  return new Response(source.pipeThrough(new DecompressionStream('deflate-raw'))).arrayBuffer().then((b) => new Uint8Array(b));
}

const SAMPLE: Spec = {
  width: 640,
  height: 360,
  bg: 'FFE4E4',
  fg: '3A2E2E',
  paletteName: 'rose',
  duration: 2,
  fps: 24,
  showProgressBar: true,
  showTime: true,
  quality: 0.85,
};

// ── CRC32 ─────────────────────────────────────────────────────────────────

describe('crc32', () => {
  test('known vectors', () => {
    // The canonical vector for the reflected polynomial 0xEDB88320.
    expect(crc32(new TextEncoder().encode('123456789'))).toBe(0xcbf43926);
    expect(crc32(new Uint8Array(0))).toBe(0);
    expect(crc32(new TextEncoder().encode('The quick brown fox jumps over the lazy dog'))).toBe(0x414fa339);
  });

  test('depends only on the content, not the backing store', () => {
    const padded = new Uint8Array(32);
    padded.set(new TextEncoder().encode('123456789'), 8);
    expect(crc32(padded.subarray(8, 17))).toBe(0xcbf43926);
  });
});

// ── deflate-raw ───────────────────────────────────────────────────────────

describe('CompressionStream deflate-raw', () => {
  test('round-trip', async () => {
    const original = fill(4096, 0xab);
    const source = new ReadableStream<BufferSource>({
      start(controller) {
        controller.enqueue(original);
        controller.close();
      },
    });
    const deflated = new Uint8Array(
      await new Response(source.pipeThrough(new CompressionStream('deflate-raw'))).arrayBuffer(),
    );
    expect(deflated.length).toBeLessThan(original.length);
    // Raw deflate starts with 0x01; with the zlib header it would be 0x78.
    expect(deflated[0]).not.toBe(0x78);
    expect(await inflateRaw(deflated)).toEqual(original);
  });
});

// ── ZIP reader (written here, not reused from the encoder) ─────────────────

const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_EOCD = 0x06054b50;

interface ZipEntryView {
  name: string;
  flags: number;
  method: number;
  crc: number;
  compressedSize: number;
  size: number;
  localOffset: number;
  /** Payload offset, deduced from the local header. */
  dataAt: number;
  content: Uint8Array;
}

interface ZipView {
  entries: ZipEntryView[];
  comment: string;
  cdOffset: number;
  cdSize: number;
  count: number;
}

/** The EOCD has no offset of its own: search for it from the end backward. */
function findEocd(bytes: Bytes): number {
  for (let at = bytes.length - 22; at >= 0; at--) {
    if (u32(bytes, at) !== SIG_EOCD) continue;
    // The only valid position is the last one where the declared comment
    // length ends exactly at the end of the file.
    if (at + 22 + u16(bytes, at + 20) === bytes.length) return at;
  }
  throw new Error('Invalid ZIP: the EOCD was not found');
}

async function parseZip(bytes: Bytes): Promise<ZipView> {
  const eocd = findEocd(bytes);
  const count = u16(bytes, eocd + 10);
  const cdSize = u32(bytes, eocd + 12);
  const cdOffset = u32(bytes, eocd + 16);
  const comment = text(bytes, eocd + 22, u16(bytes, eocd + 20));
  if (cdOffset + cdSize > eocd) throw new Error('El central directory no entra antes del EOCD');
  if (eocd !== cdOffset + cdSize) throw new Error('El central directory no termina en el EOCD');

  const entries: ZipEntryView[] = [];
  let at = cdOffset;
  for (let i = 0; i < count; i++) {
    if (u32(bytes, at) !== SIG_CENTRAL) throw new Error(`Entrada ${i} del central directory sin firma`);
    const flags = u16(bytes, at + 8);
    const method = u16(bytes, at + 10);
    const crc = u32(bytes, at + 16);
    const compressedSize = u32(bytes, at + 20);
    const size = u32(bytes, at + 24);
    const nameLen = u16(bytes, at + 28);
    const extraLen = u16(bytes, at + 30);
    const commentLen = u16(bytes, at + 32);
    const localOffset = u32(bytes, at + 42);
    const name = text(bytes, at + 46, nameLen);
    at += 46 + nameLen + extraLen + commentLen;

    // The central directory is an index: reading it is not enough; follow the
    // offset and verify that the local header is where it says it is.
    if (u32(bytes, localOffset) !== SIG_LOCAL) throw new Error(`${name}: local header sin firma`);
    if (u16(bytes, localOffset + 8) !== method) throw new Error(`${name}: the local method does not match`);
    const localNameLen = u16(bytes, localOffset + 26);
    const localExtraLen = u16(bytes, localOffset + 28);
    if (text(bytes, localOffset + 30, localNameLen) !== name) throw new Error(`${name}: el nombre local no coincide`);
    const dataAt = localOffset + 30 + localNameLen + localExtraLen;
    if (dataAt + compressedSize > eocd) throw new Error(`${name}: the data runs past the file`);

    const stored = bytes.subarray(dataAt, dataAt + compressedSize);
    const content = method === 8 ? await inflateRaw(stored) : stored;
    if (content.length !== size) throw new Error(`${name}: the uncompressed size does not match`);
    // CRC is computed over the original data, never over the payload.
    if (crc32(content) !== crc) throw new Error(`${name}: CRC ${crc.toString(16)} != ${crc32(content).toString(16)}`);
    entries.push({ name, flags, method, crc, compressedSize, size, localOffset, dataAt, content });
  }
  return { entries, comment, cdOffset, cdSize, count };
}

// ── ZIP ───────────────────────────────────────────────────────────────────

describe('buildJpegZip', () => {
  const meta = buildMetadata(SAMPLE);
  const entries: JpegZipEntry[] = [
    { name: 'metadata.json', data: new TextEncoder().encode(JSON.stringify(meta, null, 2)) },
    { name: 'frame_00001.jpg', data: incompressible(900) },
    { name: 'frame_00002.jpg', data: incompressible(1500, 7) },
  ];

  test('structure: names, sizes, CRC, and comment', async () => {
    const zip = await buildJpegZip(entries, 'comentario de prueba');
    const view = await parseZip(zip);

    expect(view.count).toBe(3);
    expect(view.entries.map((e) => e.name)).toEqual(['metadata.json', 'frame_00001.jpg', 'frame_00002.jpg']);
    expect(view.comment).toBe('comentario de prueba');
    for (const entry of entries) {
      const parsed = view.entries.find((e) => e.name === entry.name);
      expect(parsed).toBeDefined();
      expect(parsed!.size).toBe(entry.data.length);
      expect(parsed!.crc).toBe(crc32(entry.data));
      expect(parsed!.content).toEqual(entry.data);
    }
    // Local headers are in order and the central directory starts where they
    // end: that is what the EOCD declares.
    const last = view.entries[view.entries.length - 1]!;
    expect(view.cdOffset).toBe(last.dataAt + last.compressedSize);
    expect(zip.length).toBe(view.cdOffset + view.cdSize + 22 + 'comentario de prueba'.length);
  });

  test('deflate only when it saves space; otherwise stored', async () => {
    const view = await parseZip(await buildJpegZip(entries));
    const json = view.entries[0]!;
    const jpg = view.entries[1]!;
    // JSON is highly repetitive text: deflate makes it smaller.
    expect(json.method).toBe(8);
    expect(json.compressedSize).toBeLessThan(json.size);
    // Incompressible data: storing it is simpler and faster.
    expect(jpg.method).toBe(0);
    expect(jpg.compressedSize).toBe(jpg.size);
  });

  test('ASCII names do not have the UTF-8 flag', async () => {
    const view = await parseZip(await buildJpegZip(entries));
    for (const entry of view.entries) expect(entry.flags & 0x800).toBe(0);
  });

  test('a non-ASCII name has the UTF-8 flag', async () => {
    const view = await parseZip(await buildJpegZip([{ name: 'frame_ñ_00001.jpg', data: fill(4, 1) }]));
    expect(view.entries[0]!.flags & 0x800).toBe(0x800);
    expect(view.entries[0]!.name).toBe('frame_ñ_00001.jpg');
  });

  test('a name longer than 255 bytes fails', async () => {
    const long: JpegZipEntry = { name: `${'a'.repeat(260)}.jpg`, data: fill(4, 1) };
    await expect(buildJpegZip([long])).rejects.toThrow('too long for a ZIP');
  });

  test('does not parse without an EOCD', async () => {
    const zip = await buildJpegZip(entries, 'comentario');
    const truncated = zip.slice(0, zip.length - 22 - 'comentario'.length);
    expect(() => findEocd(truncated)).toThrow('EOCD');
  });

  test('detects a corrupted CRC', async () => {
    const zip = await buildJpegZip(entries);
    const view0 = await parseZip(zip);
    const dataAt = view0.entries[1]!.localOffset + 30 + 'frame_00001.jpg'.length;
    zip[dataAt + 10] = (zip[dataAt + 10]! + 1) & 0xff;
    await expect(parseZip(zip)).rejects.toThrow('CRC');
  });

  test('aborting stops assembly', async () => {
    const controller = new AbortController();
    controller.abort();
    try {
      await buildJpegZip(entries, '', controller.signal);
      throw new Error('it should have thrown an AbortError');
    } catch (err) {
      expect((err as DOMException).name).toBe('AbortError');
    }
  });
});

// ── AVI reader (written here, not reused from the encoder) ─────────────────

interface RiffChunk {
  tag: string;
  /** Type FourCC, only in lists. */
  listType: string;
  at: number;
  size: number;
  payloadStart: number;
}

function walkChunks(bytes: Bytes, from: number, to: number): RiffChunk[] {
  const out: RiffChunk[] = [];
  let at = from;
  while (at + 8 <= to) {
    const name = tag(bytes, at);
    const size = u32(bytes, at + 4);
    if (at + 8 + size > to) throw new Error(`Chunk ${name} en ${at} se pasa del final de la lista`);
    const listType = name === 'LIST' ? tag(bytes, at + 8) : '';
    out.push({ tag: name, listType, at, size, payloadStart: at + (listType ? 12 : 8) });
    at += 8 + size + (size % 2);
  }
  if (at !== to) throw new Error(`Los chunks no cierran en ${to} (quedaron en ${at})`);
  return out;
}

const only = (chunks: RiffChunk[], tagName: string, listType = ''): RiffChunk => {
  const found = chunks.filter((c) => c.tag === tagName && c.listType === listType);
  if (found.length !== 1) throw new Error(`Se esperaba un chunk ${tagName}${listType} y hay ${found.length}`);
  return found[0]!;
};

interface AviView {
  riffSize: number;
  microSecPerFrame: number;
  maxBytesPerSec: number;
  flags: number;
  totalFrames: number;
  streams: number;
  avihWidth: number;
  avihHeight: number;
  strh: { type: string; handler: string; scale: number; rate: number; length: number };
  strf: { size: number; width: number; height: number; planes: number; bitCount: number; compression: string };
  movi: Array<{ at: number; size: number; chunkTag: string }>;
  idx: Array<{ fourcc: string; flags: number; offset: number; size: number }>;
  info: Record<string, string>;
}

function parseAvi(bytes: Bytes): AviView {
  if (tag(bytes, 0) !== 'RIFF') throw new Error('No es un RIFF');
  const riffSize = u32(bytes, 4);
  if (riffSize !== bytes.length - 8) {
    throw new Error(`Inconsistent RIFF size: it declares ${riffSize} and the file has ${bytes.length - 8}`);
  }
  if (tag(bytes, 8) !== 'AVI ') throw new Error('El RIFF no declara AVI ');

  const top = walkChunks(bytes, 12, bytes.length);
  const hdrl = only(top, 'LIST', 'hdrl');
  const avih = only(walkChunks(bytes, hdrl.payloadStart, hdrl.at + 8 + hdrl.size), 'avih');
  const strl = only(walkChunks(bytes, hdrl.payloadStart, hdrl.at + 8 + hdrl.size), 'LIST', 'strl');
  const strlChildren = walkChunks(bytes, strl.payloadStart, strl.at + 8 + strl.size);
  const strh = only(strlChildren, 'strh');
  const strf = only(strlChildren, 'strf');

  const hd = bytes.subarray(avih.payloadStart);
  const sh = bytes.subarray(strh.payloadStart);
  const bi = bytes.subarray(strf.payloadStart);

  const movi = only(top, 'LIST', 'movi');
  const moviFrames = walkChunks(bytes, movi.payloadStart, movi.at + 8 + movi.size);
  const idx1 = only(top, 'idx1');
  const idx: AviView['idx'] = [];
  for (let at = idx1.payloadStart; at + 16 <= idx1.at + 8 + idx1.size; at += 16) {
    idx.push({ fourcc: tag(bytes, at), flags: u32(bytes, at + 4), offset: u32(bytes, at + 8), size: u32(bytes, at + 12) });
  }
  if (idx1.at + 8 + idx1.size - (idx1.payloadStart + idx.length * 16) !== 0) {
    throw new Error('The idx1 is not a multiple of 16');
  }

  // Index convention: offsets are relative to the position of the 'movi'
  // fourcc minus 4, i.e. to the LIST size field. The first chunk is at 8,
  // never 0.
  const moviBase = movi.at + 4;
  if (idx.length !== moviFrames.length) {
    throw new Error(`idx1 tiene ${idx.length} entradas y movi tiene ${moviFrames.length}`);
  }
  idx.forEach((entry, i) => {
    const frame = moviFrames[i]!;
    if (entry.offset !== frame.at - moviBase) {
      throw new Error(`Entry ${i} of the idx1 points to ${entry.offset} and the frame is at ${frame.at - moviBase}`);
    }
    if (entry.size !== frame.size) throw new Error(`Entry ${i} of the idx1 declares a different size`);
    if (entry.fourcc !== frame.tag) throw new Error(`Entrada ${i} del idx1 con fourcc distinto`);
  });

  const infoList = top.find((c) => c.tag === 'LIST' && c.listType === 'INFO');
  const info: Record<string, string> = {};
  if (infoList) {
    for (const chunk of walkChunks(bytes, infoList.payloadStart, infoList.at + 8 + infoList.size)) {
      info[chunk.tag] = text(bytes, chunk.payloadStart, chunk.size);
    }
  }

  return {
    riffSize,
    microSecPerFrame: u32(hd, 0),
    maxBytesPerSec: u32(hd, 4),
    flags: u32(hd, 12),
    totalFrames: u32(hd, 16),
    streams: u32(hd, 24),
    avihWidth: u32(hd, 32),
    avihHeight: u32(hd, 36),
    strh: { type: tag(sh, 0), handler: tag(sh, 4), scale: u32(sh, 20), rate: u32(sh, 24), length: u32(sh, 32) },
    strf: {
      size: u32(bi, 0),
      width: i32(bi, 4),
      height: i32(bi, 8),
      planes: u16(bi, 12),
      bitCount: u16(bi, 14),
      compression: tag(bi, 16),
    },
    movi: moviFrames.map((c) => ({ at: c.at, size: c.size, chunkTag: c.tag })),
    idx,
    info,
  };
}

describe('buildMjpegAvi', () => {
  const meta = buildMetadata(SAMPLE);
  const params = { width: SAMPLE.width, height: SAMPLE.height, fps: SAMPLE.fps, meta };
  // A mix of odd and even sizes, so RIFF padding matters.
  const frames = [
    new Uint8Array([0xf7, 0xd8, 0xff]),
    new Uint8Array([1, 2, 3, 4, 5, 6]),
    new Uint8Array([9, 9, 9, 9, 9]),
  ];

  test('RIFF structure and header', () => {
    const avi = buildMjpegAvi(frames, params);
    expect(tag(avi, 0)).toBe('RIFF');
    expect(u32(avi, 4)).toBe(avi.length - 8);
    expect(tag(avi, 8)).toBe('AVI ');

    const view = parseAvi(avi);
    expect(view.riffSize).toBe(avi.length - 8);
    expect(view.totalFrames).toBe(3);
    expect(view.streams).toBe(1);
    expect(view.microSecPerFrame).toBe(Math.round(1_000_000 / SAMPLE.fps));
    expect(view.maxBytesPerSec).toBe(6 * SAMPLE.fps);
    expect(view.flags & 0x10).toBe(0x10); // AVIF_HASINDEX
    expect(view.avihWidth).toBe(SAMPLE.width);
    expect(view.avihHeight).toBe(SAMPLE.height);
  });

  test('strh and BITMAPINFOHEADER', () => {
    const view = parseAvi(buildMjpegAvi(frames, params));
    expect(view.strh.type).toBe('vids');
    expect(view.strh.handler).toBe('MJPG');
    expect(view.strh.scale).toBe(1);
    expect(view.strh.rate).toBe(SAMPLE.fps);
    expect(view.strh.length).toBe(3);
    expect(view.strf.size).toBe(40);
    expect(view.strf.width).toBe(SAMPLE.width);
    expect(view.strf.height).toBe(SAMPLE.height);
    expect(view.strf.planes).toBe(1);
    expect(view.strf.bitCount).toBe(24);
    expect(view.strf.compression).toBe('MJPG');
  });

  test('movi contains the frames unchanged and idx1 indexes them', () => {
    const avi = buildMjpegAvi(frames, params);
    const view = parseAvi(avi);
    expect(view.movi.map((f) => f.chunkTag)).toEqual(['00dc', '00dc', '00dc']);
    expect(view.idx).toHaveLength(3);
    expect(view.idx[0]!.offset).toBe(8); // 4 for the LIST size + 4 for 'movi'
    for (const [i, frame] of frames.entries()) {
      expect(view.movi[i]!.size).toBe(frame.length);
      // `at` is where the chunk starts, so the payload is 8 bytes later.
      expect(avi.slice(view.movi[i]!.at + 8, view.movi[i]!.at + 8 + frame.length)).toEqual(frame);
      expect(view.idx[i]!.flags & 0x10).toBe(0x10); // AVIIF_KEYFRAME
    }
  });

  test('INFO contains the repo URL and the full block as the comment', () => {
    const view = parseAvi(buildMjpegAvi(frames, params));
    expect(view.info.ISBJ).toBe(REPO_URL);
    expect(view.info.ICMT).toBe(metadataAsText(meta));
    expect(view.info.ISFT).toBe(meta.software);
    expect(view.info.INAM).toBe(meta.title);
    expect(view.info.IART).toBe(AUTHOR);
  });

  test('a single frame is also a valid AVI', () => {
    const view = parseAvi(buildMjpegAvi([frames[0]!], params));
    expect(view.totalFrames).toBe(1);
    expect(view.idx).toHaveLength(1);
  });

  test('inconsistent RIFF size', () => {
    const avi = buildMjpegAvi(frames, params);
    viewOf(avi).setUint32(4, avi.length + 10, true);
    expect(() => parseAvi(avi)).toThrow('Inconsistent RIFF size');
  });

  test('idx1 with a different number of entries than movi', () => {
    // The file is internally consistent except for the index: remove the last
    // entry and fix both RIFF sizes. This is the most common corruption when
    // hand-rolling a muxer, and it must be detectable.
    const avi = buildMjpegAvi(frames, params);
    const idx1 = walkChunks(avi, 12, avi.length).find((c) => c.tag === 'idx1')!;
    viewOf(avi).setUint32(idx1.at + 4, idx1.size - 16, true);
    viewOf(avi).setUint32(4, u32(avi, 4) - 16, true);
    expect(() => parseAvi(avi.slice(0, avi.length - 16))).toThrow('idx1 tiene 2 entradas y movi tiene 3');
  });
});
