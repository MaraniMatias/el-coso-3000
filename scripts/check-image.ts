/**
 * Still-image encoder verification.
 *
 * Run: `bun run scripts/check-image.ts`
 *
 * Bun has no DOM or Canvas, so this verifies everything that does NOT
 * need canvas: byte-level logic (CRC32, PNG chunks, JPEG COM segment,
 * WebP XMP chunk) and SVG emission, which is plain text. To measure SVG text,
 * a fake context is passed in that returns deterministic metrics, so the
 * layout can be checked for real.
 *
 * Fails (exit 1) if anything is wrong.
 */
import {
  buildSvg,
  crc32,
  insertJpegComment,
  insertJpegXmp,
  insertPngChunks,
  insertWebpXmp,
  pngChunk,
  pngTextChunks,
  pngXmpChunk,
} from '../src/encoders/image';
import { FONT_DATA_URL, FONT_FACE_CSS } from '../src/core/font';
import { DEFAULT_TEXTURE_SPEED, FONT_FAMILY, FONT_WEIGHT, type Spec } from '../src/core/types';
import { buildMetadata, metadataAsPairs, metadataAsText, metadataAsXmp } from '../src/core/metadata';
import { frameGeometry, timecode } from '../src/core/draw-frame';
import { dimensionCandidates, layoutDimensions, layoutLine, paddingFor } from '../src/core/fit-text';
import { hexToRgba } from '../src/core/color';

/** Reverses the encoder's escaping so it can be compared with the original text. */
function unescapeXml(text: string): string {
  const named: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
  return text.replace(/&(amp|lt|gt|quot|apos);/g, (_, name: string) => named[name] ?? '');
}

let failures = 0;
const enc = new TextEncoder();
const dec = new TextDecoder('utf-8');

function check(ok: boolean, label: string, detail = ''): void {
  if (!ok) failures++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${label}${detail && !ok ? `\n        ${detail}` : ''}`);
}

function section(title: string): void {
  console.log(`\n${title}`);
}

// ── Fixtures ──────────────────────────────────────────────────────────────

const spec = (over: Partial<Spec> = {}): Spec => ({
  width: 1920,
  height: 1080,
  bg: 'FFE4E4',
  fg: '5A2A2A',
  paletteName: 'rose',
  duration: 0,
  fps: 30,
  showProgressBar: false,
  showTime: false,
  transparent: false,
  texture: 'none',
  textureSpeed: DEFAULT_TEXTURE_SPEED,
  quality: 0.92,
  ...over,
});

/**
 * Fake measurement context. The core layout only needs `font` to be assignable
 * and `measureText` to return the glyph bounding box.
 */
class FakeMeasureContext {
  font = '10px sans-serif';

  measureText(text: string): TextMetrics {
    const size = Number(/(?:^|\s)(\d+(?:\.\d+)?)px/.exec(this.font)?.[1] ?? '10');
    return {
      width: text.length * size * 0.6,
      actualBoundingBoxAscent: size * 0.72,
      actualBoundingBoxDescent: size * 0.22,
    } as unknown as TextMetrics;
  }
}

const measure = new FakeMeasureContext() as unknown as CanvasRenderingContext2D;

// ── CRC32 ─────────────────────────────────────────────────────────────────

section('CRC32 (known vectors for polynomial 0xEDB88320)');
const crcOf = (s: string) => crc32(enc.encode(s));
check(crcOf('') === 0x00000000, 'empty string → 0x00000000', `got 0x${crcOf('').toString(16)}`);
check(crcOf('123456789') === 0xcbf43926, '"123456789" → 0xCBF43926', `got 0x${crcOf('123456789').toString(16)}`);
check(
  crcOf('The quick brown fox jumps over the lazy dog') === 0x414fa339,
  'pangram → 0x414FA339',
  `got 0x${crcOf('The quick brown fox jumps over the lazy dog').toString(16)}`,
);
check(crcOf('a') === 0xe8b7be43, '"a" → 0xE8B7BE43', `got 0x${crcOf('a').toString(16)}`);

// ── PNG ───────────────────────────────────────────────────────────────────

const PNG_SIGNATURE = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Minimal synthetic PNG: only the chunk structure matters, not the content. */
function makePng(): Uint8Array {
  const parts = [
    PNG_SIGNATURE,
    pngChunk('IHDR', new Uint8Array(13)),
    pngChunk('IDAT', new Uint8Array([1, 2, 3, 4, 5])),
    pngChunk('IEND', new Uint8Array(0)),
  ];
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

interface PngChunk {
  type: string;
  data: Uint8Array;
  offset: number;
}

/** Walks the chunks, validating length and CRC as a decoder would. */
function walkPng(png: Uint8Array): PngChunk[] {
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  const found: PngChunk[] = [];
  let offset = 8;
  while (offset + 12 <= png.length) {
    const length = view.getUint32(offset);
    const type = String.fromCharCode(...png.subarray(offset + 4, offset + 8));
    if (offset + 12 + length > png.length) throw new Error(`chunk ${type} extends past the end`);
    const data = png.subarray(offset + 8, offset + 8 + length);
    const crc = view.getUint32(offset + 8 + length);
    const real = crc32(png.subarray(offset + 4, offset + 8 + length));
    if (crc !== real) throw new Error(`invalid CRC in ${type}: ${crc} != ${real}`);
    found.push({ type, data, offset });
    if (type === 'IEND') break;
    offset += 12 + length;
  }
  return found;
}

/**
 * Reads an `iTXt` payload: `keyword \0 flag method language \0 translated \0
 * text`. The three separators and the two compression bytes have no length, so
 * they are skipped by position, exactly as a decoder does.
 */
function readItxt(data: Uint8Array): [string, string] {
  const nul = (from: number) => data.indexOf(0, from) + 1;
  let at = nul(0) + 2; // after keyword, compression flag and method
  at = nul(at); // empty language tag
  at = nul(at); // empty translated keyword
  return [dec.decode(data.subarray(0, data.indexOf(0))), dec.decode(data.subarray(at))];
}

// Fixed clock, so the two serializers and the assertions cannot disagree by a
// second between runs.
const NOW = new Date('2026-10-01T11:46:28+02:00');
const meta = buildMetadata(spec(), { now: NOW });
const pairs = metadataAsPairs(meta);
const xmpPacket = metadataAsXmp(meta);
const textChunks = [...pngTextChunks(pairs), pngXmpChunk(xmpPacket)];

section(`PNG: injecting ${textChunks.length} chunks before the first IDAT`);
const png = makePng();
const injected = insertPngChunks(png, textChunks);
let parsed: PngChunk[] = [];
try {
  parsed = walkPng(injected);
  check(true, 'all chunks in the resulting PNG are well-formed (length + CRC32)');
} catch (err) {
  check(false, 'all chunks in the resulting PNG are well-formed (length + CRC32)', String(err));
}

check(parsed.at(-1)?.type === 'IEND', 'IEND is still the last chunk', `ended at ${parsed.at(-1)?.type}`);
check(parsed[0]?.type === 'IHDR', 'IHDR is still the first chunk', `started with ${parsed[0]?.type}`);
check(
  injected.length === png.length + textChunks.reduce((n, c) => n + c.length, 0),
  'size grows by exactly the total size of the chunks',
  `${png.length} → ${injected.length}`,
);
check(
  injected.length === parsed.at(-1)!.offset + 12,
  'nothing remains after IEND',
  `IEND at ${parsed.at(-1)?.offset}, file size ${injected.length}`,
);
check(
  new Uint8Array(injected.subarray(0, 8)).every((b, i) => b === PNG_SIGNATURE[i]),
  'PNG signature remains intact',
);

// The fix that motivated `iTXt` placement: `exiftool` warns when text chunks
// land after IDAT, and some decoders skip them entirely.
const firstIdat = parsed.find((c) => c.type === 'IDAT')?.offset ?? -1;
check(
  firstIdat > 0 && parsed.filter((c) => c.type === 'iTXt').every((c) => c.offset < firstIdat),
  'every iTXt chunk comes before the first IDAT (no exiftool warning)',
  `first IDAT at ${firstIdat}`,
);
check(
  parsed.every((c, i) => i === 0 || c.offset > parsed[i - 1]!.offset),
  'chunks stay in file order, so the CRCs still describe a linear stream',
);

const readTexts = parsed.filter((c) => c.type === 'iTXt').map((c) => readItxt(c.data));
const xmpInFile = readTexts.find(([key]) => key === 'XML:com.adobe.xmp');
check(
  readTexts.length === pairs.length + 1,
  `there are ${pairs.length} iTXt pairs plus the XMP one`,
  `found ${readTexts.length}`,
);
check(
  readTexts.slice(0, pairs.length).every(([k, v], i) => k === pairs[i]?.[0] && v === pairs[i]?.[1]),
  'each iTXt round-trips the exact key and value as UTF-8',
  JSON.stringify(readTexts[0]),
);
check(
  xmpInFile?.[1] === dec.decode(xmpPacket),
  'the XMP chunk carries the packet byte for byte',
);
check(xmpInFile !== undefined, 'the file carries the XMP packet');
// A PNG without pixel data is invalid; the injector must report it, not
// produce garbage.
try {
  insertPngChunks(new Uint8Array([...PNG_SIGNATURE, 1, 2, 3, 4]), textChunks);
  check(false, 'a PNG without IDAT is rejected with an error');
} catch {
  check(true, 'a PNG without IDAT is rejected with an error');
}
try {
  insertPngChunks(new Uint8Array(20), textChunks);
  check(false, 'an invalid signature is rejected with an error');
} catch {
  check(true, 'an invalid signature is rejected with an error');
}

// ── JPEG ──────────────────────────────────────────────────────────────────

/** Synthetic JPEG: SOI + APP0/JFIF + EOI. */
function makeJpeg(): Uint8Array {
  const app0 = new Uint8Array([
    0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00,
  ]);
  return new Uint8Array([0xff, 0xd8, ...app0, 0xff, 0xd9]);
}

section('JPEG: the COM segment is placed right after SOI');
for (const text of [metadataAsText(meta), 'corto', 'impar']) {
  const jpeg = makeJpeg();
  const out = insertJpegComment(jpeg, text);
  const view = new DataView(out.buffer);
  const label = `"${text.length} bytes"`;
  const textLen = enc.encode(text).length;

  check(out[0] === 0xff && out[1] === 0xd8, `${label}: SOI is still first`, `0x${out[0]?.toString(16)} 0x${out[1]?.toString(16)}`);
  check(out[2] === 0xff && out[3] === 0xfe, `${label}: marker 0xFFFE at offset 2`, `0x${out[2]?.toString(16)} 0x${out[3]?.toString(16)}`);
  // `COM` is not padded: an extra NUL would be part of the text a reader shows.
  check(
    view.getUint16(4) === 2 + textLen,
    `${label}: length is exactly the 2 length bytes plus the text`,
    `length ${view.getUint16(4)}, text ${textLen}`,
  );
  check(dec.decode(out.subarray(6, 6 + textLen)) === text, `${label}: text round-trips intact`);
  check(out.length === jpeg.length + 4 + textLen, `${label}: size checks out`);
  check(
    out.slice(6 + textLen).every((b, i) => b === jpeg[2 + i]),
    `${label}: the rest of the JPEG is byte-for-byte unchanged`,
  );
}

section('JPEG: the APP1 segment carries the XMP packet right after SOI');
{
  const jpeg = makeJpeg();
  const out = insertJpegXmp(jpeg, xmpPacket);
  const view = new DataView(out.buffer);
  const signature = 'http://ns.adobe.com/xap/1.0/';
  const payloadLen = signature.length + 1 + xmpPacket.length;
  const packetAt = 6 + signature.length + 1;

  check(out[0] === 0xff && out[1] === 0xd8, 'SOI is still first');
  check(out[2] === 0xff && out[3] === 0xe1, 'marker 0xFFE1 at offset 2', `0x${out[3]?.toString(16)}`);
  check(
    dec.decode(out.subarray(6, 6 + signature.length)) === signature &&
      out[6 + signature.length] === 0x00,
    'the payload starts with the XMP signature and its NUL terminator',
  );
  check(
    dec.decode(out.subarray(packetAt, packetAt + xmpPacket.length)) === dec.decode(xmpPacket),
    'the packet round-trips intact',
  );
  check(view.getUint16(4) === 2 + payloadLen, 'length is exactly the 2 length bytes plus the payload', `length ${view.getUint16(4)}, payload ${payloadLen}`);
  check(out.length === jpeg.length + 4 + payloadLen, 'size checks out');
  check(
    out.subarray(6 + payloadLen).every((b, i) => b === jpeg[2 + i]),
    'the rest of the JPEG is byte-for-byte unchanged',
  );

  // The order `exportImage` writes them: XMP first, then the comment on top, so
  // `COM` stays first in the file for tools that stop at the first segment.
  const both = insertJpegComment(out, metadataAsText(meta));
  const commentBytes = enc.encode(metadataAsText(meta));
  const app1 = 2 + 4 + commentBytes.length;
  check(both[2] === 0xff && both[3] === 0xfe, 'inserting COM afterwards leaves COM first');
  check(
    both[app1] === 0xff && both[app1 + 1] === 0xe1 &&
      dec.decode(
        both.subarray(
          app1 + 4 + signature.length + 1,
          app1 + 4 + signature.length + 1 + xmpPacket.length,
        ),
      ) === dec.decode(xmpPacket),
    'the XMP segment survives intact behind the comment',
  );
}
try {
  insertJpegXmp(new Uint8Array([1, 2, 3, 4]), xmpPacket);
  check(false, 'a file without SOI is rejected by the XMP inserter');
} catch {
  check(true, 'a file without SOI is rejected by the XMP inserter');
}

section('JPEG: a segment larger than the 16-bit length field is rejected');
{
  const jpeg = makeJpeg();
  const signatureBytes = 'http://ns.adobe.com/xap/1.0/'.length + 1;
  // The length field counts its own 2 bytes, so 65533 payload bytes is the most
  // a segment can carry. For XMP that budget is shared with the signature.
  const maxPacket = new Uint8Array(0xffff - 2 - signatureBytes);
  const out = insertJpegXmp(jpeg, maxPacket);
  const declared = new DataView(out.buffer).getUint16(4);
  check(declared === 0xffff, 'a maximum-size payload declares 0xFFFF and is not truncated', `length ${declared}`);
  check(out.length === jpeg.length + 4 + signatureBytes + maxPacket.length, 'the maximum-size segment is written whole');
  for (const [label, insert] of [
    ['XMP', () => insertJpegXmp(jpeg, new Uint8Array(maxPacket.length + 1))],
    ['comment', () => insertJpegComment(jpeg, 'x'.repeat(0xffff - 1))],
  ] as Array<[string, () => Uint8Array]>) {
    try {
      insert();
      check(false, `an oversized ${label} segment is rejected`);
    } catch (err) {
      check(
        err instanceof Error && /too large/i.test(err.message),
        `an oversized ${label} segment is rejected with a readable error`,
        (err as Error).message,
      );
    }
  }
}

// ── WebP ──────────────────────────────────────────────────────────────────

/** Synthetic WebP: RIFF/WEBP with a single `VP8 ` image chunk. */
function makeWebp(payload: number[] = [0x9d, 0x01, 0x2a, 0xff]): Uint8Array {
  const body = new Uint8Array(4 + 8 + payload.length + (payload.length % 2));
  body.set(enc.encode('WEBP'), 0);
  body.set(enc.encode('VP8 '), 4);
  new DataView(body.buffer).setUint32(8, payload.length, true);
  body.set(payload, 12);
  const out = new Uint8Array(8 + body.length);
  out.set(enc.encode('RIFF'), 0);
  new DataView(out.buffer).setUint32(4, body.length, true);
  out.set(body, 8);
  return out;
}

section('WebP: the XMP chunk is inserted before the pixels and RIFF length is fixed');
for (const xmp of [enc.encode('<x:xmpmeta/>'), enc.encode('<x:xmpmeta xmlns:x="adobe:ns:meta/"/>')]) {
  const webp = makeWebp();
  const out = insertWebpXmp(webp, xmp);
  const view = new DataView(out.buffer);
  const label = `${xmp.length} payload bytes`;

  check(
    view.getUint32(4, true) === out.length - 8,
    `${label}: RIFF length is file size - 8`,
    `RIFF says ${view.getUint32(4, true)}, file size ${out.length}`,
  );
  check(
    String.fromCharCode(...out.subarray(12, 16)) === 'XMP ',
    `${label}: chunk starts at offset 12 with the fourCC "XMP "`,
  );
  check(view.getUint32(16, true) === xmp.length, `${label}: chunk length matches the payload`);
  check(
    out.subarray(20, 20 + xmp.length).every((b, i) => b === xmp[i]),
    `${label}: payload remains intact`,
  );
  if (xmp.length % 2) {
    check(out[20 + xmp.length] === 0x00, `${label}: padding byte is present for even alignment`);
  }
  const at = 20 + xmp.length + (xmp.length % 2);
  check(String.fromCharCode(...out.subarray(at, at + 4)) === 'VP8 ', `${label}: VP8 remains after XMP`);
  check(
    out.subarray(at).every((b, i) => b === webp[12 + i]),
    `${label}: the original image chunk is byte-for-byte unchanged`,
  );
}

// ── Metadata ──────────────────────────────────────────────────────────────

section('Metadata: serialized without characters that would break the container');
const pairKeys = pairs.map(([k]) => k);
const pairValues = pairs.map(([, v]) => v);
const allValues = [...pairKeys, ...pairValues, metadataAsText(meta)];
// `iTXt` is UTF-8, so non-Latin-1 text is fine, but a control character has no
// business in a keyword or in a value that must stay one line. The text block
// does contain newlines: it is the separator between its lines.
check(
  [...pairKeys, ...pairValues].every((s) => ![...s].some((c) => c.charCodeAt(0) < 0x20 || c.charCodeAt(0) === 0x7f)),
  'no keyword or value contains control characters',
  JSON.stringify([...pairKeys, ...pairValues].filter((s) => [...s].some((c) => c.charCodeAt(0) < 0x20 || c.charCodeAt(0) === 0x7f))),
);
// `iTXt` keyword: 1 to 79 Latin-1 characters. PNG asks for no leading or
// trailing spaces; the colon of the `ElCoso3000:` prefix is allowed.
check(
  pairs.every(([k]) => /^[!-~](?:[ -~]{0,77}[!-~])?$/.test(k)),
  'iTXt keywords are 1 to 79 printable ASCII characters with no padding spaces',
  JSON.stringify(pairKeys.filter((k) => !/^[!-~](?:[ -~]{0,77}[!-~])?$/.test(k))),
);
check(
  pairKeys.filter((k) => k.startsWith('ElCoso3000:')).length > 0 &&
    pairKeys.slice(0, 8).every((k) => !k.startsWith('ElCoso3000:')),
  'the app own keywords are prefixed, so exiftool groups them instead of listing unknown tags',
);
check(
  new Set(pairKeys).size === pairKeys.length,
  'no keyword repeats (a repeated iTXt key would make the first one unreachable)',
  JSON.stringify(pairKeys.filter((k, i) => pairKeys.indexOf(k) !== i)),
);

// ── XML validator ─────────────────────────────────────────────────────────
// Bun does not include `DOMParser`, so SVG is validated with a custom
// well-formedness check. It is tested against broken documents below: if the
// validator does not reject a negative case, it is useless.

const BAD_ENTITY = /&(?!(?:amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);)/;

function attrProblem(src: string): string | null {
  let i = 0;
  while (i < src.length) {
    if (/\s/.test(src[i] ?? '')) {
      i++;
      continue;
    }
    const re = /\s*([^\s=/>]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/y;
    re.lastIndex = i;
    const m = re.exec(src);
    if (!m) return `malformed attribute near ${JSON.stringify(src.slice(i, i + 20))}`;
    const value = m[2] ?? m[3] ?? '';
    if (value.includes('<')) return `unescaped "<" in attribute: ${value}`;
    if (BAD_ENTITY.test(value)) return `invalid entity in attribute: ${value}`;
    i = re.lastIndex;
  }
  return null;
}

/** Returns the first well-formedness problem, or `null` if the XML is valid. */
function xmlProblem(src: string): string | null {
  const open: string[] = [];
  let roots = 0;
  let i = 0;

  while (i < src.length) {
    const lt = src.indexOf('<', i);
    if (lt === -1) {
      const tail = src.slice(i);
      if (open.length === 0 && tail.trim() !== '') return `text outside the root: ${JSON.stringify(tail)}`;
      if (open.length > 0 && BAD_ENTITY.test(tail)) return `invalid entity in text: ${JSON.stringify(tail)}`;
      break;
    }

    const text = src.slice(i, lt);
    if (open.length === 0) {
      if (text.trim() !== '') return `text outside the root: ${JSON.stringify(text)}`;
    } else if (BAD_ENTITY.test(text)) {
      return `invalid entity in text: ${JSON.stringify(text)}`;
    }

    if (src.startsWith('<!--', lt)) {
      const end = src.indexOf('-->', lt + 4);
      if (end === -1) return 'unclosed comment';
      i = end + 3;
      continue;
    }
    if (src.startsWith('<?', lt)) {
      const end = src.indexOf('?>', lt + 2);
      if (end === -1) return 'unclosed instruction';
      i = end + 2;
      continue;
    }
    if (src.startsWith('<![CDATA[', lt)) {
      const end = src.indexOf(']]>', lt + 9);
      if (end === -1) return 'unclosed CDATA';
      i = end + 3;
      continue;
    }
    if (src.startsWith('<!', lt)) {
      const end = src.indexOf('>', lt);
      if (end === -1) return 'unclosed declaration';
      i = end + 1;
      continue;
    }

    // Find the end of the tag while respecting quotes around attributes.
    let j = lt + 1;
    let quote = '';
    for (; j < src.length; j++) {
      const c = src[j];
      if (quote !== '') {
        if (c === quote) quote = '';
      } else if (c === '"' || c === "'") {
        quote = c;
      } else if (c === '>') break;
    }
    if (j >= src.length) return 'unclosed tag';

    const body = src.slice(lt + 1, j);
    if (body === '') return 'empty tag';
    if (body.startsWith('/')) {
      const name = body.slice(1).trim();
      const top = open.pop();
      if (top !== name) return `closing </${name}> does not match <${String(top)}>`;
    } else {
      const selfClosing = body.endsWith('/');
      const inner = selfClosing ? body.slice(0, -1) : body;
      const name = /^([^\s/>]+)/.exec(inner)?.[1] ?? '';
      if (name === '') return 'tag has no name';
      const problem = attrProblem(inner.slice(name.length));
      if (problem) return `in <${name}>: ${problem}`;
      if (open.length === 0) roots++;
      if (!selfClosing) open.push(name);
    }
    i = j + 1;
  }

  if (open.length > 0) return `unclosed tags: ${open.join(', ')}`;
  if (roots !== 1) return `expected 1 root element, found ${roots}`;
  return null;
}

section('XML validator (negative control: must find errors)');
const badDocs: Array<[string, string]> = [
  ['<a><b></a>', 'mismatched closing tag'],
  ['<a>', 'unclosed tag'],
  ['<a/><b/>', 'two roots'],
  ['<a x=1/>', 'unquoted attribute'],
  ['<a>&nope;</a>', 'unknown entity'],
  ['<a>texto & suelto</a>', 'bare ampersand in text'],
  ['<a x="<"/>', 'unescaped less-than sign in attribute'],
  ['<a><!-- unclosed', 'unclosed comment'],
];
for (const [doc, why] of badDocs) {
  check(xmlProblem(doc) !== null, `detects: ${why}`, `not detected → ${String(xmlProblem(doc))}`);
}
check(xmlProblem('<?xml version="1.0"?><a><b/></a>') === null, 'accepts a valid document');

// Now that the validator is proven, use it on the real packet.
section('XMP: the packet is well-formed and namespaced');
const xmpText = xmpInFile?.[1] ?? '';
check(xmlProblem(xmpText) === null, 'the packet in the PNG is well-formed XML', String(xmlProblem(xmpText)));
check(
  xmpText.includes('xmlns:ec3k="https://github.com/MaraniMatias/el-coso-3000/ns/1.0/"') &&
    xmpText.includes(`<ec3k:Placeholder>${meta.width}x${meta.height}</ec3k:Placeholder>`) &&
    // The schema forms, not just readable XML: an alternative and a sequence.
    xmpText.includes(`<rdf:li xml:lang="x-default">${meta.title}</rdf:li>`) &&
    xmpText.includes(`<rdf:Seq><rdf:li>${meta.author}</rdf:li></rdf:Seq>`),
  'the packet declares the app namespace and fills both layers',
  xmpText,
);

// ── SVG ───────────────────────────────────────────────────────────────────

section('SVG: valid XML, metadata, and embedded font');
const cases: Array<[string, Spec]> = [
  ['1920x1080 simple', spec()],
  ['640x360 with bar', spec({ width: 640, height: 360, showProgressBar: true })],
  ['1280x300 with clock', spec({ width: 1280, height: 300, showTime: true })],
  ['320x240 bar and clock', spec({ width: 320, height: 240, showProgressBar: true, showTime: true })],
  ['tiny 32x32', spec({ width: 32, height: 32 })],
  ['wide 4000x120', spec({ width: 4000, height: 120 })],
  ['label with dangerous XML', spec({ width: 800, height: 600, label: '<b>&"x"</b>' })],
  ['palette with &', spec({ width: 800, height: 600, paletteName: 'a&b' })],
];

const svgs = new Map<string, string>();
for (const [name, s] of cases) {
  const svg = buildSvg(s, measure);
  svgs.set(name, svg);
  check(xmlProblem(svg) === null, `${name}: well-formed XML`, String(xmlProblem(svg)));
  check(svg.startsWith('<?xml version="1.0" encoding="UTF-8"?>'), `${name}: declares XML`);
  check(
    svg.includes(`xmlns="http://www.w3.org/2000/svg"`) &&
      svg.includes(`width="${s.width}" height="${s.height}"`) &&
      svg.includes(`viewBox="0 0 ${s.width} ${s.height}"`),
    `${name}: SVG root has a ${s.width}x${s.height} viewBox`,
  );
  check(svg.includes(`<rect width="${s.width}" height="${s.height}" fill="#${s.bg}"/>`), `${name}: background rect`);
  check(svg.includes(FONT_DATA_URL), `${name}: font is embedded in <style>`);
  check(svg.includes(`<![CDATA[${FONT_FACE_CSS}]]>`), `${name}: @font-face is in CDATA`);
  check(svg.includes(`font-family="&quot;${FONT_FAMILY}&quot;`), `${name}: font-family comes from FONT_FAMILY`);
  check(svg.includes(`font-weight="${FONT_WEIGHT}"`), `${name}: font-weight comes from FONT_WEIGHT`);
  check(svg.includes('text-anchor="middle"'), `${name}: text is centered like on canvas`);

  const block = /<metadata>([\s\S]*?)<\/metadata>/.exec(svg)?.[1] ?? '';
  // `buildSvg` reads the clock itself, so the export instant is the one field
  // that cannot be compared literally without a race against the second tick.
  const withoutTime = (t: string) => t.replace(/^Creation Time: .*$/m, '');
  check(
    withoutTime(unescapeXml(block)) === withoutTime(metadataAsText(buildMetadata(s, { now: NOW }))),
    `${name}: <metadata> contains the escaped metadata`,
    block,
  );
  check(
    block.split('\n').length === pairs.length,
    `${name}: metadata retains all ${pairs.length} lines`,
    `${block.split('\n').length} remain`,
  );
  check(block.includes(buildMetadata(s, { now: NOW }).title), `${name}: metadata includes the title`);
}

/**
 * Recalculates, using core functions and the SAME parameters as `drawFrame`,
 * which lines and baselines should be emitted. If the SVG changed even one
 * number, this table would not match the output.
 */
function expectedLines(s: Spec): Array<{ x: number; y: number; size: number; text: string }> {
  const ctx = new FakeMeasureContext() as unknown as CanvasRenderingContext2D;
  const geo = frameGeometry(s);
  const contentHeight = s.height - geo.stripHeight;
  const pad = paddingFor(s.width, s.height);
  const out: Array<{ x: number; y: number; size: number; text: string }> = [];

  const dims = layoutDimensions(
    ctx,
    s,
    Math.max(1, s.width - pad * 2),
    Math.max(1, contentHeight - pad * 2),
    { fontWeight: FONT_WEIGHT },
  );
  if (dims && dims.fontSize >= 6) {
    let baseline = (contentHeight - dims.height) / 2 + dims.ascent;
    for (const line of dims.lines) {
      out.push({ x: s.width / 2, y: baseline, size: dims.fontSize, text: line });
      baseline += dims.lineHeight;
    }
  }

  if (geo.stripHeight > 0 && s.showTime && geo.timeFontSize > 0) {
    const boxH = geo.timeFontSize * 1.5;
    const clock = layoutLine(ctx, timecode(0, s.duration), s.width - pad, boxH, {
      fontWeight: FONT_WEIGHT,
      minFontSize: 7,
      maxFontSize: geo.timeFontSize,
    });
    if (clock) {
      out.push({
        x: s.width / 2,
        y: s.height - geo.barHeight - boxH + (boxH - clock.height) / 2 + clock.ascent,
        size: clock.fontSize,
        text: clock.lines[0] ?? '',
      });
    }
  }
  return out;
}

const round2 = (n: number) => Math.round(n * 100) / 100;
const sameLine = (a: { x: number; y: number; size: number; text: string }, b: { x: number; y: number; size: number; text: string }) =>
  a.text === b.text && round2(a.x) === round2(b.x) && round2(a.y) === round2(b.y) && round2(a.size) === round2(b.size);

const TEXT_RE = /<text x="([-\d.]+)" y="([-\d.]+)" fill="[^"]*" font-family="[^"]*" font-weight="\d+" font-size="([-\d.]+)" text-anchor="middle">([^<]*)<\/text>/g;

function emittedLines(svg: string): Array<{ x: number; y: number; size: number; text: string }> {
  const out: Array<{ x: number; y: number; size: number; text: string }> = [];
  for (const m of svg.matchAll(TEXT_RE)) {
    out.push({ x: Number(m[1]), y: Number(m[2]), size: Number(m[3]), text: unescapeXml(m[4] ?? '') });
  }
  return out;
}

section('SVG: text matches the core layout line by line');
for (const [name, s] of cases) {
  const expected = expectedLines(s);
  const got = emittedLines(svgs.get(name)!);
  check(
    got.length === expected.length && got.every((line, i) => sameLine(line, expected[i]!)),
    `${name}: ${expected.length} <text> elements with x, y, and font-size from the core`,
    `expected ${JSON.stringify(expected)}\n        emitted   ${JSON.stringify(got)}`,
  );
}

section('SVG: geometry that must match drawFrame');
const simple = svgs.get('1920x1080 simple')!;
check(emittedLines(simple).length === 1, 'without a bar or clock there is one <text> (the dimensions)');
check(
  dimensionCandidates(1920, 1080).flat().includes(emittedLines(simple)[0]!.text),
  'text is one of the forms produced by layoutDimensions, not an invented one',
  emittedLines(simple)[0]!.text,
);

const withBar = svgs.get('640x360 with bar')!;
const geo640 = frameGeometry(spec({ width: 640, height: 360, showProgressBar: true }));
check(
  withBar.includes(
    `<rect y="${round2(360 - geo640.barHeight)}" width="640" height="${geo640.barHeight}" fill="${hexToRgba('5A2A2A', 0.16)}"/>`,
  ),
  'bar uses frameGeometry geometry and drawFrame guide color',
  withBar.split('\n').find((l) => l.startsWith('<rect y=')) ?? 'not found',
);
check(
  (withBar.match(/<rect y="/g) ?? []).length === 1,
  'empty bar is not filled (still image, progress 0)',
  `${(withBar.match(/<rect y="/g) ?? []).length} rects have y`,
);

const withClock = svgs.get('1280x300 with clock')!;
check(emittedLines(withClock).length === 2, 'with a clock there are two <text> elements (dimensions + clock)');
check(emittedLines(withClock).some((l) => l.text === timecode(0, 0)), 'clock shows time 0 for a still image');

const tiny = svgs.get('tiny 32x32')!;
check(
  emittedLines(tiny).every((l) => l.y > 0 && l.y < 32 && l.x === 16),
  'at 32x32 the baseline falls inside the canvas, as in drawFrame',
  JSON.stringify(emittedLines(tiny)),
);

const nasty = svgs.get('label with dangerous XML')!;
check(
  nasty.includes('&lt;b&gt;&amp;&quot;x&quot;&lt;/b&gt;') && !nasty.includes('<b>&'),
  'label containing < > & " is escaped and does not break XML',
  nasty.split('\n').find((l) => l.includes('<text')) ?? '',
);
check(xmlProblem(nasty) === null, 'SVG with a dangerous label remains valid XML');

const ampersand = svgs.get('palette with &')!;
check(ampersand.includes('palette a&amp;b'), 'palette & is escaped inside metadata');

// ── Transparency ────────────────────────────────────────────────────────────

section('SVG: a transparent background is the absence of the background rect');
{
  // Same spec as the opaque case, with only `transparent` flipped: any other
  // difference in the output would mean the flag leaked into the layout.
  const base = spec({ width: 640, height: 360, showProgressBar: true });
  const opaqueSvg = buildSvg(base, measure);
  const alphaSvg = buildSvg({ ...base, transparent: true }, measure);

  check(!alphaSvg.includes('<rect width="640" height="360"'), 'the full-canvas background rect is not emitted');
  check(
    opaqueSvg.includes('<rect width="640" height="360"'),
    'the same spec without the flag still paints the background',
  );
  // The strongest statement available without a canvas: take the opaque output
  // and delete that one line, and what is left is the transparent output, byte
  // for byte. If the flag reached the layout, this would not hold.
  const withoutMeta = (svg: string) => svg.replace(/<metadata>[\s\S]*?<\/metadata>/, '');
  const bgRect = /\n<rect width="640" height="360" fill="#FFE4E4"\/>/;
  check(
    withoutMeta(alphaSvg) === withoutMeta(opaqueSvg).replace(bgRect, ''),
    'outside the metadata, the transparent SVG is the opaque one minus that rect',
  );
  check(emittedLines(alphaSvg).length === 1, 'the dimensions are still drawn');
  check(
    // `buildSvg` writes the text fill as the bare hex, without the `#` the
    // background rect carries. Matched on the fill alone: the position belongs
    // to the layout, which the line-by-line test above already covers.
    alphaSvg.includes(`fill="${base.fg}" font-family=`),
    'the text keeps the color derived from the background, so it stays readable',
  );
  check(
    alphaSvg.includes(`<rect y="${round2(360 - frameGeometry(base).barHeight)}" width="640" height="${frameGeometry(base).barHeight}"`),
    'the progress bar track is still there',
  );
  check(xmlProblem(alphaSvg) === null, 'the transparent SVG is still valid XML', String(xmlProblem(alphaSvg)));
  // The metadata states the background color, which is what the text color was
  // derived from. It is the honest thing to record: the color is chosen, only
  // the fill is skipped.
  check(
    unescapeXml(/<metadata>([\s\S]*?)<\/metadata>/.exec(alphaSvg)?.[1] ?? '').includes(`Background: #${base.bg}`),
    'the metadata still records the background color the text was derived from',
  );
}

// ── The texture ───────────────────────────────────────────────────────────
// The SVG is written as text and stays flat: a texture is painted with a
// canvas, and this file cannot. What it can do is say so honestly — nowhere in
// the drawing — and record what was asked for in the metadata.
section('SVG: a texture is not drawn');
const textured = spec({ texture: 'focus' });
const texturedSvg = buildSvg(textured, measure);
const flatSvg = buildSvg(spec(), measure);
const strip = (svg: string) => svg.replace(/<metadata>[\s\S]*?<\/metadata>/, '');
check(
  strip(texturedSvg) === strip(flatSvg),
  'a textured spec produces exactly the flat SVG',
);
check(!/<circle|<radialGradient|<filter/.test(texturedSvg), 'and no shape of the texture leaked in');
check(xmlProblem(texturedSvg) === null, 'it is still valid XML', String(xmlProblem(texturedSvg)));
check(
  unescapeXml(/<metadata>([\s\S]*?)<\/metadata>/.exec(texturedSvg)?.[1] ?? '').includes('Texture: focus'),
  'the metadata still records which texture was asked for',
);
check(
  !/Texture:/.test(unescapeXml(/<metadata>([\s\S]*?)<\/metadata>/.exec(flatSvg)?.[1] ?? '')),
  'and a flat file has no texture to record',
);

// The speed is a property of the animation, so it is only a fact about a file
// that has frames to animate. A still image is the same picture at any speed.
const speedStill = buildSvg(textured, measure);
const speedVideo = buildSvg({ ...textured, duration: 5, fps: 15, textureSpeed: 3 }, measure);
const block = (svg: string) => unescapeXml(/<metadata>([\s\S]*?)<\/metadata>/.exec(svg)?.[1] ?? '');
check(!block(speedStill).includes('Texture Speed'), 'a still image records no speed');
check(block(speedVideo).includes('Texture Speed: 3x'), 'an animated one does', block(speedVideo));
check(
  block(speedStill) === block(buildSvg(textured, measure)),
  'and the speed does not reach the drawing of a still image',
);

console.log(failures === 0 ? '\n✔ image encoder OK' : `\n✘ ${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);