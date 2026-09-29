/**
 * Verificación de la convención de nombres de archivo.
 *
 * Corre: `bun run check:filename`
 *
 * El nombre es lo primero que uno ve de un placeholder, y se encontró que las
 * imágenes fijas salían como `320x240-15fps-0s.png`: fps de relleno y una
 * duración cero que parece un video mal configurado.
 */
import { buildFilename, filenameForSpec, evenDimensions, trimNumber, mimeFor } from '../src/core/filename';
import type { Spec } from '../src/core/types';

let fails = 0;
const check = (name: string, ok: boolean, detail = ''): void => {
  if (!ok) {
    fails++;
    console.log(`  ✘ ${name}${detail ? `  → ${detail}` : ''}`);
  }
};

function spec(over: Partial<Spec> = {}): Spec {
  return {
    width: 1920,
    height: 1080,
    bg: 'F2DEE2',
    fg: '962C41',
    paletteName: 'rose',
    duration: 0,
    fps: 15,
    showProgressBar: false,
    showTime: false,
    quality: 0.9,
    ...over,
  };
}

console.log('imágenes fijas (no llevan fps ni duración):');
for (const format of ['png', 'jpeg', 'webp', 'svg'] as const) {
  const name = filenameForSpec(spec(), format);
  console.log(`  ${name}`);
  check(`no dice 0s en ${format}`, !name.includes('0s'), name);
  check(`no dice fps en ${format}`, !name.includes('fps'), name);
  check(`${format} arranca con las dimensiones`, name.startsWith('1920x1080.'), name);
}

console.log('\nformatos con línea de tiempo:');
for (const format of ['gif', 'mjpeg-avi', 'jpeg-zip', 'mp4', 'webm', 'mov', 'mkv'] as const) {
  const name = filenameForSpec(spec({ duration: 5 }), format);
  console.log(`  ${name}`);
  check(`${format} lleva la duración`, name.includes('-5s'), name);
}

console.log('\nel GIF reporta el FPS efectivo, no el pedido:');
// 15 fps → delay de 7 centésimas (redondeo) → 14,29 fps reales.
const gif = buildFilename({
  width: 320, height: 240, format: 'gif', fps: 15, duration: 0, effectiveFps: 100 / 7,
});
console.log(`  ${gif}`);
check('usa el FPS efectivo cuando difiere', gif.includes('14.29'), gif);
check('no duplica el FPS pedido', !gif.includes('15fps'), gif);

console.log('\ndimensiones pares tras el redondeo de H.264:');
const even = evenDimensions(1079, 481);
const real = filenameForSpec(spec({ width: 1079, height: 481, duration: 5 }), 'mp4', even);
console.log(`  pedido 1079x481 → ${real}`);
check('el nombre usa las dimensiones reales', real.startsWith('1080x482'), real);
check('marca que se redondeó', even.changed);
check('los pares no cambian', !evenDimensions(1080, 482).changed);

console.log('\nMIME:');
const cases: Array<[Parameters<typeof mimeFor>[0], Parameters<typeof mimeFor>[1], string]> = [
  ['png', false, 'image/png'],
  ['jpeg', false, 'image/jpeg'],
  ['svg', false, 'image/svg+xml'],
  ['gif', false, 'image/gif'],
  ['jpeg-zip', false, 'application/zip'],
  ['mp4', true, 'video/mp4'],
  ['mov', true, 'video/quicktime'],
  ['mkv', true, 'video/x-matroska'],
];
for (const [format, isVideo, expected] of cases) {
  const got = mimeFor(format, isVideo);
  check(`MIME de ${format}`, got === expected, `${got} ≠ ${expected}`);
}

check('trimNumber quita ceros inútiles', trimNumber(10) === '10' && trimNumber(2.5) === '2.5');

console.log(fails === 0 ? '\n✔ nombres OK' : `\n✘ ${fails} fallo(s)`);
process.exit(fails === 0 ? 0 : 1);
