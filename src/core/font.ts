/**
 * Embedded Montserrat SemiBold.
 *
 * The file is generated from `fonts/Montserrat-SemiBold-latin.woff2` by
 * `bun run build` and ends up in `src/core/font-data.ts`. Do not edit by hand.
 *
 * It is embedded rather than linked to Google Fonts on purpose: the app must
 * open without a network connection, and the exported SVG includes the font so
 * it remains readable in an editor without the font installed.
 */

import { FONT_FAMILY, FONT_WEIGHT } from './types';
import { FONT_BASE64 } from './font-data';

export const FONT_MIME = 'font/woff2';
export const FONT_STACK = `"${FONT_FAMILY}", system-ui, -apple-system, "Segoe UI", sans-serif`;

/** Data URL ready for an `@font-face`. */
export const FONT_DATA_URL = `data:${FONT_MIME};base64,${FONT_BASE64}`;

/** The `@font-face` CSS, injected into the page and the SVG. */
export const FONT_FACE_CSS = `@font-face {
  font-family: "${FONT_FAMILY}";
  font-style: normal;
  font-weight: ${FONT_WEIGHT};
  font-display: block;
  src: url(${FONT_DATA_URL}) format("${FONT_MIME}");
}`;

/**
 * Registers the font and waits for it to be ready.
 *
 * Without this, `measureText` uses the fallback font and all auto-fit
 * calculations get the wrong size. Call this once, before the first render.
 */
export async function ensureFontLoaded(): Promise<void> {
  if (typeof document === 'undefined' || !('fonts' in document)) return;
  const faces = document.fonts as FontFaceSet;
  // `block` in font-display makes the document wait instead of painting with
  // the fallback, avoiding a second measurement.
  await faces.load(`${FONT_WEIGHT} 100px "${FONT_FAMILY}"`);
  await faces.ready;
}
