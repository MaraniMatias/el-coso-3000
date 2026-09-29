import type { ContrastLevel, ContrastResult, PaletteEntry } from './types';

/** ── Conversión de color ──────────────────────────────────────────────── */

export function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const h = hex.replace('#', '');
  const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
  const n = Number.parseInt(full, 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

export function rgbToHex(r: number, g: number, b: number): string {
  const to = (v: number) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0');
  return `${to(r)}${to(g)}${to(b)}`;
}

/** Normaliza cualquier hex válido a 6 dígitos en mayúsculas, sin `#`. */
export function normalizeHex(hex: string): string {
  return rgbToHex(hexToRgb(hex).r, hexToRgb(hex).g, hexToRgb(hex).b).toUpperCase();
}

export function rgbToHsl(r: number, g: number, b: number): { h: number; s: number; l: number } {
  const rn = r / 255, gn = g / 255, bn = b / 255;
  const max = Math.max(rn, gn, bn), min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  const d = max - min;
  if (d === 0) return { h: 0, s: 0, l };
  const s = d / (1 - Math.abs(2 * l - 1));
  let h: number;
  if (max === rn) h = ((gn - bn) / d) % 6;
  else if (max === gn) h = (bn - rn) / d + 2;
  else h = (rn - gn) / d + 4;
  h *= 60;
  if (h < 0) h += 360;
  return { h, s, l };
}

export function hslToRgb(h: number, s: number, l: number): { r: number; g: number; b: number } {
  const hn = ((h % 360) + 360) % 360;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((hn / 60) % 2) - 1));
  const m = l - c / 2;
  let rp = 0, gp = 0, bp = 0;
  if (hn < 60) [rp, gp, bp] = [c, x, 0];
  else if (hn < 120) [rp, gp, bp] = [x, c, 0];
  else if (hn < 180) [rp, gp, bp] = [0, c, x];
  else if (hn < 240) [rp, gp, bp] = [0, x, c];
  else if (hn < 300) [rp, gp, bp] = [x, 0, c];
  else [rp, gp, bp] = [c, 0, x];
  return { r: (rp + m) * 255, g: (gp + m) * 255, b: (bp + m) * 255 };
}

export function hslToHex(h: number, s: number, l: number): string {
  const { r, g, b } = hslToRgb(h, s, l);
  return rgbToHex(r, g, b).toUpperCase();
}

/** `rgba()` a partir de un hex, para superponer sin recalcular nada. */
export function hexToRgba(hex: string, alpha: number): string {
  const { r, g, b } = hexToRgb(hex);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

/**
 * Hex apto para `ctx.fillStyle` y para CSS.
 *
 * Internamente los colores se guardan sin `#` porque es lo que quiere la
 * metadata de cada formato. Pero canvas y CSS **descartan en silencio** un
 * color sin `#`: `fillStyle = 'F2DEE2'` no tira error, simplemente se queda
 * con el valor anterior (negro). Por eso todo consumidor tiene que pasar por
 * acá en vez de usar el hex crudo.
 */
export function cssColor(hex: string): string {
  return hex.startsWith('#') ? hex : `#${hex}`;
}

/** ── WCAG 2.1 ────────────────────────────────────────────────────────── */

/** Luminancia relativa WCAG. `0` = negro, `1` = blanco. */
export function relativeLuminance(r: number, g: number, b: number): number {
  const lin = (v: number) => {
    const c = v / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

export function luminanceOf(hex: string): number {
  const { r, g, b } = hexToRgb(hex);
  return relativeLuminance(r, g, b);
}

export function contrastRatio(a: string, b: string): number {
  const la = luminanceOf(a);
  const lb = luminanceOf(b);
  const [hi, lo] = la > lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

export function levelForRatio(ratio: number): ContrastLevel {
  if (ratio >= 7) return 'AAA';
  if (ratio >= 4.5) return 'AA';
  if (ratio >= 3) return 'AA-large';
  return 'fail';
}

export function checkContrast(fg: string, bg: string): ContrastResult {
  const ratio = contrastRatio(fg, bg);
  return {
    ratio,
    label: `${ratio.toFixed(2)}:1`,
    level: levelForRatio(ratio),
  };
}

// ── Generación de la paleta ─────────────────────────────────────────────

/** Objetivos de la paleta pastel generada por fórmula. */
const BG_LIGHTNESS = 0.91;
const BG_SATURATION = 0.42;
const FG_SATURATION = 0.55;

/** Rango de luminosidad del texto, elegido según el del fondo. */
const FG_DARK_RANGE: [number, number] = [0.05, 0.38];
const FG_LIGHT_RANGE: [number, number] = [0.62, 0.97];

/**
 * Un color por cada tramo de la rueda, en español y ordenados por tono: la
 * grilla de la interfaz los muestra como van en la rueda.
 */
const PALETTE_NAMES: Array<{ name: string; label: string; hue: number }> = [
  { name: 'rose', label: 'Rosa', hue: 350 },
  { name: 'coral', label: 'Coral', hue: 12 },
  { name: 'apricot', label: 'Albaricoque', hue: 28 },
  { name: 'amber', label: 'Ámbar', hue: 45 },
  { name: 'lime', label: 'Lima', hue: 78 },
  { name: 'olive', label: 'Oliva', hue: 110 },
  { name: 'sage', label: 'Salvia', hue: 140 },
  { name: 'mint', label: 'Menta', hue: 158 },
  { name: 'teal', label: 'Verde azulado', hue: 172 },
  { name: 'turquoise', label: 'Turquesa', hue: 188 },
  { name: 'sky', label: 'Cielo', hue: 200 },
  { name: 'azure', label: 'Azul', hue: 218 },
  { name: 'steel', label: 'Acero', hue: 234 },
  { name: 'indigo', label: 'Índigo', hue: 250 },
  { name: 'violet', label: 'Violeta', hue: 278 },
  { name: 'plum', label: 'Ciruela', hue: 294 },
  { name: 'orchid', label: 'Orquídea', hue: 310 },
  { name: 'fuchsia', label: 'Fucsia', hue: 330 },
];

/**
 * Para un fondo dado, busca el texto del mismo tono con el mayor contraste
 * posible dentro de la pastelidad permitida.
 *
 * Fondo claro → texto oscuro (busca el tono MÁS ALTO que aún llega a 4.5:1,
 * para que no se vea un negro duro). Fondo oscuro → texto claro simétrico.
 *
 * Búsqueda binaria sobre la luminosidad, que es monotónica respecto del
 * contraste, así que 24 iteraciones dan precisión de sobra.
 */
/**
 * Para un fondo dado, busca el texto del mismo tono con el mayor contraste
 * posible dentro de la pastelidad permitida.
 *
 * Se elige el tono MÁS SUAVE que todavía llega al mínimo de contraste: el
 * criterio pedido es que un rojo clarito lleve un rojo más oscuro, no un
 * negro duro.
 *
 * @param minRatio contraste mínimo a garantizar. Por defecto AA (4.5:1).
 * @returns hex de 6 dígitos en mayúsculas, sin `#`.
 */
/**
 * Para un fondo dado, busca el texto del mismo tono con el mayor contraste
 * posible dentro de la pastelidad permitida.
 *
 * Se elige el tono MÁS SUAVE que todavía llega al mínimo de contraste: el
 * criterio pedido es que un rojo clarito lleve un rojo más oscuro, no un
 * negro duro.
 *
 * @param minRatio contraste mínimo a garantizar. Por defecto AA (4.5:1).
 * @returns hex de 6 dígitos en mayúsculas, sin `#`.
 */
export function deriveForeground(bg: string, minRatio = 4.5): string {
  const { r, g, b } = hexToRgb(bg);
  const { h } = rgbToHsl(r, g, b);
  const bgIsLight = luminanceOf(bg) > 0.18;

  // `near` es el extremo MÁS CERCANO al fondo (menos contraste) y `far` el
  // MÁS ALEJADO (más contraste). Con texto oscuro alejamos bajando L; con
  // texto claro, subiéndolo.
  const [near, far] = bgIsLight ? [FG_DARK_RANGE[1], FG_DARK_RANGE[0]] : FG_LIGHT_RANGE;
  const hue = hslToHex;

  // Si ni el extremo de más contraste alcanza el mínimo, el tono no sirve y
  // se cae al absoluto (negro o blanco), que siempre cumple.
  if (contrastRatio(hue(h, FG_SATURATION, far), bg) < minRatio) {
    return bgIsLight ? '000000' : 'FFFFFF';
  }

  // Bisección sobre L, monotónica respecto del contraste. Empezamos en `far`
  // (cumple, por el test de arriba) y vamos moviéndonos hacia `near` hasta
  // justo antes de que deje de cumplir: ese es el tono más suave posible.
  let best = far;
  let a = far;
  let z = near;
  for (let i = 0; i < 24; i++) {
    const mid = (a + z) / 2;
    if (contrastRatio(hue(h, FG_SATURATION, mid), bg) >= minRatio) {
      best = mid;
      a = mid;
    } else {
      z = mid;
    }
  }
  return hue(h, FG_SATURATION, best);
}

/** Genera la paleta pastel completa. Determinista: mismo array, mismos colores. */
export function buildPalette(): PaletteEntry[] {
  return PALETTE_NAMES.map(({ name, label, hue }) => {
    const bg = hslToHex(hue, BG_SATURATION, BG_LIGHTNESS);
    const fg = deriveForeground(bg);
    return { name, label, hue, bg, fg, contrast: checkContrast(fg, bg) };
  });
}

let cached: PaletteEntry[] | null = null;
export function palette(): PaletteEntry[] {
  if (!cached) cached = buildPalette();
  return cached;
}

/** Elige una paleta al azar. Usa el PRNG propio para no depender del estado global. */
export function randomPalette(): PaletteEntry {
  const p = palette();
  const pick = p[Math.floor(Math.random() * p.length)];
  if (!pick) throw new Error('la paleta está vacía');
  return pick;
}
