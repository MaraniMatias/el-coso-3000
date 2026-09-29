/**
 * Verification of the text auto-fit.
 *
 * Runs: `bun run check:fit`
 *
 * Bun has no Canvas, so a fake context that models the font metrics is used.
 * It is not the real font, but it reproduces its essential behavior: the width
 * grows with the size and is proportional to the number of characters.
 */
import { layoutDimensions, layoutLine, clampMaxFont, paddingFor, MAX_SIDE_RATIO } from '../src/core/fit-text';
import { frameGeometry } from '../src/core/draw-frame';
import type { Spec } from '../src/core/types';

const ADVANCE = 0.58; // average width per character, in em
const SPACE = 0.28;
const ASCENT = 0.72;
const DESCENT = 0.22;

type Metrics = TextMetrics;

function fakeMetrics(text: string, size: number): Metrics {
  let em = 0;
  for (const ch of text) em += ch === ' ' || ch === ' ' ? SPACE : ADVANCE;
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

console.log('width     height   font    lines  shrunk  fits');
console.log('─'.repeat(56));

for (const [w, h] of CASES) {
  const s = spec(w, h);
  // The same limits `drawFrame` uses.
  const pad = paddingFor(w, h);
  const maxW = Math.max(1, w - pad * 2);
  const maxH = Math.max(1, h - pad * 2);
  const layout = layoutDimensions(ctx, s, maxW, maxH);

  if (!layout) {
    // No layout is only acceptable on tiny images.
    if (Math.min(w, h) > 16) {
      fails++;
      console.log(`  ✘ ${w}x${h} without layout`);
    }
    console.log(`${String(w).padEnd(10)}${String(h).padEnd(8)}—`);
    continue;
  }

  const cap = clampMaxFont(w, h);
  const fits = layout.width <= maxW && layout.height <= maxH;
  // The text is never allowed to take more than 60% of the shortest side.
  const side = Math.min(w, h) * MAX_SIDE_RATIO;
  const within = layout.width <= side + 0.5 && layout.height <= side + 0.5;
  check(`${w}x${h} fits`, fits, `(${layout.width.toFixed(1)}x${layout.height.toFixed(1)} in ${maxW.toFixed(1)}x${maxH.toFixed(1)})`);
  check(`${w}x${h} under the ceiling`, layout.fontSize <= cap + 0.5, `(${layout.fontSize.toFixed(1)} > ${cap})`);
  check(`${w}x${h} never bigger than the image`, layout.fontSize <= Math.min(w, h));
  check(`${w}x${h} within 60% of the shortest side`, within, `(${layout.width.toFixed(1)}x${layout.height.toFixed(1)} in ${side.toFixed(1)})`);

  console.log(
    `${String(w).padEnd(10)}${String(h).padEnd(8)}${layout.fontSize.toFixed(1).padStart(5)}  ` +
      `${String(layout.lines.length).padStart(5)}  ${(layout.shrunk ? 'yes' : 'no').padEnd(8)}  ${fits ? 'yes' : 'NO'}`,
  );
}

// The font size has to GROW with the image. This is what a subagent found
// broken: everything stayed at 10px.
console.log('\nmonotonicity of the font size:');
const ladder: Array<[number, number]> = [[64, 64], [128, 128], [256, 256], [512, 512], [1024, 1024], [1920, 1080]];
const sizes = ladder.map(([w, h]) => layoutDimensions(ctx, spec(w, h), w, h)?.fontSize ?? 0);
ladder.forEach(([w, h], i) => console.log(`  ${w}x${h}`.padEnd(14) + (sizes[i]?.toFixed(1) ?? '—')));
let monotonic = true;
for (let i = 1; i < sizes.length; i++) {
  if (sizes[i]! <= sizes[i - 1]!) monotonic = false;
}
check('the size grows with the image', monotonic, `→ ${sizes.map((s) => s?.toFixed(1)).join(' ')}`);
console.log(monotonic ? '  ✔ grows' : '  ✘ does not grow');

// A narrow image forces the text to break into two lines: the compact one-line
// variant does not fit, but two lines do, and they give a bigger size.
const narrow = layoutDimensions(ctx, spec(40, 600), 40 - paddingFor(40, 600) * 2, 600 - paddingFor(40, 600) * 2);
check('the narrow one breaks into two lines', (narrow?.lines.length ?? 0) > 1, `→ ${narrow?.lines.length} line(s)`);
check('and at a bigger size than in one line', (narrow?.fontSize ?? 0) > 8);
console.log(`\n40x600 → ${narrow ? narrow.lines.join(' / ') : 'no layout'} at ${narrow?.fontSize.toFixed(1)}px`);

// A wide banner, on the other hand, comfortably fits in one line.
const banner = layoutDimensions(ctx, spec(728, 90), 728 - paddingFor(728, 90) * 2, 90 - paddingFor(728, 90) * 2);
check('a wide banner goes in one line', banner?.lines.length === 1, `→ ${banner?.lines.length} line(s)`);
console.log(`728x90 → ${banner?.lines.join(' / ')} at ${banner?.fontSize.toFixed(1)}px`);

// The clock also has to fit, and return null when it does not.
const clock = layoutLine(ctx, '0:03 / 0:10', 200, 30, { minFontSize: 7, maxFontSize: 22 });
check('the clock fits', clock !== null);
const tooSmall = layoutLine(ctx, '0:03 / 0:10', 8, 4, { minFontSize: 7, maxFontSize: 22 });
check('the clock returns null when it does not fit', tooSmall === null);
console.log(`clock at ${clock?.fontSize.toFixed(1)}px`);

// ── The bottom strip scales with the video ─────────────────────────────
// The bar is 1.2% of the height and the clock 3.5% of the shortest side, with
// a floor so that they are still there on a tiny canvas. The two ratios are the
// contract: the strip has to keep the same proportion at every size.
console.log('\nbottom strip: bar and clock');
const BAR_RATIO = 0.012;
const BAR_MIN = 1;
const TIME_RATIO = 0.035;
const TIME_MIN = 6;
const videoLadder: Array<[number, number]> = [
  [32, 32], [64, 64], [320, 240], [640, 360], [1280, 720], [1920, 1080], [3840, 2160],
];
for (const [w, h] of videoLadder) {
  const geo = frameGeometry({ ...spec(w, h), showProgressBar: true, showTime: true });
  const barWanted = Math.max(BAR_MIN, h * BAR_RATIO);
  const timeWanted = Math.max(TIME_MIN, Math.min(w, h) * TIME_RATIO);
  check(
    `${w}x${h} bar is 1.2% of the height`,
    Math.abs(geo.barHeight - barWanted) <= 0.5,
    `(${geo.barHeight}px, wanted ${barWanted.toFixed(2)})`,
  );
  check(
    `${w}x${h} clock is 3.5% of the shortest side`,
    Math.abs(geo.timeFontSize - timeWanted) <= 0.5,
    `(${geo.timeFontSize}px, wanted ${timeWanted.toFixed(2)})`,
  );
  check(`${w}x${h} strip is never invisible`, geo.barHeight >= BAR_MIN && geo.timeFontSize >= TIME_MIN);
  // A 32x32 video cannot hold a bar and a readable clock in proportion, so the
  // floors win there. The only hard rule is that the dimensions keep their
  // room; the proportional share is only expected once the floors let go.
  check(
    `${w}x${h} strip leaves room for the dimensions`,
    geo.stripHeight < h / 3,
    `strip ${geo.stripHeight}px of ${h}`,
  );
  if (h * BAR_RATIO >= BAR_MIN && Math.min(w, h) * TIME_RATIO >= TIME_MIN) {
    check(
      `${w}x${h} strip holds its proportional share`,
      geo.stripHeight <= h * 0.07,
      `strip ${geo.stripHeight}px (${(geo.stripHeight / h * 100).toFixed(2)}% of ${h})`,
    );
  }
  console.log(
    `  ${`${w}x${h}`.padEnd(11)} bar ${String(geo.barHeight).padStart(3)}px ` +
      `(${(geo.barHeight / h * 100).toFixed(2)}%)  clock ${String(geo.timeFontSize).padStart(3)}px ` +
      `(${(geo.timeFontSize / Math.min(w, h) * 100).toFixed(2)}%)  strip ${geo.stripHeight}px`,
  );
}

// And it grows with the video, which is the whole point of using ratios.
const strips = videoLadder.map(([w, h]) => frameGeometry({ ...spec(w, h), showProgressBar: true, showTime: true }));
let stripGrows = true;
for (let i = 1; i < strips.length; i++) {
  if ((strips[i]?.barHeight ?? 0) < (strips[i - 1]?.barHeight ?? 0)) stripGrows = false;
  if ((strips[i]?.timeFontSize ?? 0) < (strips[i - 1]?.timeFontSize ?? 0)) stripGrows = false;
}
check('the strip grows with the video', stripGrows, `→ ${strips.map((g) => g?.barHeight + '/' + g?.timeFontSize).join(' ')}`);

console.log(fails === 0 ? '\n✔ auto-fit OK' : `\n✘ ${fails} failure(s)`);
process.exit(fails === 0 ? 0 : 1);
