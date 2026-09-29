/**
 * Downloads the typeface and leaves it in `fonts/`.
 *
 * Runs: `bun run fetch:font`
 *
 * Montserrat SemiBold is not in Google Fonts as a "Montserrat Mono" family
 * (that one does not exist in the web catalog), so the `Montserrat` family is
 * requested with weight 600 and the latin subset is kept.
 *
 * License: SIL Open Font License 1.1, which allows embedding it.
 */
const FAMILIES = [{ family: 'Montserrat', weight: 600, file: 'Montserrat-SemiBold-latin.woff2' }];
const CSS_URL = 'https://fonts.googleapis.com/css2?family=Montserrat:wght@600&display=swap';
// Google Fonts serves woff2 only to browsers that ask for it. With plain curl
// it returns TTF, so the user agent has to lie.
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const OUT_DIR = new URL('../fonts/', import.meta.url);

const css = await fetch(CSS_URL, { headers: { 'User-Agent': UA } }).then((r) => {
  if (!r.ok) throw new Error(`could not request the CSS: ${r.status}`);
  return r.text();
});

// What we care about is the block whose unicode-range covers basic latin.
// Google Fonts orders the subsets from newest to oldest, but it is better not
// to depend on the order.
const blocks = css.split('@font-face');
const latin = blocks
  .map((b) => ({ url: /url\((https:\/\/[^)]+\.woff2)\)/.exec(b)?.[1], range: /unicode-range:\s*([^;]+);/.exec(b)?.[1] }))
  .find((b) => b.url && b.range?.includes('U+0000-00FF'));

if (!latin?.url) {
  throw new Error('the latin subset was not found in the Google Fonts CSS');
}

for (const { family, weight, file } of FAMILIES) {
  const buffer = await fetch(latin.url, { headers: { 'User-Agent': UA } }).then(async (r) => {
    if (!r.ok) throw new Error(`the download of ${family} failed: ${r.status}`);
    return r.arrayBuffer();
  });

  const signature = new TextDecoder().decode(new Uint8Array(buffer, 0, 4));
  if (signature !== 'wOF2') {
    throw new Error(`what came back is not a woff2 (signature "${signature}")`);
  }

  const path = new URL(file, OUT_DIR);
  await Bun.write(path, buffer);
  console.log(`${file.padEnd(32)} ${(buffer.byteLength / 1024).toFixed(1)} KB  (${family} ${weight}, SIL OFL 1.1)`);
}

console.log('\nNow run `bun run build` to regenerate src/core/font-data.ts.');
