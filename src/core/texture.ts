/**
 * Animated textured backgrounds, the canvas port of the CSS demo in `docs/`.
 *
 * The demo paints its background with DOM elements: blurred circles moved by
 * CSS animations, a `radial-gradient` vignette and an SVG `feTurbulence` grain
 * tile. Nothing here is drawn with CSS, because the exporters paint on a
 * canvas and a canvas has no DOM behind it. So the composition is computed as
 * data first (`buildTexturePlan`, pure, testable without a browser) and then
 * painted (`paintTexture`).
 *
 * The two halves cannot drift: the plan holds the same seed, the same orb
 * tables and the same periods as the demo, so the texture here is the same
 * texture, painted with a radial gradient instead of a `filter: blur`.
 */
import { hexToRgb } from './color';
import { DEFAULT_TEXTURE_SPEED, type Spec, type Texture } from './types';

/**
 * Fixed seed, so the same `Spec` always draws the same texture. A video needs
 * it: frames have to line up with each other, and re-exporting the same
 * settings has to give the same file.
 */
const SEED = 1;

/** Longest side of the offscreen the orbs are composed on. */
const ORB_SURFACE_MAX = 640;

/**
 * Grain tile, in px. Grain is a film property, not a layout one: it does not
 * grow with the frame.
 */
const GRAIN_TILE = 160;

/** Grain step, in seconds, from the demo's `.9s steps(1)` cycle. */
const GRAIN_STEP = 0.9 / 5;

/** Grain offsets, in tile px, one per step. */
const GRAIN_OFFSETS: ReadonlyArray<readonly [number, number]> = [
  [0, 0],
  [-40, 30],
  [50, -20],
  [-30, -50],
  [60, 40],
];

/** `rgb` triplet, 0..255. */
export type Rgb = readonly [number, number, number];

/**
 * Frame width the demo's pixel lengths are written for: a column of its grid is
 * about 640px wide, and the CSS blur it uses is in absolute pixels.
 *
 * Everything in px is scaled by the frame's width over this, so a 40px blur is
 * the same share of the frame at 320px and at 4096px. Without it a small frame
 * would be blurred into a single flat color and a big one would look sharp.
 */
const REFERENCE_WIDTH = 640;

// ── Planning ───────────────────────────────────────────────────────────────

/** One blurred sphere drifting over the frame. */
export interface Orb {
  /** Center, as a share of the frame's width and height. */
  x: number;
  y: number;
  /** Diameter, as a share of the frame's width. */
  size: number;
  color: Rgb;
  /** Drift of the center, as a share of the orb's own size, like a CSS
   * percentage translate. */
  ax: number;
  ay: number;
  /** Opacity at the center, falling to 0 at the blur's edge. */
  opacity: number;
  /** Blur radius in px on a 640px frame; scaled to the real one. */
  blur: number;
  /** Period of each animation, in seconds. */
  periodX: number;
  periodY: number;
  /** Breathing period of the radius, in seconds. */
  periodB: number;
  /** Where each animation starts, as a fraction of its own period. */
  phaseX: number;
  phaseY: number;
  phaseB: number;
}

/** One sphere rising from the bottom edge and fading out. */
export interface Rise {
  /** Center, as a share of the frame's width. */
  x: number;
  /** Diameter, as a share of the frame's width. */
  size: number;
  color: Rgb;
  opacity: number;
  blur: number;
  /** Sideways slide in px on a 640px frame. */
  drift: number;
  /** Period of the whole rise, in seconds. */
  period: number;
  /** Where it starts, as a fraction of its own period. */
  phase: number;
}

/** Everything one frame of a texture is made of. */
export interface TexturePlan {
  orbs: Orb[];
  rises: Rise[];
  /** Alpha of the grain layer: 0.3, or 0.4 for `fog`. */
  grain: number;
  /** `true` for `focus`, the one effect with a vignette. */
  vignette: boolean;
}

/** Linear interpolation between two numbers. */
function lerp(a: number, b: number, k: number): number {
  return a + (b - a) * k;
}

/**
 * A period in seconds. The demo divides its periods by the speed through a CSS
 * custom property, which is the same thing done in one place.
 *
 * @param speed multiple of the demo's own timing. `0` holds the animation: an
 * infinite period leaves every sphere at the phase it started with, which is a
 * texture that is painted and never moves.
 */
function period(seconds: number, speed: number): number {
  return speed > 0 ? Math.max(0.05, seconds / speed) : Number.POSITIVE_INFINITY;
}

/** The demo's own PRNG, so the layout of the texture is the demo's layout. */
function rng(seed: number): () => number {
  let s = seed % 2147483647;
  if (s <= 0) s += 2147483646;
  return () => {
    s = (s * 16807) % 2147483647;
    return s / 2147483647;
  };
}

/**
 * The mix between the background and the text color: `0` is the background,
 * `1` the text, negative values head to white. This is `color-mix` in sRGB.
 */
export function mixTone(t: number, bg: string, fg: string): Rgb {
  const b = hexToRgb(bg);
  const to = t < 0 ? { r: 255, g: 255, b: 255 } : hexToRgb(fg);
  const k = Math.abs(t);
  return [
    Math.round(lerp(b.r, to.r, k)),
    Math.round(lerp(b.g, to.g, k)),
    Math.round(lerp(b.b, to.b, k)),
  ] as const;
}

/** Shared parameters of a family of orbs, straight from the demo's tables. */
interface OrbSpec {
  count: number;
  /** Offset of the family's own seed. */
  seed: number;
  smin: number;
  smax: number;
  tmin: number;
  tmax: number;
  bmin: number;
  bmax: number;
  omin: number;
  omax: number;
  amin: number;
  amax: number;
  dmin: number;
  dvar: number;
}

/** Big soft blobs behind, small bokeh spheres in front. */
const MIX_BACK: OrbSpec = { count: 3, seed: 5, smin: 55, smax: 80, tmin: 0.12, tmax: 0.35, bmin: 40, bmax: 56, omin: 0.5, omax: 0.75, amin: 30, amax: 70, dmin: 22, dvar: 14 };
const MIX_FRONT: OrbSpec = { count: 6, seed: 13, smin: 24, smax: 42, tmin: 0.3, tmax: 0.6, bmin: 16, bmax: 28, omin: 0.5, omax: 0.85, amin: 35, amax: 85, dmin: 14, dvar: 12 };
/** Huge and very slow. */
const FOG: OrbSpec = { count: 4, seed: 21, smin: 70, smax: 100, tmin: 0.1, tmax: 0.5, bmin: 50, bmax: 70, omin: 0.5, omax: 0.8, amin: 25, amax: 55, dmin: 30, dvar: 16 };
/** Few small spheres, and a vignette over them. */
const FOCUS: OrbSpec = { count: 7, seed: 17, smin: 14, smax: 30, tmin: 0.3, tmax: 0.6, bmin: 10, bmax: 18, omin: 0.45, omax: 0.85, amin: 60, amax: 140, dmin: 14, dvar: 10 };

const ORBS: Partial<Record<Texture, readonly OrbSpec[]>> = {
  mix: [MIX_BACK, MIX_FRONT],
  fog: [FOG],
  focus: [FOCUS],
};

/** Spheres in the `rise` effect. */
const RISE_COUNT = 10;

/** How many orbs each effect has, checked by `scripts/check-texture.ts`. */
export const ORB_COUNT: Readonly<Record<Texture, number>> = {
  none: 0,
  mix: MIX_BACK.count + MIX_FRONT.count,
  fog: FOG.count,
  focus: FOCUS.count,
  rise: 0,
};

/** How many spheres rise in the `rise` effect. */
export const RISE_TOTAL = RISE_COUNT;

/**
 * Builds the plan of one frame of a texture.
 *
 * It takes `bg`/`fg` as plain hex so the result can be inspected without a
 * `Spec`: the caller is the one deciding whether the format carries a texture
 * at all.
 */
export function buildTexturePlan(
  effect: Texture,
  bg: string,
  fg: string,
  speed: number = DEFAULT_TEXTURE_SPEED,
): TexturePlan {
  // The flat background paints nothing: no orbs, no grain. It is not a
  // texture that happens to be empty.
  if (effect === 'none') return { orbs: [], rises: [], grain: 0, vignette: false };
  const plan: TexturePlan = { orbs: [], rises: [], grain: 0.3, vignette: false };
  if (effect === 'rise') {
    plan.rises = rises(bg, fg, speed);
    return plan;
  }
  for (const group of ORBS[effect] ?? []) {
    plan.orbs.push(...orbs(group, bg, fg, speed));
  }
  if (effect === 'fog') plan.grain = 0.4;
  if (effect === 'focus') plan.vignette = true;
  return plan;
}

function orbs(spec: OrbSpec, bg: string, fg: string, speed: number): Orb[] {
  const r = rng(SEED + spec.seed);
  const out: Orb[] = [];
  for (let i = 0; i < spec.count; i++) {
    const size = lerp(spec.smin, spec.smax, r());
    // Bigger spheres drift slower, so the back layer reads as further away.
    const depth = size / spec.smax;
    const k = 0.7 + depth * 0.6;
    out.push({
      x: r() * (1 - (size / 100) * 0.6),
      y: r() * (1 - (size / 100) * 0.6),
      size: size / 100,
      color: mixTone(lerp(spec.tmin, spec.tmax, r()), bg, fg),
      ax: lerp(spec.amin, spec.amax, r()) / 100,
      ay: lerp(spec.amin, spec.amax, r()) / 100,
      opacity: lerp(spec.omin, spec.omax, r()),
      blur: lerp(spec.bmin, spec.bmax, r()),
      periodX: period(Math.round((spec.dmin + r() * spec.dvar) * k), speed),
      periodY: period(Math.round((spec.dmin + 4 + r() * spec.dvar) * k), speed),
      periodB: period(Math.round(8 + r() * 8), speed),
      // The demo offsets every animation with a negative delay, which is the
      // same as starting it partway through its own cycle.
      phaseX: r(),
      phaseY: r(),
      phaseB: r(),
    });
  }
  return out;
}

function rises(bg: string, fg: string, speed: number): Rise[] {
  const r = rng(SEED + 55);
  const out: Rise[] = [];
  for (let i = 0; i < RISE_COUNT; i++) {
    out.push({
      x: r() * 0.9,
      size: (8 + r() * 14) / 100,
      color: mixTone(0.25 + r() * 0.35, bg, fg),
      opacity: 0.5 + r() * 0.35,
      blur: 8 + r() * 12,
      drift: -30 + r() * 60,
      period: period(Math.round(16 + r() * 14), speed),
      phase: r(),
    });
  }
  return out;
}

// ── Painting ───────────────────────────────────────────────────────────────

/**
 * Where an `alternate` animation is at `t`, as a 0..1 fraction between its `from`
 * and its `to`.
 *
 * The demo animates every orb with `alternate`, so half the period is the trip
 * out and the other half the trip back, and the value it returns is symmetric
 * around the middle: `2 * f - 1` is the signed offset between them, negative on
 * the way back.
 */
function sway(t: number, seconds: number, phase: number): number {
  const cycle = t / seconds + phase;
  const p = cycle - Math.floor(cycle);
  const tri = p < 0.5 ? p * 2 : 2 - p * 2;
  // `ease-in-out`, so the extremes are reached gradually instead of at
  // constant speed.
  return tri * tri * (3 - 2 * tri);
}

/** A color with an alpha, for a gradient stop. */
function rgba(color: Rgb, alpha: number): string {
  const a = alpha < 0 ? 0 : alpha > 1 ? 1 : alpha;
  return `rgba(${color[0]}, ${color[1]}, ${color[2]}, ${a})`;
}

/** A hex color in the same shape `mixTone` returns. */
function rgbOf(hex: string): Rgb {
  const { r, g, b } = hexToRgb(hex);
  return [r, g, b];
}

/** One blurred circle: a radial gradient standing in for `filter: blur`. */
function paintOrb(
  ctx: CanvasRenderingContext2D,
  orb: Orb,
  t: number,
  w: number,
  h: number,
): void {
  const x = (orb.x + orb.size * orb.ax * (2 * sway(t, orb.periodX, orb.phaseX) - 1)) * w;
  const y = (orb.y + orb.size * orb.ay * (2 * sway(t, orb.periodY, orb.phaseY) - 1)) * h;
  // The breathing of the demo: the sphere is a little smaller and a little
  // bigger than its size, over a period of its own.
  const r = orb.size * w * 0.5 * (0.86 + 0.3 * sway(t, orb.periodB, orb.phaseB));
  // The gradient reaches `r + blur`, so the sphere fades out exactly where the
  // demo's blur would have ended.
  const outer = r + orb.blur * (w / REFERENCE_WIDTH);
  if (outer <= 0) return;

  const edge = r / outer;
  const grad = ctx.createRadialGradient(x, y, 0, x, y, outer);
  grad.addColorStop(0, rgba(orb.color, orb.opacity));
  // A blur spreads the rim, so the falloff starts before it and is soft by the
  // time it gets there.
  grad.addColorStop(Math.max(0, edge * 0.72), rgba(orb.color, orb.opacity * 0.62));
  grad.addColorStop(edge, rgba(orb.color, orb.opacity * 0.24));
  grad.addColorStop(1, rgba(orb.color, 0));
  ctx.fillStyle = grad;
  ctx.beginPath();
  ctx.arc(x, y, outer, 0, Math.PI * 2);
  ctx.fill();
}

/** A rising sphere: from below the bottom edge to above the top one. */
function paintRise(
  ctx: CanvasRenderingContext2D,
  rise: Rise,
  t: number,
  w: number,
  h: number,
): void {
  const cycle = t / rise.period + rise.phase;
  const p = cycle - Math.floor(cycle);
  const size = rise.size * w;
  const outer = size * 0.5 + rise.blur * (w / REFERENCE_WIDTH);
  // `pbg-fade`: in over the first 15%, out over the last 15%.
  const alpha = rise.opacity * Math.min(1, p / 0.15) * Math.min(1, (1 - p) / 0.15);
  if (alpha <= 0 || outer <= 0) return;

  // The demo's `pbg-rise` travels the height of the frame plus its own diameter,
  // and slides sideways by a fixed amount as it goes.
  const x = rise.x * w + rise.drift * (w / REFERENCE_WIDTH);
  const y = h - p * (h + size);
  const grad = ctx.createRadialGradient(x, y, 0, x, y, outer);
  grad.addColorStop(0, rgba(rise.color, alpha));
  grad.addColorStop(0.72, rgba(rise.color, alpha * 0.62));
  grad.addColorStop(1, rgba(rise.color, 0));
  ctx.fillStyle = grad;
  ctx.beginPath();
  ctx.arc(x, y, outer, 0, Math.PI * 2);
  ctx.fill();
}

/** The tinted vignette of `focus`: clean in the center, `fg` at the edges. */
function paintVignette(
  ctx: CanvasRenderingContext2D,
  fg: string,
  w: number,
  h: number,
): void {
  const color = rgbOf(fg);
  const r = Math.max(w, h) * 0.75;
  const grad = ctx.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, r);
  grad.addColorStop(0, rgba(color, 0));
  // The demo leaves the middle 35% untouched.
  grad.addColorStop(0.35, rgba(color, 0));
  grad.addColorStop(1, rgba(color, 0.42));
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, w, h);
}

/** The grain pattern, built once and shared by every frame and every export. */
let grainPattern: CanvasPattern | null = null;

/**
 * A tile of noise: the stand-in for the demo's `feTurbulence` rect.
 *
 * It is built from the same PRNG as everything else, so the grain of an export
 * is the grain of every frame of it.
 */
function grainTile(): HTMLCanvasElement | OffscreenCanvas {
  const surface = createSurface(GRAIN_TILE, GRAIN_TILE);
  const g = surface.getContext('2d');
  if (!g) return surface;
  const image = g.createImageData(GRAIN_TILE, GRAIN_TILE);
  const data = image.data;
  const r = rng(SEED + 7);
  for (let i = 0; i < data.length; i += 4) {
    // Gray between 0.72 and 1: `multiply` can only darken, so a tile that went
    // over white would be a no-op.
    const v = Math.round(lerp(0.72, 1, r()) * 255);
    data[i] = v;
    data[i + 1] = v;
    data[i + 2] = v;
    data[i + 3] = 255;
  }
  g.putImageData(image, 0, 0);
  return surface;
}

function grain(
  ctx: CanvasRenderingContext2D,
  alpha: number,
  w: number,
  h: number,
  t: number,
): void {
  if (!grainPattern) grainPattern = ctx.createPattern(grainTile(), 'repeat');
  if (!grainPattern) return;
  const step = Math.floor(t / GRAIN_STEP) % GRAIN_OFFSETS.length;
  const offset = GRAIN_OFFSETS[(step + GRAIN_OFFSETS.length) % GRAIN_OFFSETS.length]!;
  ctx.save();
  // `multiply` is how the demo blends it, at a third of its strength.
  ctx.globalCompositeOperation = 'multiply';
  ctx.globalAlpha = alpha;
  ctx.fillStyle = grainPattern;
  ctx.translate(offset[0], offset[1]);
  ctx.fillRect(-offset[0], -offset[1], w, h);
  ctx.restore();
}

/** Any 2D canvas, in the same order the encoders use. */
function createSurface(width: number, height: number): HTMLCanvasElement | OffscreenCanvas {
  if (typeof OffscreenCanvas === 'function') return new OffscreenCanvas(width, height);
  if (typeof document !== 'undefined') {
    const c = document.createElement('canvas');
    c.width = width;
    c.height = height;
    return c;
  }
  throw new Error('No canvas is available: OffscreenCanvas or a document is required.');
}

/**
 * Orbs are composed on a small offscreen and then scaled up.
 *
 * A 640px sphere blurred over 40px is a very large gradient to fill, and the
 * GIF and the video exporters draw one per frame. The blur keeps its shape when
 * it is scaled, so nothing is lost by composing them small and letting the
 * browser's own filtering do the rest.
 */
let orbSurface: {
  surface: HTMLCanvasElement | OffscreenCanvas;
  ctx: CanvasRenderingContext2D;
  width: number;
  height: number;
} | null = null;

function orbContext(w: number, h: number): { ctx: CanvasRenderingContext2D; scale: number } {
  const scale = Math.min(1, ORB_SURFACE_MAX / Math.max(w, h));
  const width = Math.max(1, Math.round(w * scale));
  const height = Math.max(1, Math.round(h * scale));
  if (!orbSurface || orbSurface.width !== width || orbSurface.height !== height) {
    const surface = createSurface(width, height);
    const ctx = surface.getContext('2d');
    if (!ctx) throw new Error('The browser did not provide a 2D canvas context.');
    // The types draw the offscreen context and the onscreen one apart, but they
    // have the same drawing methods, so they are interchangeable here.
    orbSurface = { surface, ctx: ctx as CanvasRenderingContext2D, width, height };
  }
  return { ctx: orbSurface.ctx, scale };
}

/**
 * Paints the background of one frame over the flat color already on the canvas.
 *
 * @param t Position in the clip, in seconds.
 */
export function paintTexture(ctx: CanvasRenderingContext2D, spec: Spec, t: number): void {
  if (spec.texture === 'none') return;
  const { width, height } = spec;
  // A speed of 0 is a background that is painted and never moves. The periods
  // already hold every sphere still, but the grain steps on the clock alone, so
  // the frame it lands on has to stop too.
  const at = spec.textureSpeed > 0 ? t : 0;
  const plan = buildTexturePlan(spec.texture, spec.bg, spec.fg, spec.textureSpeed);
  if (plan.orbs.length > 0) {
    const { ctx: small, scale } = orbContext(width, height);
    const source = orbSurface!;
    small.setTransform(1, 0, 0, 1, 0, 0);
    small.clearRect(0, 0, source.width, source.height);
    small.setTransform(scale, 0, 0, scale, 0, 0);
    // The orb coordinates are the frame's, and the transform maps them down to
    // the offscreen: the blur travels with them, so it only has to be scaled by
    // the frame and not by the offscreen too.
    for (const orb of plan.orbs) paintOrb(small, orb, at, width, height);
    small.setTransform(1, 0, 0, 1, 0, 0);
    ctx.drawImage(source.surface, 0, 0, width, height);
  }
  for (const rise of plan.rises) paintRise(ctx, rise, at, width, height);
  if (plan.vignette) paintVignette(ctx, spec.fg, width, height);
  grain(ctx, plan.grain, width, height, at);
}
