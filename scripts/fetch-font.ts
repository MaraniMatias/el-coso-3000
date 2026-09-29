/**
 * Descarga la tipografía y la deja en `fonts/`.
 *
 * Corre: `bun run fetch:font`
 *
 * Montserrat SemiBold no está en Google Fonts como familia "Montserrat Mono"
 * (esa no existe en el catálogo web), así que se pide la subfamilia
 * `Montserrat` con peso 600 y se queda con el subset latino.
 *
 * Licencia: SIL Open Font License 1.1, que permite embeberla.
 */
const FAMILIES = [{ family: 'Montserrat', weight: 600, file: 'Montserrat-SemiBold-latin.woff2' }];
const CSS_URL = 'https://fonts.googleapis.com/css2?family=Montserrat:wght@600&display=swap';
// Google Fonts sirve woff2 sólo a navegadores que lo piden. Con curl pelado
// devuelve TTF, así que hay que mentir con el user agent.
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const OUT_DIR = new URL('../fonts/', import.meta.url);

const css = await fetch(CSS_URL, { headers: { 'User-Agent': UA } }).then((r) => {
  if (!r.ok) throw new Error(`no se pudo pedir la CSS: ${r.status}`);
  return r.text();
});

// Nos interesa el bloque cuyo unicode-range cubre el latín básico. Google
// Fonts ordena los subsets de más nuevo a más viejo, pero mejor no depender
// del orden.
const blocks = css.split('@font-face');
const latin = blocks
  .map((b) => ({ url: /url\((https:\/\/[^)]+\.woff2)\)/.exec(b)?.[1], range: /unicode-range:\s*([^;]+);/.exec(b)?.[1] }))
  .find((b) => b.url && b.range?.includes('U+0000-00FF'));

if (!latin?.url) {
  throw new Error('no encontré el subset latino en la CSS de Google Fonts');
}

for (const { family, weight, file } of FAMILIES) {
  const buffer = await fetch(latin.url, { headers: { 'User-Agent': UA } }).then(async (r) => {
    if (!r.ok) throw new Error(`falló la descarga de ${family}: ${r.status}`);
    return r.arrayBuffer();
  });

  const signature = new TextDecoder().decode(new Uint8Array(buffer, 0, 4));
  if (signature !== 'wOF2') {
    throw new Error(`lo que llegó no es un woff2 (firma "${signature}")`);
  }

  const path = new URL(file, OUT_DIR);
  await Bun.write(path, buffer);
  console.log(`${file.padEnd(32)} ${(buffer.byteLength / 1024).toFixed(1)} KB  (${family} ${weight}, SIL OFL 1.1)`);
}

console.log('\nAhora corré `bun run build` para regenerar src/core/font-data.ts.');
