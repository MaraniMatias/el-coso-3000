import { cssColor, hexToRgba } from './color';
import { applyFont, clampMaxFont, layoutDimensions, layoutLine, paddingFor, type TextLayout } from './fit-text';
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

const BAR_RATIO = 0.012;
const BAR_MIN = 2;
const BAR_MAX = 12;
const TIME_RATIO = 0.035;
const TIME_MIN = 9;
const TIME_MAX = 22;
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
  const barHeight = Math.round(Math.max(BAR_MIN, Math.min(BAR_MAX, spec.height * BAR_RATIO)));
  const timeFontSize = showTime
    ? Math.round(Math.max(TIME_MIN, Math.min(TIME_MAX, Math.min(spec.width, spec.height) * TIME_RATIO)))
    : 0;
  // The clock needs its line height plus a small breather over the bar.
  const timeBlock = timeFontSize > 0 ? timeFontSize * 1.5 : 0;
  return { barHeight, timeFontSize, stripHeight: barHeight + timeBlock };
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
  ctx.fillStyle = cssColor(spec.bg);
  ctx.fillRect(0, 0, width, height);

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
      const clock = layoutLine(
        ctx,
        tc,
        width - pad,
        geo.timeFontSize * 1.5,
        { fontWeight: FONT_WEIGHT, minFontSize: 7, maxFontSize: geo.timeFontSize },
      );
      if (clock) {
        applyFont(ctx, clock.fontSize, FONT_WEIGHT);
        paintText(ctx, clock, width / 2, barTop - geo.timeFontSize * 1.5, geo.timeFontSize * 1.5, spec.fg);
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

export { clampMaxFont };
