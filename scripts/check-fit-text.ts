/**
 * Verification of the text auto-fit.
 *
 * Runs: `bun run check:fit`
 *
 * Bun has no Canvas, so a fake context that models the font metrics is used.
 * It is not the real font, but it reproduces its essential behavior: the width
 * grows with the size and is proportional to the number of characters.
 */
import { ABSOLUTE_FLOOR, layoutDimensions, layoutLine, paddingFor, MAX_BLOCK_H, MAX_BLOCK_W } from '../src/core/fit-text';
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

  // The only limit is the area it is given: it fills it and never overflows.
  const fits = layout.width <= maxW && layout.height <= maxH;
  check(`${w}x${h} fits`, fits, `(${layout.width.toFixed(1)}x${layout.height.toFixed(1)} in ${maxW.toFixed(1)}x${maxH.toFixed(1)})`);
  check(`${w}x${h} never bigger than the image`, layout.fontSize <= Math.min(w, h));
  // The dimensions are never split across lines.
  check(`${w}x${h} stays in one line`, layout.lines.length === 1, `→ ${layout.lines.length} line(s)`);

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

// A narrow format keeps the text on ONE line: it is never split, the compact
// `×h` form simply scales to whatever fits. 70% of the width is not enough
// here, so the width is given back up to the legibility floor and no further.
const narrow = layoutDimensions(ctx, spec(40, 600), 40 - paddingFor(40, 600) * 2, 600 - paddingFor(40, 600) * 2);
check('the narrow one stays in one line', narrow?.lines.length === 1, `→ ${narrow?.lines.length} line(s)`);
// At 40px wide the label is 34.8px at the 10px floor but only 33.6px are left
// after the padding, so the floor is geometrically unreachable here. The width
// cap is still given back (the text uses the whole usable width instead of
// 70% of it), and not overflowing beats reaching the floor.
const narrowUsable = 40 - paddingFor(40, 600) * 2;
check(
  'the width cap is given back rather than obeyed',
  (narrow?.width ?? 0) > narrowUsable * MAX_BLOCK_W,
  `(${narrow?.width.toFixed(1)}px of ${narrowUsable.toFixed(1)}px usable, cap was ${(narrowUsable * MAX_BLOCK_W).toFixed(1)}px)`,
);
check(
  'and it still never overflows',
  (narrow?.width ?? 0) <= narrowUsable + 0.5,
  `(${narrow?.width.toFixed(1)}px of ${narrowUsable.toFixed(1)}px)`,
);
check(
  'so the floor yields only when it cannot fit',
  (narrow?.fontSize ?? 0) >= ABSOLUTE_FLOOR - 1,
  `→ ${narrow?.fontSize.toFixed(1)}px, floor is ${ABSOLUTE_FLOOR}px`,
);
console.log(`\n40x600 → ${narrow ? narrow.lines.join(' / ') : 'no layout'} at ${narrow?.fontSize.toFixed(1)}px`);

// The wide banners that used to be squeezed: every one of them must now be a
// single line that scales with its height, inside the 70%/60% box.
console.log('\nbanners that used to break or shrink:');
const BANNERS: Array<[number, number]> = [[320, 50], [468, 60], [728, 90], [970, 90], [320, 100]];
for (const [w, h] of BANNERS) {
  const pad = paddingFor(w, h);
  const usableW = w - pad * 2;
  const usableH = h - pad * 2;
  const L = layoutDimensions(ctx, spec(w, h), usableW, usableH);
  // Before the fix these sat at 10-14px, crushed by the 60% square and by the
  // 0.14 ceiling on the shortest side.
  check(`${w}x${h} is one line`, L?.lines.length === 1, `→ ${L?.lines.length} line(s)`);
  check(`${w}x${h} scales with its height`, (L?.fontSize ?? 0) > h * 0.3, `→ ${L?.fontSize.toFixed(1)}px of ${h}px`);
  // It grows to fill its box without crossing the two limits.
  check(
    `${w}x${h} stays within 70% of the width`,
    (L?.width ?? 0) <= usableW * MAX_BLOCK_W + 0.5,
    `(${L?.width.toFixed(1)}px in ${(usableW * MAX_BLOCK_W).toFixed(1)}px)`,
  );
  check(
    `${w}x${h} stays within 60% of the height`,
    (L?.height ?? 0) <= usableH * MAX_BLOCK_H + 0.5,
    `(${L?.height.toFixed(1)}px in ${(usableH * MAX_BLOCK_H).toFixed(1)}px)`,
  );
  // And it uses the height it is allowed, otherwise the cap is too timid.
  check(
    `${w}x${h} uses the height it has`,
    (L?.height ?? 0) > usableH * MAX_BLOCK_H * 0.9,
    `→ ${L?.height.toFixed(1)}px of ${(usableH * MAX_BLOCK_H).toFixed(1)}px`,
  );
  console.log(
    `  ${`${w}x${h}`.padEnd(10)} ${L ? `${L.fontSize.toFixed(1)}px  ${L.lines.join('')}` : 'no layout'}`,
  );
}

// The clock also has to fit, and return null when it does not.
const clock = layoutLine(ctx, '0:03 / 0:10', 200, 30, { minFontSize: 7, maxFontSize: 22 });
check('the clock fits', clock !== null);
const tooSmall = layoutLine(ctx, '0:03 / 0:10', 8, 4, { minFontSize: 7, maxFontSize: 22 });
check('the clock returns null when it does not fit', tooSmall === null);
console.log(`clock at ${clock?.fontSize.toFixed(1)}px`);

// ── The bottom strip scales with the video ─────────────────────────────
// The bar is 1.2% of the height and the clock 3.5% of the shortest side, each
// with a floor (2px and 10px) so they stay visible on a short banner. Neither
// is allowed to take more than a quarter of the height: the dimensions are the
// subject of the image, so the strip yields when there is no room.
console.log('\nbottom strip: bar and clock');
const BAR_RATIO = 0.012;
const BAR_MIN = 2;
const TIME_RATIO = 0.035;
const TIME_MIN = 10;
const MAX_STRIP_RATIO = 0.35;
const videoLadder: Array<[number, number]> = [
  [32, 32], [64, 64], [320, 240], [320, 100], [468, 60], [728, 90], [640, 360],
  [1280, 720], [1920, 1080], [3840, 2160],
];
for (const [w, h] of videoLadder) {
  const geo = frameGeometry({ ...spec(w, h), showProgressBar: true, showTime: true });
  const barWanted = Math.max(BAR_MIN, h * BAR_RATIO);
  const timeWanted = Math.max(TIME_MIN, Math.min(w, h) * TIME_RATIO);
  // The floors and the 25% cap both override the ratio, so the ratio is only
  // the expected value where neither of them is the binding rule.
  const capped = barWanted + timeWanted * 1.5 > h * MAX_STRIP_RATIO;
  check(
    `${w}x${h} bar is 1.2% of the height`,
    capped || Math.abs(geo.barHeight - barWanted) <= 0.5,
    `(${geo.barHeight}px, wanted ${barWanted.toFixed(2)})`,
  );
  check(
    `${w}x${h} clock is 3.5% of the shortest side`,
    capped || Math.abs(geo.timeFontSize - timeWanted) <= 0.5,
    `(${geo.timeFontSize}px, wanted ${timeWanted.toFixed(2)})`,
  );
  // The strip always leaves the dimensions most of the canvas.
  check(
    `${w}x${h} strip leaves room for the dimensions`,
    geo.stripHeight <= h * MAX_STRIP_RATIO + 0.01,
    `strip ${geo.stripHeight.toFixed(1)}px of ${h}`,
  );
  // Neither the bar nor the clock may vanish, whatever the cap does.
  check(
    `${w}x${h} bar and clock are still visible`,
    geo.barHeight >= BAR_MIN - 0.5 && (geo.timeFontSize > 0),
    `(bar ${geo.barHeight}px, clock ${geo.timeFontSize.toFixed(1)}px)`,
  );
  console.log(
    `  ${`${w}x${h}`.padEnd(11)} bar ${geo.barHeight.toFixed(1).padStart(5)}px ` +
      `(${((geo.barHeight / h) * 100).toFixed(2)}%)  clock ${geo.timeFontSize.toFixed(1).padStart(5)}px ` +
      `(${((geo.timeFontSize / Math.min(w, h)) * 100).toFixed(2)}%)  strip ${geo.stripHeight.toFixed(1)}px ` +
      `(${(capped ? 'capped' : `${((geo.stripHeight / h) * 100).toFixed(2)}%`)})`,
  );
}

// A short banner is the case that used to look wrong: a 1px bar and a 6px
// clock next to 70px of dimensions.
console.log('\nshort banners keep a readable strip:');
for (const [w, h] of [[320, 100], [468, 60], [728, 90], [320, 50]] as Array<[number, number]>) {
  const geo = frameGeometry({ ...spec(w, h), showProgressBar: true, showTime: true });
  check(`${w}x${h} bar is at least 2px`, geo.barHeight >= 2, `→ ${geo.barHeight}px`);
  check(`${w}x${h} clock is at least 10px`, geo.timeFontSize >= 10 - 0.01, `→ ${geo.timeFontSize.toFixed(1)}px`);
  console.log(`  ${`${w}x${h}`.padEnd(11)} bar ${geo.barHeight}px  clock ${geo.timeFontSize.toFixed(1)}px`);
}

// And it grows with the video, which is the whole point of using ratios.
const strips = [[320, 240], [640, 360], [1280, 720], [1920, 1080], [3840, 2160]].map(
  ([w, h]) => frameGeometry({ ...spec(w!, h!), showProgressBar: true, showTime: true }),
);
let stripGrows = true;
for (let i = 1; i < strips.length; i++) {
  if ((strips[i]?.barHeight ?? 0) < (strips[i - 1]?.barHeight ?? 0)) stripGrows = false;
  if ((strips[i]?.timeFontSize ?? 0) < (strips[i - 1]?.timeFontSize ?? 0)) stripGrows = false;
}
check('the strip grows with the video', stripGrows, `→ ${strips.map((g) => g?.barHeight + '/' + g?.timeFontSize).join(' ')}`);

console.log(fails === 0 ? '\n✔ auto-fit OK' : `\n✘ ${fails} failure(s)`);
process.exit(fails === 0 ? 0 : 1);
