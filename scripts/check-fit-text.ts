/**
 * Verificación del auto-ajuste del texto.
 *
 * Corre: `bun run check:fit`
 *
 * Bun no tiene Canvas, así que se usa un contexto falso que modela las
 * métricas de la fuente. No es la fuente real, pero reproduce su
 * comportamiento esencial: el ancho crece con el tamaño y es proporcional
 * al número de caracteres.
 */
import { layoutDimensions, layoutLine, clampMaxFont, paddingFor } from '../src/core/fit-text';
import type { Spec } from '../src/core/types';

const ADVANCE = 0.58; // ancho medio por carácter, en em
const SPACE = 0.28;
const ASCENT = 0.72;
const DESCENT = 0.22;

type Metrics = TextMetrics;

function fakeMetrics(text: string, size: number): Metrics {
  let em = 0;
  for (const ch of text) em += ch === ' ' || ch === ' ' ? SPACE : ADVANCE;
  return {
    width: em * size,
    actualBoundingBoxAscent: ASCENT * size,
    actualBoundingBoxDescent: DESCENT * size,
  } as Metrics;
}

function fakeCtx(): CanvasRenderingContext2D {
  let size = 16;
  return {
    set font(value: string) {
      const m = /(\d+(?:\.\d+)?)px/.exec(value);
      if (m?.[1]) size = Number(m[1]);
    },
    get font() {
      return '';
    },
    measureText(text: string) {
      return fakeMetrics(text, size);
    },
  } as unknown as CanvasRenderingContext2D;
}

const ctx = fakeCtx();

function spec(w: number, h: number): Spec {
  return {
    width: w,
    height: h,
    bg: 'F2DEE2',
    fg: '962C41',
    paletteName: 'rose',
    duration: 5,
    fps: 15,
    showProgressBar: true,
    showTime: true,
    quality: 0.9,
  };
}

let fails = 0;
function check(name: string, ok: boolean, detail = ''): void {
  if (!ok) {
    fails++;
    console.log(`  ✘ ${name} ${detail}`);
  }
}

const CASES: Array<[number, number]> = [
  [1920, 1080], [1280, 720], [800, 600], [640, 480], [500, 500], [400, 300],
  [300, 200], [256, 256], [192, 108], [160, 90], [120, 80], [100, 100],
  [96, 64], [80, 80], [64, 64], [48, 48], [32, 32], [24, 24], [16, 16],
  [2000, 50], [50, 2000], [3000, 40], [1, 1], [4, 4], [10, 10],
];

console.log('ancho      alto     fuente  líneas  encogió  cabe');
console.log('─'.repeat(56));

for (const [w, h] of CASES) {
  const s = spec(w, h);
  // Mismos límites que usa `drawFrame`.
  const pad = paddingFor(w, h);
  const maxW = Math.max(1, w - pad * 2);
  const maxH = Math.max(1, h - pad * 2);
  const layout = layoutDimensions(ctx, s, maxW, maxH);

  if (!layout) {
    // Sin layout sólo es aceptable en imágenes diminutas.
    if (Math.min(w, h) > 16) {
      fails++;
      console.log(`  ✘ ${w}x${h} sin layout`);
    }
    console.log(`${String(w).padEnd(10)}${String(h).padEnd(8)}—`);
    continue;
  }

  const cap = clampMaxFont(w, h);
  const fits = layout.width <= maxW && layout.height <= maxH;
  check(`${w}x${h} cabe`, fits, `(${layout.width.toFixed(1)}x${layout.height.toFixed(1)} en ${maxW.toFixed(1)}x${maxH.toFixed(1)})`);
  check(`${w}x${h} bajo el techo`, layout.fontSize <= cap + 0.5, `(${layout.fontSize.toFixed(1)} > ${cap})`);
  check(`${w}x${h} nunca mayor que la imagen`, layout.fontSize <= Math.min(w, h));

  console.log(
    `${String(w).padEnd(10)}${String(h).padEnd(8)}${layout.fontSize.toFixed(1).padStart(5)}  ` +
      `${String(layout.lines.length).padStart(5)}  ${(layout.shrunk ? 'sí' : 'no').padEnd(8)}  ${fits ? 'sí' : 'NO'}`,
  );
}

// El tamaño de fuente tiene que CRECER con la imagen. Esto es lo que el
// subagente detectó roto: todo se quedaba en 10px.
console.log('\nmonotonía del tamaño de fuente:');
const ladder: Array<[number, number]> = [[64, 64], [128, 128], [256, 256], [512, 512], [1024, 1024], [1920, 1080]];
const sizes = ladder.map(([w, h]) => layoutDimensions(ctx, spec(w, h), w, h)?.fontSize ?? 0);
ladder.forEach(([w, h], i) => console.log(`  ${w}x${h}`.padEnd(14) + (sizes[i]?.toFixed(1) ?? '—')));
let monotonic = true;
for (let i = 1; i < sizes.length; i++) {
  if (sizes[i]! <= sizes[i - 1]!) monotonic = false;
}
check('el tamaño crece con la imagen', monotonic, `→ ${sizes.map((s) => s?.toFixed(1)).join(' ')}`);
console.log(monotonic ? '  ✔ crece' : '  ✘ no crece');

// Una imagen angosta obliga a partir el texto en dos líneas: la variante
// compacta de una línea no entra, pero dos renglones sí, y da más tamaño.
const narrow = layoutDimensions(ctx, spec(40, 600), 40 - paddingFor(40, 600) * 2, 600 - paddingFor(40, 600) * 2);
check('la angosta se parte en dos líneas', (narrow?.lines.length ?? 0) > 1, `→ ${narrow?.lines.length} línea(s)`);
check('y a mayor tamaño que en una línea', (narrow?.fontSize ?? 0) > 8);
console.log(`\n40x600 → ${narrow ? narrow.lines.join(' / ') : 'sin layout'} a ${narrow?.fontSize.toFixed(1)}px`);

// Un bannerPanorámico ancho, en cambio, va comfortable en una línea.
const banner = layoutDimensions(ctx, spec(728, 90), 728 - paddingFor(728, 90) * 2, 90 - paddingFor(728, 90) * 2);
check('un banner ancho va en una línea', banner?.lines.length === 1, `→ ${banner?.lines.length} línea(s)`);
console.log(`728x90 → ${banner?.lines.join(' / ')} a ${banner?.fontSize.toFixed(1)}px`);

// El reloj también tiene que entrar y devolver null si no cabe.
const clock = layoutLine(ctx, '0:03 / 0:10', 200, 30, { minFontSize: 7, maxFontSize: 22 });
check('el reloj entra', clock !== null);
const tooSmall = layoutLine(ctx, '0:03 / 0:10', 8, 4, { minFontSize: 7, maxFontSize: 22 });
check('el reloj devuelve null si no cabe', tooSmall === null);
console.log(`reloj a ${clock?.fontSize.toFixed(1)}px`);

console.log(fails === 0 ? '\n✔ auto-ajuste OK' : `\n✘ ${fails} fallo(s)`);
process.exit(fails === 0 ? 0 : 1);
