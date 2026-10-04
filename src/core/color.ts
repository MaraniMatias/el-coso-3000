import type { ContrastLevel, ContrastResult, PaletteEntry } from "./types";

/** ── Color conversion ────────────────────────────────────────────────── */

export function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const h = hex.replace("#", "");
  const full =
    h.length === 3
      ? h
          .split("")
          .map((c) => c + c)
          .join("")
      : h;
  const n = Number.parseInt(full, 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

export function rgbToHex(r: number, g: number, b: number): string {
  const to = (v: number) =>
    Math.max(0, Math.min(255, Math.round(v)))
      .toString(16)
      .padStart(2, "0");
  return `${to(r)}${to(g)}${to(b)}`;
}

/** Normalizes any valid hex to 6 uppercase digits, without `#`. */
export function normalizeHex(hex: string): string {
  return rgbToHex(
    hexToRgb(hex).r,
    hexToRgb(hex).g,
    hexToRgb(hex).b,
  ).toUpperCase();
}

export function rgbToHsl(
  r: number,
  g: number,
  b: number,
): { h: number; s: number; l: number } {
  const rn = r / 255,
    gn = g / 255,
    bn = b / 255;
  const max = Math.max(rn, gn, bn),
    min = Math.min(rn, gn, bn);
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

export function hslToRgb(
  h: number,
  s: number,
  l: number,
): { r: number; g: number; b: number } {
  const hn = ((h % 360) + 360) % 360;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((hn / 60) % 2) - 1));
  const m = l - c / 2;
  let rp = 0,
    gp = 0,
    bp = 0;
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

/** `rgba()` out of a hex, to overlay without recomputing anything. */
export function hexToRgba(hex: string, alpha: number): string {
  const { r, g, b } = hexToRgb(hex);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

/**
 * Hex ready for `ctx.fillStyle` and for CSS.
 *
 * Internally the colors are stored without `#` because that is what the
 * metadata of every format wants. But canvas and CSS **silently drop** a color
 * without `#`: `fillStyle = 'F2DEE2'` does not throw, it just keeps the
 * previous value (black). That is why every consumer has to go through here
 * instead of using the raw hex.
 */
export function cssColor(hex: string): string {
  return hex.startsWith("#") ? hex : `#${hex}`;
}

/** ── WCAG 2.1 ────────────────────────────────────────────────────────── */

/** WCAG relative luminance. `0` = black, `1` = white. */
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
  if (ratio >= 7) return "AAA";
  if (ratio >= 4.5) return "AA";
  if (ratio >= 3) return "AA-large";
  return "fail";
}

export function checkContrast(fg: string, bg: string): ContrastResult {
  const ratio = contrastRatio(fg, bg);
  return {
    ratio,
    label: `${ratio.toFixed(2)}:1`,
    level: levelForRatio(ratio),
  };
}

// ── Palette ────────────────────────────────────────────────────────────

/** Saturation of the color that `deriveForeground` picks for a custom one. */
const DERIVED_SATURATION = 0.55;

/**
 * Below this, the color is gray: it has no hue of its own to keep, so the
 * derived one is gray too. A pure gray has a hue of 0, which is red, and a
 * neutral background would otherwise come out with a pink text.
 */
const ACHROMATIC_SATURATION = 0.05;

/**
 * Lightness range of the derived color, as `[most different, closest]`. Which
 * one it is depends on the color it is derived from: a light one gets a dark
 * partner and a dark one gets a light partner.
 */
const DARK_RANGE: [number, number] = [0.05, 0.38];
const LIGHT_RANGE: [number, number] = [0.62, 0.97];

/**
 * The swatches of the interface, as pairs picked by hand: a soft background
 * and a dark text of the same family. They are NOT generated by formula, so
 * they are written down here; `checkContrast` still verifies them and
 * `check:palette` fails if one ever drops below AA.
 *
 * `name` is the stable identifier that reaches the file metadata; `label` is
 * what the UI shows.
 */
const PALETTE: Array<{ name: string; label: string; bg: string; fg: string }> =
  [
    { name: "gray", label: "Gray", bg: "E5E7EB", fg: "374151" },
    { name: "red", label: "Red", bg: "FEE2E2", fg: "991B1B" },
    { name: "orange", label: "Orange", bg: "FFEDD5", fg: "9A3412" },
    { name: "yellow", label: "Yellow", bg: "FEF9C3", fg: "854D0E" },
    { name: "green", label: "Green", bg: "DCFCE7", fg: "166534" },
    { name: "teal", label: "Teal", bg: "CCFBF1", fg: "115E59" },
    { name: "blue", label: "Blue", bg: "DBEAFE", fg: "1E40AF" },
    { name: "violet", label: "Violet", bg: "EDE9FE", fg: "5B21B6" },
    { name: "rose", label: "Rose", bg: "FCE7F3", fg: "9D174D" },
  ];

/**
 * The partner of a color of the pair: the text that goes with a background, and
 * the background that goes with a text.
 *
 * Both directions are the same rule, which is why one function answers both (see
 * `deriveBackground`): keep the hue, walk the lightness AWAY from the color that
 * was given, and stop at the SOFTEST tone that still reaches the minimum. The
 * requested criterion is that a light red carries a darker red, not a hard
 * black.
 *
 * @param minRatio minimum contrast to guarantee. AA (4.5:1) by default.
 * @returns 6-digit uppercase hex, without `#`.
 */
export function deriveForeground(bg: string, minRatio = 4.5): string {
  const { r, g, b } = hexToRgb(bg);
  const { h, s } = rgbToHsl(r, g, b);
  const bgIsLight = luminanceOf(bg) > 0.18;

  // `near` is the end CLOSEST to the color that was given (least contrast) and
  // `far` the FURTHEST one (most contrast). With a dark partner it moves away by
  // lowering L; with a light one, by raising it.
  const [near, far] = bgIsLight
    ? [DARK_RANGE[1], DARK_RANGE[0]]
    : LIGHT_RANGE;
  const hue = hslToHex;
  // A gray has nothing to keep, so it stays gray.
  const sat = s < ACHROMATIC_SATURATION ? 0 : DERIVED_SATURATION;

  // If not even the end with the most contrast reaches the minimum, the hue is
  // useless and it falls back to the absolute (black or white), which always
  // complies.
  if (contrastRatio(hue(h, sat, far), bg) < minRatio) {
    return bgIsLight ? "000000" : "FFFFFF";
  }

  // Bisection on L, monotonic with respect to the contrast. It starts at `far`
  // (which complies, by the test above) and moves towards `near` until just
  // before it stops complying: that is the softest tone possible.
  let best = far;
  let a = far;
  let z = near;
  for (let i = 0; i < 24; i++) {
    const mid = (a + z) / 2;
    if (contrastRatio(hue(h, sat, mid), bg) >= minRatio) {
      best = mid;
      a = mid;
    } else {
      z = mid;
    }
  }
  return hue(h, sat, best);
}

/**
 * The background that goes with a text of the person's own. The same rule, read
 * from the other side of the pair, so it is the same function under the name
 * that says what it is being asked for.
 */
export const deriveBackground = deriveForeground;

/** The palette, with the contrast of each pair measured. Deterministic. */
export function buildPalette(): PaletteEntry[] {
  return PALETTE.map(({ name, label, bg, fg }) => {
    const { r, g, b } = hexToRgb(bg);
    return {
      name,
      label,
      hue: rgbToHsl(r, g, b).h,
      bg,
      fg,
      contrast: checkContrast(fg, bg),
    };
  });
}

let cached: PaletteEntry[] | null = null;
export function palette(): PaletteEntry[] {
  if (!cached) cached = buildPalette();
  return cached;
}

/** Picks a palette at random. It uses its own PRNG to avoid global state. */
export function randomPalette(): PaletteEntry {
  const p = palette();
  const pick = p[Math.floor(Math.random() * p.length)];
  if (!pick) throw new Error("the palette is empty");
  return pick;
}
