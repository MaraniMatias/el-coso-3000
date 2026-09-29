/**
 * Punto de entrada. Lo único que hay que hacer es importar la UI.
 *
 * El bundler de Bun produce un IIFE y lo pega dentro del HTML, así que en el
 * navegador no hay módulos, ni imports, ni nada que resolver en runtime.
 */
import './ui/app';
