import { FONT_FAMILY, FONT_WEIGHT, type Spec } from './types';

/** Absolute legibility floor. Below this the text stops being useful. */
const ABSOLUTE_FLOOR = 10;
/** Leading, as a multiple of the font size. */
const LINE_HEIGHT_RATIO = 1.12;
/** Padding around the text block, as a fraction of the shortest side. */
const PADDING_RATIO = 0.08;

export interface TextLayout {
  fontSize: number;
  lines: string[];
  lineHeight: number;
  /** Measured width of the block, in px. */
  width: number;
  /** Measured height of the block, in px. */
  height: number;
  /** `true` when it had to shrink below the legibility floor. */
  shrunk: boolean;
  /** Height above the baseline of the tallest line. For exact centering. */
  ascent: number;
  /** Depth below the baseline. */
  descent: number;
}

export interface FitOptions {
  /** Multiplier on the font size. For the clock, ~0.5. */
  scale?: number;
  /** Padding in px. When omitted, it is derived from the dimensions. */
  padding?: number;
  minFontSize?: number;
  maxFontSize?: number;
  fontWeight?: number;
}

function applyFont(ctx: CanvasRenderingContext2D, size: number, weight: number): void {
  ctx.font = `${weight} ${Math.max(1, size)}px "${FONT_FAMILY}", system-ui, sans-serif`;
}

export function paddingFor(width: number, height: number): number {
  return Math.min(width, height) * PADDING_RATIO;
}

/** Measures an already composed block of lines. Only the font is touched. */
function measureBlock(
  ctx: CanvasRenderingContext2D,
  lines: string[],
  fontSize: number,
  weight: number,
): { w: number; h: number; ascent: number; descent: number } {
  applyFont(ctx, fontSize, weight);
  const lineHeight = fontSize * LINE_HEIGHT_RATIO;
  let width = 0;
  let ascent = 0;
  let descent = 0;
  for (const line of lines) {
    const m = ctx.measureText(line);
    width = Math.max(width, m.width);
    // `actualBoundingBox*` gives the real box of the glyphs. The max of ascent
    // and descent is used, not the line height, so that lowercase letters
    // without accents do not reserve more room than they need.
    ascent = Math.max(ascent, m.actualBoundingBoxAscent ?? fontSize * 0.72);
    descent = Math.max(descent, m.actualBoundingBoxDescent ?? fontSize * 0.22);
  }
  const contentH = lines.length === 1 ? ascent + descent : lineHeight * (lines.length - 1) + ascent + descent;
  return { w: width, h: contentH, ascent, descent };
}

function fits(ctx: CanvasRenderingContext2D, lines: string[], size: number, maxW: number, maxH: number, weight: number): boolean {
  const m = measureBlock(ctx, lines, size, weight);
  return m.w <= maxW && m.h <= maxH;
}

/** Below this nothing is drawn: it is no longer text, it is noise. */
const MIN_DRAWABLE = 6;

/**
 * Biggest font size whose block fits the given area.
 *
 * The measured width and height grow monotonically with the size, so the
 * bisection converges on the exact value. It returns `0` if the block does not
 * fit even at the smallest drawable size, which is the signal for "draw
 * nothing".
 *
 * The legibility floor (`minFontSize`) is NOT a limit of the search: if the
 * text fits at 20px it fits perfectly, and one at 8px is better than drawing
 * nothing. The floor is only used afterwards, to report that it shrank too
 * much.
 */
function searchSize(
  ctx: CanvasRenderingContext2D,
  lines: string[],
  max: number,
  maxW: number,
  maxH: number,
  weight: number,
): number {
  if (max <= MIN_DRAWABLE) return fits(ctx, lines, max, maxW, maxH, weight) ? max : 0;
  if (fits(ctx, lines, max, maxW, maxH, weight)) return max;
  if (!fits(ctx, lines, MIN_DRAWABLE, maxW, maxH, weight)) return 0;

  let a = MIN_DRAWABLE;
  let z = max;
  for (let i = 0; i < 16; i++) {
    const mid = (a + z) / 2;
    if (fits(ctx, lines, mid, maxW, maxH, weight)) a = mid;
    else z = mid;
  }
  return a;
}

/**
 * Composes the text of the placeholder. By design it only holds the dimensions.
 *
 * Several shapes are tried and the one that allows the BIGGEST text wins, with
 * a single line preferred on a tie. All shapes are a single line: the text is
 * never split, so on a tall format the compact `×h` form simply fits bigger.
 */
export function dimensionCandidates(width: number, height: number): string[][] {
  const w = String(width);
  const h = String(height);
  return [
    [`${w} × ${h}`],   // one line, the most legible
    [`${w}×${h}`],     // one compact line, no spaces
  ];
}

/** Bigger font wins; on a tie, fewer lines; on a tie, narrower. */
function beats(candidate: TextLayout, best: TextLayout): boolean {
  return (
    candidate.fontSize > best.fontSize + 0.01 ||
    (Math.abs(candidate.fontSize - best.fontSize) <= 0.01 && candidate.lines.length < best.lines.length) ||
    (Math.abs(candidate.fontSize - best.fontSize) <= 0.01 &&
      candidate.lines.length === best.lines.length &&
      candidate.width < best.width)
  );
}

/** Share of the usable width the dimensions may use. */
const MAX_BLOCK_W = 0.7;
/** Share of the usable height the dimensions may use. */
const MAX_BLOCK_H = 0.6;

/**
 * Area the dimensions may occupy: a share of the room the caller allows, with
 * the width and the height as two independent limits.
 *
 * Two independent limits are what makes this work. A single cap on the
 * shortest side squeezes a wide banner into a square and forces the text to
 * break in two; capping width and height separately lets a banner grow with
 * its own height while still leaving air around the block, so the placeholder
 * does not read as a solid slab of text.
 *
 * Doing it here means every caller gets it, and the exports and the live
 * preview cannot disagree.
 */
export function textAreaFor(maxW: number, maxH: number): { maxW: number; maxH: number } {
  return { maxW: maxW * MAX_BLOCK_W, maxH: maxH * MAX_BLOCK_H };
}

/**
 * Search area for the text: the 70%/60% box, widened when honouring it would
 * push the text below the legibility floor.
 *
 * The cap exists to leave air around the block, not to make it unreadable. On a
 * tall and narrow format (40x600) 70% of the width is what binds and the text
 * lands under 10px, so there the width is given back, only as far as the floor
 * needs. Wide formats never reach this: their height binds instead, so the cap
 * holds and the text keeps its margins.
 */
function searchArea(
  ctx: CanvasRenderingContext2D,
  maxW: number,
  maxH: number,
  lines: string[],
  weight: number,
  min: number,
): { maxW: number; maxH: number } {
  const area = textAreaFor(maxW, maxH);
  if (min <= 0) return area;
  applyFont(ctx, min, weight);
  // Already in px: the text measured at the floor is exactly the width the
  // floor needs. The sliver covers the rounding of the metrics.
  const needed = Math.max(...lines.map((l) => ctx.measureText(l).width)) * 1.01;
  // `maxW` is the real limit: the cap is given back only up to it, so the text
  // can never overflow the canvas, and on a canvas too small to hold the floor
  // the area simply stays the capped one and the text shrinks as usual.
  return { maxW: Math.min(Math.max(area.maxW, needed), maxW), maxH: area.maxH };
}

export function layoutDimensions(
  ctx: CanvasRenderingContext2D,
  spec: Spec,
  maxW: number,
  maxH: number,
  opts: FitOptions = {},
): TextLayout | null {
  const weight = opts.fontWeight ?? FONT_WEIGHT;
  const min = opts.minFontSize ?? ABSOLUTE_FLOOR;

  // An explicit label wins and is not decomposed. Its newlines become spaces:
  // the dimensions are never split across lines.
  const candidates: string[][] = spec.label
    ? [[spec.label.replace(/\s*\n+\s*/g, ' ').trim()]]
    : dimensionCandidates(spec.width, spec.height);

  // The area is the only limit: the text grows until it fills it. Widest
  // candidate bounds the box, so a long label is measured against the width it
  // actually needs rather than the shortest one.
  const area = searchArea(
    ctx,
    maxW,
    maxH,
    candidates.map((l) => l.join(' ')),
    weight,
    min,
  );
  // Upper bracket of the search, never a cap: twice the largest side can never
  // fit, so it always brackets the real answer.
  const max = opts.maxFontSize ?? Math.max(area.maxW, area.maxH) * 2;

  let best: TextLayout | null = null;
  for (const lines of candidates) {
    const size = searchSize(ctx, lines, max, area.maxW, area.maxH, weight);
    // `0` means it does not fit even at the smallest drawable size: the
    // candidate is dropped and the next one is tried.
    if (size <= 0) continue;
    const m = measureBlock(ctx, lines, size, weight);
    const candidate: TextLayout = {
      fontSize: size,
      lines,
      lineHeight: size * LINE_HEIGHT_RATIO,
      width: m.w,
      height: m.h,
      shrunk: size < min,
      ascent: m.ascent,
      descent: m.descent,
    };
    if (!best || beats(candidate, best)) best = candidate;
  }
  return best;
}

/** A single line, without decomposition. For the clock on the progress bar. */
export function layoutLine(
  ctx: CanvasRenderingContext2D,
  text: string,
  maxW: number,
  maxH: number,
  opts: FitOptions = {},
): TextLayout | null {
  const weight = opts.fontWeight ?? FONT_WEIGHT;
  const min = opts.minFontSize ?? ABSOLUTE_FLOOR;
  const max = opts.maxFontSize ?? 28;
  const size = searchSize(ctx, [text], max, maxW, maxH, weight);
  if (size <= 0) return null;
  const m = measureBlock(ctx, [text], size, weight);
  if (m.w > maxW || m.h > maxH) return null;
  return {
    fontSize: size,
    lines: [text],
    lineHeight: size * LINE_HEIGHT_RATIO,
    width: m.w,
    height: m.h,
    shrunk: size < min,
    ascent: m.ascent,
    descent: m.descent,
  };
}

export { ABSOLUTE_FLOOR, LINE_HEIGHT_RATIO, MAX_BLOCK_H, MAX_BLOCK_W, PADDING_RATIO };
export { measureBlock, applyFont };
