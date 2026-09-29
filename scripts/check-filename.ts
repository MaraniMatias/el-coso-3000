/**
 * Verification of the file naming convention.
 *
 * Runs: `bun run check:filename`
 *
 * The name is the first thing anyone sees of a placeholder, and it was found
 * that still images came out as `320x240-15fps-0s.png`: a filler fps and a
 * zero duration that looks like a misconfigured video.
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

console.log('still images (they carry neither fps nor duration):');
for (const format of ['png', 'jpeg', 'webp', 'svg'] as const) {
  const name = filenameForSpec(spec(), format);
  console.log(`  ${name}`);
  check(`it does not say 0s in ${format}`, !name.includes('0s'), name);
  check(`it does not say fps in ${format}`, !name.includes('fps'), name);
  check(`${format} starts with the dimensions`, name.startsWith('1920x1080.'), name);
}

console.log('\nformats with a timeline:');
for (const format of ['gif', 'mjpeg-avi', 'jpeg-zip', 'mp4', 'webm', 'mov', 'mkv'] as const) {
  const name = filenameForSpec(spec({ duration: 5 }), format);
  console.log(`  ${name}`);
  check(`${format} carries the duration`, name.includes('-5s'), name);
}

console.log('\nthe GIF reports the effective FPS, not the requested one:');
// 15 fps → a delay of 7 hundredths (rounded) → 14.29 real fps.
const gif = buildFilename({
  width: 320, height: 240, format: 'gif', fps: 15, duration: 0, effectiveFps: 100 / 7,
});
console.log(`  ${gif}`);
check('it uses the effective FPS when it differs', gif.includes('14.29'), gif);
check('it does not repeat the requested FPS', !gif.includes('15fps'), gif);

console.log('\neven dimensions after the H.264 rounding:');
const even = evenDimensions(1079, 481);
const real = filenameForSpec(spec({ width: 1079, height: 481, duration: 5 }), 'mp4', even);
console.log(`  requested 1079x481 → ${real}`);
check('the name uses the real dimensions', real.startsWith('1080x482'), real);
check('it reports that it rounded up', even.changed);
check('even numbers do not change', !evenDimensions(1080, 482).changed);

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
  check(`MIME of ${format}`, got === expected, `${got} ≠ ${expected}`);
}

check('trimNumber drops useless zeros', trimNumber(10) === '10' && trimNumber(2.5) === '2.5');

console.log(fails === 0 ? '\n✔ names OK' : `\n✘ ${fails} failure(s)`);
process.exit(fails === 0 ? 0 : 1);
