import { FONT_FAMILY, FONT_WEIGHT, type Spec } from './types';

/** Absolute legibility floor. Below this the text stops being useful. */
const ABSOLUTE_FLOOR = 10;
/** Ceiling: never bigger than this on the shortest side of the canvas. */
const MAX_FONT_RATIO = 0.14;
const MAX_FONT_CEILING = 220;
const MIN_FONT_CEILING = 12;
/** Leading, as a multiple of the font size. */
const LINE_HEIGHT_RATIO = 1.12;
/** Padding around the text block, as a fraction of the shortest side. */
const PADDING_RATIO = 0.08;
/**
 * The text never grows past this fraction of the shortest side, no matter how
 * much room the canvas has. A placeholder whose dimensions fill it edge to
 * edge stops looking like a placeholder, so the block is confined to a square
 * box of `MIN(width, height) * MAX_SIDE_RATIO`.
 */
const MAX_SIDE_RATIO = 0.6;

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
 * fewer lines preferred on a tie. But a single line is kept whenever it is
 * still readable: splitting only buys a bigger font size, and the 60% cap
 * exists to make the text SMALLER. Two lines are worth it only when the
 * one-line shape would fall below the legibility floor, as on a tall banner.
 */
export function dimensionCandidates(width: number, height: number): string[][] {
  const w = String(width);
  const h = String(height);
  return [
    [`${w} × ${h}`],   // one line, the most legible
    [`${w}×${h}`],     // one compact line, no spaces
    [`${w}`, `× ${h}`], // two lines, for very wide formats
    [`${w}`, `×${h}`],
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

/**
 * Area the dimensions may occupy: whatever the caller allows, capped to the
 * 60% square of the shortest side. Doing the cap here means every caller
 * gets it, and the exports and the live preview cannot disagree.
 */
export function textAreaFor(spec: Spec, maxW: number, maxH: number): { maxW: number; maxH: number } {
  const side = Math.min(maxW, maxH, Math.min(spec.width, spec.height) * MAX_SIDE_RATIO);
  return { maxW: side, maxH: side };
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
  const max = opts.maxFontSize ?? clampMaxFont(spec.width, spec.height);
  const label = spec.label ?? `${spec.width} × ${spec.height}`;
  const area = textAreaFor(spec, maxW, maxH);

  // An explicit label wins and is not decomposed.
  const candidates = spec.label ? [spec.label.split('\n')] : dimensionCandidates(spec.width, spec.height);

  let best: TextLayout | null = null;
  let bestSingle: TextLayout | null = null;
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
    if (lines.length === 1 && (!bestSingle || beats(candidate, bestSingle))) bestSingle = candidate;
  }
  // A readable single line always wins: two lines only pay off when the
  // one-line shape ends up below the legibility floor.
  if (bestSingle && !bestSingle.shrunk) return bestSingle;
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

export function clampMaxFont(width: number, height: number): number {
  return Math.max(MIN_FONT_CEILING, Math.min(MAX_FONT_CEILING, Math.min(width, height) * MAX_FONT_RATIO));
}

export { ABSOLUTE_FLOOR, LINE_HEIGHT_RATIO, MAX_SIDE_RATIO, PADDING_RATIO };
export { measureBlock, applyFont };
