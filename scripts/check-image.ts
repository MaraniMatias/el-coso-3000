/**
 * Verificación del encoder de imagen estática.
 *
 * Corre: `bun run scripts/check-image.ts`
 *
 * Bun no tiene DOM ni Canvas, así que lo que se verifica es todo lo que NO
 * necesita canvas: la lógica de bytes (CRC32, chunks PNG, segmento COM de
 * JPEG, chunk XMP de WebP) y la emisión del SVG, que es texto plano. Para
 * medir el texto del SVG se pasa un contexto falso que devuelve métricas
 * deterministas, de modo que el layout se puede comprobar de verdad.
 *
 * Falla (exit 1) si algo no cierra.
 */
import {
  buildSvg,
  crc32,
  insertJpegComment,
  insertPngChunks,
  insertWebpXmp,
  pngChunk,
  pngTextChunks,
} from '../src/encoders/image';
import { FONT_DATA_URL, FONT_FACE_CSS } from '../src/core/font';
import { FONT_FAMILY, FONT_WEIGHT, type Spec } from '../src/core/types';
import { buildMetadata, metadataAsPairs, metadataAsText } from '../src/core/metadata';
import { frameGeometry, timecode } from '../src/core/draw-frame';
import { dimensionCandidates, layoutDimensions, layoutLine, paddingFor } from '../src/core/fit-text';
import { hexToRgba } from '../src/core/color';

/** Revierte el escapado del encoder, para comparar contra el texto original. */
function unescapeXml(text: string): string {
  const named: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
  return text.replace(/&(amp|lt|gt|quot|apos);/g, (_, name: string) => named[name] ?? '');
}

let failures = 0;
const enc = new TextEncoder();
const dec = new TextDecoder('utf-8');
/** Decoder ISO-8859-1, que es el charset que impone la spec de `tEXt`. */
const decLatin1 = new TextDecoder('latin1');
const latin1 = (bytes: Uint8Array) => decLatin1.decode(bytes);

function check(ok: boolean, label: string, detail = ''): void {
  if (!ok) failures++;
  console.log(`  ${ok ? 'ok  ' : 'FALLA'}  ${label}${detail && !ok ? `\n        ${detail}` : ''}`);
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
  quality: 0.92,
  ...over,
});

/**
 * Contexto de medición falso. El layout del core sólo necesita que se le pueda
 * asignar `font` y que `measureText` devuelva la caja de los glifos.
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

section('CRC32 (vectores conocidos del polinomio 0xEDB88320)');
const crcOf = (s: string) => crc32(enc.encode(s));
check(crcOf('') === 0x00000000, 'cadena vacía → 0x00000000', `dio 0x${crcOf('').toString(16)}`);
check(crcOf('123456789') === 0xcbf43926, '"123456789" → 0xCBF43926', `dio 0x${crcOf('123456789').toString(16)}`);
check(
  crcOf('The quick brown fox jumps over the lazy dog') === 0x414fa339,
  'frase de pangrama → 0x414FA339',
  `dio 0x${crcOf('The quick brown fox jumps over the lazy dog').toString(16)}`,
);
check(crcOf('a') === 0xe8b7be43, '"a" → 0xE8B7BE43', `dio 0x${crcOf('a').toString(16)}`);

// ── PNG ───────────────────────────────────────────────────────────────────

const PNG_SIGNATURE = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** PNG mínimo sintético: sólo importa la estructura de chunks, no el contenido. */
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

/** Recorre los chunks validando largo y CRC, igual que haría un decodificador. */
function walkPng(png: Uint8Array): PngChunk[] {
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  const found: PngChunk[] = [];
  let offset = 8;
  while (offset + 12 <= png.length) {
    const length = view.getUint32(offset);
    const type = String.fromCharCode(...png.subarray(offset + 4, offset + 8));
    if (offset + 12 + length > png.length) throw new Error(`chunk ${type} se pasa del final`);
    const data = png.subarray(offset + 8, offset + 8 + length);
    const crc = view.getUint32(offset + 8 + length);
    const real = crc32(png.subarray(offset + 4, offset + 8 + length));
    if (crc !== real) throw new Error(`CRC inválido en ${type}: ${crc} != ${real}`);
    found.push({ type, data, offset });
    if (type === 'IEND') break;
    offset += 12 + length;
  }
  return found;
}

const meta = buildMetadata(spec());
const pairs = metadataAsPairs(meta);
const textChunks = pngTextChunks(pairs);

section(`PNG: se inyectan ${textChunks.length} chunks tEXt antes del IEND`);
const png = makePng();
const injected = insertPngChunks(png, textChunks);
let parsed: PngChunk[] = [];
try {
  parsed = walkPng(injected);
  check(true, 'todos los chunks del PNG resultante están bien formados (largo + CRC32)');
} catch (err) {
  check(false, 'todos los chunks del PNG resultante están bien formados (largo + CRC32)', String(err));
}

check(parsed.at(-1)?.type === 'IEND', 'el IEND sigue siendo el último chunk', `terminó en ${parsed.at(-1)?.type}`);
check(parsed[0]?.type === 'IHDR', 'el IHDR sigue siendo el primero', `empezó con ${parsed[0]?.type}`);
check(
  injected.length === png.length + textChunks.reduce((n, c) => n + c.length, 0),
  'el tamaño crece exactamente lo que suman los chunks',
  `${png.length} → ${injected.length}`,
);
check(
  injected.length === parsed.at(-1)!.offset + 12,
  'no sobra nada después del IEND',
  `IEND en ${parsed.at(-1)?.offset}, archivo de ${injected.length}`,
);
check(
  new Uint8Array(injected.subarray(0, 8)).every((b, i) => b === PNG_SIGNATURE[i]),
  'la firma PNG quedó intacta',
);

const readTexts = parsed
  .filter((c) => c.type === 'tEXt')
  .map((c) => {
    const nul = c.data.indexOf(0);
    // `tEXt` es Latin-1 según la spec, así que se decodifica como Latin-1.
    // Decodificarlo como UTF-8 rompería con la "á" de "estática".
    return [latin1(c.data.subarray(0, nul)), latin1(c.data.subarray(nul + 1))] as const;
  });
check(readTexts.length === pairs.length, `aparecen ${pairs.length} chunks tEXt en el archivo`, `aparecen ${readTexts.length}`);
check(
  readTexts.every(([k, v], i) => k === pairs[i]?.[0] && v === pairs[i]?.[1]),
  'cada tEXt round-trippea clave y valor exactos',
  JSON.stringify(readTexts[0]),
);
check(
  parsed.filter((c) => c.type === 'tEXt').every((c) => c.offset > parsed[0]!.offset),
  'los tEXt van después del IHDR',
);

// Un PNG sin IEND es inválido y el inyector tiene que decirlo, no producir basura.
try {
  insertPngChunks(new Uint8Array([...PNG_SIGNATURE, 1, 2, 3, 4]), textChunks);
  check(false, 'un PNG sin IEND se rechaza con error');
} catch {
  check(true, 'un PNG sin IEND se rechaza con error');
}
try {
  insertPngChunks(new Uint8Array(20), textChunks);
  check(false, 'una firma inválida se rechaza con error');
} catch {
  check(true, 'una firma inválida se rechaza con error');
}

// ── JPEG ──────────────────────────────────────────────────────────────────

/** JPEG sintético: SOI + APP0/JFIF + EOI. */
function makeJpeg(): Uint8Array {
  const app0 = new Uint8Array([
    0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00,
  ]);
  return new Uint8Array([0xff, 0xd8, ...app0, 0xff, 0xd9]);
}

section('JPEG: el segmento COM queda justo después del SOI');
for (const text of [metadataAsText(meta), 'corto', 'impar']) {
  const jpeg = makeJpeg();
  const out = insertJpegComment(jpeg, text);
  const view = new DataView(out.buffer);
  const label = `"${text.length} bytes"`;
  const payloadLen = view.getUint16(4);
  // El largo declarado siempre es par; el relleno se deduce del texto, porque
  // `2 (sus propios bytes) + payload` tiene que quedar par.
  const pad = (2 + enc.encode(text).length) % 2;

  check(out[0] === 0xff && out[1] === 0xd8, `${label}: el SOI sigue primero`, `0x${out[0]?.toString(16)} 0x${out[1]?.toString(16)}`);
  check(out[2] === 0xff && out[3] === 0xfe, `${label}: marcador 0xFFFE en offset 2`, `0x${out[2]?.toString(16)} 0x${out[3]?.toString(16)}`);
  check(
    payloadLen === 2 + enc.encode(text).length + pad && payloadLen % 2 === 0,
    `${label}: largo par que incluye sus 2 bytes`,
    `largo ${payloadLen}, texto ${enc.encode(text).length}, relleno ${pad}`,
  );
  check(
    dec.decode(out.subarray(6, 6 + enc.encode(text).length)) === text,
    `${label}: el texto vuelve intacto`,
  );
  check(pad === 0 || out[6 + enc.encode(text).length] === 0x00, `${label}: byte de relleno en cero`);
  check(out.length === jpeg.length + 4 + enc.encode(text).length + pad, `${label}: el tamaño cierra`);
  check(
    out.slice(2 + 4 + enc.encode(text).length + pad).every((b, i) => b === jpeg[2 + i]),
    `${label}: el resto del JPEG quedó byte a byte igual`,
  );
}

// ── WebP ──────────────────────────────────────────────────────────────────

/** WebP sintético: RIFF/WEBP con un solo chunk de imagen `VP8 `. */
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

section('WebP: el chunk XMP entra antes de los píxeles y arregla el largo de RIFF');
for (const xmp of [enc.encode('<x:xmpmeta/>'), enc.encode('<x:xmpmeta xmlns:x="adobe:ns:meta/"/>')]) {
  const webp = makeWebp();
  const out = insertWebpXmp(webp, xmp);
  const view = new DataView(out.buffer);
  const label = `${xmp.length} bytes de payload`;

  check(
    view.getUint32(4, true) === out.length - 8,
    `${label}: el largo de RIFF quedó en archivo - 8`,
    `RIFF dice ${view.getUint32(4, true)}, archivo de ${out.length}`,
  );
  check(
    String.fromCharCode(...out.subarray(12, 16)) === 'XMP ',
    `${label}: el chunk arranca en offset 12 con el fourCC "XMP "`,
  );
  check(view.getUint32(16, true) === xmp.length, `${label}: el largo del chunk es el del payload`);
  check(
    out.subarray(20, 20 + xmp.length).every((b, i) => b === xmp[i]),
    `${label}: el payload quedó intacto`,
  );
  if (xmp.length % 2) {
    check(out[20 + xmp.length] === 0x00, `${label}: hay byte de relleno a byte par`);
  }
  const at = 20 + xmp.length + (xmp.length % 2);
  check(String.fromCharCode(...out.subarray(at, at + 4)) === 'VP8 ', `${label}: VP8 quedó después del XMP`);
  check(
    out.subarray(at).every((b, i) => b === webp[12 + i]),
    `${label}: el chunk de imagen original quedó byte a byte igual`,
  );
}

// ── Metadata ──────────────────────────────────────────────────────────────

section('Metadata: se serializa sin caracteres que rompan el contenedor');
const pairKeys = pairs.map(([k]) => k);
const pairValues = pairs.map(([, v]) => v);
const allValues = [...pairKeys, ...pairValues, metadataAsText(meta)];
check(
  allValues.every((s) => [...s].every((c) => c.charCodeAt(0) <= 0xff)),
  'todo el vocabulario de la metadata entra en Latin-1 (requisito de tEXt)',
  JSON.stringify(allValues.filter((s) => [...s].some((c) => c.charCodeAt(0) > 0xff))),
);
check(allValues.every((s) => !s.includes('\0')), 'ningún valor tiene NUL (rompería el split clave/valor)');
// El `tEXt` es clave\0valor sin longitud, así que un salto de línea ahí no se
// puede distinguir del contenido. En el `COM` de JPEG y el `<metadata>` del SVG
// no hay problema: el largo es explícito.
check(
  pairKeys.every((s) => !/[\r\n\0]/.test(s)) && pairValues.every((s) => !/[\r\n\0]/.test(s)),
  'ningún par de tEXt tiene saltos de línea',
  JSON.stringify([...pairKeys, ...pairValues].filter((s) => /[\r\n\0]/.test(s))),
);
check(
  pairs.every(([k]) => /^[A-Za-z0-9]{1,79}$/.test(k)),
  'las claves tEXt son nombres de 1 a 79 caracteres ASCII',
  JSON.stringify(pairKeys.filter((k) => !/^[A-Za-z0-9]{1,79}$/.test(k))),
);

// ── Validador de XML ──────────────────────────────────────────────────────
// Bun no trae `DOMParser`, así que el SVG se valida con un chequeo de
// well-formedness propio. Está testeado contra documentos rotos más abajo: si
// el validador no acepta el caso negativo, no sirve para nada.

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
    if (!m) return `atributo mal formado cerca de ${JSON.stringify(src.slice(i, i + 20))}`;
    const value = m[2] ?? m[3] ?? '';
    if (value.includes('<')) return `atributo con "<" sin escapar: ${value}`;
    if (BAD_ENTITY.test(value)) return `entidad inválida en atributo: ${value}`;
    i = re.lastIndex;
  }
  return null;
}

/** Devuelve el primer problema de well-formedness, o `null` si el XML cierra. */
function xmlProblem(src: string): string | null {
  const open: string[] = [];
  let roots = 0;
  let i = 0;

  while (i < src.length) {
    const lt = src.indexOf('<', i);
    if (lt === -1) {
      const tail = src.slice(i);
      if (open.length === 0 && tail.trim() !== '') return `texto fuera del root: ${JSON.stringify(tail)}`;
      if (open.length > 0 && BAD_ENTITY.test(tail)) return `entidad inválida en texto: ${JSON.stringify(tail)}`;
      break;
    }

    const text = src.slice(i, lt);
    if (open.length === 0) {
      if (text.trim() !== '') return `texto fuera del root: ${JSON.stringify(text)}`;
    } else if (BAD_ENTITY.test(text)) {
      return `entidad inválida en texto: ${JSON.stringify(text)}`;
    }

    if (src.startsWith('<!--', lt)) {
      const end = src.indexOf('-->', lt + 4);
      if (end === -1) return 'comentario sin cerrar';
      i = end + 3;
      continue;
    }
    if (src.startsWith('<?', lt)) {
      const end = src.indexOf('?>', lt + 2);
      if (end === -1) return 'instrucción sin cerrar';
      i = end + 2;
      continue;
    }
    if (src.startsWith('<![CDATA[', lt)) {
      const end = src.indexOf(']]>', lt + 9);
      if (end === -1) return 'CDATA sin cerrar';
      i = end + 3;
      continue;
    }
    if (src.startsWith('<!', lt)) {
      const end = src.indexOf('>', lt);
      if (end === -1) return 'declaración sin cerrar';
      i = end + 1;
      continue;
    }

    // Buscar el cierre del tag respetando las comillas de los atributos.
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
    if (j >= src.length) return 'tag sin cerrar';

    const body = src.slice(lt + 1, j);
    if (body === '') return 'tag vacío';
    if (body.startsWith('/')) {
      const name = body.slice(1).trim();
      const top = open.pop();
      if (top !== name) return `cierre </${name}> que no corresponde a <${String(top)}>`;
    } else {
      const selfClosing = body.endsWith('/');
      const inner = selfClosing ? body.slice(0, -1) : body;
      const name = /^([^\s/>]+)/.exec(inner)?.[1] ?? '';
      if (name === '') return 'tag sin nombre';
      const problem = attrProblem(inner.slice(name.length));
      if (problem) return `en <${name}>: ${problem}`;
      if (open.length === 0) roots++;
      if (!selfClosing) open.push(name);
    }
    i = j + 1;
  }

  if (open.length > 0) return `tags sin cerrar: ${open.join(', ')}`;
  if (roots !== 1) return `se esperaba 1 elemento raíz, hay ${roots}`;
  return null;
}

section('Validador de XML (control negativo: tiene que encontrar los errores)');
const badDocs: Array<[string, string]> = [
  ['<a><b></a>', 'cierre cruzado'],
  ['<a>', 'tag sin cerrar'],
  ['<a/><b/>', 'dos raíces'],
  ['<a x=1/>', 'atributo sin comillas'],
  ['<a>&nope;</a>', 'entidad desconocida'],
  ['<a>texto & suelto</a>', 'ampersand suelto en texto'],
  ['<a x="<"/>', 'menor sin escapar en atributo'],
  ['<a><!-- sin cerrar', 'comentario sin cerrar'],
];
for (const [doc, why] of badDocs) {
  check(xmlProblem(doc) !== null, `detecta: ${why}`, `no lo detectó → ${String(xmlProblem(doc))}`);
}
check(xmlProblem('<?xml version="1.0"?><a><b/></a>') === null, 'acepta un documento sano');

// ── SVG ───────────────────────────────────────────────────────────────────

section('SVG: XML válido, metadata y fuente embebida');
const cases: Array<[string, Spec]> = [
  ['1920x1080 simple', spec()],
  ['640x360 con barra', spec({ width: 640, height: 360, showProgressBar: true })],
  ['1280x300 con reloj', spec({ width: 1280, height: 300, showTime: true })],
  ['320x240 barra y reloj', spec({ width: 320, height: 240, showProgressBar: true, showTime: true })],
  ['minúsculo 32x32', spec({ width: 32, height: 32 })],
  ['ancho 4000x120', spec({ width: 4000, height: 120 })],
  ['label con XML peligroso', spec({ width: 800, height: 600, label: '<b>&"x"</b>' })],
  ['paleta con &', spec({ width: 800, height: 600, paletteName: 'a&b' })],
];

const svgs = new Map<string, string>();
for (const [name, s] of cases) {
  const svg = buildSvg(s, measure);
  svgs.set(name, svg);
  check(xmlProblem(svg) === null, `${name}: XML bien formado`, String(xmlProblem(svg)));
  check(svg.startsWith('<?xml version="1.0" encoding="UTF-8"?>'), `${name}: declara XML`);
  check(
    svg.includes(`xmlns="http://www.w3.org/2000/svg"`) &&
      svg.includes(`width="${s.width}" height="${s.height}"`) &&
      svg.includes(`viewBox="0 0 ${s.width} ${s.height}"`),
    `${name}: root svg con viewBox de ${s.width}x${s.height}`,
  );
  check(svg.includes(`<rect width="${s.width}" height="${s.height}" fill="#${s.bg}"/>`), `${name}: rect de fondo`);
  check(svg.includes(FONT_DATA_URL), `${name}: la fuente va embebida en el <style>`);
  check(svg.includes(`<![CDATA[${FONT_FACE_CSS}]]>`), `${name}: el @font-face va en CDATA`);
  check(svg.includes(`font-family="&quot;${FONT_FAMILY}&quot;`), `${name}: font-family sale de FONT_FAMILY`);
  check(svg.includes(`font-weight="${FONT_WEIGHT}"`), `${name}: font-weight sale de FONT_WEIGHT`);
  check(svg.includes('text-anchor="middle"'), `${name}: el texto va centrado como el canvas`);

  const block = /<metadata>([\s\S]*?)<\/metadata>/.exec(svg)?.[1] ?? '';
  check(unescapeXml(block) === metadataAsText(buildMetadata(s)), `${name}: el <metadata> lleva la metadata escapada`, block);
  check(block.split('\n').length === 5, `${name}: el metadata conserva los 5 renglones`, `quedaron ${block.split('\n').length}`);
  check(block.includes(buildMetadata(s).title), `${name}: el metadata incluye el título`);
}

/**
 * Recalcula, con las funciones del core y con los MISMOS parámetros que usa
 * `drawFrame`, qué renglones y qué línea base deberían salir. Si el SVG
 * cambiara un solo número, esta tabla no coincidiría con lo emitido.
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

section('SVG: el texto coincide renglón a renglón con el layout del core');
for (const [name, s] of cases) {
  const expected = expectedLines(s);
  const got = emittedLines(svgs.get(name)!);
  check(
    got.length === expected.length && got.every((line, i) => sameLine(line, expected[i]!)),
    `${name}: ${expected.length} <text> con x, y y font-size del core`,
    `esperado ${JSON.stringify(expected)}\n        emitido   ${JSON.stringify(got)}`,
  );
}

section('SVG: geometría que tiene que coincidir con drawFrame');
const simple = svgs.get('1920x1080 simple')!;
check(emittedLines(simple).length === 1, 'sin barra ni reloj hay un solo <text> (las dimensiones)');
check(
  dimensionCandidates(1920, 1080).flat().includes(emittedLines(simple)[0]!.text),
  'el texto es una de las formas que compone layoutDimensions, no una inventada',
  emittedLines(simple)[0]!.text,
);

const withBar = svgs.get('640x360 con barra')!;
const geo640 = frameGeometry(spec({ width: 640, height: 360, showProgressBar: true }));
check(
  withBar.includes(
    `<rect y="${round2(360 - geo640.barHeight)}" width="640" height="${geo640.barHeight}" fill="${hexToRgba('5A2A2A', 0.16)}"/>`,
  ),
  'la barra usa la geometría de frameGeometry y el color de guía de drawFrame',
  withBar.split('\n').find((l) => l.startsWith('<rect y=')) ?? 'no está',
);
check(
  (withBar.match(/<rect y="/g) ?? []).length === 1,
  'la barra vacía no se rellena (imagen estática, progreso 0)',
  `hay ${(withBar.match(/<rect y="/g) ?? []).length} rect con y`,
);

const withClock = svgs.get('1280x300 con reloj')!;
check(emittedLines(withClock).length === 2, 'con reloj hay dos <text> (dimensiones + reloj)');
check(emittedLines(withClock).some((l) => l.text === timecode(0, 0)), 'el reloj marca el tiempo 0 de una imagen fija');

const tiny = svgs.get('minúsculo 32x32')!;
check(
  emittedLines(tiny).every((l) => l.y > 0 && l.y < 32 && l.x === 16),
  'a 32x32 la línea base cae dentro del lienzo, como en drawFrame',
  JSON.stringify(emittedLines(tiny)),
);

const nasty = svgs.get('label con XML peligroso')!;
check(
  nasty.includes('&lt;b&gt;&amp;&quot;x&quot;&lt;/b&gt;') && !nasty.includes('<b>&'),
  'el label con < > & " sale escapado y no rompe el XML',
  nasty.split('\n').find((l) => l.includes('<text')) ?? '',
);
check(xmlProblem(nasty) === null, 'el SVG con label peligroso sigue siendo XML válido');

const ampersand = svgs.get('paleta con &')!;
check(ampersand.includes('paleta a&amp;b'), 'el & de la paleta queda escapado dentro del metadata');

console.log(failures === 0 ? '\n✔ encoder de imagen OK' : `\n✘ ${failures} fallo(s)`);
process.exit(failures === 0 ? 0 : 1);
