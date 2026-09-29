import { cssColor, hexToRgba } from './color';
import { applyFont, clampMaxFont, layoutDimensions, layoutLine, paddingFor, type TextLayout } from './fit-text';
import { FONT_WEIGHT, type Spec } from './types';

/** Franja reservada al pie para la barra de progreso y el reloj. */
export interface FrameGeometry {
  /** Alto de la barra, en px. */
  barHeight: number;
  /** Tamaño de fuente del reloj, en px. */
  timeFontSize: number;
  /** Alto total reservado al pie, en px. Cero si no hay barra. */
  stripHeight: number;
}

const BAR_RATIO = 0.012;
const BAR_MIN = 2;
const BAR_MAX = 12;
const TIME_RATIO = 0.035;
const TIME_MIN = 9;
const TIME_MAX = 22;
/** Opacidad de la guía de la barra, para que se lea sin competir. */
const TRACK_ALPHA = 0.16;

/**
 * Geometría de la franja inferior. No depende del tamaño de las dimensiones,
 * así que no hay circularidad al calcular el centro del texto.
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
  // El reloj necesita su alto de línea más un pequeño respiro sobre la barra.
  const timeBlock = timeFontSize > 0 ? timeFontSize * 1.5 : 0;
  return { barHeight, timeFontSize, stripHeight: barHeight + timeBlock };
}

/** `0:03`, con los minutos sin cero inicial y los segundos siempre con dos. */
export function formatClock(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, '0')}`;
}

/** `0:03 / 0:10` */
export function timecode(current: number, total: number): string {
  return `${formatClock(current)} / ${formatClock(total)}`;
}

/** Centra un bloque de texto ya medido dentro de un área vertical. */
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
 * Dibuja un frame completo. Es el único camino de render del proyecto: lo
 * usan el preview en vivo, los exportadores de imagen, el GIF, el MJPEG y el
 * video. Si esto cambia, cambia todo junto.
 *
 * @param progress avance 0..1 de la barra. `undefined` la deja vacía.
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

  // Dimensiones, centradas en el área que sobra arriba de la franja.
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
      // Guía: presente pero discreta, para que la barra se lea como progreso.
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
 * Precalcula el layout de las dimensiones una sola vez por exportación.
 * Los exportadores de video generan cientos de frames con el mismo texto y
 * sin esto se estaría midiendo texto miles de veces.
 */
export function makeFrameRenderer(spec: Spec): (ctx: CanvasRenderingContext2D, progress?: number) => void {
  return (ctx, progress) => drawFrame(ctx, spec, progress);
}

export { clampMaxFont };
