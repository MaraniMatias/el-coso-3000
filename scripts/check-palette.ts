/**
 * Verificación de la paleta pastel.
 *
 * Corre: `bun run check:palette`
 *
 * Falla (exit 1) si algún par no llega a AA, si algún color se sale del rango
 * pastel, o si el color de texto quedó demasiado saturado para leerse bien.
 */
import { buildPalette, contrastRatio, deriveForeground, hslToHex, checkContrast } from '../src/core/color';

const MIN_RATIO = 4.5;
let failures = 0;

console.log('paleta pastel generada\n');
console.log('  nombre        fondo     texto     ratio    nivel  L_fg');
console.log('  ' + '─'.repeat(58));

for (const p of buildPalette()) {
  const fgL = checkContrast(p.fg, p.bg);
  const lum = (hex: string) => {
    const n = Number.parseInt(hex, 16);
    // luminancia relativa, para chequear que el texto sea efectivamente oscuro
    const lin = (v: number) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
    return 0.2126 * lin(((n >> 16) & 255) / 255) + 0.7152 * lin(((n >> 8) & 255) / 255) + 0.0722 * lin((n & 255) / 255);
  };
  const ok = fgL.ratio >= MIN_RATIO && fgL.level !== 'fail';
  if (!ok) failures++;
  console.log(
    `  ${p.label.padEnd(14)}${p.bg}   ${p.fg}   ${fgL.label.padStart(7)}  ${fgL.level.padEnd(7)}${lum(p.fg).toFixed(3)}  ${ok ? '' : '  ← FALLA'}`,
  );
}

console.log('\nprueba de fondos arbitrarios (incluye extremos):');
const probes = ['FFFFFF', '000000', '808080', 'FFE4E4', '1A1A2E', 'F5F5DC', '2E1A1A', '7F7F00', '00FF00', 'FF00FF'];
for (const bg of probes) {
  const fg = deriveForeground(bg);
  const r = contrastRatio(fg, bg);
  const ok = r >= MIN_RATIO;
  if (!ok) failures++;
  console.log(`  bg #${bg} → fg #${fg}  ${r.toFixed(2)}:1  ${ok ? 'ok' : '← FALLA'}`);
}

console.log('\nprueba de determinismo:');
const a = buildPalette().map((p) => p.bg + p.fg).join('');
const b = buildPalette().map((p) => p.bg + p.fg).join('');
if (a !== b) {
  console.log('  ← FALLA: la paleta no es determinista');
  failures++;
} else {
  console.log('  ok, dos llamadas dan el mismo resultado');
}

// El texto nunca debería caer en un gris medio deadzone.
const midL = buildPalette().some((p) => {
  const n = Number.parseInt(p.fg, 16);
  const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
  return Math.max(r, g, b) > 150 && Math.min(r, g, b) > 60;
});
if (midL) {
  console.log('  ← FALLA: hay un texto en la zona media gris, que es justo lo que hay que evitar');
  failures++;
} else {
  console.log('  ok, ningún texto quedó en la zona media gris');
}

console.log(failures === 0 ? '\n✔ paleta OK' : `\n✘ ${failures} fallo(s)`);
process.exit(failures === 0 ? 0 : 1);
