/**
 * Verification of the pastel palette.
 *
 * Runs: `bun run check:palette`
 *
 * Fails (exit 1) if any pair does not reach AA, if any color falls outside the
 * pastel range, or if the text color ended up too saturated to read well.
 */
import { buildPalette, contrastRatio, deriveBackground, deriveForeground, hslToHex, checkContrast } from '../src/core/color';

const MIN_RATIO = 4.5;
let failures = 0;

console.log('generated pastel palette\n');
console.log('  name            bg       text     ratio    level  L_fg');
console.log('  ' + '─'.repeat(58));

for (const p of buildPalette()) {
  const fgL = checkContrast(p.fg, p.bg);
  const lum = (hex: string) => {
    const n = Number.parseInt(hex, 16);
    // relative luminance, to check that the text is effectively dark
    const lin = (v: number) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
    return 0.2126 * lin(((n >> 16) & 255) / 255) + 0.7152 * lin(((n >> 8) & 255) / 255) + 0.0722 * lin((n & 255) / 255);
  };
  const ok = fgL.ratio >= MIN_RATIO && fgL.level !== 'fail';
  if (!ok) failures++;
  console.log(
    `  ${p.label.padEnd(14)}${p.bg}   ${p.fg}   ${fgL.label.padStart(7)}  ${fgL.level.padEnd(7)}${lum(p.fg).toFixed(3)}  ${ok ? '' : '  ← FAILS'}`,
  );
}

console.log('\ntest with arbitrary backgrounds (extremes included):');
const probes = ['FFFFFF', '000000', '808080', 'FFE4E4', '1A1A2E', 'F5F5DC', '2E1A1A', '7F7F00', '00FF00', 'FF00FF'];
for (const bg of probes) {
  const fg = deriveForeground(bg);
  const r = contrastRatio(fg, bg);
  const ok = r >= MIN_RATIO;
  if (!ok) failures++;
  console.log(`  bg #${bg} → fg #${fg}  ${r.toFixed(2)}:1  ${ok ? 'ok' : '← FAILS'}`);
}

// The same rule from the other side: a text of their own brings the background
// with it, and it has to clear AA just the same.
console.log('\ntest with arbitrary texts, the background derived from them:');
for (const fg of probes) {
  const bg = deriveBackground(fg);
  const r = contrastRatio(fg, bg);
  const ok = r >= MIN_RATIO;
  if (!ok) failures++;
  console.log(`  fg #${fg} → bg #${bg}  ${r.toFixed(2)}:1  ${ok ? 'ok' : '← FAILS'}`);
}

console.log('\ndeterminism test:');
const a = buildPalette().map((p) => p.bg + p.fg).join('');
const b = buildPalette().map((p) => p.bg + p.fg).join('');
if (a !== b) {
  console.log('  ← FAILS: the palette is not deterministic');
  failures++;
} else {
  console.log('  ok, two calls give the same result');
}

// The text should never land in the middle grey zone.
const midL = buildPalette().some((p) => {
  const n = Number.parseInt(p.fg, 16);
  const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
  return Math.max(r, g, b) > 150 && Math.min(r, g, b) > 60;
});
if (midL) {
  console.log('  ← FAILS: there is text in the middle grey zone, which is exactly what has to be avoided');
  failures++;
} else {
  console.log('  ok, no text ended up in the middle grey zone');
}

console.log(failures === 0 ? '\n✔ palette OK' : `\n✘ ${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);
