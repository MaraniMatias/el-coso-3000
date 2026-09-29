/**
 * Montserrat SemiBold embebida.
 *
 * El archivo se genera desde `fonts/Montserrat-SemiBold-latin.woff2` con
 * `bun run build` y queda en `src/core/font-data.ts`. No editar a mano.
 *
 * Va embebida y no enlazada a Google Fonts a propósito: la app tiene que
 * abrir sin red, y además el SVG exportado lleva la fuente dentro así que
 * sigue siendo legible aunque lo abras en un editor que no tenga la fuente
 * instalada.
 */

import { FONT_FAMILY, FONT_WEIGHT } from './types';
import { FONT_BASE64 } from './font-data';

export const FONT_MIME = 'font/woff2';
export const FONT_STACK = `"${FONT_FAMILY}", system-ui, -apple-system, "Segoe UI", sans-serif`;

/** Data URL lista para un `@font-face`. */
export const FONT_DATA_URL = `data:${FONT_MIME};base64,${FONT_BASE64}`;

/** El CSS del `@font-face`. Se inyecta en la página y también en el SVG. */
export const FONT_FACE_CSS = `@font-face {
  font-family: "${FONT_FAMILY}";
  font-style: normal;
  font-weight: ${FONT_WEIGHT};
  font-display: block;
  src: url(${FONT_DATA_URL}) format("${FONT_MIME}");
}`;

/**
 * Registra la fuente y espera a que esté lista.
 *
 * Importante: sin esto, `measureText` mide con la tipografía de respaldo y
 * todos los cálculos de auto-ajuste dan un tamaño equivocado. Hay que llamar
 * a esto una vez, antes del primer render.
 */
export async function ensureFontLoaded(): Promise<void> {
  if (typeof document === 'undefined' || !('fonts' in document)) return;
  const faces = document.fonts as FontFaceSet;
  // `block` en font-display hace que el documento espere en vez de pintar con
  // el fallback, que es justo lo que queremos para no medir dos veces.
  await faces.load(`${FONT_WEIGHT} 100px "${FONT_FAMILY}"`);
  await faces.ready;
}
