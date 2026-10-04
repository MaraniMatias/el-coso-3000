import { cssColor, hexToRgba } from './color';
import { applyFont, layoutDimensions, layoutLine, paddingFor, type TextLayout } from './fit-text';
import { paintTexture } from './texture';
import { FONT_WEIGHT, type Spec } from './types';

/** Strip reserved at the bottom for the progress bar and the clock. */
export interface FrameGeometry {
  /** Height of the bar, in px. */
  barHeight: number;
  /** Font size of the clock, in px. */
  timeFontSize: number;
  /** Total height reserved at the bottom, in px. Zero when there is no bar. */
  stripHeight: number;
}

/**
 * The bar and the clock are sized as a fraction of the video, so they keep the
 * same proportion at 320×240 and at 4K. Both are shares of
 * `MIN(width, height)`, so a portrait and a landscape of the same short side
 * get the same strip: the bar keeps its thickness next to the clock instead of
 * drifting away from it. `MIN` are floors, not ceilings: they only stop the
 * strip from disappearing on a tiny canvas, they never flatten it on a big one.
 */
const BAR_RATIO = 0.018;
const BAR_MIN = 2;
const TIME_RATIO = 0.05;
const TIME_MIN = 10;
/**
 * The clock block: its line height plus a small breather over the bar.
 */
const TIME_BLOCK_RATIO = 1.5;
/**
 * Last-resort ceiling on the strip: it keeps the dimensions as the subject of
 * the image. It only bites on a canvas too short to hold the floors, which is
 * why it sits above the share the floors already ask for (17px is 34% of a
 * 50px banner).
 */
const MAX_STRIP_RATIO = 0.35;
/** Opacity of the bar track, so it reads without competing. */
const TRACK_ALPHA = 0.16;

/**
 * Geometry of the bottom strip. It does not depend on the size of the
 * dimensions, so there is no circularity when centering the text.
 */
export function frameGeometry(spec: Spec): FrameGeometry {
  const showBar = spec.showProgressBar;
  const showTime = spec.showTime;
  if (!showBar && !showTime) {
    return { barHeight: 0, timeFontSize: 0, stripHeight: 0 };
  }
  const block = (time: number) => (time > 0 ? time * TIME_BLOCK_RATIO : 0);
  // One reference side for both, so the bar and the clock keep their relation
  // to each other at every aspect ratio.
  const side = Math.min(spec.width, spec.height);
  const timeRatio = side * TIME_RATIO;
  let timeFontSize = showTime ? Math.max(TIME_MIN, Math.round(timeRatio)) : 0;
  // The bar crosses to its floor together with the clock. Letting each round
  // on its own leaves a window where the clock sits on 10px and the bar is
  // still below its proportional size, and the two lose their relation.
  let barHeight = Math.max(BAR_MIN, Math.round(side * BAR_RATIO));
  if (showTime && timeRatio < TIME_MIN) barHeight = BAR_MIN;

  // The strip is capped so the dimensions keep the canvas. The floors above
  // come first: only a canvas too short to hold them reaches this, and then the
  // clock gives way before the bar does.
  const budget = spec.height * MAX_STRIP_RATIO;
  if (barHeight + block(timeFontSize) > budget) {
    timeFontSize = Math.max(0, (budget - barHeight) / TIME_BLOCK_RATIO);
  }
  if (barHeight + block(timeFontSize) > budget) {
    barHeight = Math.max(0, budget - block(timeFontSize));
  }

  return { barHeight, timeFontSize, stripHeight: barHeight + block(timeFontSize) };
}

/** `0:03`, with minutes without a leading zero and seconds always with two. */
export function formatClock(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, '0')}`;
}

/** `0:03 / 0:10` */
export function timecode(current: number, total: number): string {
  return `${formatClock(current)} / ${formatClock(total)}`;
}

/** Centers an already measured text block inside a vertical area. */
function paintText(
  ctx: CanvasRenderingContext2D,
  layout: TextLayout,
  centerX: number,
  top: number,
  areaHeight: number,
  color: string,
): void {
  ctx.fillStyle = cssColor(color);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  const blockTop = top + (areaHeight - layout.height) / 2;
  let baseline = blockTop + layout.ascent;
  for (const line of layout.lines) {
    ctx.fillText(line, centerX, baseline);
    baseline += layout.lineHeight;
  }
}

/**
 * Draws a full frame. It is the only render path of the project: the live
 * preview, the image exporters, the GIF, the MJPEG and the video all use it.
 * If this changes, everything changes with it.
 *
 * @param progress bar progress 0..1. `undefined` leaves it empty.
 */
export function drawFrame(ctx: CanvasRenderingContext2D, spec: Spec, progress?: number): void {
  const { width, height } = spec;
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, width, height);
  // The texture is a function of the frame's position in the timeline, so the
  // preview and every frame of every exporter show the same thing. A still image
  // has no timeline and lands on the first frame, at t = 0.
  const t = (progress ?? 0) * spec.duration;
  if (spec.texture !== 'none') {
    // A texture is an opaque background by definition: it fills every pixel, so
    // `transparent` does not apply while it is on.
    ctx.fillStyle = cssColor(spec.bg);
    ctx.fillRect(0, 0, width, height);
    paintTexture(ctx, spec, t);
  } else if (!spec.transparent) {
    // The `clearRect` above is the whole background when it is transparent: the
    // pixels stay at alpha 0 and the file carries a real alpha channel. The text
    // color is still the one derived from `bg`, so the pairing stays readable.
    ctx.fillStyle = cssColor(spec.bg);
    ctx.fillRect(0, 0, width, height);
  }

  const geo = frameGeometry(spec);
  const contentHeight = height - geo.stripHeight;
  const pad = paddingFor(width, height);

  // Dimensions, centered in the area left above the strip.
  const dims = layoutDimensions(
    ctx,
    spec,
    Math.max(1, width - pad * 2),
    Math.max(1, contentHeight - pad * 2),
    { fontWeight: FONT_WEIGHT },
  );
  if (dims && dims.fontSize >= 6) {
    applyFont(ctx, dims.fontSize, FONT_WEIGHT);
    paintText(ctx, dims, width / 2, 0, contentHeight, spec.fg);
  }

  if (geo.stripHeight > 0) {
    const barTop = height - geo.barHeight;

    if (spec.showTime && geo.timeFontSize > 0) {
      const tc = timecode((progress ?? 0) * spec.duration, spec.duration);
      // `layoutLine` fits the clock to the width it really has and returns
      // `null` when even the smallest drawable size would overflow, so on a
      // very narrow frame the timecode is dropped instead of spilling past the
      // edges. `timeFontSize` only caps it; the width is what decides.
      const clock = layoutLine(
        ctx,
        tc,
        width - pad * 2,
        geo.timeFontSize * TIME_BLOCK_RATIO,
        { fontWeight: FONT_WEIGHT, minFontSize: 7, maxFontSize: geo.timeFontSize },
      );
      if (clock) {
        applyFont(ctx, clock.fontSize, FONT_WEIGHT);
        paintText(ctx, clock, width / 2, barTop - geo.timeFontSize * TIME_BLOCK_RATIO, geo.timeFontSize * TIME_BLOCK_RATIO, spec.fg);
      }
    }

    if (spec.showProgressBar && geo.barHeight > 0) {
      // Track: present but discreet, so the bar reads as progress.
      ctx.fillStyle = hexToRgba(spec.fg, TRACK_ALPHA);
      ctx.fillRect(0, barTop, width, geo.barHeight);
      const filled = Math.round(width * Math.max(0, Math.min(1, progress ?? 0)));
      if (filled > 0) {
        ctx.fillStyle = cssColor(spec.fg);
        ctx.fillRect(0, barTop, filled, geo.barHeight);
      }
    }
  }

  ctx.restore();
}

/**
 * Precomputes the layout of the dimensions once per export. The video
 * exporters generate hundreds of frames with the same text, and without this
 * the text would be measured thousands of times.
 */
export function makeFrameRenderer(spec: Spec): (ctx: CanvasRenderingContext2D, progress?: number) => void {
  return (ctx, progress) => drawFrame(ctx, spec, progress);
}
