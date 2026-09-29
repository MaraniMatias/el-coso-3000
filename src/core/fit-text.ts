import { FONT_FAMILY, FONT_WEIGHT, type Spec } from './types';

/** Piso absoluto de legibilidad. Por debajo de esto el texto deja de servir. */
const ABSOLUTE_FLOOR = 10;
/** Techo: nunca más grande que esto en lado menor del canvas. */
const MAX_FONT_RATIO = 0.14;
const MAX_FONT_CEILING = 220;
const MIN_FONT_CEILING = 12;
/** Interlineado, como múltiplo del tamaño de fuente. */
const LINE_HEIGHT_RATIO = 1.12;
/** Padding alrededor del bloque de texto, como fracción del lado menor. */
const PADDING_RATIO = 0.08;

export interface TextLayout {
  fontSize: number;
  lines: string[];
  lineHeight: number;
  /** Ancho real medido del bloque, en px. */
  width: number;
  /** Alto real medido del bloque, en px. */
  height: number;
  /** `true` si hubo que encoger por debajo del piso de legibilidad. */
  shrunk: boolean;
  /** Altura sobre la línea base del renglón más alto. Para centrar exacto. */
  ascent: number;
  /** Profundidad bajo la línea base. */
  descent: number;
}

export interface FitOptions {
  /** Multiplicador sobre el tamaño de fuente. Para el reloj, ~0.5. */
  scale?: number;
  /** Padding en px. Si se omite, se deriva de las dimensiones. */
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

/** Mide un bloque de líneas ya compuesto. No modifica el ctx salvo por la fuente. */
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
    // `actualBoundingBox*` da la caja real de los glifos. Se usa el máximo
    // entre ascent y descent, no la altura de línea, para que unas minúsculas
    // sin acentos no reserven espacio de más.
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

/** Por debajo de esto no se dibuja: ya no es texto, es ruido. */
const MIN_DRAWABLE = 6;

/**
 * Mayor tamaño de fuente cuyo bloque entra en el área dada.
 *
 * El ancho y el alto medidos crecen monótonamente con el tamaño, así que la
 * bisección converge al valor exacto. Devuelve `0` si no entra ni al tamaño
 * mínimo dibujable, que es la señal de "no dibujar nada".
 *
 * El piso de legibilidad (`minFontSize`) NO es un límite de la búsqueda: si
 * el texto entra a 20px entra perfecto, y uno a 8px vale más que no dibujar
 * nada. El piso sólo se usa después, para avisar que se encogió de más.
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
 * Compone el texto del placeholder. Por diseño sólo contiene las dimensiones.
 *
 * Se prueban varias formas y se gana la que permits el texto MÁS GRANDE. A
 * igualdad de tamaño se prefiere la de menos líneas, que se lee más limpio.
 */
export function dimensionCandidates(width: number, height: number): string[][] {
  const w = String(width);
  const h = String(height);
  return [
    [`${w} × ${h}`],   // una línea, la más legible
    [`${w}×${h}`],     // una línea compacta, sin espacios
    [`${w}`, `× ${h}`], // dos líneas, para formatos muy apaisados
    [`${w}`, `×${h}`],
  ];
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

  // El label explícito manda y no se descompone.
  const candidates = spec.label ? [spec.label.split('\n')] : dimensionCandidates(spec.width, spec.height);

  let best: TextLayout | null = null;
  for (const lines of candidates) {
    const size = searchSize(ctx, lines, max, maxW, maxH, weight);
    // `0` significa que ni al mínimo dibujable entra: se descarta el
    // candidato y se prueba el siguiente.
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
    if (!best) {
      best = candidate;
      continue;
    }
    // Mayor tamaño gana; a igualdad, menos líneas; a igualdad, más simple.
    const better =
      candidate.fontSize > best.fontSize + 0.01 ||
      (Math.abs(candidate.fontSize - best.fontSize) <= 0.01 && candidate.lines.length < best.lines.length) ||
      (Math.abs(candidate.fontSize - best.fontSize) <= 0.01 &&
        candidate.lines.length === best.lines.length &&
        candidate.width < best.width);
    if (better) best = candidate;
  }
  return best;
}

/** Una sola línea, sin descomposición. Para el reloj de la barra de progreso. */
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

export { ABSOLUTE_FLOOR, LINE_HEIGHT_RATIO, PADDING_RATIO };
export { measureBlock, applyFont };
