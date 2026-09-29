/**
 * Build de el-coso-3000.
 *
 * Produce UN solo archivo: `dist/placeholder.html`, que se abre con doble
 * click desde el Finder, sin servidor y sin conexión.
 *
 * Pasos:
 *   1. Regenera `src/core/font-data.ts` desde el woff2 de `fonts/`.
 *   2. Empaqueta `src/main.ts` con el bundler de Bun, en formato IIFE.
 *   3. Inyecta el JS y el CSS dentro de `src/index.html`.
 *   4. Verifica que el resultado no carga nada de la red.
 *
 * Corre: `bun run build`
 */
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const FONT = join(root, 'fonts/Montserrat-SemiBold-latin.woff2');
const FONT_DATA = join(root, 'src/core/font-data.ts');
const ENTRY = join(root, 'src/main.ts');
const TEMPLATE = join(root, 'src/index.html');
const STYLES = join(root, 'src/styles.css');
const OUT_DIR = join(root, 'dist');
const OUT = join(OUT_DIR, 'placeholder.html');

const kb = (n: number) => `${(n / 1024).toFixed(1)} KB`;

// ── 1. Fuente embebida ──────────────────────────────────────────────

async function bakeFont(): Promise<number> {
  const bytes = new Uint8Array(await Bun.file(FONT).arrayBuffer());
  // La firma de un woff2 es 'wOF2'. Si no está, el archivo se bajó mal y hay
  // que saberlo ahora y no cuando el texto salga con la tipografía de reserva.
  const signature = new TextDecoder().decode(bytes.slice(0, 4));
  if (signature !== 'wOF2') {
    throw new Error(`"${FONT}" no es un woff2 válido (firma "${signature}"). Corré \`bun run fetch:font\`.`);
  }
  const b64 = Buffer.from(bytes).toString('base64');
  const header = [
    '/* Generado por scripts/build.ts. No editar a mano. */',
    '/* Fuente: fonts/Montserrat-SemiBold-latin.woff2 — SIL Open Font License 1.1 */',
    '',
    `export const FONT_BASE64 =`,
    `  "${b64}";`,
    '',
  ].join('\n');
  await Bun.write(FONT_DATA, header);
  return bytes.length;
}

// ── 2. Bundle ───────────────────────────────────────────────────────

async function bundle(): Promise<string> {
  const result = await Bun.build({
    entrypoints: [ENTRY],
    target: 'browser',
    format: 'iife',
    minify: true,
    sourcemap: 'none',
  });
  if (!result.success) {
    for (const log of result.logs) console.error(log);
    throw new Error('el bundler falló');
  }
  const output = result.outputs[0];
  if (!output) throw new Error('el bundler no devolvió nada');
  return output.text();
}

// ── 3. Inyección ────────────────────────────────────────────────────

/**
 * Los scripts inline no pueden llevar la secuencia `</script>` adentro, ni
 * aunque esté dentro de un string. Rompería el HTML en silencio.
 */
function guardInlineScript(js: string): string {
  return js.replace(/<\/script/gi, '<\\/script').replace(/<!--/g, '<\\!--');
}

// ── 4. Verificación de que es realmente offline ─────────────────────

/**
 * Sólo importan los `rel` que hacen descargar algo. `canonical`, `alternate`
 * y `author` son metadata pura: apuntan a una URL pero el navegador no pide
 * nada, así que no rompen la promesa de offline.
 */
const LOADING_LINK_RELS = ['stylesheet', 'preload', 'prefetch', 'modulepreload', 'icon', 'apple-touch-icon', 'manifest'];

const REMOTE_LOADERS: Array<{ pattern: RegExp; what: string }> = [
  { pattern: /<script[^>]+\bsrc\s*=\s*["']https?:/i, what: 'un <script> con src remoto' },
  { pattern: /@import\s+(?:url\()?["']?https?:/i, what: 'un @import remoto' },
  { pattern: /url\(\s*["']?https?:/i, what: 'un url() remoto en el CSS' },
  { pattern: /\bfetch\(\s*["'`]https?:/i, what: 'un fetch() a un origen remoto' },
  { pattern: /\bimportScripts\(\s*["'`]https?:/i, what: 'un importScripts() remoto' },
  { pattern: /<img[^>]+\bsrc\s*=\s*["']https?:/i, what: 'una <img> remota' },
];

/** Los `<meta>` y `<link rel="canonical">` son metadata, no cargas. */
function auditOffline(html: string): void {
  const problems: string[] = [];

  for (const rel of LOADING_LINK_RELS) {
    const pattern = new RegExp(`<link[^>]*\\brel\\s*=\\s*["'][^"']*\\b${rel}\\b[^"']*["'][^>]*>`, 'i');
    const match = pattern.exec(html);
    if (match && /https?:/i.test(match[0])) {
      problems.push(`un <link rel="${rel}"> a un recurso remoto`);
    }
  }

  for (const { pattern, what } of REMOTE_LOADERS) {
    const match = pattern.exec(html);
    if (match) {
      const at = html.indexOf(match[0]);
      problems.push(`${what} — cerca de: …${html.slice(Math.max(0, at - 60), at + 60).replace(/\s+/g, ' ')}…`);
    }
  }

  if (problems.length > 0) {
    throw new Error(`el HTML carga recursos remotos:\n  - ${problems.join('\n  - ')}`);
  }
}

// ── Correr ───────────────────────────────────────────────────────────

const fontBytes = await bakeFont();
console.log(`fuente     ${kb(fontBytes)}  (${kb(Math.round(fontBytes * 4) / 3)} en base64)`);

const js = await bundle();
console.log(`bundle     ${kb(new TextEncoder().encode(js).length)}`);

const css = await Bun.file(STYLES).text();
const template = await Bun.file(TEMPLATE).text();

const html = template
  .replace('/*__STYLES__*/', () => css.trim())
  .replace('/*__BUNDLE__*/', () => guardInlineScript(js));

if (html.includes('/*__STYLES__*/') || html.includes('/*__BUNDLE__*/')) {
  throw new Error('faltan marcadores en el template de index.html');
}

auditOffline(html);

await Bun.write(OUT, html);

const outBytes = new TextEncoder().encode(html).length;
console.log(`\n✔ ${OUT}`);
console.log(`  ${kb(outBytes)} en total, autocontenido.`);
console.log('  Abrilo con doble click. No necesita servidor ni conexión.');
