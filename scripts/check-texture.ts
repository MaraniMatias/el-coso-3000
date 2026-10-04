/**
 * Texture verification.
 *
 * Run: `bun run scripts/check-texture.ts`
 *
 * The textures are half composition and half painting. This verifies the
 * composition, which is pure data: the same seed has to give the same layout
 * every time, the orbs have to stay where the demo puts them, and the tones
 * have to be mixes of the two colors the user chose.
 *
 * The painting needs a canvas, so it is verified where a canvas exists: in the
 * browser, by `scripts/verify-browser.ts`.
 *
 * Fails (exit 1) if anything is wrong.
 */
import {
  buildTexturePlan,
  mixTone,
  ORB_COUNT,
  RISE_TOTAL,
  type Rgb,
} from '../src/core/texture';
import {
  DEFAULT_IMAGE_TEXTURE,
  DEFAULT_TEXTURE_SPEED,
  DEFAULT_VIDEO_TEXTURE,
  TEXTURES,
  TEXTURE_SPEEDS,
  type Texture,
} from '../src/core/types';

let failures = 0;

function check(ok: boolean, label: string, detail = ''): void {
  if (!ok) failures++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${label}${detail && !ok ? `\n        ${detail}` : ''}`);
}

function section(title: string): void {
  console.log(`\n${title}`);
}

/** The palette of the tests: a light background and a dark text. */
const BG = 'F0EDEB';
const FG = '5B544D';

const textures = TEXTURES.filter((t): t is Texture => t !== 'none');

section('the texture list');
check(textures.length === 4, 'there are four textures besides the flat one', `${textures.length}`);
check(TEXTURES[0] === 'none', '`none` is the flat background', TEXTURES[0]);

section('every effect builds a plan of the expected shape');
for (const effect of textures) {
  const plan = buildTexturePlan(effect, BG, FG);
  const orbs = plan.orbs.length;
  const rises = plan.rises.length;
  const expectedRises = effect === 'rise' ? RISE_TOTAL : 0;
  const expectedOrbs = effect === 'rise' ? 0 : ORB_COUNT[effect];
  check(orbs === expectedOrbs, `${effect}: ${expectedOrbs} orbs`, `got ${orbs}`);
  check(rises === expectedRises, `${effect}: ${expectedRises} rising spheres`, `got ${rises}`);
  check(
    orbs + rises > 0 && plan.grain > 0,
    `${effect}: something is drawn and it carries grain`,
    `grain ${plan.grain}`,
  );
  check(
    plan.vignette === (effect === 'focus'),
    `${effect}: the vignette is ${effect === 'focus' ? 'on' : 'off'}`,
  );
}

const flat = buildTexturePlan('none', BG, FG);
check(
  flat.orbs.length === 0 && flat.rises.length === 0 && flat.grain === 0,
  'the flat background has no plan at all',
  JSON.stringify(flat),
);

section('the same settings always give the same texture');
for (const effect of textures) {
  const a = buildTexturePlan(effect, BG, FG);
  const b = buildTexturePlan(effect, BG, FG);
  check(JSON.stringify(a) === JSON.stringify(b), `${effect} is deterministic`);
}

section('the orbs stay inside the frame and inside their own range');
for (const effect of textures) {
  const plan = buildTexturePlan(effect, BG, FG);
  // A rising sphere has no place to be: it starts below the frame, so only its
  // horizontal position and its size are constrained.
  const shapes: Array<{ x: number; y?: number; size: number; blur: number; opacity: number }> = [
    ...plan.orbs,
    ...plan.rises,
  ];
  const outside = shapes.filter(
    (s) => s.x < 0 || s.x > 1 || (s.y !== undefined && (s.y < 0 || s.y > 1)) || s.size <= 0 || s.size > 1,
  );
  check(outside.length === 0, `${effect}: every shape has a position and a size`, `${outside.length} bad`);

  const blurred = shapes.filter((s) => s.blur <= 0 || s.opacity <= 0 || s.opacity > 1);
  check(blurred.length === 0, `${effect}: every shape is visible and blurred`, `${blurred.length} bad`);

  // The demo places an orb so that it never starts entirely off the frame, and
  // its biggest amplitude is 140% of the orb's own size.
  const misplaced = plan.orbs.filter((o) => o.x > 1 - o.size * 0.6 + 1e-9 || o.y > 1 - o.size * 0.6 + 1e-9);
  check(misplaced.length === 0, `${effect}: every sphere starts inside the frame`, `${misplaced.length} bad`);
  const wild = plan.orbs.filter((o) => o.ax > 1.5 || o.ay > 1.5);
  check(wild.length === 0, `${effect}: no sphere drifts more than 1.5 of its size`, `${wild.length} bad`);
}

section('the periods are the demo periods, at the speed asked for');
// The demo's orbs take 22s to 36s per sweep, scaled by 0.7 to 1.3 for their
// size, and the app divides all of it by the speed that was chosen.
const periodsAt = (speed: number) => {
  const plan = buildTexturePlan('mix', BG, FG, speed);
  return [...plan.orbs.map((o) => o.periodX), ...plan.orbs.map((o) => o.periodY)];
};
const periods = periodsAt(DEFAULT_TEXTURE_SPEED);
const slowest = Math.max(...periods);
const fastest = Math.min(...periods);
check(
  fastest >= (22 * 0.7) / DEFAULT_TEXTURE_SPEED - 1e-9 &&
    slowest <= (36 * 1.3) / DEFAULT_TEXTURE_SPEED + 1e-9,
  'every sweep is a demo period divided by the speed',
  `${fastest.toFixed(2)}s .. ${slowest.toFixed(2)}s`,
);
check(
  periods.every(
    (p) =>
      Math.abs(p * DEFAULT_TEXTURE_SPEED - Math.round(p * DEFAULT_TEXTURE_SPEED)) < 1e-9,
  ),
  'and it is a whole number of demo seconds on top of that',
);

section('the speed divides every period, and nothing else');
// The composition comes out of the seed and does not depend on the speed, so
// the same texture has to be the same picture played faster or slower.
const base = periodsAt(1);
const geometry = (speed: number) =>
  buildTexturePlan('mix', BG, FG, speed).orbs.map((o) => [o.x, o.y, o.size, o.color.join()]);
for (const speed of TEXTURE_SPEEDS) {
  // 0 is not a speed, it is the absence of one: an infinite period leaves every
  // sphere exactly where it started, which is the one thing it must not share
  // with the moving ones.
  if (speed === 0) continue;
  const at = periodsAt(speed);
  // The period is the demo's divided by the speed, so 2x is half the time for
  // the same sweep: the ratio is 1/speed, and that is what "2x faster" means.
  const ratio = base.map((p, i) => p / at[i]!);
  check(
    ratio.every((r) => Math.abs(r - speed) < 1e-9),
    `${speed}x takes 1/${speed} of the time of 1x for the same sweep`,
    `ratio ${ratio[0]?.toFixed(3)}`,
  );
  check(
    JSON.stringify(geometry(speed)) === JSON.stringify(geometry(1)),
    `${speed}x does not move a single sphere`,
  );
}
check(
  periodsAt(0).every((p) => p === Number.POSITIVE_INFINITY),
  '0x holds every animation, so the texture is painted and never moves',
);
check(
  DEFAULT_TEXTURE_SPEED === 2 && TEXTURE_SPEEDS.join() === '0,1,1.5,2,2.5,3',
  'the speeds run from 0 to 3, and 2 is the one asked for by default',
  `${TEXTURE_SPEEDS.join()} / default ${DEFAULT_TEXTURE_SPEED}`,
);
check(
  DEFAULT_IMAGE_TEXTURE === 'fog' && DEFAULT_VIDEO_TEXTURE === 'mix',
  'an image starts on fog and a video on bokeh',
  `${DEFAULT_IMAGE_TEXTURE} / ${DEFAULT_VIDEO_TEXTURE}`,
);

section('the tones are mixes of the two colors, and never anything else');
const bgc: Rgb = [240, 237, 235];
const fgc: Rgb = [91, 84, 77];
check(
  mixTone(0, BG, FG).join() === bgc.join(),
  'a tone of 0 is the background itself',
  mixTone(0, BG, FG).join(),
);
check(
  mixTone(1, BG, FG).join() === fgc.join(),
  'a tone of 1 is the text color',
  mixTone(1, BG, FG).join(),
);
check(mixTone(0.5, BG, FG).join() === '166,161,156', 'halfway is halfway', mixTone(0.5, BG, FG).join());
check(mixTone(-1, BG, FG).join() === '255,255,255', 'a negative tone goes to white', mixTone(-1, BG, FG).join());

for (const effect of textures) {
  const plan = buildTexturePlan(effect, BG, FG);
  const tones = [...plan.orbs, ...plan.rises].map((s) => s.color);
  const outside = tones.filter((color) =>
    color.some((c, i) => c < Math.min(bgc[i]!, fgc[i]!) - 1 || c > Math.max(bgc[i]!, fgc[i]!) + 1),
  );
  check(
    outside.length === 0,
    `${effect}: every tone sits between the background and the text color`,
    `${outside.length} outside: ${outside[0]?.join() ?? ''}`,
  );
}

section('a different background gives a different texture');
const reference = buildTexturePlan('mix', BG, FG);
const other = buildTexturePlan('mix', 'DBEAFE', '1E40AF');
check(
  JSON.stringify(other) !== JSON.stringify(reference),
  'the colors reach the plan, so the texture follows the palette',
);
check(
  reference.orbs.every((o, i) => o.color.join() !== other.orbs[i]!.color.join()),
  'and every orb is tinted with them',
);

console.log(failures === 0 ? '\n✔ texture OK' : `\n✘ ${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);
